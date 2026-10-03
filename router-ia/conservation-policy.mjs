const cooldowns = new Map();

const COOLDOWN_MS = Object.freeze({
  quota: 15 * 60_000,
  payment: 30 * 60_000,
  timeout: 60_000,
  unreachable: 60_000,
  server: 2 * 60_000,
  rejected: 10 * 60_000,
});

function providerKey(provider) {
  return provider?.id || `${provider?.baseUrl ?? ""}\u0000${provider?.model ?? ""}`;
}

function verificationStatus(provider, capability) {
  return provider?.modelMetadata?.capabilityVerification?.checks?.[capability]?.status ?? "unknown";
}

function abundanceScore(provider) {
  const access = provider?.modelMetadata?.freePlanAccess;
  if (access === "groq_free_plan") return 36;
  if (access === "cloudflare_workers_ai_free") return 30;
  if (access === "nvidia_api_catalog_prototyping") return 18;
  if (provider?.provider === "openrouter") return 12;
  if (provider?.provider === "openai") return -20;
  return 8;
}

function verificationScore(provider, capability) {
  const status = verificationStatus(provider, capability);
  if (status === "verified") return 42;
  if (["unsupported", "blocked", "retired"].includes(status)) return -1000;
  if (status === "inconclusive") return 4;
  return 8;
}

function capabilityBonus(provider, capability) {
  if (capability === "vision" && provider?.capabilities?.includes("vision")) return 6;
  if (capability === "chat" && provider?.capabilities?.includes("fast")) return 4;
  return 0;
}

export function isProviderCoolingDown(provider, now = Date.now()) {
  const state = cooldowns.get(providerKey(provider));
  if (!state) return false;
  if (state.until <= now) {
    cooldowns.delete(providerKey(provider));
    return false;
  }
  return true;
}

export function conservationScore(provider, capability, now = Date.now()) {
  if (isProviderCoolingDown(provider, now)) return -10_000;
  const priority = Math.max(0, Math.min(100, Number(provider?.priority) || 0));
  return verificationScore(provider, capability) + abundanceScore(provider) + Math.round(priority / 5) + capabilityBonus(provider, capability);
}

export function sortByConservation(providers, capability, now = Date.now()) {
  return [...providers].sort((a, b) => {
    const score = conservationScore(b, capability, now) - conservationScore(a, capability, now);
    if (score) return score;
    const priority = (Number(b.priority) || 0) - (Number(a.priority) || 0);
    if (priority) return priority;
    return String(a.name ?? a.model ?? "").localeCompare(String(b.name ?? b.model ?? ""));
  });
}

export function recordProviderFailure(provider, kind, now = Date.now()) {
  const duration = COOLDOWN_MS[kind] ?? 0;
  if (!duration) return;
  const key = providerKey(provider);
  const previous = cooldowns.get(key);
  const multiplier = previous && previous.until > now ? Math.min((previous.strikes ?? 1) + 1, 4) : 1;
  cooldowns.set(key, { until: now + duration * multiplier, strikes: multiplier, kind });
}

export function recordProviderSuccess(provider) {
  cooldowns.delete(providerKey(provider));
}

export function clearConservationState() {
  cooldowns.clear();
}
