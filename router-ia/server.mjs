import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAdminHandler } from "./admin-routes.mjs";
import { createSupabaseAdminPasskeyStore } from "./admin-passkey-store.mjs";
import { createSupabaseProviderStore } from "./provider-store.mjs";
import {
  isExplicitlyFreeModel,
  isGroqFreePlanModel,
  isNvidiaApiCatalogBaseUrl,
  normalizeCustomBaseUrl,
} from "./provider-adapter.mjs";

const MAX_COMPLETION_BODY_BYTES = 1_048_576;
const MAX_COMPLETION_RESPONSE_BYTES = 2_000_000;
const DEFAULT_MAX_COMPLETION_TOKENS = 512;
const MAX_COMPLETION_TOKENS = 8_192;
const GROQ_FREE_PLAN_METADATA = "groq_free_plan";
const NVIDIA_COMPLETION_METADATA = "nvidia_api_catalog_prototyping";

const FORWARDED_COMPLETION_FIELDS = [
  "temperature",
  "top_p",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "response_format",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "logit_bias",
  "user",
];

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendNoContent(response) {
  response.writeHead(204, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end();
}

function sendApiError(response, statusCode, code, message) {
  return sendJson(response, statusCode, { error: { code, message } });
}

async function readCompletionBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_COMPLETION_BODY_BYTES) {
      const error = new Error("The completion request is too large.");
      error.statusCode = 413;
      error.code = "request_too_large";
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("The completion request must be valid JSON.");
    error.statusCode = 400;
    error.code = "invalid_json";
    throw error;
  }
}

