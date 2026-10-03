import { timingSafeEqual } from "node:crypto";
import {
  isExplicitlyFreeModel,
  isGroqFreePlanModel,
  isNvidiaApiCatalogBaseUrl,
  normalizeCustomBaseUrl,
} from "./provider-adapter.mjs";

const MAX_JSON_BODY_BYTES = 1_048_576;
const MAX_MULTIPART_BODY_BYTES = 26_214_400;
const MAX_JSON_RESPONSE_BYTES = 10_000_000;
const MAX_BINARY_RESPONSE_BYTES = 26_214_400;
const GROQ_FREE_PLAN_METADATA = "groq_free_plan";
const NVIDIA_COMPLETION_METADATA = "nvidia_api_catalog_prototyping";

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

function sendApiError(response, statusCode, code, message) {
  return sendJson(response, statusCode, { error: { code, message } });
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

function getEligibleProviders(activeProviders, capability) {
  return activeProviders
    .filter(
      (candidate) =>
        candidate?.active === true &&
        typeof candidate.model === "string" &&
        candidate.model.length > 0 &&
        candidate.model.trim() === candidate.model &&
        Array.isArray(candidate.capabilities) &&
        candidate.capabilities.includes(capability) &&
        typeof candidate.apiKey === "string" &&
        candidate.apiKey.length > 0 &&
        hasExplicitFreeEligibility(candidate) &&
        isSafeProviderBaseUrl(candidate.baseUrl),
    )
    .sort(
      (first, second) =>
        (Number(second.priority) || 0) - (Number(first.priority) || 0),
    );
}

async function readBoundedBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("The request is too large.");
      error.statusCode = 413;
      error.code = "request_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(request) {
  const buffer = await readBoundedBody(request, MAX_JSON_BODY_BYTES);
  try {
    const value = JSON.parse(buffer.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    const error = new Error("The request body must be a JSON object.");
    error.statusCode = 400;
    error.code = "invalid_json";
    throw error;
  }
}

async function readMultipartForm(request) {
  const contentType = request.headers["content-type"] ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    const error = new Error("Content-Type must be multipart/form-data.");
    error.statusCode = 415;
    error.code = "unsupported_media_type";
    throw error;
  }
  const buffer = await readBoundedBody(request, MAX_MULTIPART_BODY_BYTES);
  try {
    const parsed = new Request("http://router.local/upload", {
      method: "POST",
      headers: { "content-type": contentType },
      body: buffer,
    });
    return await parsed.formData();
  } catch {
    const error = new Error("The multipart request could not be parsed.");
    error.statusCode = 400;
    error.code = "invalid_multipart";
    throw error;
  }
}

async function readBoundedBuffer(upstream, maxBytes) {
  if (!upstream.body) return Buffer.alloc(0);
  const reader = upstream.body.getReader();
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
  return Buffer.concat(chunks);
}

function selectCandidates(providers, requestedModel) {
  if (requestedModel && requestedModel !== "router-ia-auto") {
    const exact = providers.find((candidate) => candidate.model === requestedModel);
    return exact ? [exact] : [];
  }
  return providers;
}

async function loadCandidates(providerStore, capability, requestedModel) {
  if (!providerStore || typeof providerStore.getActiveProviders !== "function") {
    const error = new Error("Provider storage is not configured.");
    error.statusCode = 503;
    error.code = "provider_storage_unavailable";
    throw error;
  }
  let activeProviders;
  try {
    activeProviders = await providerStore.getActiveProviders();
  } catch {
    const error = new Error("Saved providers could not be loaded.");
    error.statusCode = 503;
    error.code = "provider_storage_unavailable";
    throw error;
  }
  const eligible = getEligibleProviders(Array.isArray(activeProviders) ? activeProviders : [], capability);
  const candidates = selectCandidates(eligible, requestedModel);
  if (!candidates.length) {
    const error = new Error(`No active, eligible ${capability} model is configured in Router IA.`);
    error.statusCode = 404;
    error.code = "model_unavailable";
    throw error;
  }
  return candidates;
}

function shouldTryNext(status) {
  return status === 401 || status === 403 || status === 408 || status === 409 || status === 429 || status >= 500;
}

async function callWithFallback(candidates, makeRequest, fetchImpl) {
  let lastError = null;
  for (const provider of candidates) {
    try {
      const request = makeRequest(provider);
      const upstream = await fetchImpl(request.url, request.options);
      if (upstream.ok) return { upstream, provider };
      const status = upstream.status;
      await upstream.body?.cancel().catch(() => {});
      lastError = { status };
      if (!shouldTryNext(status) || candidates.length === 1) break;
    } catch (error) {
      lastError = { error };
      if (candidates.length === 1) break;
    }
  }

  if (lastError?.status === 429 || lastError?.status === 402) {
    const error = new Error("Every eligible provider is currently rate-limited or out of quota.");
    error.statusCode = lastError.status;
    error.code = "provider_quota_exceeded";
    throw error;
  }
  const timedOut = lastError?.error?.name === "TimeoutError" || lastError?.error?.name === "AbortError";
  const error = new Error("No eligible provider completed the request.");
  error.statusCode = timedOut ? 504 : 502;
  error.code = timedOut ? "provider_timeout" : "provider_unavailable";
  throw error;
}

