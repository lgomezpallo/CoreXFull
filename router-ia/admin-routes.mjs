import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { buildCapabilityRoutes } from "./provider-capabilities.mjs";
import {
  discoverModels,
  inferModelCapabilities,
  isExplicitlyFreeModel,
  isGroqFreePlanBaseUrl,
  isGroqFreePlanModel,
  isNvidiaApiCatalogBaseUrl,
  normalizeProviderInput,
} from "./provider-adapter.mjs";

const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const PASSKEY_CEREMONY_TTL_MS = 5 * 60 * 1_000;
const MAX_PENDING_CEREMONIES = 256;
const SESSION_COOKIE = "router_ia_admin";
const MAX_BODY_BYTES = 1_048_576;
const ADMIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "admin");
const ASSETS = new Map([
  ["/admin", ["index.html", "text/html; charset=utf-8"]],
  ["/admin/", ["index.html", "text/html; charset=utf-8"]],
  ["/admin/admin.css", ["admin.css", "text/css; charset=utf-8"]],
  ["/admin/admin.js", ["admin.js", "text/javascript; charset=utf-8"]],
  ["/admin/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json; charset=utf-8"]],
  ["/admin/service-worker.js", ["service-worker.js", "text/javascript; charset=utf-8"]],
  ["/admin/icons/icon-192.png", ["icons/icon-192.png", "image/png"]],
  ["/admin/icons/icon-512.png", ["icons/icon-512.png", "image/png"]],
  ["/admin/icons/icon-512-maskable.png", ["icons/icon-512-maskable.png", "image/png"]],
  ["/admin/icons/apple-touch-icon.png", ["icons/apple-touch-icon.png", "image/png"]],
]);
const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    ...JSON_HEADERS,
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function sendNoContent(response) {
  response.writeHead(204, JSON_HEADERS);
  response.end();
}

