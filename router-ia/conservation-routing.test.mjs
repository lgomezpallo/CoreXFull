import assert from "node:assert/strict";
import test from "node:test";
import { clearConservationState } from "./conservation-policy.mjs";
import { requestChatWithFallback } from "./chat-routing.mjs";

function provider(id, priority) {
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
      capabilityVerification: { checks: { chat: { status: "verified" } } },
    },
  };
}

const messages = [{ role: "user", content: "hola" }];
const upstreamBody = { messages };

test("429 falls back to the next capable model and cooling model is skipped next request", async () => {
  clearConservationState();
  const primary = provider("primary", 90);
  const secondary = provider("openrouter-secondary", 50);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("primary.example")) return new Response("quota", { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const first = await requestChatWithFallback({ providers: [secondary, primary], messages, requestedModel: "router-ia-auto", upstreamBody, fetchImpl });
  assert.equal(first.ok, true);
  assert.deepEqual(calls.map((url) => new URL(url).hostname), ["primary.example", "openrouter-secondary.example"]);

  calls.length = 0;
  const second = await requestChatWithFallback({ providers: [secondary, primary], messages, requestedModel: "router-ia-auto", upstreamBody, fetchImpl });
  assert.equal(second.ok, true);
  assert.deepEqual(calls.map((url) => new URL(url).hostname), ["openrouter-secondary.example"]);
});

test("semantic 400 exhausts compatible providers before failing", async () => {
  clearConservationState();
  const low = provider("low-semantic", 50);
  const high = provider("openrouter-high-semantic", 90);
  const calls = [];
  const result = await requestChatWithFallback({
    providers: [low, high],
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
  assert.equal(calls.length, 2);
  assert.match(calls[0], /openrouter-high-semantic/);
  assert.match(calls[1], /low-semantic/);
});
