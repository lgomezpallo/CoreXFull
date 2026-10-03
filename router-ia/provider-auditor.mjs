const TINY_PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";

function isCloudflare(provider) {
  try {
    const url = new URL(provider.baseUrl);
    return url.origin === "https://api.cloudflare.com" && /\/client\/v4\/accounts\/[^/]+\/ai\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function likelyVision(model) {
  return /(vision|vlm|vila|neva|fuyu|kosmos|omni|gemma-3|gemma-4|llama-3\.2-(?:11b|90b)|llama-4|kimi|qwen3\.8|clef|glm-5\.3-flash)/i.test(model);
}
function likelyImage(model) {
  return /(flux|stable.?diffusion|sdxl|diffusion|image|imagen)/i.test(model);
}
function likelyTranscription(model) {
  return /(whisper|transcri|speech.?recogn|asr)/i.test(model);
}
function likelySpeech(model) {
  return /(orpheus|tts|text.?to.?speech|speech.?gener)/i.test(model);
}
function likelyNonChat(model) {
  return /(embed|rerank|clip|detector|parse|reward|guard|safety|translate)/i.test(model);
}

function statusFromResponse(response) {
  if (response.ok) return "verified";
  if ([408, 409, 429].includes(response.status) || response.status >= 500) return "inconclusive";
  if ([401, 403, 402].includes(response.status)) return "inconclusive";
  return "unsupported";
}

async function safeFetch(fetchImpl, url, options, timeout = 25000) {
  try {
    const response = await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(timeout) });
    const status = statusFromResponse(response);
    const contentType = response.headers.get("content-type") || "";
    let body = null;
    if (response.ok) {
      if (/application\/json/i.test(contentType)) {
        try { body = await response.json(); } catch { body = null; }
      } else {
        try { body = await response.arrayBuffer(); } catch { body = null; }
      }
    } else {
      await response.body?.cancel().catch(() => {});
    }
    return { status, httpStatus: response.status, contentType, body };
  } catch (error) {
    return { status: "inconclusive", error: error?.name || "network_error" };
  }
}

async function probeChat(provider, fetchImpl, withImage = false) {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const url = isCloudflare(provider) ? `${base}/v1/chat/completions` : `${base}/chat/completions`;
  const content = withImage
    ? [
        { type: "text", text: "What color is the single pixel? Answer briefly." },
        { type: "image_url", image_url: { url: TINY_PNG_DATA_URL } },
      ]
    : "Reply with OK.";
  return safeFetch(fetchImpl, url, {
    method: "POST",
    headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: provider.model, messages: [{ role: "user", content }], max_tokens: 12 }),
  });
}

function cloudflareImageResultLooksValid(result) {
  if (!result || result.status !== "verified") return false;
  if (/^image\//i.test(result.contentType)) return true;
  const payload = result.body;
  if (!payload || typeof payload !== "object") return false;
  const value = payload.result;
  if (typeof value === "string" && value.length > 100) return true;
  if (value && typeof value === "object" && typeof value.image === "string") return true;
  return false;
}

async function probeImageGeneration(provider, fetchImpl) {
  const base = provider.baseUrl.replace(/\/+$/, "");
  if (isCloudflare(provider)) {
    const result = await safeFetch(fetchImpl, `${base}/run/${provider.model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "A red circle on a white background" }),
    }, 45000);
    if (result.status === "verified" && !cloudflareImageResultLooksValid(result)) return { ...result, status: "unsupported" };
    return result;
  }
  return safeFetch(fetchImpl, `${base}/images/generations`, {
    method: "POST",
    headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: provider.model, prompt: "A red circle on a white background", n: 1, size: "256x256" }),
  }, 45000);
}

async function probeSpeech(provider, fetchImpl) {
  const base = provider.baseUrl.replace(/\/+$/, "");
  if (isCloudflare(provider)) return { status: "inconclusive", reason: "model_specific_format" };
  return safeFetch(fetchImpl, `${base}/audio/speech`, {
    method: "POST",
    headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: provider.model, input: "Hello", voice: "alloy", format: "wav" }),
  }, 45000);
}

async function probeTranscription(provider, fetchImpl) {
  const base = provider.baseUrl.replace(/\/+$/, "");
  if (isCloudflare(provider)) return { status: "inconclusive", reason: "model_specific_format" };
  const wav = new Uint8Array([82,73,70,70,36,0,0,0,87,65,86,69,102,109,116,32,16,0,0,0,1,0,1,0,64,31,0,0,128,62,0,0,2,0,16,0,100,97,116,97,0,0,0,0]);
  const form = new FormData();
  form.set("model", provider.model);
  form.set("file", new Blob([wav], { type: "audio/wav" }), "probe.wav");
  return safeFetch(fetchImpl, `${base}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${provider.apiKey}` },
    body: form,
  }, 45000);
}

export async function auditProviderCapabilities(provider, fetchImpl = globalThis.fetch) {
  const declared = Array.isArray(provider.capabilities) ? provider.capabilities : [];
  const checks = {};
  const verified = new Set();

  if (!likelyNonChat(provider.model) || declared.includes("chat")) {
    checks.chat = await probeChat(provider, fetchImpl, false);
    if (checks.chat.status === "verified") verified.add("chat");
  }

  if (declared.includes("vision") || likelyVision(provider.model)) {
    checks.vision = await probeChat(provider, fetchImpl, true);
    if (checks.vision.status === "verified") verified.add("vision");
  }

  if (declared.includes("image_generation") || likelyImage(provider.model)) {
    checks.image_generation = await probeImageGeneration(provider, fetchImpl);
    if (checks.image_generation.status === "verified") verified.add("image_generation");
  }

  if (declared.includes("transcription") || likelyTranscription(provider.model)) {
    checks.transcription = await probeTranscription(provider, fetchImpl);
    if (checks.transcription.status === "verified") verified.add("transcription");
  }

  if (declared.includes("speech") || likelySpeech(provider.model)) {
    checks.speech = await probeSpeech(provider, fetchImpl);
    if (checks.speech.status === "verified") verified.add("speech");
  }

  for (const passive of ["coding", "reasoning", "summarization", "document", "long_context", "fast", "image_editing"]) {
    if (declared.includes(passive)) verified.add(passive);
  }

  return {
    capabilities: [...verified],
    verification: {
      checkedAt: new Date().toISOString(),
      source: "active_probe_v1",
      checks: Object.fromEntries(Object.entries(checks).map(([key, value]) => [key, {
        status: value.status,
        ...(Number.isInteger(value.httpStatus) ? { httpStatus: value.httpStatus } : {}),
        ...(value.reason ? { reason: value.reason } : {}),
        ...(value.error ? { error: value.error } : {}),
      }])),
    },
  };
}

export async function auditAllProviders({ providerStore, fetchImpl = globalThis.fetch, concurrency = 2 }) {
  const providers = await providerStore.getActiveProviders();
  let index = 0;
  let verifiedModels = 0;
  let inconclusiveModels = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(4, concurrency)) }, async () => {
    while (true) {
      const current = index++;
      if (current >= providers.length) return;
      const provider = providers[current];
      const audit = await auditProviderCapabilities(provider, fetchImpl);
      const checks = Object.values(audit.verification.checks);
      if (checks.some((check) => check.status === "verified")) verifiedModels += 1;
      if (checks.some((check) => check.status === "inconclusive")) inconclusiveModels += 1;
      await providerStore.updateProviderVerification(provider.id, audit);
    }
  });
  await Promise.all(workers);
  return { total: providers.length, verifiedModels, inconclusiveModels };
}
