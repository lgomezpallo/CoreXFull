import assert from "node:assert/strict";
import test from "node:test";
import {
  clearConservationState,
  conservationScore,
  isProviderCoolingDown,
  recordProviderFailure,
  recordProviderSuccess,
  sortByConservation,
} from "./conservation-policy.mjs";

function provider({ id, provider = "custom", priority = 50, freePlanAccess, status = "unknown", capabilities = ["chat"] }) {
  return {
    id,
    provider,
    name: id,
    priority,
    capabilities,
    modelMetadata: {
      ...(freePlanAccess ? { freePlanAccess } : {}),
      capabilityVerification: { checks: { chat: { status } } },
    },
  };
}

test("verified abundant provider outranks scarce higher-priority provider", () => {
  clearConservationState();
  const groq = provider({ id: "groq", priority: 50, freePlanAccess: "groq_free_plan", status: "verified" });
  const scarce = provider({ id: "scarce", provider: "openrouter", priority: 95, status: "verified" });
  const [first] = sortByConservation([scarce, groq], "chat", 1_000);
  assert.equal(first.id, "groq");
  assert.ok(conservationScore(groq, "chat", 1_000) > conservationScore(scarce, "chat", 1_000));
});

test("unsupported verification removes provider from meaningful ranking", () => {
  clearConservationState();
  const unsupported = provider({ id: "bad", priority: 100, freePlanAccess: "groq_free_plan", status: "unsupported" });
  const verified = provider({ id: "good", priority: 10, provider: "openrouter", status: "verified" });
  const [first] = sortByConservation([unsupported, verified], "chat", 2_000);
  assert.equal(first.id, "good");
});

test("quota failure places provider in cooldown and success clears it", () => {
  clearConservationState();
  const p = provider({ id: "quota", freePlanAccess: "groq_free_plan", status: "verified" });
  recordProviderFailure(p, "quota", 10_000);
  assert.equal(isProviderCoolingDown(p, 10_001), true);
  assert.ok(conservationScore(p, "chat", 10_001) < -1000);
  recordProviderSuccess(p);
  assert.equal(isProviderCoolingDown(p, 10_001), false);
});
