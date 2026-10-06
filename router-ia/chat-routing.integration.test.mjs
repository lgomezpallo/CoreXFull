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
    if (url.startsWith("https://primary.example")) return new Response("quota", { status: 429 });
    return new Response(JSON.stringify({ id: "ok", choices: [{ index: 0, message: { role: "assistant", content: "fallback worked" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ model: "router-ia-auto", messages: [{ role: "user", content: "hola" }] }) });
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
    return new Response(JSON.stringify({ id: "vision-ok", choices: [{ index: 0, message: { role: "assistant", content: "veo la imagen" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ model: "router-ia-auto", messages: [{ role: "user", content: [{ type: "text", text: "¿Qué hay acá?" }, { type: "image_url", image_url: { url: "https://example.com/image.jpg" } }] }] }) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.router.capability, "vision");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "vision-model");
});

test("normal chat falls back after a provider-specific 400", async (t) => {
  const calls = [];
  const providers = [
    provider({ id: "first", model: "first-model", priority: 90, capabilities: ["chat"] }),
    provider({ id: "second", model: "second-model", priority: 50, capabilities: ["chat"] }),
  ];
  const baseUrl = await startApp(t, providers, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.startsWith("https://first.example")) return new Response("bad request", { status: 400 });
    return new Response(JSON.stringify({
      id: "ok-after-400",
      choices: [{ index: 0, message: { role: "assistant", content: "fallback after 400" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "router-ia-auto", messages: [{ role: "user", content: "hola" }] }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.choices[0].message.content, "fallback after 400");
  assert.deepEqual(calls.map((call) => call.body.model), ["first-model", "second-model"]);
});

test("tool-calling chat tries the next provider after a 400 payload rejection", async (t) => {
  const calls = [];
  const providers = [provider({ id: "tool-a", model: "tool-a-model", priority: 90, capabilities: ["chat"] }), provider({ id: "tool-b", model: "tool-b-model", priority: 50, capabilities: ["chat"] })];
  const baseUrl = await startApp(t, providers, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.startsWith("https://tool-a.example")) return new Response("tools not supported", { status: 400 });
    return new Response(JSON.stringify({ id: "tool-fallback-ok", choices: [{ index: 0, message: { role: "assistant", content: "segunda opción funcionó" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" },
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

test("tool-calling chat continues after a model-specific 413", async (t) => {
  const calls = [];
  const providers = [provider({ id: "small", model: "small-model", priority: 90, capabilities: ["chat"] }), provider({ id: "large", model: "large-model", priority: 50, capabilities: ["chat"] })];
  const baseUrl = await startApp(t, providers, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.startsWith("https://small.example")) return new Response("request too large", { status: 413 });
    return new Response(JSON.stringify({ id: "large-ok", choices: [{ index: 0, message: { role: "assistant", content: "modelo grande funcionó" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ model: "router-ia-auto", messages: [{ role: "user", content: "revisá CoreX" }], tools: [{ type: "function", function: { name: "corex_search", description: "Busca en CoreX", parameters: { type: "object", properties: { query: { type: "string" } } } } }] }) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.choices[0].message.content, "modelo grande funcionó");
  assert.deepEqual(calls.map((call) => call.body.model), ["small-model", "large-model"]);
});

test("safety and guard models are excluded from generic chat routing", async (t) => {
  const calls = [];
  const providers = [
    provider({ id: "prompt-guard", model: "meta-llama/llama-prompt-guard-2-22m", priority: 100, capabilities: ["chat"] }),
    provider({ id: "safeguard", model: "openai/gpt-oss-safeguard-20b", priority: 95, capabilities: ["chat"] }),
    provider({ id: "real-chat", model: "llama-3.3-70b-versatile", priority: 50, capabilities: ["chat"] }),
  ];
  const baseUrl = await startApp(t, providers, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ id: "chat-ok", choices: [{ index: 0, message: { role: "assistant", content: "chat real" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ model: "router-ia-auto", messages: [{ role: "user", content: "hola" }] }) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.choices[0].message.content, "chat real");
  assert.deepEqual(calls.map((call) => call.body.model), ["llama-3.3-70b-versatile"]);
});

test("vision tries the next vision provider after a 400 payload rejection", async (t) => {
  const calls = [];
  const providers = [provider({ id: "vision-a", model: "vision-a-model", priority: 90, capabilities: ["chat", "vision"] }), provider({ id: "vision-b", model: "vision-b-model", priority: 50, capabilities: ["chat", "vision"] })];
  const baseUrl = await startApp(t, providers, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.startsWith("https://vision-a.example")) return new Response("image payload rejected", { status: 400 });
    return new Response(JSON.stringify({ id: "vision-fallback-ok", choices: [{ index: 0, message: { role: "assistant", content: "segunda visión funcionó" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ model: "router-ia-auto", messages: [{ role: "user", content: [{ type: "text", text: "¿Qué muestra?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] }) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.router.capability, "vision");
  assert.equal(body.choices[0].message.content, "segunda visión funcionó");
  assert.deepEqual(calls.map((call) => call.body.model), ["vision-a-model", "vision-b-model"]);
});


test("explicit task capability routes only to models with that capability", async (t) => {
  const calls = [];
  const providers = [
    provider({ id: "plain-chat", model: "plain-chat-model", priority: 100, capabilities: ["chat"] }),
    provider({ id: "reasoner", model: "reasoner-model", priority: 40, capabilities: ["chat", "reasoning"] }),
  ];
  const baseUrl = await startApp(t, providers, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      id: "reasoning-ok",
      choices: [{ index: 0, message: { role: "assistant", content: "reasoning worked" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "router-ia-auto",
      router_capability: "reasoning",
      messages: [{ role: "user", content: "Elegí entre dos candidatos ya analizados." }],
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.router.capability, "reasoning");
  assert.deepEqual(calls.map((call) => call.body.model), ["reasoner-model"]);
});

test("image content overrides a text capability request and routes as vision", async (t) => {
  const calls = [];
  const providers = [
    provider({ id: "reasoner", model: "reasoner-model", priority: 100, capabilities: ["chat", "reasoning"] }),
    provider({ id: "vision", model: "vision-model", priority: 40, capabilities: ["chat", "vision"] }),
  ];
  const baseUrl = await startApp(t, providers, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      id: "vision-ok",
      choices: [{ index: 0, message: { role: "assistant", content: "vision worked" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "router-ia-auto",
      router_capability: "reasoning",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "¿Qué ves?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      }],
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.router.capability, "vision");
  assert.deepEqual(calls.map((call) => call.body.model), ["vision-model"]);
});


test("HTTP 200 with empty completion falls back to the next provider", async (t) => {
  const calls = [];
  const providers = [
    provider({ id: "empty", model: "empty-model", priority: 90, capabilities: ["chat"] }),
    provider({ id: "healthy", model: "healthy-model", priority: 50, capabilities: ["chat"] }),
  ];
  const baseUrl = await startApp(t, providers, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.startsWith("https://empty.example")) {
      return new Response(JSON.stringify({
        id: "empty",
        choices: [{ index: 0, message: { role: "assistant", content: "" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      id: "healthy",
      choices: [{ index: 0, message: { role: "assistant", content: "usable" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "router-ia-auto", messages: [{ role: "user", content: "hola" }] }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.choices[0].message.content, "usable");
  assert.deepEqual(calls.map((call) => call.body.model), ["empty-model", "healthy-model"]);
});

test("HTTP 200 with malformed JSON falls back to the next provider", async (t) => {
  const calls = [];
  const providers = [
    provider({ id: "broken-json", model: "broken-json-model", priority: 90, capabilities: ["chat"] }),
    provider({ id: "healthy-json", model: "healthy-json-model", priority: 50, capabilities: ["chat"] }),
  ];
  const baseUrl = await startApp(t, providers, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.startsWith("https://broken-json.example")) {
      return new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      id: "healthy-json",
      choices: [{ index: 0, message: { role: "assistant", content: "recovered" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "router-ia-auto", messages: [{ role: "user", content: "hola" }] }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.choices[0].message.content, "recovered");
  assert.deepEqual(calls.map((call) => call.body.model), ["broken-json-model", "healthy-json-model"]);
});

test("an explicitly requested model is preferred but no longer a single point of failure", async (t) => {
  const calls = [];
  const providers = [
    provider({ id: "preferred", model: "preferred-model", priority: 10, capabilities: ["chat"] }),
    provider({ id: "fallback", model: "fallback-model", priority: 90, capabilities: ["chat"] }),
  ];
  const baseUrl = await startApp(t, providers, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.startsWith("https://preferred.example")) return new Response("server error", { status: 503 });
    return new Response(JSON.stringify({
      id: "explicit-fallback",
      choices: [{ index: 0, message: { role: "assistant", content: "fallback despite explicit preference" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "preferred-model", messages: [{ role: "user", content: "hola" }] }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.choices[0].message.content, "fallback despite explicit preference");
  assert.deepEqual(calls.map((call) => call.body.model), ["preferred-model", "fallback-model"]);
});
