import assert from "node:assert/strict";
import test from "node:test";
import { auditVisionProviders } from "./vision-auditor.mjs";

function provider(overrides = {}) {
  return {
    id: overrides.id ?? "p1",
    name: overrides.name ?? "Groq",
    baseUrl: overrides.baseUrl ?? "https://api.groq.com/openai/v1",
    apiKey: "test-key",
    model: overrides.model ?? "qwen/qwen3.8-27b",
    active: true,
    capabilities: overrides.capabilities ?? ["vision"],
    modelMetadata: overrides.modelMetadata ?? {},
  };
}

test("targeted vision audit skips OpenRouter and already verified models", async () => {
  const saved = [];
  const providers = [
    provider({ id: "groq" }),
    provider({ id: "openrouter", name: "Openrouter", baseUrl: "https://openrouter.ai/api/v1" }),
    provider({
      id: "verified",
      name: "NVIDIA NIM",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      modelMetadata: { capabilityVerification: { checks: { vision: { status: "verified" } } } },
    }),
  ];
  const result = await auditVisionProviders({
    providerStore: {
      async getActiveProviders() { return providers; },
      async updateProviderVerification(id, audit) { saved.push({ id, audit }); },
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const imageUrl = body.messages[0].content[1].image_url.url;
      assert.match(imageUrl, /^data:image\/png;base64,/);
      assert.ok(imageUrl.length > 100);
      return new Response(JSON.stringify({ choices: [{ message: { content: "blue" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(result.total, 1);
  assert.equal(result.verified, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, "groq");
  assert.ok(saved[0].audit.capabilities.includes("vision"));
});

test("unsupported vision response removes only vision and preserves other capabilities", async () => {
  const saved = [];
  const p = provider({ id: "nvidia", name: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", capabilities: ["chat", "vision"] });
  const result = await auditVisionProviders({
    providerStore: {
      async getActiveProviders() { return [p]; },
      async updateProviderVerification(id, audit) { saved.push({ id, audit }); },
    },
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "This model does not support image input" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(result.unsupported, 1);
  assert.deepEqual(saved[0].audit.capabilities, ["chat"]);
});
