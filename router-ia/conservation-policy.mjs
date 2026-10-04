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

const SPECIALIZED_CAPABILITIES = new Set([
  "vision",
  "coding",
  "reasoning",
  "document",
  "transcription",
  "speech",
  "image_generation",
  "image_editing",
  "long_context",
]);

function providerKey(provider) {
  return provider?.id || `${provider?.baseUrl ?? ""}\u0000${provider?.model ?? ""}`;
}

function verificationStatus(provider, capability) {
  return provider?.modelMetadata?.capabilityVerification?.checks?.[capability]?.status ?? "unknown";
}

function priorityValue(provider) {
  return Math.max(0, Math.min(100, Number(provider?.priority) || 0));
}

function specializationPenalty(provider, capability) {
  const capabilities = Array.isArray(provider?.capabilities) ? provider.capabilities : [];
  return capabilities.reduce((count, item) => {
    if (item === capability || item === "chat" || item === "fast") return count;
    return count + (SPECIALIZED_CAPABILITIES.has(item) ? 1 : 0);
  }, 0);
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
  return {
    coolingDown: isProviderCoolingDown(provider, now),
    verificationStatus: status,
    verificationTier: VERIFICATION_TIER[status] ?? VERIFICATION_TIER.unknown,
    specializationPenalty: specializationPenalty(provider, capability),
    capabilityPriority: priorityValue(provider),
    fast: capability === "chat" && provider?.capabilities?.includes("fast") ? 1 : 0,
  };
}

export function sortByCapabilityPriority(providers, capability, now = Date.now()) {
  return [...providers].sort((a, b) => {
    const ar = routingRank(a, capability, now);
    const br = routingRank(b, capability, now);

    if (ar.coolingDown !== br.coolingDown) return ar.coolingDown ? 1 : -1;
    if (ar.verificationTier !== br.verificationTier) return ar.verificationTier - br.verificationTier;
    if (ar.specializationPenalty !== br.specializationPenalty) return ar.specializationPenalty - br.specializationPenalty;
    if (ar.capabilityPriority !== br.capabilityPriority) return br.capabilityPriority - ar.capabilityPriority;
    if (ar.fast !== br.fast) return br.fast - ar.fast;
    return String(a.model ?? a.name ?? "").localeCompare(String(b.model ?? b.name ?? ""));
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
