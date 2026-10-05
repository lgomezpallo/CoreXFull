import { timingSafeEqual } from "node:crypto";
import { requestChatWithFallback } from "./chat-routing.mjs";

const MAX_BODY_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_MAX_TOKENS = 512;
const MAX_TOKENS = 8_192;
const ROUTABLE_TEXT_CAPABILITIES = new Set(["chat", "coding", "reasoning", "document", "long_context"]);
const FORWARDED_FIELDS = [
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

function tokenMatches(request, expectedToken) {
  const authorization = request.headers.authorization;
  if (!expectedToken || typeof authorization !== "string") return false;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) return false;
  const supplied = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
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

async function readResponseJson(upstream) {
  const text = await upstream.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error("response_too_large");
  }
  return JSON.parse(text);
}

export function createSmartChatHandler({ appToken, providerStore, fetchImpl = globalThis.fetch }) {
  return async function handleSmartChat(request, response, url) {
    if (request.method !== "POST" || url.pathname !== "/api/v1/chat/completions") {
      return false;
    }

    if (!appToken) {
      sendJson(response, 503, { error: { code: "router_unconfigured", message: "Router application token is not configured." } });
      return true;
    }
    if (!tokenMatches(request, appToken)) {
      sendJson(response, 401, { error: { code: "unauthorized", message: "Unauthorized." } });
      return true;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
      request.resume();
      sendJson(response, 415, { error: { code: "unsupported_media_type", message: "Content-Type must be application/json." } });
      return true;
    }

    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      sendJson(response, Number.isInteger(error?.statusCode) ? error.statusCode : 400, {
        error: { code: error?.code ?? "invalid_request", message: error.message },
      });
      return true;
    }

    const requestedModel = typeof body?.model === "string" ? body.model.trim() : "";
    const requestedCapability =
      typeof body?.router_capability === "string" ? body.router_capability.trim() : "";
    if (
      !body || typeof body !== "object" || Array.isArray(body) ||
      (body.model !== undefined && (typeof body.model !== "string" || !requestedModel || requestedModel.length > 200)) ||
      (body.router_capability !== undefined &&
        (typeof body.router_capability !== "string" || !ROUTABLE_TEXT_CAPABILITIES.has(requestedCapability)))
    ) {
      sendJson(response, 400, { error: { code: "invalid_request", message: "Provide a valid completion request." } });
      return true;
    }

    if (
      !Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 100 ||
      body.messages.some((message) =>
        !message || typeof message !== "object" || Array.isArray(message) ||
        !["system", "developer", "user", "assistant", "tool", "function"].includes(message.role) ||
        !(typeof message.content === "string" || Array.isArray(message.content) || message.content === null)
      )
    ) {
      sendJson(response, 400, { error: { code: "invalid_messages", message: "Provide between 1 and 100 valid chat messages." } });
      return true;
    }
    if (body.stream !== undefined && body.stream !== false) {
      sendJson(response, 400, { error: { code: "streaming_unsupported", message: "Streaming responses are not supported yet." } });
      return true;
    }
    if (body.n !== undefined && body.n !== 1) {
      sendJson(response, 400, { error: { code: "multiple_choices_unsupported", message: "A single completion is allowed per request." } });
      return true;
    }

    const requestedMaxTokens = body.max_tokens ?? body.max_completion_tokens;
    if (requestedMaxTokens !== undefined && (!Number.isSafeInteger(requestedMaxTokens) || requestedMaxTokens < 1)) {
      sendJson(response, 400, { error: { code: "invalid_max_tokens", message: "max_tokens must be a positive integer." } });
      return true;
    }

    if (!providerStore || typeof providerStore.getActiveProviders !== "function") {
      sendJson(response, 503, { error: { code: "provider_storage_unavailable", message: "Provider storage is not configured." } });
      return true;
    }

    let providers;
    try {
      providers = await providerStore.getActiveProviders();
    } catch {
      sendJson(response, 503, { error: { code: "provider_storage_unavailable", message: "Saved providers could not be loaded." } });
      return true;
    }

    const upstreamBody = {
      messages: body.messages,
      max_tokens: Math.min(requestedMaxTokens ?? DEFAULT_MAX_TOKENS, MAX_TOKENS),
    };
    for (const field of FORWARDED_FIELDS) {
      if (Object.hasOwn(body, field)) upstreamBody[field] = body[field];
    }

    const routed = await requestChatWithFallback({
      providers: Array.isArray(providers) ? providers : [],
      messages: body.messages,
      requestedModel,
      requestedCapability,
      upstreamBody,
      fetchImpl,
    });

    if (!routed.ok) {
      sendJson(response, routed.status, { error: { code: routed.code, message: routed.message } });
      return true;
    }

    let completion;
    try {
      completion = await readResponseJson(routed.response);
    } catch {
      sendJson(response, 502, { error: { code: "invalid_provider_response", message: "The provider returned an invalid or oversized completion response." } });
      return true;
    }
    if (!completion || typeof completion !== "object" || Array.isArray(completion)) {
      sendJson(response, 502, { error: { code: "invalid_provider_response", message: "The provider returned an invalid completion response." } });
      return true;
    }

    sendJson(response, 200, {
      ...completion,
      model: "router-ia-auto",
      router: { capability: routed.capability },
    });
    return true;
  };
}
