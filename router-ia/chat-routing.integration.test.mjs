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

test("normal chat still stops after a semantic 400", async (t) => {
  const calls = [];
  const providers = [
    provider({ id: "first", model: "first-model", priority: 90, capabilities: ["chat"] }),
    provider({ id: "second", model: "second-model", priority: 50, capabilities: ["chat"] }),
  ];
  const baseUrl = await startApp(t, providers, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response("bad request", { status: 400 });
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

  assert.equal(response.status, 400);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "first-model");
});

test("tool-calling chat tries the next provider after a 400 payload rejection", async (t) => {
  const calls = [];
  const providers = [
    provider({ id: "tool-a", model: "tool-a-model", priority: 90, capabilities: ["chat"] }),
    provider({ id: "tool-b", model: "tool-b-model", priority: 50, capabilities: ["chat"] }),
  ];
  const baseUrl = await startApp(t, providers, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.startsWith("https://tool-a.example")) {
      return new Response("tools not supported", { status: 400 });
    }
    return new Response(JSON.stringify({
      id: "tool-fallback-ok",
      choices: [{ index: 0, message: { role: "assistant", content: "segunda opción funcionó" } }],
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
      messages: [{ role: "user", content: "diagnosticá CoreX" }],
      tools: [{
        type: "function",
        function: {
          name: "corex_search",
          description: "Busca en CoreX",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      }],
      tool_choice: "auto",
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.router.capability, "chat");
  assert.equal(body.choices[0].message.content, "segunda opción funcionó");
  assert.deepEqual(calls.map((call) => call.body.model), ["tool-a-model", "tool-b-model"]);
});

test("vision tries the next vision provider after a 400 payload rejection", async (t) => {
  const calls = [];
  const providers = [
    provider({ id: "vision-a", model: "vision-a-model", priority: 90, capabilities: ["chat", "vision"] }),
    provider({ id: "vision-b", model: "vision-b-model", priority: 50, capabilities: ["chat", "vision"] }),
  ];
  const baseUrl = await startApp(t, providers, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.startsWith("https://vision-a.example")) {
      return new Response("image payload rejected", { status: 400 });
    }
    return new Response(JSON.stringify({
      id: "vision-fallback-ok",
      choices: [{ index: 0, message: { role: "assistant", content: "segunda visión funcionó" } }],
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
          { type: "text", text: "¿Qué muestra?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      }],
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.router.capability, "vision");
  assert.equal(body.choices[0].message.content, "segunda visión funcionó");
  assert.deepEqual(calls.map((call) => call.body.model), ["vision-a-model", "vision-b-model"]);
});
