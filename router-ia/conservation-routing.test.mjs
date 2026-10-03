import assert from "node:assert/strict";
import test from "node:test";
import { clearConservationState } from "./conservation-policy.mjs";
import { requestChatWithFallback } from "./chat-routing.mjs";

function provider(id, priority, freePlanAccess) {
  return {
    id,
    provider: id.includes("openrouter") ? "openrouter" : "custom",
    name: id,
    baseUrl: `https://${id}.example/v1`,
    apiKey: `${id}-key`,
    model: `${id}-model`,
    active: true,
    priority,
    capabilities: ["chat"],
    modelMetadata: {
      ...(freePlanAccess ? { freePlanAccess } : {}),
      capabilityVerification: { checks: { chat: { status: "verified" } } },
    },
  };
}

const messages = [{ role: "user", content: "hola" }];
const upstreamBody = { messages };

test("429 falls back to the next provider and cooling provider is skipped next request", async () => {
  clearConservationState();
  const abundant = provider("abundant", 50, "groq_free_plan");
  const reserve = provider("openrouter-reserve", 90);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("abundant.example")) return new Response("quota", { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const first = await requestChatWithFallback({ providers: [reserve, abundant], messages, requestedModel: "router-ia-auto", upstreamBody, fetchImpl });
  assert.equal(first.ok, true);
  assert.deepEqual(calls.map((url) => new URL(url).hostname), ["abundant.example", "openrouter-reserve.example"]);

  calls.length = 0;
  const second = await requestChatWithFallback({ providers: [reserve, abundant], messages, requestedModel: "router-ia-auto", upstreamBody, fetchImpl });
  assert.equal(second.ok, true);
  assert.deepEqual(calls.map((url) => new URL(url).hostname), ["openrouter-reserve.example"]);
});

test("semantic 400 stops instead of burning fallback providers", async () => {
  clearConservationState();
  const abundant = provider("abundant-semantic", 50, "groq_free_plan");
  const reserve = provider("openrouter-semantic", 90);
  const calls = [];
  const result = await requestChatWithFallback({
    providers: [reserve, abundant],
    messages,
    requestedModel: "router-ia-auto",
    upstreamBody,
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response("bad request", { status: 400 });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /abundant-semantic/);
});
