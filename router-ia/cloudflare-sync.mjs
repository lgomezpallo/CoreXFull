import {
  inferModelCapabilities,
  isCloudflareWorkersAiBaseUrl,
  isCloudflareWorkersAiFreeModel,
} from "./provider-adapter.mjs";

const PAGE_SIZE = 100;
const MAX_MODELS = 500;

function normalizeNativeModel(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const id = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!id || id.length > 200) return null;
  const taskName = typeof entry.task?.name === "string"
    ? entry.task.name.trim()
    : typeof entry.task === "string"
      ? entry.task.trim()
      : "";
  return {
    id,
    ...(taskName ? { taskName } : {}),
  };
}

async function fetchNativeCatalog(baseUrl, apiKey, fetchImpl) {
  const models = [];
  const seen = new Set();
  for (let page = 1; page <= 10; page += 1) {
    const url = `${baseUrl.replace(/\/+$/, "")}/models/search?hide_experimental=true&include_deprecated=false&per_page=${PAGE_SIZE}&page=${page}`;
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Cloudflare catalog HTTP ${response.status}`);
    const payload = await response.json();
    const source = Array.isArray(payload?.result) ? payload.result : [];
    for (const entry of source) {
      const model = normalizeNativeModel(entry);
      if (!model || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
      if (models.length > MAX_MODELS) throw new Error("Cloudflare catalog is unexpectedly large.");
    }
    if (source.length < PAGE_SIZE) break;
  }
  return models;
}

export async function syncCloudflareCatalog({ providerStore, fetchImpl = globalThis.fetch }) {
  if (!providerStore) throw new Error("Provider storage is unavailable.");

  const active = await providerStore.getActiveProviders();
  const seed = active.find((provider) => isCloudflareWorkersAiBaseUrl(provider.baseUrl));
  if (!seed) return { found: 0, eligible: 0, added: 0, reason: "cloudflare_not_configured" };

  const models = await fetchNativeCatalog(seed.baseUrl, seed.apiKey, fetchImpl);
  const eligible = models.filter((model) => isCloudflareWorkersAiFreeModel(model, seed.baseUrl));
  const existing = await providerStore.listProviders();
  const keys = new Set(existing.map((provider) => `${provider.baseUrl}\u0000${provider.model}`));
  const missing = eligible.filter((model) => !keys.has(`${seed.baseUrl}\u0000${model.id}`));

  const toSave = missing
    .map((model) => ({
      provider: seed.provider,
      name: seed.name,
      baseUrl: seed.baseUrl,
      apiKey: seed.apiKey,
      model: model.id,
      capabilities: inferModelCapabilities(model),
      priority: seed.priority ?? 50,
      modelMetadata: { ...model, freePlanAccess: "cloudflare_workers_ai_free" },
    }))
    .filter((provider) => provider.capabilities.length > 0);

  const saved = toSave.length ? await providerStore.addProviders(toSave) : [];
  return {
    found: models.length,
    eligible: eligible.length,
    classified: toSave.length,
    added: saved.length,
  };
}
