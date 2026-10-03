import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createRouterApp } from "./main.mjs";

const APP_TOKEN = "test-app-token";

async function startApp(t, providers, fetchImpl) {
  const server = createRouterApp({
    appToken: APP_TOKEN,
    adminToken: "",
    providerStore: { getActiveProviders: async () => providers },
    fetchImpl,
    passkeyStore: null,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function provider({ id, model, priority, capabilities }) {
  return {
    id,
    provider: "custom",
    name: id,
    baseUrl: `https://${id}.example/v1`,
    apiKey: `${id}-key`,
    model,
    active: true,
    priority,
    capabilities,
    modelMetadata: { pricing: { prompt: "0", completion: "0" } },
  };
}

test("automatic chat falls back to the next chat provider", async (t) => {
  const calls = [];
  const providers = [
    provider({ id: "primary", model: "primary-model", priority: 90, capabilities: ["chat"] }),
    provider({ id: "secondary", model: "secondary-model", priority: 50, capabilities: ["chat"] }),
  ];
  const baseUrl = await startApp(t, providers, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.startsWith("https://primary.example")) {
      return new Response("quota", { status: 429 });
    }
    return new Response(JSON.stringify({
      id: "ok",
      choices: [{ index: 0, message: { role: "assistant", content: "fallback worked" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${APP_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "router-ia-auto",
      messages: [{ role: "user", content: "hola" }],
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.choices[0].message.content, "fallback worked");
  assert.equal(body.model, "router-ia-auto");
  assert.equal(body.router.capability, "chat");
  assert.deepEqual(calls.map((call) => call.body.model), ["primary-model", "secondary-model"]);
});

test("messages with images route only to vision-capable models", async (t) => {
  const calls = [];
  const providers = [
    provider({ id: "chat-only", model: "chat-model", priority: 100, capabilities: ["chat"] }),
    provider({ id: "vision", model: "vision-model", priority: 40, capabilities: ["chat", "vision"] }),
  ];
  const baseUrl = await startApp(t, providers, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      id: "vision-ok",
      choices: [{ index: 0, message: { role: "assistant", content: "veo la imagen" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${APP_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "router-ia-auto",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "¿Qué hay acá?" },
          { type: "image_url", image_url: { url: "https://example.com/image.jpg" } },
        ],
      }],
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.router.capability, "vision");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "vision-model");
});
