import assert from "node:assert/strict";
import test from "node:test";
import {
  clearConservationState,
  conservationScore,
  identifyProviderFamily,
  isProviderCoolingDown,
  recordProviderFailure,
  recordProviderSuccess,
  routingRank,
  sortByConservation,
} from "./conservation-policy.mjs";

function provider({ id, provider = "custom", name = id, baseUrl = `https://${id}.example/v1`, priority = 50, freePlanAccess, status = "unknown", capability = "chat", capabilities = [capability] }) {
  return {
    id,
    provider,
    name,
    baseUrl,
    priority,
    capabilities,
    modelMetadata: {
      ...(freePlanAccess ? { freePlanAccess } : {}),
      capabilityVerification: { checks: { [capability]: { status } } },
    },
  };
}

test("provider family is identified even when imported as custom", () => {
  assert.equal(identifyProviderFamily(provider({ id: "cf", name: "Cloudflare Workers AI", baseUrl: "https://api.cloudflare.com/client/v4/accounts/x/ai/v1" })), "cloudflare");
  assert.equal(identifyProviderFamily(provider({ id: "g", name: "Groq", baseUrl: "https://api.groq.com/openai/v1" })), "groq");
  assert.equal(identifyProviderFamily(provider({ id: "or", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" })), "openrouter");
  assert.equal(identifyProviderFamily(provider({ id: "nv", name: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1" })), "nvidia");
});

test("verified Cloudflare is preferred to verified Groq regardless of manual priority", () => {
  clearConservationState();
  const cloudflare = provider({ id: "cloudflare", priority: 10, freePlanAccess: "cloudflare_workers_ai_free", status: "verified" });
  const groq = provider({ id: "groq", priority: 100, freePlanAccess: "groq_free_plan", status: "verified" });
  assert.equal(sortByConservation([groq, cloudflare], "chat", 1_000)[0].id, "cloudflare");
  assert.ok(conservationScore(cloudflare, "chat", 1_000) > conservationScore(groq, "chat", 1_000));
});

test("verified Groq is preferred to imported-custom OpenRouter", () => {
  clearConservationState();
  const groq = provider({ id: "groq", priority: 20, freePlanAccess: "groq_free_plan", status: "verified" });
  const openrouter = provider({ id: "or", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", priority: 100, status: "verified" });
  assert.equal(sortByConservation([openrouter, groq], "chat", 1_000)[0].id, "groq");
});

test("verification outranks conservation tier", () => {
  clearConservationState();
  const verifiedNvidia = provider({ id: "nv", freePlanAccess: "nvidia_api_catalog_prototyping", status: "verified" });
  const inconclusiveCloudflare = provider({ id: "cf", freePlanAccess: "cloudflare_workers_ai_free", status: "inconclusive" });
  assert.equal(sortByConservation([inconclusiveCloudflare, verifiedNvidia], "chat", 1_000)[0].id, "nv");
});

test("manual priority is a tie-breaker only inside the same tiers", () => {
  clearConservationState();
  const low = provider({ id: "low", priority: 10, freePlanAccess: "groq_free_plan", status: "verified" });
  const high = provider({ id: "high", priority: 90, freePlanAccess: "groq_free_plan", status: "verified" });
  assert.equal(sortByConservation([low, high], "chat", 1_000)[0].id, "high");
});

test("unsupported verification is last even with high priority", () => {
  clearConservationState();
  const unsupported = provider({ id: "bad", priority: 100, freePlanAccess: "cloudflare_workers_ai_free", status: "unsupported" });
  const verified = provider({ id: "good", priority: 1, name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", status: "verified" });
  assert.equal(sortByConservation([unsupported, verified], "chat", 2_000)[0].id, "good");
});

test("vision uses the same verified-first and conservation hierarchy", () => {
  clearConservationState();
  const cfVision = provider({ id: "cf-vision", capability: "vision", capabilities: ["chat", "vision"], freePlanAccess: "cloudflare_workers_ai_free", status: "verified" });
  const orVision = provider({ id: "or-vision", capability: "vision", capabilities: ["chat", "vision"], name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", priority: 100, status: "verified" });
  const ordered = sortByConservation([orVision, cfVision], "vision", 3_000);
  assert.equal(ordered[0].id, "cf-vision");
  assert.equal(routingRank(ordered[0], "vision", 3_000).verificationStatus, "verified");
});

test("quota failure places provider in cooldown and success clears it", () => {
  clearConservationState();
  const p = provider({ id: "quota", freePlanAccess: "cloudflare_workers_ai_free", status: "verified" });
  recordProviderFailure(p, "quota", 10_000);
  assert.equal(isProviderCoolingDown(p, 10_001), true);
  assert.ok(conservationScore(p, "chat", 10_001) < -1000);
  recordProviderSuccess(p);
  assert.equal(isProviderCoolingDown(p, 10_001), false);
});