async function readBoundedResponseText(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        const error = new Error("The provider response is too large.");
        error.code = "response_too_large";
        throw error;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isSafeProviderBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string") return false;
  try {
    return normalizeCustomBaseUrl(baseUrl) === baseUrl.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

function hasExplicitFreeEligibility(provider) {
  const metadata = provider?.modelMetadata;
  if (
    metadata?.freePlanAccess === GROQ_FREE_PLAN_METADATA &&
    isGroqFreePlanModel({ id: provider.model }, provider.baseUrl)
  ) {
    return true;
  }
  if (
    metadata?.freePlanAccess === NVIDIA_COMPLETION_METADATA &&
    isNvidiaApiCatalogBaseUrl(provider.baseUrl)
  ) {
    return true;
  }
  return isExplicitlyFreeModel({ pricing: metadata?.pricing });
}

function getEligibleProviders(activeProviders) {
  return activeProviders
    .filter(
      (candidate) =>
        candidate?.active === true &&
        typeof candidate.model === "string" &&
        candidate.model.length > 0 &&
        candidate.model.trim() === candidate.model &&
        hasExplicitFreeEligibility(candidate) &&
        isSafeProviderBaseUrl(candidate.baseUrl),
    )
    .sort(
      (first, second) =>
        (Number(second.priority) || 0) - (Number(first.priority) || 0),
    );
}

function hasValidAppToken(request, expectedToken) {
  const authorization = request.headers.authorization;
  if (!expectedToken || typeof authorization !== "string") return false;

  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) return false;

  const supplied = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createRouterServer(overrides = {}) {
  const config = {
    appToken: process.env.ROUTER_APP_TOKEN?.trim() ?? "",
    adminToken: process.env.ROUTER_ADMIN_TOKEN?.trim() ?? "",
    fetchImpl: globalThis.fetch,
    providerStore: undefined,
    passkeyStore: undefined,
    webauthn: undefined,
    adminCookieSecure: process.env.NODE_ENV === "production",
    ...overrides,
  };

  config.appToken = typeof config.appToken === "string" ? config.appToken.trim() : "";
  config.adminToken = typeof config.adminToken === "string" ? config.adminToken.trim() : "";
  const supabaseConfig = {
    supabaseUrl: process.env.ROUTER_SUPABASE_URL?.trim() ?? "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "",
  };
  if (config.providerStore === undefined) {
    const storageConfig = {
      ...supabaseConfig,
      encryptionKey: process.env.ROUTER_PROVIDER_ENCRYPTION_KEY?.trim() ?? "",
    };
    const configuredCount = Object.values(storageConfig).filter(Boolean).length;
    if (configuredCount === Object.keys(storageConfig).length) {
      config.providerStore = createSupabaseProviderStore(storageConfig);
    } else {
      config.providerStore = null;
    }
  }
  if (config.passkeyStore === undefined) {
    config.passkeyStore =
      supabaseConfig.supabaseUrl && supabaseConfig.serviceRoleKey
        ? createSupabaseAdminPasskeyStore({
            ...supabaseConfig,
            fetchImpl: config.fetchImpl,
          })
        : null;
  }

  const adminHandler = createAdminHandler({
    adminToken: config.adminToken,
    providerStore: config.providerStore,
    passkeyStore: config.passkeyStore,
    webauthn: config.webauthn,
    fetchImpl: config.fetchImpl,
    secureCookies: config.adminCookieSecure,
  });

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://router.local");

    if (await adminHandler(request, response, url)) return;

    if (request.method === "GET" && url.pathname === "/health") {
      if (!config.appToken) {
        return sendJson(response, 503, {
          error: { message: "Router application token is not configured." },
        });
      }
      return sendJson(response, 200, { ok: true, service: "router-ia" });
    }

    if (request.method === "GET" && url.pathname === "/api/v1/auth/check") {
      if (!config.appToken) {
        return sendJson(response, 503, {
          error: { message: "Router application token is not configured." },
        });
      }
      if (!hasValidAppToken(request, config.appToken)) {
        return sendJson(response, 401, {
          error: { message: "Unauthorized." },
        });
      }
      return sendNoContent(response);
    }

    if (request.method === "POST" && url.pathname === "/api/v1/chat/completions") {
      if (!config.appToken) {
        return sendJson(response, 503, {
          error: { message: "Router application token is not configured." },
        });
      }
      if (!hasValidAppToken(request, config.appToken)) {
        return sendJson(response, 401, {
          error: { message: "Unauthorized." },
        });
      }
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
        request.resume();
        return sendApiError(
          response,
          415,
          "unsupported_media_type",
          "Content-Type must be application/json.",
        );
      }

      let body;
      try {
        body = await readCompletionBody(request);
      } catch (error) {
        return sendApiError(
          response,
          Number.isInteger(error?.statusCode) ? error.statusCode : 400,
          error?.code ?? "invalid_request",
          error.message,
        );
      }

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return sendApiError(
          response,
          400,
          "invalid_request",
          "The completion request must be a JSON object.",
        );
      }
      const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
      if (
        body.model !== undefined &&
        (typeof body.model !== "string" ||
          !requestedModel ||
          requestedModel.length > 200)
      ) {
        return sendApiError(
          response,
          400,
          "invalid_model",
          "Provide a valid model ID or use the Router IA automatic model.",
        );
      }
      if (
        !Array.isArray(body.messages) ||
        body.messages.length === 0 ||
        body.messages.length > 100 ||
        body.messages.some(
          (message) =>
            !message ||
            typeof message !== "object" ||
            Array.isArray(message) ||
            !["system", "developer", "user", "assistant", "tool", "function"].includes(
              message.role,
            ) ||
            !(
              typeof message.content === "string" ||
              Array.isArray(message.content) ||
              message.content === null
            ),
        )
      ) {
        return sendApiError(
          response,
          400,
          "invalid_messages",
          "Provide between 1 and 100 valid chat messages.",
        );
      }
      if (body.stream !== undefined && body.stream !== false) {
        return sendApiError(
          response,
          400,
          "streaming_unsupported",
          "Streaming responses are not supported by this Router IA endpoint.",
        );
      }
      if (body.n !== undefined && body.n !== 1) {
        return sendApiError(
          response,
          400,
          "multiple_choices_unsupported",
          "A single completion is allowed per request.",
        );
      }
      const requestedMaxTokens = body.max_tokens ?? body.max_completion_tokens;
      if (
        requestedMaxTokens !== undefined &&
        (!Number.isSafeInteger(requestedMaxTokens) || requestedMaxTokens < 1)
      ) {
        return sendApiError(
          response,
          400,
          "invalid_max_tokens",
          "max_tokens must be a positive integer.",
        );
      }
      const maxTokens = Math.min(
        requestedMaxTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
        MAX_COMPLETION_TOKENS,
      );

      if (!config.providerStore || typeof config.providerStore.getActiveProviders !== "function") {
        return sendApiError(
          response,
          503,
          "provider_storage_unavailable",
          "Provider storage is not configured.",
        );
      }

      let activeProviders;
      try {
        activeProviders = await config.providerStore.getActiveProviders();
      } catch {
        return sendApiError(
          response,
          503,
          "provider_storage_unavailable",
          "Saved providers could not be loaded.",
        );
      }
      if (!Array.isArray(activeProviders)) {
        return sendApiError(
          response,
          503,
          "provider_storage_unavailable",
          "Saved providers could not be loaded.",
        );
      }

      const eligibleProviders = getEligibleProviders(activeProviders);
      const provider = requestedModel === "router-ia-auto"
        ? eligibleProviders[0]
        : requestedModel
          ? eligibleProviders.find((candidate) => candidate.model === requestedModel)
          : eligibleProviders[0];
      if (!provider) {
        return sendApiError(
          response,
          404,
          "model_unavailable",
          requestedModel && requestedModel !== "router-ia-auto"
            ? "This model is not active in Router IA with explicitly free access."
            : "No active, eligible model is configured in Router IA.",
        );
      }
      if (typeof provider.apiKey !== "string" || !provider.apiKey) {
        return sendApiError(
          response,
          503,
          "provider_credentials_unavailable",
          "The saved provider credentials are unavailable.",
        );
      }

      const upstreamBody = {
        model: provider.model,
        messages: body.messages,
        max_tokens: maxTokens,
      };
      for (const field of FORWARDED_COMPLETION_FIELDS) {
        if (Object.hasOwn(body, field)) upstreamBody[field] = body[field];
      }
      // Groq GPT-OSS uses the same output budget for reasoning and final JSON.
      // Keep structured tasks concise so their usable response is not crowded out.
      if (provider.baseUrl === "https://api.groq.com/openai/v1" &&
          ["openai/gpt-oss-20b", "openai/gpt-oss-120b"].includes(provider.model) &&
          body.response_format?.type === "json_object") {
        upstreamBody.reasoning_effort = "low";
      }

      let upstream;
      try {
        upstream = await config.fetchImpl(
          `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`,
          {
            method: "POST",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${provider.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(upstreamBody),
            redirect: "error",
            signal: AbortSignal.timeout(30_000),
          },
        );
      } catch (error) {
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        return sendApiError(
          response,
          timedOut ? 504 : 502,
          timedOut ? "provider_timeout" : "provider_unreachable",
          "The provider did not complete the request. No other provider was tried.",
        );
      }

      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        if (upstream.status === 429 || upstream.status === 402) {
          return sendApiError(
            response,
            upstream.status,
            "provider_quota_exceeded",
            "The provider rejected the request because of a rate or usage limit. No other provider was tried.",
          );
        }
        return sendApiError(
          response,
          502,
          upstream.status === 401 || upstream.status === 403
            ? "provider_request_rejected"
            : "provider_error",
          "The provider did not accept the request. No other provider was tried.",
        );
      }

      let completion;
      try {
        const text = await readBoundedResponseText(
          upstream,
          MAX_COMPLETION_RESPONSE_BYTES,
        );
        completion = JSON.parse(text);
      } catch (error) {
        return sendApiError(
          response,
          502,
          error?.code ?? "invalid_provider_response",
          "The provider returned an invalid or oversized completion response.",
        );
      }
      if (!completion || typeof completion !== "object" || Array.isArray(completion)) {
        return sendApiError(
          response,
          502,
          "invalid_provider_response",
          "The provider returned an invalid or oversized completion response.",
        );
      }
      return sendJson(response, 200, { ...completion, model: "router-ia-auto" });
    }

    return sendJson(response, 404, {
      error: { message: "Not found." },
    });
  });
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const appToken = process.env.ROUTER_APP_TOKEN?.trim();
  if (!appToken) {
    console.error("Set ROUTER_APP_TOKEN before starting Router IA.");
    process.exitCode = 1;
  } else {
    const port = Number(process.env.PORT ?? 8080);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error("PORT must be a valid TCP port.");
      process.exitCode = 1;
    } else {
      const server = createRouterServer();
      server.listen(port, "0.0.0.0", () => {
        console.log(`Router IA listening on port ${port}.`);
      });

      const shutdown = () => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 8_000).unref();
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    }
  }
}
