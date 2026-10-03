import {
  discoverModels,
  inferModelCapabilities,
  isCloudflareWorkersAiBaseUrl,
  isCloudflareWorkersAiFreeModel,
} from "./provider-adapter.mjs";

export async function syncCloudflareCatalog({ providerStore, fetchImpl = globalThis.fetch }) {
  if (!providerStore) throw new Error("Provider storage is unavailable.");

  const active = await providerStore.getActiveProviders();
  const seed = active.find((provider) => isCloudflareWorkersAiBaseUrl(provider.baseUrl));
  if (!seed) return { found: 0, eligible: 0, added: 0, reason: "cloudflare_not_configured" };

  const result = await discoverModels({ baseUrl: seed.baseUrl, apiKey: seed.apiKey, fetchImpl });
  if (!result.ok) throw new Error(`Cloudflare catalog sync failed: ${result.reason}`);

  const eligible = result.models.filter((model) => isCloudflareWorkersAiFreeModel(model, seed.baseUrl));
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
    found: result.models.length,
    eligible: eligible.length,
    classified: toSave.length,
    added: saved.length,
  };
}
