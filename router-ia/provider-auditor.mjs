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
  if ([400, 401, 402, 403, 408, 409, 422, 429].includes(response.status) || response.status >= 500) return "inconclusive";
  if ([404, 405, 415].includes(response.status)) return "unsupported";
  return "inconclusive";
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
  const arabic = /arabic-saudi/i.test(provider.model);
  return safeFetch(fetchImpl, `${base}/audio/speech`, {
    method: "POST",
    headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: provider.model,
      input: arabic ? "مرحبا" : "Hello",
      voice: arabic ? "fahad" : "troy",
      response_format: "wav",
    }),
  }, 45000);
}

function makeSilenceWav() {
  const sampleRate = 8000;
  const samples = 2000;
  const dataSize = samples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataSize, true);
  return new Uint8Array(buffer);
}

async function probeTranscription(provider, fetchImpl) {
  const base = provider.baseUrl.replace(/\/+$/, "");
  if (isCloudflare(provider)) return { status: "inconclusive", reason: "model_specific_format" };
  const form = new FormData();
  form.set("model", provider.model);
  form.set("response_format", "json");
  form.set("file", new Blob([makeSilenceWav()], { type: "audio/wav" }), "probe.wav");
  return safeFetch(fetchImpl, `${base}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${provider.apiKey}` },
    body: form,
  }, 45000);
}

function applyProbeResult(capabilities, declared, capability, result) {
  if (result.status === "verified") capabilities.add(capability);
  else if (result.status === "inconclusive" && declared.includes(capability)) capabilities.add(capability);
}

export async function auditProviderCapabilities(provider, fetchImpl = globalThis.fetch) {
  const declared = Array.isArray(provider.capabilities) ? provider.capabilities : [];
  const checks = {};
  const capabilities = new Set(
    declared.filter((capability) => ["coding", "reasoning", "summarization", "document", "long_context", "fast", "image_editing"].includes(capability)),
  );

  if (!likelyNonChat(provider.model) || declared.includes("chat")) {
    checks.chat = await probeChat(provider, fetchImpl, false);
    applyProbeResult(capabilities, declared, "chat", checks.chat);
  }
  if (declared.includes("vision") || likelyVision(provider.model)) {
    checks.vision = await probeChat(provider, fetchImpl, true);
    applyProbeResult(capabilities, declared, "vision", checks.vision);
  }
  if (declared.includes("image_generation") || likelyImage(provider.model)) {
    checks.image_generation = await probeImageGeneration(provider, fetchImpl);
    applyProbeResult(capabilities, declared, "image_generation", checks.image_generation);
  }
  if (declared.includes("transcription") || likelyTranscription(provider.model)) {
    checks.transcription = await probeTranscription(provider, fetchImpl);
    applyProbeResult(capabilities, declared, "transcription", checks.transcription);
  }
  if (declared.includes("speech") || likelySpeech(provider.model)) {
    checks.speech = await probeSpeech(provider, fetchImpl);
    applyProbeResult(capabilities, declared, "speech", checks.speech);
  }

  return {
    capabilities: [...capabilities],
    verification: {
      checkedAt: new Date().toISOString(),
      source: "active_probe_v2",
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