function copyFormData(source, providerModel) {
  const target = new FormData();
  for (const [key, value] of source.entries()) {
    if (key === "model") continue;
    target.append(key, value);
  }
  target.set("model", providerModel);
  return target;
}

function requestedModelFrom(value) {
  const model = typeof value === "string" ? value.trim() : "";
  return model && model.length <= 200 ? model : "router-ia-auto";
}

export function createMultimodalHandler({ appToken, providerStore, fetchImpl = globalThis.fetch }) {
  return async function handleMultimodalRequest(request, response, url) {
    const routes = new Set([
      "/api/v1/audio/transcriptions",
      "/api/v1/audio/speech",
      "/api/v1/images/generations",
      "/api/v1/images/edits",
    ]);
    if (request.method !== "POST" || !routes.has(url.pathname)) return false;

    if (!appToken) {
      sendApiError(response, 503, "router_not_configured", "Router application token is not configured.");
      return true;
    }
    if (!hasValidAppToken(request, appToken)) {
      request.resume();
      sendApiError(response, 401, "unauthorized", "Unauthorized.");
      return true;
    }

    try {
      if (url.pathname === "/api/v1/audio/transcriptions") {
        const form = await readMultipartForm(request);
        const requestedModel = requestedModelFrom(form.get("model"));
        const candidates = await loadCandidates(providerStore, "transcription", requestedModel);
        const { upstream } = await callWithFallback(
          candidates,
          (provider) => {
            const body = copyFormData(form, provider.model);
            return {
              url: `${provider.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`,
              options: {
                method: "POST",
                headers: { authorization: `Bearer ${provider.apiKey}` },
                body,
                redirect: "error",
                signal: AbortSignal.timeout(60_000),
              },
            };
          },
          fetchImpl,
        );
        const body = await readBoundedBuffer(upstream, MAX_JSON_RESPONSE_BYTES);
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-length": body.length,
          "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        response.end(body);
        return true;
      }

      if (url.pathname === "/api/v1/audio/speech") {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          request.resume();
          sendApiError(response, 415, "unsupported_media_type", "Content-Type must be application/json.");
          return true;
        }
        const body = await readJsonBody(request);
        if (typeof body.input !== "string" || !body.input.trim() || body.input.length > 20_000) {
          sendApiError(response, 400, "invalid_input", "Provide speech input text.");
          return true;
        }
        const requestedModel = requestedModelFrom(body.model);
        const candidates = await loadCandidates(providerStore, "speech", requestedModel);
        const { upstream } = await callWithFallback(
          candidates,
          (provider) => ({
            url: `${provider.baseUrl.replace(/\/+$/, "")}/audio/speech`,
            options: {
              method: "POST",
              headers: {
                accept: "*/*",
                authorization: `Bearer ${provider.apiKey}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ ...body, model: provider.model }),
              redirect: "error",
              signal: AbortSignal.timeout(60_000),
            },
          }),
          fetchImpl,
        );
        const audio = await readBoundedBuffer(upstream, MAX_BINARY_RESPONSE_BYTES);
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-length": audio.length,
          "content-type": upstream.headers.get("content-type") ?? "audio/mpeg",
          "x-content-type-options": "nosniff",
        });
        response.end(audio);
        return true;
      }

      if (url.pathname === "/api/v1/images/generations") {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          request.resume();
          sendApiError(response, 415, "unsupported_media_type", "Content-Type must be application/json.");
          return true;
        }
        const body = await readJsonBody(request);
        if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 20_000) {
          sendApiError(response, 400, "invalid_prompt", "Provide an image prompt.");
          return true;
        }
        const requestedModel = requestedModelFrom(body.model);
        const candidates = await loadCandidates(providerStore, "image_generation", requestedModel);
        const { upstream } = await callWithFallback(
          candidates,
          (provider) => ({
            url: `${provider.baseUrl.replace(/\/+$/, "")}/images/generations`,
            options: {
              method: "POST",
              headers: {
                accept: "application/json",
                authorization: `Bearer ${provider.apiKey}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ ...body, model: provider.model }),
              redirect: "error",
              signal: AbortSignal.timeout(90_000),
            },
          }),
          fetchImpl,
        );
        const output = await readBoundedBuffer(upstream, MAX_JSON_RESPONSE_BYTES);
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-length": output.length,
          "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        response.end(output);
        return true;
      }

      const form = await readMultipartForm(request);
      const requestedModel = requestedModelFrom(form.get("model"));
      const candidates = await loadCandidates(providerStore, "image_editing", requestedModel);
      const { upstream } = await callWithFallback(
        candidates,
        (provider) => {
          const body = copyFormData(form, provider.model);
          return {
            url: `${provider.baseUrl.replace(/\/+$/, "")}/images/edits`,
            options: {
              method: "POST",
              headers: { authorization: `Bearer ${provider.apiKey}` },
              body,
              redirect: "error",
              signal: AbortSignal.timeout(90_000),
            },
          };
        },
        fetchImpl,
      );
      const output = await readBoundedBuffer(upstream, MAX_JSON_RESPONSE_BYTES);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": output.length,
        "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end(output);
      return true;
    } catch (error) {
      sendApiError(
        response,
        Number.isInteger(error?.statusCode) ? error.statusCode : 502,
        error?.code ?? "multimodal_request_failed",
        error?.message ?? "The multimodal request failed.",
      );
      return true;
    }
  };
}
