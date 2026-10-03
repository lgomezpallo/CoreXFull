import assert from "node:assert/strict";
import test from "node:test";
import { auditProviderCapabilities } from "./provider-auditor.mjs";

test("inconclusive probe preserves an already declared capability", async () => {
  const result = await auditProviderCapabilities(
    {
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "secret",
      model: "openai/gpt-oss-20b",
      capabilities: ["chat", "long_context"],
    },
    async () => new Response("rate limited", { status: 429 }),
  );
  assert.deepEqual(result.capabilities.sort(), ["chat", "long_context"]);
  assert.equal(result.verification.checks.chat.status, "inconclusive");
});

test("unclassified NVIDIA vision model gains capabilities only after successful probes", async () => {
  const calls = [];
  const result = await auditProviderCapabilities(
    {
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: "secret",
      model: "meta/llama-3.2-11b-vision-instruct",
      capabilities: [],
    },
    async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  assert.deepEqual(result.capabilities.sort(), ["chat", "vision"]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.url.endsWith("/chat/completions")));
  assert.equal(result.verification.checks.chat.status, "verified");
  assert.equal(result.verification.checks.vision.status, "verified");
});

test("Cloudflare chat probe uses the account AI OpenAI-compatible endpoint", async () => {
  const urls = [];
  const result = await auditProviderCapabilities(
    {
      baseUrl: "https://api.cloudflare.com/client/v4/accounts/abc1234567890123/ai",
      apiKey: "secret",
      model: "@cf/meta/llama-3.1-8b-instruct",
      capabilities: ["chat"],
    },
    async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  assert.deepEqual(result.capabilities, ["chat"]);
  assert.equal(urls[0], "https://api.cloudflare.com/client/v4/accounts/abc1234567890123/ai/v1/chat/completions");
});
