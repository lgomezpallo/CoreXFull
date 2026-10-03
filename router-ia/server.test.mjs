import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createRouterServer } from "./server.mjs";

const APP_TOKEN = "test-router-app-token";

async function startServer(t, config = {}) {
  const server = createRouterServer({
    appToken: APP_TOKEN,
    providerStore: null,
    fetchImpl: async () => {
      throw new Error("Unexpected provider call in test.");
    },
    ...config,
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
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function makeProvider(overrides = {}) {
  return {
    id: "saved-provider",
    provider: "custom",
    name: "Test provider",
    baseUrl: "https://provider.example/v1",
    apiKey: "test-provider-key",
    model: "test-model",
    active: true,
    priority: 50,
    modelMetadata: {},
    ...overrides,
  };
}

function makeProviderStore(providers) {
  return { getActiveProviders: async () => providers };
}

test("health and valid token check do not call the provider", async (t) => {
  let providerCalls = 0;
  const baseUrl = await startServer(t, {
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("Token checks must not invoke the provider.");
    },
  });

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "router-ia" });

  const check = await fetch(`${baseUrl}/api/v1/auth/check`, {
    headers: { authorization: `Bearer ${APP_TOKEN}` },
  });
  assert.equal(check.status, 204);
  assert.equal(providerCalls, 0);
});

test("missing and incorrect tokens are rejected without provider calls", async (t) => {
  let providerCalls = 0;
  const baseUrl = await startServer(t, {
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("Unauthorized requests must not invoke the provider.");
    },
  });

  const missing = await fetch(`${baseUrl}/api/v1/auth/check`);
  const incorrect = await fetch(`${baseUrl}/api/v1/auth/check`, {
    headers: { authorization: "Bearer wrong-token" },
  });

  assert.equal(missing.status, 401);
  assert.equal(incorrect.status, 401);
  assert.equal(providerCalls, 0);
});

test("completion fails closed when the requested model has no eligible saved route", async (t) => {
  let providerCalls = 0;
  const baseUrl = await startServer(t, {
    providerStore: makeProviderStore([]),
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("A model without a saved route must not be called.");
    },
  });

  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${APP_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "not-saved",
      messages: [{ role: "user", content: "Test prompt." }],
    }),
  });

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "model_unavailable");
  assert.equal(providerCalls, 0);
});