function constantTimeTokenMatch(provided, expectedToken) {
  if (typeof provided !== "string" || !expectedToken) return false;
  const supplied = Buffer.from(provided, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function getCookie(request) {
  const cookieHeader = request.headers.cookie;
  if (typeof cookieHeader !== "string") return "";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator >= 0 && part.slice(0, separator).trim() === SESSION_COOKIE) {
      return part.slice(separator + 1).trim();
    }
  }
  return "";
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (typeof origin !== "string") return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function sendSessionCookie(response, token, secure) {
  response.setHeader(
    "set-cookie",
    `${SESSION_COOKIE}=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_SESSION_TTL_MS / 1_000}${secure ? "; Secure" : ""}`,
  );
}

function clearSessionCookie(response, secure) {
  response.setHeader(
    "set-cookie",
    `${SESSION_COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`,
  );
}

function isAuthenticated(request, sessions) {
  const token = getCookie(request);
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function getPasskeyOrigin(request) {
  const originHeader = request.headers.origin;
  if (typeof originHeader !== "string" || !isSameOrigin(request)) return null;

  try {
    const origin = new URL(originHeader);
    const localHttpOrigin =
      origin.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if (
      (origin.protocol !== "https:" && !localHttpOrigin) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      return null;
    }
    return { expectedOrigin: origin.origin, rpID: origin.hostname };
  } catch {
    return null;
  }
}

function isJsonRequest(request) {
  return /^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "");
}

function getLoginAttempt(failedLogins, remoteAddress, now) {
  let attempt = failedLogins.get(remoteAddress);
  if (attempt && now - attempt.startedAt >= 5 * 60_000) {
    failedLogins.delete(remoteAddress);
    attempt = null;
  }
  return attempt;
}

function isLoginBlocked(failedLogins, remoteAddress, now) {
  return getLoginAttempt(failedLogins, remoteAddress, now)?.count >= 10;
}

function recordLoginFailure(failedLogins, remoteAddress, now) {
  const attempt = getLoginAttempt(failedLogins, remoteAddress, now) ?? {
    startedAt: now,
    count: 0,
  };
  attempt.count += 1;
  failedLogins.set(remoteAddress, attempt);
}

function createCeremony(challenges, values) {
  const now = Date.now();
  for (const [id, ceremony] of challenges) {
    if (ceremony.expiresAt <= now) challenges.delete(id);
  }
  while (challenges.size >= MAX_PENDING_CEREMONIES) {
    const oldest = challenges.keys().next().value;
    if (oldest === undefined) break;
    challenges.delete(oldest);
  }

  const id = randomBytes(32).toString("base64url");
  challenges.set(id, {
    ...values,
    expiresAt: now + PASSKEY_CEREMONY_TTL_MS,
  });
  return id;
}

function errorResponseStatus(error) {
  return Number.isInteger(error?.statusCode) ? error.statusCode : 400;
}

export function createAdminHandler({
  adminToken,
  providerStore,
  passkeyStore = null,
  webauthn = {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
  },
  fetchImpl = globalThis.fetch,
  secureCookies = process.env.NODE_ENV === "production",
}) {
  const sessions = new Map();
  const failedLogins = new Map();
  const registrationChallenges = new Map();
  const authenticationChallenges = new Map();

  function establishSession(response, remoteAddress) {
    const now = Date.now();
    failedLogins.delete(remoteAddress);
    const sessionToken = randomBytes(32).toString("hex");
    sessions.set(sessionToken, now + ADMIN_SESSION_TTL_MS);
    sendSessionCookie(response, sessionToken, secureCookies);
  }

  return async function handleAdminRequest(request, response, url) {
    const asset = ASSETS.get(url.pathname);
    if (request.method === "GET" && asset) {
      try {
        const body = await readFile(resolve(ADMIN_DIR, asset[0]));
        response.writeHead(200, {
          ...JSON_HEADERS,
          "cache-control": "no-store",
          "content-length": body.byteLength,
          "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
          "content-type": asset[1],
        });
        response.end(body);
      } catch {
        sendJson(response, 500, { error: { message: "The admin panel could not be loaded." } });
      }
      return true;
    }

    if (!url.pathname.startsWith("/admin/api/")) return false;
    if (!adminToken) {
      sendJson(response, 503, {
        error: { message: "Router IA admin access is not configured." },
      });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/admin/api/session") {
      sendJson(response, 200, { authenticated: isAuthenticated(request, sessions) });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/admin/api/passkeys/status") {
      if (!passkeyStore) {
        sendJson(response, 200, { configured: false, count: 0 });
        return true;
      }
      try {
        const credentials = await passkeyStore.listCredentials();
        sendJson(response, 200, { configured: true, count: credentials.length });
      } catch {
        sendJson(response, 503, {
          error: { message: "Passkey sign-in is temporarily unavailable." },
        });
      }
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/admin/api/passkeys/login/options"
    ) {
      const remoteAddress = request.socket.remoteAddress ?? "unknown";
      if (isLoginBlocked(failedLogins, remoteAddress, Date.now())) {
        sendJson(response, 429, {
          error: { message: "Too many sign-in attempts. Try again in five minutes." },
        });
        return true;
      }
      const origin = getPasskeyOrigin(request);
      if (!origin) {
        sendJson(response, 403, { error: { message: "Origin not allowed." } });
        return true;
      }
      if (!isJsonRequest(request)) {
        sendJson(response, 415, {
          error: { message: "Content-Type must be application/json." },
        });
        return true;
      }
      try {
        await readJsonBody(request);
      } catch (error) {
        sendJson(response, errorResponseStatus(error), {
          error: { message: error.message },
        });
        return true;
      }
      if (!passkeyStore) {
        sendJson(response, 503, {
          error: { message: "Passkey sign-in is not configured." },
        });
        return true;
      }

      try {
        const credentials = await passkeyStore.listCredentials();
        if (!credentials.length) {
          sendJson(response, 409, {
            error: { message: "No passkeys are registered for this admin panel." },
          });
          return true;
        }
        const options = await webauthn.generateAuthenticationOptions({
          rpID: origin.rpID,
          allowCredentials: credentials.map((credential) => ({
            id: credential.id,
            transports: credential.transports,
          })),
          userVerification: "required",
          timeout: 60_000,
        });
        const challengeId = createCeremony(authenticationChallenges, {
          challenge: options.challenge,
          expectedOrigin: origin.expectedOrigin,
          rpID: origin.rpID,
        });
        sendJson(response, 200, { challengeId, options });
      } catch {
        sendJson(response, 503, {
          error: { message: "Passkey sign-in could not be started." },
        });
      }
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/admin/api/passkeys/login/verify"
    ) {
      const remoteAddress = request.socket.remoteAddress ?? "unknown";
      const now = Date.now();
      if (isLoginBlocked(failedLogins, remoteAddress, now)) {
        sendJson(response, 429, {
          error: { message: "Too many sign-in attempts. Try again in five minutes." },
        });
        return true;
      }
      if (!getPasskeyOrigin(request)) {
        sendJson(response, 403, { error: { message: "Origin not allowed." } });
        return true;
      }
      if (!isJsonRequest(request)) {
        sendJson(response, 415, {
          error: { message: "Content-Type must be application/json." },
        });
        return true;
      }
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, errorResponseStatus(error), {
          error: { message: error.message },
        });
        return true;
      }
      const ceremonyId = body?.challengeId;
      const credentialId = body?.response?.id;
      const ceremony =
        typeof ceremonyId === "string"
          ? authenticationChallenges.get(ceremonyId)
          : null;
      if (typeof ceremonyId === "string") {
        authenticationChallenges.delete(ceremonyId);
      }
      if (
        !passkeyStore ||
        !ceremony ||
        ceremony.expiresAt <= now ||
        !/^[A-Za-z0-9_-]{1,1024}$/.test(credentialId ?? "")
      ) {
        recordLoginFailure(failedLogins, remoteAddress, now);
        sendJson(response, 401, {
          error: { message: "Passkey sign-in could not be verified." },
        });
        return true;
      }

      let credential;
      try {
        credential = await passkeyStore.getCredential(credentialId);
      } catch {
        sendJson(response, 503, {
          error: { message: "Passkey sign-in is temporarily unavailable." },
        });
        return true;
      }
      if (!credential) {
        recordLoginFailure(failedLogins, remoteAddress, now);
        sendJson(response, 401, {
          error: { message: "Passkey sign-in could not be verified." },
        });
        return true;
      }

      let verification;
      try {
        verification = await webauthn.verifyAuthenticationResponse({
          response: body.response,
          expectedChallenge: ceremony.challenge,
          expectedOrigin: ceremony.expectedOrigin,
          expectedRPID: ceremony.rpID,
          requireUserVerification: true,
          credential: {
            id: credential.id,
            publicKey: credential.publicKey,
            counter: credential.counter,
            transports: credential.transports,
          },
        });
      } catch {
        verification = null;
      }
      const authenticationInfo = verification?.authenticationInfo;
      if (
        !verification?.verified ||
        authenticationInfo?.userVerified !== true ||
        authenticationInfo.credentialID !== credential.id ||
        !Number.isSafeInteger(authenticationInfo.newCounter) ||
        authenticationInfo.newCounter < 0
      ) {
        recordLoginFailure(failedLogins, remoteAddress, now);
        sendJson(response, 401, {
          error: { message: "Passkey sign-in could not be verified." },
        });
        return true;
      }

      try {
        await passkeyStore.updateCounter(
          credential.id,
          authenticationInfo.newCounter,
        );
      } catch {
        sendJson(response, 503, {
          error: { message: "Passkey sign-in is temporarily unavailable." },
        });
        return true;
      }
      establishSession(response, remoteAddress);
      sendJson(response, 200, { authenticated: true });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/admin/api/session") {
      if (!isSameOrigin(request)) {
        sendJson(response, 403, { error: { message: "Origin not allowed." } });
        return true;
      }
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
        sendJson(response, 415, {
          error: { message: "Content-Type must be application/json." },
        });
        return true;
      }

      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, errorResponseStatus(error), { error: { message: error.message } });
        return true;
      }

      const remoteAddress = request.socket.remoteAddress ?? "unknown";
      const now = Date.now();
      if (isLoginBlocked(failedLogins, remoteAddress, now)) {
        sendJson(response, 429, {
          error: { message: "Too many sign-in attempts. Try again in five minutes." },
        });
        return true;
      }
      if (!body || Array.isArray(body) || !constantTimeTokenMatch(body.token, adminToken)) {
        recordLoginFailure(failedLogins, remoteAddress, now);
        sendJson(response, 401, { error: { message: "Invalid admin token." } });
        return true;
      }

      establishSession(response, remoteAddress);
      sendJson(response, 200, { authenticated: true });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/admin/api/session/logout") {
      if (!isSameOrigin(request)) {
        sendJson(response, 403, { error: { message: "Origin not allowed." } });
        return true;
      }
      sessions.delete(getCookie(request));
      clearSessionCookie(response, secureCookies);
      sendJson(response, 200, { authenticated: false });
      return true;
    }

    if (!isAuthenticated(request, sessions)) {
      sendJson(response, 401, { error: { message: "Admin authentication required." } });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/admin/api/passkeys") {
      if (!passkeyStore) {
        sendJson(response, 503, {
          error: { message: "Passkey storage is not configured on this Router IA service." },
        });
        return true;
      }
      try {
        const credentials = await passkeyStore.listCredentials();
        sendJson(response, 200, {
          credentials: credentials.map((credential) => ({
            id: credential.id,
            name: credential.name,
            createdAt: credential.createdAt,
          })),
        });
      } catch {
        sendJson(response, 502, {
          error: { message: "Passkeys could not be loaded." },
        });
      }
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/admin/api/passkeys/register/options"
    ) {
      const origin = getPasskeyOrigin(request);
      if (!origin) {
        sendJson(response, 403, { error: { message: "Origin not allowed." } });
        return true;
      }
      if (!isJsonRequest(request)) {
        sendJson(response, 415, {
          error: { message: "Content-Type must be application/json." },
        });
        return true;
      }
      try {
        await readJsonBody(request);
      } catch (error) {
        sendJson(response, errorResponseStatus(error), {
          error: { message: error.message },
        });
        return true;
      }
      if (!passkeyStore) {
        sendJson(response, 503, {
          error: { message: "Passkey storage is not configured." },
        });
        return true;
      }

      try {
        const credentials = await passkeyStore.listCredentials();
        const options = await webauthn.generateRegistrationOptions({
          rpName: "Router IA",
          rpID: origin.rpID,
          userID: Buffer.from("router-ia-admin"),
          userName: "admin",
          userDisplayName: "Router IA Admin",
          attestationType: "none",
          excludeCredentials: credentials.map((credential) => ({
            id: credential.id,
            transports: credential.transports,
          })),
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            residentKey: "preferred",
            userVerification: "required",
          },
          timeout: 60_000,
        });
        const challengeId = createCeremony(registrationChallenges, {
          challenge: options.challenge,
          expectedOrigin: origin.expectedOrigin,
          rpID: origin.rpID,
          sessionToken: getCookie(request),
        });
        sendJson(response, 200, { challengeId, options });
      } catch {
        sendJson(response, 503, {
          error: { message: "Passkey setup could not be started." },
        });
      }
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/admin/api/passkeys/register/verify"
    ) {
      if (!getPasskeyOrigin(request)) {
        sendJson(response, 403, { error: { message: "Origin not allowed." } });
        return true;
      }
      if (!isJsonRequest(request)) {
        sendJson(response, 415, {
          error: { message: "Content-Type must be application/json." },
        });
        return true;
      }
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, errorResponseStatus(error), {
          error: { message: error.message },
        });
        return true;
      }
      const ceremonyId = body?.challengeId;
      const ceremony =
        typeof ceremonyId === "string"
          ? registrationChallenges.get(ceremonyId)
          : null;
      if (typeof ceremonyId === "string") {
        registrationChallenges.delete(ceremonyId);
      }
      if (
        !passkeyStore ||
        !ceremony ||
        ceremony.expiresAt <= Date.now() ||
        ceremony.sessionToken !== getCookie(request)
      ) {
        sendJson(response, 400, {
          error: { message: "Passkey setup expired. Please try again." },
        });
        return true;
      }
      if (!body.response || typeof body.response !== "object") {
        sendJson(response, 400, {
          error: { message: "Passkey setup response is invalid." },
        });
        return true;
      }
      const name =
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : "Dispositivo";
      if (name.length > 80) {
        sendJson(response, 400, {
          error: { message: "Passkey name must be 80 characters or fewer." },
        });
        return true;
      }

      let verification;
      try {
        verification = await webauthn.verifyRegistrationResponse({
          response: body.response,
          expectedChallenge: ceremony.challenge,
          expectedOrigin: ceremony.expectedOrigin,
          expectedRPID: ceremony.rpID,
          requireUserVerification: true,
        });
      } catch {
        verification = null;
      }
      const credential = verification?.registrationInfo?.credential;
      if (
        !verification?.verified ||
        !credential?.id ||
        !(credential.publicKey instanceof Uint8Array) ||
        !Number.isSafeInteger(credential.counter) ||
        credential.counter < 0
      ) {
        sendJson(response, 422, {
          error: { message: "The device could not verify passkey registration." },
        });
        return true;
      }

      try {
        const existing = await passkeyStore.getCredential(credential.id);
        if (existing) {
          sendJson(response, 409, {
            error: { message: "This passkey is already registered." },
          });
          return true;
        }
        await passkeyStore.addCredential({
          id: credential.id,
          publicKey: credential.publicKey,
          counter: credential.counter,
          transports: credential.transports ?? [],
          name,
        });
        sendJson(response, 201, { registered: true });
      } catch {
        sendJson(response, 502, {
          error: { message: "The passkey could not be saved." },
        });
      }
      return true;
    }

    const deletePasskeyPrefix = "/admin/api/passkeys/";
    if (
      request.method === "DELETE" &&
      url.pathname.startsWith(deletePasskeyPrefix)
    ) {
      if (!getPasskeyOrigin(request)) {
        sendJson(response, 403, { error: { message: "Origin not allowed." } });
        return true;
      }
      const credentialId = url.pathname.slice(deletePasskeyPrefix.length);
      if (!/^[A-Za-z0-9_-]{1,1024}$/.test(credentialId)) {
        sendJson(response, 400, {
          error: { message: "Passkey identifier is invalid." },
        });
        return true;
      }
      if (!passkeyStore) {
        sendJson(response, 503, {
          error: { message: "Passkey storage is not configured." },
        });
        return true;
      }
      try {
        await passkeyStore.deleteCredential(credentialId);
        sendJson(response, 200, { deleted: true });
      } catch {
        sendJson(response, 502, {
          error: { message: "The passkey could not be deleted." },
        });
      }
      return true;
    }

    if (request.method === "GET" && url.pathname === "/admin/api/providers") {
      if (!providerStore) {
        sendJson(response, 503, {
          error: { message: "Provider storage is not configured on this Router IA service." },
        });
        return true;
      }
      try {
        const providers = await providerStore.listProviders();
        sendJson(response, 200, {
          providers,
          routes: buildCapabilityRoutes(providers),
        });
      } catch (error) {
        const statusCode = Number.isInteger(error?.statusCode)
          ? error.statusCode
          : null;
        console.error(
          `Router IA provider list failed${statusCode ? ` (storage HTTP ${statusCode})` : ""}.`,
        );
        sendJson(response, 502, {
          error: {
            message:
              statusCode === 401 || statusCode === 403
                ? "Supabase rechazó la clave de servicio configurada en Router IA."
                : "No se pudo cargar la configuración de proveedores.",
          },
        });
      }
      return true;
    }

    const isDiscover =
      request.method === "POST" &&
      url.pathname === "/admin/api/providers/discover-models";
    const isAddFreeModels =
      request.method === "POST" &&
      url.pathname === "/admin/api/providers/add-free-models";
    const isCreate = request.method === "POST" && url.pathname === "/admin/api/providers";
    if (isDiscover || isAddFreeModels || isCreate) {
      if (!isSameOrigin(request)) {
        sendJson(response, 403, { error: { message: "Origin not allowed." } });
        return true;
      }
      if (!providerStore) {
        sendJson(response, 503, {
          error: { message: "Provider storage is not configured on this Router IA service." },
        });
        return true;
      }
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
        sendJson(response, 415, {
          error: { message: "Content-Type must be application/json." },
        });
        return true;
      }

      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, errorResponseStatus(error), { error: { message: error.message } });
        return true;
      }

      let provider;
      try {
        provider = normalizeProviderInput(body);
      } catch (error) {
        sendJson(response, 400, { error: { message: error.message } });
        return true;
      }

      if (isDiscover) {
        const result = await discoverModels({ ...provider, fetchImpl });
        if (!result.ok) {
          const message =
            result.reason === "unauthorized"
              ? "The provider rejected this API key."
              : result.reason === "unreachable"
                ? "The provider could not be reached."
                : result.reason === "too_many_models"
                  ? "The provider returned too many models to process safely."
                  : "The provider model list could not be read.";
          sendJson(response, result.reason === "unauthorized" ? 422 : 502, {
            error: { code: result.reason, message },
          });
        } else {
          sendJson(response, 200, { models: result.models });
        }
        return true;
      }

      if (isAddFreeModels) {
        const result = await discoverModels({ ...provider, fetchImpl });
        if (!result.ok) {
          const message =
            result.reason === "unauthorized"
              ? "El proveedor rechazó esta API key."
              : result.reason === "unreachable"
                ? "No se pudo conectar con el proveedor."
                : result.reason === "too_many_models"
                  ? "El proveedor devolvió demasiados modelos para procesarlos de forma segura."
                  : "No se pudo leer el catálogo del proveedor.";
          sendJson(response, result.reason === "unauthorized" ? 422 : 502, {
            error: { code: result.reason, message },
          });
          return true;
        }

        const groqFreePlan = isGroqFreePlanBaseUrl(provider.baseUrl);
        const nvidiaApiCatalog = isNvidiaApiCatalogBaseUrl(provider.baseUrl);
        const isListedGroqFreeModel = (model) =>
          isGroqFreePlanModel(model, provider.baseUrl);
        const freeModels = result.models.filter(
          (model) =>
            isExplicitlyFreeModel(model) ||
            isListedGroqFreeModel(model) ||
            nvidiaApiCatalog,
        );
        const groqFreePlanMatchedCount = result.models.filter(isListedGroqFreeModel).length;
        const nvidiaApiCatalogMatchedCount = nvidiaApiCatalog ? result.models.length : 0;
        const existingProviders = await providerStore.listProviders();
        const existingModels = new Set(
          existingProviders.map(
            (entry) => `${entry.provider}\u0000${entry.baseUrl}\u0000${entry.model}`,
          ),
        );
        const modelsToAdd = freeModels.filter(
          (model) =>
            !existingModels.has(`${provider.provider}\u0000${provider.baseUrl}\u0000${model.id}`),
        );
        const groqFreePlanAddedCount = modelsToAdd.filter(isListedGroqFreeModel).length;
        const nvidiaApiCatalogAddedCount = nvidiaApiCatalog ? modelsToAdd.length : 0;
        const toSave = modelsToAdd.map((model) => ({
          ...provider,
          model: model.id,
          capabilities: inferModelCapabilities(model),
          priority: 50,
          modelMetadata: isListedGroqFreeModel(model)
            ? { ...model, freePlanAccess: "groq_free_plan" }
            : nvidiaApiCatalog
              ? { ...model, freePlanAccess: "nvidia_api_catalog_prototyping" }
            : model,
        }));

        const saved = toSave.length > 0 ? await providerStore.addProviders(toSave) : [];
        const unknownPricingCount = result.models.filter(
          (model) =>
            !model.pricing ||
            !Object.hasOwn(model.pricing, "prompt") ||
            !Object.hasOwn(model.pricing, "completion"),
        ).length;
        const unconfirmedModelsCount = result.models.filter(
          (model) =>
            !isExplicitlyFreeModel(model) &&
            !(groqFreePlan && isListedGroqFreeModel(model)) &&
            !nvidiaApiCatalog,
        ).length;

        sendJson(response, saved.length > 0 ? 201 : 200, {
          providers: saved,
          modelsFound: result.models.length,
          freeModelsFound: freeModels.length,
          addedCount: saved.length,
          alreadyConfiguredCount: freeModels.length - modelsToAdd.length,
          unknownPricingCount,
          freePlanPolicy: nvidiaApiCatalog
            ? "nvidia_api_catalog_prototyping"
            : groqFreePlan
              ? "groq_free_plan"
              : "explicit_zero_price",
          groqFreePlanMatchedCount,
          groqFreePlanAddedCount,
          nvidiaApiCatalogMatchedCount,
          nvidiaApiCatalogAddedCount,
          unconfirmedModelsCount,
        });
        return true;
      }

      if (!provider.model) {
        sendJson(response, 400, {
          error: { message: "Choose a model before saving the provider." },
        });
        return true;
      }
      if (provider.capabilities.length === 0) {
        sendJson(response, 400, {
          error: { message: "Choose at least one declared capability before saving." },
        });
        return true;
      }
      try {
        const saved = await providerStore.addProvider(provider);
        sendJson(response, 201, { provider: saved });
      } catch {
        sendJson(response, 502, { error: { message: "The provider could not be saved." } });
      }
      return true;
    }

    const activateMatch = /^\/admin\/api\/providers\/([0-9a-f-]+)\/activate$/i.exec(
      url.pathname,
    );
    if (request.method === "POST" && activateMatch) {
      if (!isSameOrigin(request)) {
        sendJson(response, 403, { error: { message: "Origin not allowed." } });
        return true;
      }
      if (!providerStore) {
        sendJson(response, 503, {
          error: { message: "Provider storage is not configured on this Router IA service." },
        });
        return true;
      }
      if (!isUuid(activateMatch[1])) {
        sendJson(response, 400, { error: { message: "Invalid provider ID." } });
        return true;
      }
      try {
        await providerStore.activateProvider(activateMatch[1]);
        sendNoContent(response);
      } catch {
        sendJson(response, 502, { error: { message: "The provider could not be activated." } });
      }
      return true;
    }

    const deactivateMatch = /^\/admin\/api\/providers\/([0-9a-f-]+)\/deactivate$/i.exec(
      url.pathname,
    );
    if (request.method === "POST" && deactivateMatch) {
      if (!isSameOrigin(request)) {
        sendJson(response, 403, { error: { message: "Origin not allowed." } });
        return true;
      }
      if (!providerStore) {
        sendJson(response, 503, {
          error: { message: "Provider storage is not configured on this Router IA service." },
        });
        return true;
      }
      if (!isUuid(deactivateMatch[1])) {
        sendJson(response, 400, { error: { message: "Invalid provider ID." } });
        return true;
      }
      try {
        await providerStore.deactivateProvider(deactivateMatch[1]);
        sendNoContent(response);
      } catch {
        sendJson(response, 502, { error: { message: "The provider could not be deactivated." } });
      }
      return true;
    }

    const deleteMatch = /^\/admin\/api\/providers\/([0-9a-f-]+)$/i.exec(url.pathname);
    if (request.method === "DELETE" && deleteMatch) {
      if (!isSameOrigin(request)) {
        sendJson(response, 403, { error: { message: "Origin not allowed." } });
        return true;
      }
      if (!providerStore) {
        sendJson(response, 503, {
          error: { message: "Provider storage is not configured on this Router IA service." },
        });
        return true;
      }
      if (!isUuid(deleteMatch[1])) {
        sendJson(response, 400, { error: { message: "Invalid provider ID." } });
        return true;
      }
      try {
        await providerStore.deleteProvider(deleteMatch[1]);
        sendNoContent(response);
      } catch {
        sendJson(response, 502, { error: { message: "The provider could not be deleted." } });
      }
      return true;
    }

    sendJson(response, 404, { error: { message: "Not found." } });
    return true;
  };
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}