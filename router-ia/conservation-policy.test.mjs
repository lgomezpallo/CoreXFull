import assert from "node:assert/strict";
import test from "node:test";
import {
  clearConservationState,
  isProviderCoolingDown,
  recordProviderFailure,
  recordProviderSuccess,
  routingRank,
  sortByCapabilityPriority,
} from "./conservation-policy.mjs";

function provider({ id, name = id, model = id, priority = 50, status = "unknown", capability = "chat", capabilities = [capability] }) {
  return {
    id,
    name,
    model,
    priority,
    capabilities,
    modelMetadata: {
      capabilityVerification: { checks: { [capability]: { status } } },
    },
  };
}

test("provider identity does not affect ordering", () => {
  clearConservationState();
  const groq = provider({ id: "groq", name: "Groq", model: "g", priority: 20, status: "verified" });
  const cloudflare = provider({ id: "cloudflare", name: "Cloudflare Workers AI", model: "c", priority: 80, status: "verified" });
  const ordered = sortByCapabilityPriority([groq, cloudflare], "chat", 1_000);
  assert.deepEqual(ordered.map((item) => item.id), ["cloudflare", "groq"]);
});

test("verified capability outranks unverified capability", () => {
  clearConservationState();
  const verified = provider({ id: "verified", priority: 10, status: "verified" });
  const unknown = provider({ id: "unknown", priority: 100, status: "unknown" });
  assert.equal(sortByCapabilityPriority([unknown, verified], "chat", 1_000)[0].id, "verified");
});

test("least specialized sufficient model is preferred", () => {
  clearConservationState();
  const plainChat = provider({ id: "plain", priority: 40, status: "verified", capabilities: ["chat"] });
  const specialist = provider({ id: "specialist", priority: 100, status: "verified", capabilities: ["chat", "vision", "long_context", "reasoning"] });
  assert.equal(sortByCapabilityPriority([specialist, plainChat], "chat", 1_000)[0].id, "plain");
});

test("capability priority breaks ties after verification and specialization", () => {
  clearConservationState();
  const low = provider({ id: "low", priority: 10, status: "verified", capabilities: ["chat"] });
  const high = provider({ id: "high", priority: 90, status: "verified", capabilities: ["chat"] });
  assert.equal(sortByCapabilityPriority([low, high], "chat", 1_000)[0].id, "high");
});

test("vision compares only vision capability and not provider", () => {
  clearConservationState();
  const a = provider({ id: "a", name: "Groq", capability: "vision", capabilities: ["chat", "vision"], priority: 20, status: "verified" });
  const b = provider({ id: "b", name: "OpenRouter", capability: "vision", capabilities: ["chat", "vision"], priority: 80, status: "verified" });
  const ordered = sortByCapabilityPriority([a, b], "vision", 2_000);
  assert.equal(ordered[0].id, "b");
  assert.equal(routingRank(ordered[0], "vision", 2_000).verificationStatus, "verified");
});

test("cooldown only removes a failing execution path temporarily", () => {
  clearConservationState();
  const first = provider({ id: "first", priority: 100, status: "verified" });
  const second = provider({ id: "second", priority: 50, status: "verified" });
  recordProviderFailure(first, "quota", 10_000);
  assert.equal(isProviderCoolingDown(first, 10_001), true);
  assert.equal(sortByCapabilityPriority([first, second], "chat", 10_001)[0].id, "second");
  recordProviderSuccess(first);
  assert.equal(isProviderCoolingDown(first, 10_001), false);
});
