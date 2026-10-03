import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createRouterApp } from "./main.mjs";

const APP_TOKEN = "test-router-app-token";

function provider(overrides = {}) {
  return {
    id: "provider-1",
    provider: "custom",
    name: "Provider",
    baseUrl: "https://provider.example/v1",
    apiKey: "provider-key",
    model: "voice-model",
    active: true,
    capabilities: ["speech"],
    priority: 50,
    modelMetadata: { pricing: { prompt: "0", completion: "0" } },
    ...overrides,
  };
}

async function startServer(t, { providers, fetchImpl }) {
  const server = createRouterApp({
    appToken: APP_TOKEN,
    providerStore: { getActiveProviders: async () => providers },
    fetchImpl,
    adminToken: "",
    passkeyStore: null,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("capabilities endpoint reports active provider coverage without provider secrets", async (t) => {
  const baseUrl = await startServer(t, {
    providers: [
      provider({ capabilities: ["speech", "chat"], apiKey: "secret-a" }),
      provider({ id: "provider-2", capabilities: ["chat", "vision"], apiKey: "secret-b" }),
    ],
    fetchImpl: async () => {
      throw new Error("Capabilities discovery must not call an upstream provider.");
    },
  });

  const response = await fetch(`${baseUrl}/api/v1/capabilities`, {
    headers: { authorization: `Bearer ${APP_TOKEN}` },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const byName = Object.fromEntries(body.capabilities.map((entry) => [entry.capability, entry]));
  assert.equal(byName.chat.providerCount, 2);
  assert.equal(byName.speech.providerCount, 1);
  assert.equal(byName.vision.providerCount, 1);
  assert.equal(JSON.stringify(body).includes("secret-a"), false);
  assert.equal(JSON.stringify(body).includes("secret-b"), false);
});

test("speech route falls back to the next eligible provider on quota failure", async (t) => {
  const calls = [];
  const providers = [
    provider({
      id: "primary",
      name: "Primary",
      baseUrl: "https://primary.example/v1",
      model: "primary-voice",
      priority: 90,
    }),
    provider({
      id: "secondary",
      name: "Secondary",
      baseUrl: "https://secondary.example/v1",
      model: "secondary-voice",
      priority: 50,
    }),
  ];

  const baseUrl = await startServer(t, {
    providers,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.startsWith("https://primary.example")) {
        return new Response("quota", { status: 429 });
      }
      return new Response(Buffer.from("fake-audio"), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    },
  });

  const response = await fetch(`${baseUrl}/api/v1/audio/speech`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${APP_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ input: "Hola" }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString("utf8"), "fake-audio");
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://primary.example/v1/audio/speech",
      "https://secondary.example/v1/audio/speech",
    ],
  );
  assert.equal(JSON.parse(calls[0].options.body).model, "primary-voice");
  assert.equal(JSON.parse(calls[1].options.body).model, "secondary-voice");
});

test("explicit multimodal model selection does not silently switch models", async (t) => {
  const calls = [];
  const providers = [
    provider({ id: "primary", model: "primary-voice", priority: 90 }),
    provider({ id: "secondary", model: "secondary-voice", priority: 50 }),
  ];
  const baseUrl = await startServer(t, {
    providers,
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response("quota", { status: 429 });
    },
  });

  const response = await fetch(`${baseUrl}/api/v1/audio/speech`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${APP_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ input: "Hola", model: "primary-voice" }),
  });

  assert.equal(response.status, 429);
  assert.deepEqual(calls, ["https://provider.example/v1/audio/speech"]);
});
