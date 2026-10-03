import { makeSolidPng } from "./probe-assets.mjs";

const ALLOWED_PROVIDER_NAMES = new Set(["Cloudflare Workers AI", "Groq", "NVIDIA NIM"]);

function isCloudflare(provider) {
  try {
    const url = new URL(provider.baseUrl);
    return url.origin === "https://api.cloudflare.com" && /\/client\/v4\/accounts\/[^/]+\/ai\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function likelyVision(model) {
  return /(vision|vlm|vila|neva|fuyu|kosmos|omni|gemma-3|gemma-4|llama-3\.2-(?:11b|90b)|llama-4|qwen3\.8|moondream)/i.test(model ?? "");
}

function existingStatus(provider) {
  return provider?.modelMetadata?.capabilityVerification?.checks?.vision?.status ?? null;
}

function shouldProbe(provider) {
  if (!ALLOWED_PROVIDER_NAMES.has(provider?.name)) return false;
  const status = existingStatus(provider);
  if (["verified", "unsupported", "blocked", "retired"].includes(status)) return false;
  return Array.isArray(provider.capabilities) && provider.capabilities.includes("vision") || likelyVision(provider.model);
}

function compactDiagnostic(value) {
  let text = typeof value === "string" ? value : "";
  if (!text && value && typeof value === "object") {
    const candidate = value?.error?.message ?? value?.errors?.[0]?.message ?? value?.message ?? value?.error ?? value;
    try { text = typeof candidate === "string" ? candidate : JSON.stringify(candidate); } catch { text = String(candidate); }
  }
  return text.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]").replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 400);
}

function classify(status, diagnostic) {
  const text = diagnostic ?? "";
  if (status >= 200 && status < 300) return "verified";
  if (status === 410 || /end of life|no longer available|retired/i.test(text)) return "retired";
  if (/not available on .*free plan|quota|rate.?limit|key limit|requires terms acceptance/i.test(text)) return "blocked";
  if (/does not support|not support.*image|unsupported.*image|only available on agentic harnesses/i.test(text)) return "unsupported";
  if ([404, 405, 415].includes(status)) return "unsupported";
  return "inconclusive";
}

async function probeVision(provider, fetchImpl) {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const url = isCloudflare(provider) ? `${base}/v1/chat/completions` : `${base}/chat/completions`;
  const imageUrl = `data:image/png;base64,${makeSolidPng(64, 64, [30, 144, 255]).toString("base64")}`;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: provider.model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "What is the dominant color of this image? Answer with one color word." },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        }],
        max_tokens: 12,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(40_000),
    });
    let payload = null;
    let diagnostic = "";
    try { payload = await response.json(); } catch {}
    if (!response.ok) diagnostic = compactDiagnostic(payload);
    const validSuccess = response.ok && Array.isArray(payload?.choices) && payload.choices.length > 0;
    return {
      status: validSuccess ? "verified" : response.ok ? "inconclusive" : classify(response.status, diagnostic),
      httpStatus: response.status,
      ...(diagnostic ? { diagnostic } : {}),
    };
  } catch (error) {
    return { status: "inconclusive", error: error?.name ?? "network_error", diagnostic: compactDiagnostic(error?.message) };
  }
}

function mergedAudit(provider, result) {
  const previousVerification = provider?.modelMetadata?.capabilityVerification;
  const previousChecks = previousVerification?.checks && typeof previousVerification.checks === "object" ? previousVerification.checks : {};
  const previousCandidates = Array.isArray(previousVerification?.candidates) ? previousVerification.candidates : [];
  const capabilities = new Set(Array.isArray(provider.capabilities) ? provider.capabilities : []);
  if (result.status === "verified") capabilities.add("vision");
  if (["unsupported", "retired"].includes(result.status)) capabilities.delete("vision");
  return {
    capabilities: [...capabilities],
    verification: {
      checkedAt: new Date().toISOString(),
      source: "targeted_vision_probe_v1",
      candidates: [...new Set([...previousCandidates, "vision"])],
      checks: { ...previousChecks, vision: result },
    },
  };
}

export async function auditVisionProviders({ providerStore, fetchImpl = globalThis.fetch, concurrency = 2 }) {
  const all = await providerStore.getActiveProviders();
  const providers = all.filter(shouldProbe);
  let index = 0;
  const summary = { total: providers.length, verified: 0, unsupported: 0, blocked: 0, retired: 0, inconclusive: 0 };
  const workers = Array.from({ length: Math.max(1, Math.min(3, concurrency)) }, async () => {
    while (true) {
      const current = index++;
      if (current >= providers.length) return;
      const provider = providers[current];
      const result = await probeVision(provider, fetchImpl);
      if (Object.hasOwn(summary, result.status)) summary[result.status] += 1;
      await providerStore.updateProviderVerification(provider.id, mergedAudit(provider, result));
    }
  });
  await Promise.all(workers);
  return summary;
}
