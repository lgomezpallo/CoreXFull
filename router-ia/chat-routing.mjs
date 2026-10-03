function hasImageContent(messages) {
  return messages.some((message) => {
    if (!Array.isArray(message?.content)) return false;
    return message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      return ["image_url", "input_image", "image"].includes(part.type);
    });
  });
}

function sortByPriority(providers) {
  return [...providers].sort(
    (a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0),
  );
}

function supportsCapability(provider, capability) {
  return (
    provider?.active === true &&
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
  const eligible = sortByPriority(
    providers.filter((provider) => supportsCapability(provider, capability)),
  );

  if (requestedModel && requestedModel !== "router-ia-auto") {
    const explicit = eligible.find((provider) => provider.model === requestedModel);
    return { capability, candidates: explicit ? [explicit] : [] };
  }

  return { capability, candidates: eligible };
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
      lastFailure = {
        status: error?.name === "TimeoutError" || error?.name === "AbortError" ? 504 : 502,
        code:
          error?.name === "TimeoutError" || error?.name === "AbortError"
            ? "provider_timeout"
            : "provider_unreachable",
      };
      if (requestedModel && requestedModel !== "router-ia-auto") break;
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      lastFailure = {
        status: response.status === 429 || response.status === 402 ? response.status : 502,
        code:
          response.status === 429 || response.status === 402
            ? "provider_quota_exceeded"
            : response.status === 401 || response.status === 403
              ? "provider_request_rejected"
              : "provider_error",
      };
      if (requestedModel && requestedModel !== "router-ia-auto") break;
      continue;
    }

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