test("automatic selection uses the highest-priority eligible model and hides its identity", async (t) => {
  const calls = [];
  const selectedProvider = makeProvider({
    id: "selected-route",
    name: "Private provider name",
    baseUrl: "https://selected.example/v1",
    apiKey: "private-provider-key",
    model: "private/selected-model",
    priority: 90,
    modelMetadata: { pricing: { prompt: "0", completion: "0" } },
  });
  const lowerPriorityProvider = makeProvider({
    id: "lower-priority-route",
    baseUrl: "https://lower-priority.example/v1",
    model: "lower-priority-model",
    priority: 20,
    modelMetadata: { pricing: { prompt: "0", completion: "0" } },
  });
  const ineligibleProvider = makeProvider({
    id: "ineligible-high-priority-route",
    model: "paid-model",
    priority: 100,
    modelMetadata: { pricing: { prompt: "0", completion: "0.01" } },
  });
  const providerCompletion = {
    id: "completion-auto",
    model: "private/selected-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Simulated response." },
      },
    ],
  };
  const baseUrl = await startServer(t, {
    providerStore: makeProviderStore([
      lowerPriorityProvider,
      ineligibleProvider,
      selectedProvider,
    ]),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(providerCompletion), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const requestBodies = [
    {
      model: "router-ia-auto",
      messages: [{ role: "user", content: "Test prompt." }],
    },
    { messages: [{ role: "user", content: "Test prompt without model." }] },
  ];

  for (const requestBody of requestBodies) {
    const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${APP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
    const completion = await response.json();

    assert.equal(response.status, 200);
    assert.equal(completion.model, "router-ia-auto");
    assert.equal(JSON.stringify(completion).includes("private/selected-model"), false);
  }

  assert.equal(calls.length, requestBodies.length);
  assert.ok(
    calls.every(
      (call) => call.url === "https://selected.example/v1/chat/completions",
    ),
  );
  assert.ok(
    calls.every(
      (call) =>
        JSON.parse(call.options.body).model === "private/selected-model",
    ),
  );
});

test("completions call only saved models with an approved free-access basis", async (t) => {
  const eligibleProviders = [
    makeProvider({
      id: "groq-free",
      provider: "custom",
      name: "Groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "openai/gpt-oss-20b",
      modelMetadata: { freePlanAccess: "groq_free_plan" },
    }),
    makeProvider({
      id: "nvidia-prototype",
      name: "NVIDIA",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      model: "nvidia/llama-3.1-nemotron-70b-instruct",
      modelMetadata: { freePlanAccess: "nvidia_api_catalog_prototyping" },
    }),
    makeProvider({
      id: "zero-price",
      name: "Explicit zero-price provider",
      baseUrl: "https://zero.example/v1",
      model: "zero-price-model",
      modelMetadata: {
        pricing: { prompt: "0", completion: "0", image: "0" },
      },
    }),
  ];

  for (const provider of eligibleProviders) {
    await t.test(provider.id, async (subtest) => {
      const calls = [];
      const providerCompletion = {
        id: "completion-test",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Simulated response." },
          },
        ],
      };
      const baseUrl = await startServer(subtest, {
        providerStore: makeProviderStore([provider]),
        fetchImpl: async (url, options) => {
          calls.push({ url, options });
          return new Response(JSON.stringify(providerCompletion), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });

      const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${APP_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [{ role: "user", content: "Test prompt." }],
          max_tokens: 50_000,
          response_format: { type: "json_object" },
          temperature: 0.2,
          ignored_by_router: true,
        }),
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ...providerCompletion,
        model: "router-ia-auto",
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${provider.baseUrl}/chat/completions`);
      assert.equal(calls[0].options.method, "POST");
      assert.equal(calls[0].options.redirect, "error");
      assert.equal(
        calls[0].options.headers.authorization,
        `Bearer ${provider.apiKey}`,
      );
      assert.deepEqual(JSON.parse(calls[0].options.body), {
        model: provider.model,
        messages: [{ role: "user", content: "Test prompt." }],
        max_tokens: 8_192,
        response_format: { type: "json_object" },
        ...(provider.id === "groq-free" ? { reasoning_effort: "low" } : {}),
        temperature: 0.2,
      });
    });
  }
});

test("completion never falls back or retries after the selected provider rejects a request", async (t) => {
  const calls = [];
  const primary = makeProvider({
    id: "primary",
    baseUrl: "https://primary.example/v1",
    priority: 90,
    modelMetadata: { pricing: { prompt: "0", completion: "0" } },
  });
  const secondary = makeProvider({
    id: "secondary",
    baseUrl: "https://secondary.example/v1",
    priority: 10,
    modelMetadata: { pricing: { prompt: "0", completion: "0" } },
  });
  const baseUrl = await startServer(t, {
    providerStore: makeProviderStore([secondary, primary]),
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response("quota exceeded", { status: 429 });
    },
  });

  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${APP_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "Test prompt." }],
    }),
  });

  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "provider_quota_exceeded");
  assert.deepEqual(calls, ["https://primary.example/v1/chat/completions"]);
});

test("unauthorized completion does not invoke the provider", async (t) => {
  let providerCalls = 0;
  const baseUrl = await startServer(t, {
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("Unauthorized requests must not invoke the provider.");
    },
  });

  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "This should not reach a model." }],
    }),
  });

  assert.equal(response.status, 401);
  assert.equal(providerCalls, 0);
});

test("completion reports unavailable provider storage without contacting a provider", async (t) => {
  let providerCalls = 0;
  const baseUrl = await startServer(t, {
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("Unavailable storage must not trigger a provider request.");
    },
  });

  const check = await fetch(`${baseUrl}/api/v1/auth/check`, {
    headers: { authorization: `Bearer ${APP_TOKEN}` },
  });
  assert.equal(check.status, 204);

  const completion = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${APP_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "No provider is configured." }],
    }),
  });

  assert.equal(completion.status, 503);
  assert.equal(
    (await completion.json()).error.code,
    "provider_storage_unavailable",
  );
  assert.equal(providerCalls, 0);
});

test("completion rejects an unsafe saved provider URL without making a request", async (t) => {
  let providerCalls = 0;
  const baseUrl = await startServer(t, {
    providerStore: makeProviderStore([
      makeProvider({
        baseUrl: "http://provider.example/v1",
        modelMetadata: { pricing: { prompt: "0", completion: "0" } },
      }),
    ]),
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("Insecure provider URLs must not trigger a request.");
    },
  });

  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${APP_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "This must not reach a provider." }],
    }),
  });

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "model_unavailable");
  assert.equal(providerCalls, 0);
});

test("unknown, nonzero, and forged free-access metadata are rejected", async (t) => {
  const providers = [
    makeProvider({
      id: "unknown-pricing",
      model: "unknown-pricing",
      modelMetadata: {},
    }),
    makeProvider({
      id: "paid",
      model: "paid",
      modelMetadata: { pricing: { prompt: "0", completion: "0.01" } },
    }),
    makeProvider({
      id: "forged-groq",
      provider: "custom",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "not-on-groq-free-list",
      modelMetadata: { freePlanAccess: "groq_free_plan" },
    }),
    makeProvider({
      id: "forged-nvidia",
      baseUrl: "https://other.example/v1",
      model: "nvidia/model",
      modelMetadata: { freePlanAccess: "nvidia_api_catalog_prototyping" },
    }),
  ];
  let providerCalls = 0;
  const baseUrl = await startServer(t, {
    providerStore: makeProviderStore(providers),
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("Ineligible models must not reach a provider.");
    },
  });

  for (const provider of providers) {
    const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${APP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "user", content: "This must be blocked." }],
      }),
    });
    assert.equal(response.status, 404, provider.id);
    assert.equal(
      (await response.json()).error.code,
      "model_unavailable",
      provider.id,
    );
  }
  assert.equal(providerCalls, 0);
});
