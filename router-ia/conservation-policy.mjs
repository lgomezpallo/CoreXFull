const cooldowns = new Map();

const COOLDOWN_MS = Object.freeze({
  quota: 15 * 60_000,
  payment: 30 * 60_000,
  timeout: 60_000,
  unreachable: 60_000,
  server: 2 * 60_000,
  rejected: 10 * 60_000,
});

const VERIFICATION_TIER = Object.freeze({
  verified: 0,
  unknown: 1,
  inconclusive: 2,
  unsupported: 9,
  blocked: 9,
  retired: 9,
});

const CONSERVATION_TIER = Object.freeze({
  cloudflare: 0,
  groq: 1,
  openrouter: 2,
  nvidia: 3,
  custom: 4,
  openai: 9,
});

function providerKey(provider) {
  return provider?.id || `${provider?.baseUrl ?? ""}\u0000${provider?.model ?? ""}`;
}

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function verificationStatus(provider, capability) {
  return provider?.modelMetadata?.capabilityVerification?.checks?.[capability]?.status ?? "unknown";
}

export function identifyProviderFamily(provider) {
  const access = normalizeText(provider?.modelMetadata?.freePlanAccess);
  if (access === "cloudflare_workers_ai_free") return "cloudflare";
  if (access === "groq_free_plan") return "groq";
  if (access === "nvidia_api_catalog_prototyping") return "nvidia";

  const providerName = normalizeText(provider?.provider);
  const name = normalizeText(provider?.name);
  const baseUrl = normalizeText(provider?.baseUrl);
  const haystack = `${providerName} ${name} ${baseUrl}`;

  if (haystack.includes("cloudflare") || baseUrl.includes("api.cloudflare.com/client/v4/accounts/")) return "cloudflare";
  if (haystack.includes("groq") || baseUrl.includes("api.groq.com")) return "groq";
  if (haystack.includes("openrouter") || baseUrl.includes("openrouter.ai")) return "openrouter";
  if (haystack.includes("nvidia") || baseUrl.includes("integrate.api.nvidia.com")) return "nvidia";
  if (providerName === "openai" || name.includes("openai") || baseUrl.includes("api.openai.com")) return "openai";
  return "custom";
}

function priorityValue(provider) {
  return Math.max(0, Math.min(100, Number(provider?.priority) || 0));
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

export function routingRank(provider, capability, now = Date.now()) {
  const status = verificationStatus(provider, capability);
  const family = identifyProviderFamily(provider);
  return {
    coolingDown: isProviderCoolingDown(provider, now),
    verificationStatus: status,
    verificationTier: VERIFICATION_TIER[status] ?? VERIFICATION_TIER.unknown,
    providerFamily: family,
    conservationTier: CONSERVATION_TIER[family] ?? CONSERVATION_TIER.custom,
    priority: priorityValue(provider),
    fast: capability === "chat" && provider?.capabilities?.includes("fast") ? 1 : 0,
  };
}

export function conservationScore(provider, capability, now = Date.now()) {
  const rank = routingRank(provider, capability, now);
  if (rank.coolingDown) return -1_000_000;
  return 1_000_000
    - rank.verificationTier * 100_000
    - rank.conservationTier * 10_000
    + rank.priority * 10
    + rank.fast;
}

export function sortByConservation(providers, capability, now = Date.now()) {
  return [...providers].sort((a, b) => {
    const ar = routingRank(a, capability, now);
    const br = routingRank(b, capability, now);

    if (ar.coolingDown !== br.coolingDown) return ar.coolingDown ? 1 : -1;
    if (ar.verificationTier !== br.verificationTier) return ar.verificationTier - br.verificationTier;
    if (ar.conservationTier !== br.conservationTier) return ar.conservationTier - br.conservationTier;
    if (ar.priority !== br.priority) return br.priority - ar.priority;
    if (ar.fast !== br.fast) return br.fast - ar.fast;
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
