import {
  recordProviderFailure,
  recordProviderSuccess,
  sortByConservation,
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

function supportsCapability(provider, capability) {
  const verification = provider?.modelMetadata?.capabilityVerification?.checks?.[capability]?.status;
  return (
    provider?.active === true &&
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

export function getChatCapability(messages) {
  return hasImageContent(messages) ? "vision" : "chat";
}

export function getChatCandidates(providers, { messages, requestedModel }) {
  const capability = getChatCapability(messages);
  const eligible = providers.filter((provider) => supportsCapability(provider, capability));

  if (requestedModel && requestedModel !== "router-ia-auto") {
    const explicit = eligible.find((provider) => provider.model === requestedModel);
    return { capability, candidates: explicit ? [explicit] : [] };
  }

  return { capability, candidates: sortByConservation(eligible, capability) };
}

function classifyFailure(responseStatus) {
  if (responseStatus === 429) return { transient: true, kind: "quota", status: 429, code: "provider_quota_exceeded" };
  if (responseStatus === 402) return { transient: true, kind: "payment", status: 402, code: "provider_quota_exceeded" };
  if (responseStatus === 408) return { transient: true, kind: "timeout", status: 504, code: "provider_timeout" };
  if (responseStatus >= 500) return { transient: true, kind: "server", status: 502, code: "provider_error" };
  if (responseStatus === 401 || responseStatus === 403) return { transient: true, kind: "rejected", status: 502, code: "provider_request_rejected" };
  return { transient: false, kind: null, status: responseStatus, code: "provider_request_rejected" };
}

export async function requestChatWithFallback({
  providers,
  messages,
  requestedModel,
  upstreamBody,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
}) {
  const { capability, candidates } = getChatCandidates(providers, {
    messages,
    requestedModel,
  });

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
      response = await fetchImpl(
        `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${provider.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ ...upstreamBody, model: provider.model }),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch (error) {
      const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
      recordProviderFailure(provider, timeout ? "timeout" : "unreachable");
      lastFailure = {
        status: timeout ? 504 : 502,
        code: timeout ? "provider_timeout" : "provider_unreachable",
      };
      if (requestedModel && requestedModel !== "router-ia-auto") break;
      continue;
    }

    if (!response.ok) {
      const failure = classifyFailure(response.status);
      await response.body?.cancel().catch(() => {});
      if (failure.kind) recordProviderFailure(provider, failure.kind);
      lastFailure = { status: failure.status, code: failure.code };

      if (requestedModel && requestedModel !== "router-ia-auto") break;
      if (!failure.transient) break;
      continue;
    }

    recordProviderSuccess(provider);
    return { ok: true, response, provider, capability };
  }

  return {
    ok: false,
    status: lastFailure?.status ?? 502,
    code: lastFailure?.code ?? "provider_error",
    capability,
    message:
      requestedModel && requestedModel !== "router-ia-auto"
        ? "The requested provider could not complete the request."
        : `All available ${capability} providers failed.`,
  };
}
