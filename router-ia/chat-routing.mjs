import {
  recordProviderFailure,
  recordProviderSuccess,
  sortByCapabilityPriority,
} from "./conservation-policy.mjs";

function hasImageContent(messages) {
  return messages.some((message) => {
    if (!Array.isArray(message?.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return ["image_url", "input_image", "image"].includes(part.type);
    });
  });
}

function isGenericGenerativeModel(provider) {
  const identity = `${provider?.model ?? ""} ${provider?.name ?? ""}`.toLowerCase();
  return !/(?:prompt[-_ ]?guard|safeguard|content[-_ ]?safety|moderation|\bsafety\b|\bguard\b)/i.test(identity);
}

function supportsCapability(provider, capability) {
  const verification = provider?.modelMetadata?.capabilityVerification?.checks?.[capability]?.status;
  return (
    provider?.active === true &&
    isGenericGenerativeModel(provider) &&
    !["unsupported", "blocked", "retired"].includes(verification) &&
    Array.isArray(provider.capabilities) &&
    provider.capabilities.includes(capability) &&
    typeof provider.model === "string" &&
    provider.model.length > 0 &&
    typeof provider.apiKey === "string" &&
    provider.apiKey.length > 0 &&
    typeof provider.baseUrl === "string" &&
    provider.baseUrl.startsWith("https://")
  );
}

const ROUTABLE_TEXT_CAPABILITIES = new Set(["chat", "coding", "reasoning", "document", "long_context"]);

export function getChatCapability(messages, requestedCapability = "") {
  if (hasImageContent(messages)) return "vision";
  return ROUTABLE_TEXT_CAPABILITIES.has(requestedCapability) ? requestedCapability : "chat";
}

export function getChatCandidates(providers, { messages, requestedModel, requestedCapability = "" }) {
  const capability = getChatCapability(messages, requestedCapability);
  const eligible = providers.filter((provider) => supportsCapability(provider, capability));

  const ranked = sortByCapabilityPriority(eligible, capability);

  if (requestedModel && requestedModel !== "router-ia-auto") {
    const explicit = ranked.find((provider) => provider.model === requestedModel);
    if (!explicit) return { capability, candidates: [] };
    return {
      capability,
      candidates: [explicit, ...ranked.filter((provider) => provider !== explicit)],
    };
  }

  return { capability, candidates: ranked };
}

function classifyFailure(responseStatus) {
  if (responseStatus === 429) return { transient: true, kind: "quota", status: 429, code: "provider_quota_exceeded" };
  if (responseStatus === 402) return { transient: true, kind: "payment", status: 402, code: "provider_quota_exceeded" };
  if (responseStatus === 408) return { transient: true, kind: "timeout", status: 504, code: "provider_timeout" };
  if (responseStatus >= 500) return { transient: true, kind: "server", status: 502, code: "provider_error" };
  if (responseStatus === 401 || responseStatus === 403) return { transient: true, kind: "rejected", status: 502, code: "provider_request_rejected" };
  return { transient: false, kind: null, status: responseStatus, code: "provider_request_rejected" };
}

function hasToolRequest(upstreamBody) {
  return Array.isArray(upstreamBody?.tools) && upstreamBody.tools.length > 0;
}

function plainChatToolMismatch(responseStatus, diagnostic, toolRequest) {
  return (
    !toolRequest &&
    responseStatus === 400 &&
    /tool choice is none|model called a tool|tool_use_failed/i.test(diagnostic)
  );
}

function shouldTryNextProvider({ failure, responseStatus }) {
  if (failure.transient) return true;
  return [400, 404, 405, 409, 413, 415, 422].includes(responseStatus);
}

function usableCompletionPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) return false;
  return payload.choices.some((choice) => {
    const message = choice?.message;
    if (!message || typeof message !== "object") return false;
    if (typeof message.content === "string" && message.content.trim()) return true;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
    if (message.function_call && typeof message.function_call === "object") return true;
    if (typeof message.refusal === "string" && message.refusal.trim()) return true;
    return false;
  });
}

async function validateSuccessfulResponse(response) {
  let text = "";
  try {
    text = await response.text();
    const payload = JSON.parse(text);
    if (!usableCompletionPayload(payload)) {
      return { ok: false, diagnostic: "Provider returned HTTP 200 without a usable completion." };
    }
    return {
      ok: true,
      response: new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    };
  } catch {
    return { ok: false, diagnostic: "Provider returned HTTP 200 with invalid JSON." };
  }
}

function sanitizeDiagnostic(text) {
  return String(text ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

function providerChatUrl(provider) {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const identity = `${provider?.name ?? ""} ${provider?.provider ?? ""}`.toLowerCase();
  if (identity.includes("cloudflare")) return `${base}/v1/chat/completions`;
  return `${base}/chat/completions`;
}

export async function requestChatWithFallback({
  providers,
  messages,
  requestedModel,
  requestedCapability = "",
  upstreamBody,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
}) {
  const { capability, candidates } = getChatCandidates(providers, { messages, requestedModel, requestedCapability });
  const toolRequest = hasToolRequest(upstreamBody);

  if (!candidates.length) {
    return {
      ok: false,
      status: 404,
      code: "model_unavailable",
      capability,
      message:
        requestedModel && requestedModel !== "router-ia-auto"
          ? `The requested model is not available for ${capability}.`
          : `No active model is available for ${capability}.`,
    };
  }

  let lastFailure = null;
  for (const provider of candidates) {
    let response;
    try {
      response = await fetchImpl(providerChatUrl(provider), {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${provider.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...upstreamBody, model: provider.model }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
      recordProviderFailure(provider, timeout ? "timeout" : "unreachable");
      console.warn("ROUTER_PROVIDER_ATTEMPT_FAILED", {
        provider: provider?.name ?? provider?.provider ?? "unknown",
        model: provider?.model ?? "unknown",
        capability,
        toolRequest,
        kind: timeout ? "timeout" : "unreachable",
      });
      lastFailure = { status: timeout ? 504 : 502, code: timeout ? "provider_timeout" : "provider_unreachable" };
      continue;
    }

    if (!response.ok) {
      const responseStatus = response.status;
      const failure = classifyFailure(responseStatus);
      const diagnostic = sanitizeDiagnostic(await response.text().catch(() => ""));
      if (failure.kind) recordProviderFailure(provider, failure.kind);
      lastFailure = { status: failure.status, code: failure.code };

      console.warn("ROUTER_PROVIDER_ATTEMPT_FAILED", {
        provider: provider?.name ?? provider?.provider ?? "unknown",
        model: provider?.model ?? "unknown",
        capability,
        toolRequest,
        status: responseStatus,
        diagnostic,
      });

      if (!shouldTryNextProvider({ failure, responseStatus })) break;
      continue;
    }

    const validated = await validateSuccessfulResponse(response);
    if (!validated.ok) {
      recordProviderFailure(provider, "invalid");
      lastFailure = { status: 502, code: "invalid_provider_response" };
      console.warn("ROUTER_PROVIDER_ATTEMPT_FAILED", {
        provider: provider?.name ?? provider?.provider ?? "unknown",
        model: provider?.model ?? "unknown",
        capability,
        toolRequest,
        status: 200,
        diagnostic: validated.diagnostic,
      });
      continue;
    }

    recordProviderSuccess(provider);
    return { ok: true, response: validated.response, provider, capability };
  }

  return {
    ok: false,
    status: lastFailure?.status ?? 502,
    code: lastFailure?.code ?? "provider_error",
    capability,
    message: `All available ${capability} providers failed.`,
  };
}
