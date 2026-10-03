import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createRouterServer } from "./server.mjs";

const APP_TOKEN = "test-router-app-token";
const ADMIN_TOKEN = "test-router-admin-token";
const PROVIDER_ID = "c05d7c85-4614-4fd4-9465-5096677c6f45";

async function startServer(t, options = {}) {
  const server = createRouterServer({
    appToken: APP_TOKEN,
    adminToken: ADMIN_TOKEN,
    providerBaseUrl: "",
    providerApiKey: "",
    model: "",
    providerStore: null,
    passkeyStore: null,
    providerStorageConfigError: false,
    adminCookieSecure: false,
    fetchImpl: async () => {
      throw new Error("Unexpected external request in test.");
    },
    ...options,
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

async function login(baseUrl, token = ADMIN_TOKEN) {
  const response = await fetch(`${baseUrl}/admin/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return {
    response,
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
  };
}

function providerStore(overrides = {}) {
  return {
    listProviders: async () => [],
    addProvider: async (value) => ({
      id: PROVIDER_ID,
      provider: value.provider,
      name: value.name,
      baseUrl: value.baseUrl,
      model: value.model,
      active: true,
      capabilities: value.capabilities,
      priority: value.priority,
      modelMetadata: value.modelMetadata,
      createdAt: "2026-10-01T00:00:00.000Z",
    }),
    activateProvider: async () => {},
    deactivateProvider: async () => {},
    deleteProvider: async () => {},
    ...overrides,
  };
}

function memoryPasskeyStore(initialCredentials = []) {
  const credentials = [...initialCredentials];
  return {
    credentials,
    listCredentials: async () => credentials,
    getCredential: async (id) =>
      credentials.find((credential) => credential.id === id) ?? null,
    addCredential: async (credential) => credentials.push(credential),
    updateCounter: async (id, counter) => {
      const credential = credentials.find((entry) => entry.id === id);
      if (credential) credential.counter = counter;
    },
    deleteCredential: async (id) => {
      const index = credentials.findIndex((credential) => credential.id === id);
      if (index >= 0) credentials.splice(index, 1);
    },
  };
}

test("the private admin panel is served without exposing provider data", async (t) => {
  const baseUrl = await startServer(t);
  const page = await fetch(`${baseUrl}/admin`);
  const html = await page.text();
  const unauthenticatedList = await fetch(`${baseUrl}/admin/api/providers`);

  assert.equal(page.status, 200);
  assert.match(html, /Panel privado/);
  assert.match(html, /passkey-login-button/);
  assert.match(html, /token de recuperación/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(unauthenticatedList.status, 401);
});

test("the private admin panel exposes an installable PWA shell without caching API responses", async (t) => {
  const baseUrl = await startServer(t);
  const page = await fetch(`${baseUrl}/admin/`);
  const html = await page.text();
  const manifestResponse = await fetch(`${baseUrl}/admin/manifest.webmanifest`);
  const manifest = await manifestResponse.json();
  const workerResponse = await fetch(`${baseUrl}/admin/service-worker.js`);
  const worker = await workerResponse.text();

  assert.equal(page.status, 200);
  assert.match(html, /rel="manifest" href="\/admin\/manifest\.webmanifest"/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.equal(manifest.start_url, "/admin/");
  assert.equal(manifest.scope, "/admin/");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "maskable"));
  assert.equal(workerResponse.status, 200);
  assert.match(worker, /url\.pathname\.startsWith\("\/admin\/api\/"\)/);
  assert.match(worker, /request\.method !== "GET"/);

  for (const path of [
    "/admin/icons/icon-192.png",
    "/admin/icons/icon-512.png",
    "/admin/icons/icon-512-maskable.png",
    "/admin/icons/apple-touch-icon.png",
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, `${path} should load`);
    assert.match(response.headers.get("content-type"), /^image\/png/);
    assert.deepEqual(
      bytes.subarray(0, 8),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }
});

test("admin login sets an HttpOnly session and rejects an incorrect token", async (t) => {
  const baseUrl = await startServer(t);
  const invalid = await login(baseUrl, "incorrect-token");
  const valid = await login(baseUrl);

  assert.equal(invalid.response.status, 401);
  assert.equal(valid.response.status, 200);
  assert.match(valid.cookie, /^router_ia_admin=/);
  assert.match(valid.response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(valid.response.headers.get("set-cookie"), /SameSite=Strict/);

  const session = await fetch(`${baseUrl}/admin/api/session`, {
    headers: { cookie: valid.cookie },
  });
  assert.deepEqual(await session.json(), { authenticated: true });
});

test("passkey registration requires an admin session and stores only verified credentials", async (t) => {
  const store = memoryPasskeyStore();
  let expectedChallenge;
  const webauthn = {
    generateRegistrationOptions: async ({ rpID }) => {
      expectedChallenge = "registration-challenge";
      return { challenge: expectedChallenge, rp: { id: rpID } };
    },
    verifyRegistrationResponse: async (input) => {
      assert.equal(input.expectedChallenge, expectedChallenge);
      assert.equal(input.requireUserVerification, true);
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id: "device_credential_01",
            publicKey: Uint8Array.from([1, 2, 3]),
            counter: 0,
            transports: ["internal"],
          },
        },
      };
    },
  };
  const baseUrl = await startServer(t, { passkeyStore: store, webauthn });
  const origin = new URL(baseUrl).origin;
  const { cookie } = await login(baseUrl);
  const crossOriginOptions = await fetch(
    `${baseUrl}/admin/api/passkeys/register/options`,
    {
      method: "POST",
      headers: {
        cookie,
        origin: "https://untrusted.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    },
  );
  assert.equal(crossOriginOptions.status, 403);

  const optionsResponse = await fetch(
    `${baseUrl}/admin/api/passkeys/register/options`,
    {
      method: "POST",
      headers: {
        cookie,
        origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    },
  );
  const optionsPayload = await optionsResponse.json();
  assert.equal(optionsResponse.status, 200);

  const verifyResponse = await fetch(
    `${baseUrl}/admin/api/passkeys/register/verify`,
    {
      method: "POST",
      headers: {
        cookie,
        origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        challengeId: optionsPayload.challengeId,
        name: "Teléfono",
        response: { id: "device_credential_01", type: "public-key" },
      }),
    },
  );
  assert.equal(verifyResponse.status, 201);
  assert.deepEqual(await verifyResponse.json(), { registered: true });
  assert.deepEqual(store.credentials, [
    {
      id: "device_credential_01",
      publicKey: Uint8Array.from([1, 2, 3]),
      counter: 0,
      transports: ["internal"],
      name: "Teléfono",
    },
  ]);

  const listResponse = await fetch(`${baseUrl}/admin/api/passkeys`, {
    headers: { cookie },
  });
  const listed = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(listed.credentials[0].id, "device_credential_01");
  assert.equal("publicKey" in listed.credentials[0], false);
});

test("passkey login verifies the device and establishes an admin session", async (t) => {
  const store = memoryPasskeyStore([
    {
      id: "device_credential_02",
      publicKey: Uint8Array.from([4, 5, 6]),
      counter: 0,
      transports: ["internal"],
      name: "Teléfono",
      createdAt: "2026-10-02T00:00:00.000Z",
    },
  ]);
  let expectedChallenge;
  let requireUserVerification;
  const webauthn = {
    generateAuthenticationOptions: async ({ rpID }) => {
      expectedChallenge = "authentication-challenge";
      return { challenge: expectedChallenge, rpID };
    },
    verifyAuthenticationResponse: async (input) => {
      assert.equal(input.expectedChallenge, expectedChallenge);
      assert.equal(input.credential.id, "device_credential_02");
      requireUserVerification = input.requireUserVerification;
      return {
        verified: true,
        authenticationInfo: {
          userVerified: true,
          credentialID: "device_credential_02",
          newCounter: 1,
        },
      };
    },
  };
  const baseUrl = await startServer(t, { passkeyStore: store, webauthn });
  const origin = new URL(baseUrl).origin;
  const optionsResponse = await fetch(
    `${baseUrl}/admin/api/passkeys/login/options`,
    {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  const optionsPayload = await optionsResponse.json();
  assert.equal(optionsResponse.status, 200);

  const verifyResponse = await fetch(
    `${baseUrl}/admin/api/passkeys/login/verify`,
    {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: optionsPayload.challengeId,
        response: { id: "device_credential_02", type: "public-key" },
      }),
    },
  );
  const cookie = verifyResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.equal(verifyResponse.status, 200);
  assert.equal(requireUserVerification, true);
  assert.match(cookie, /^router_ia_admin=/);
  assert.equal(store.credentials[0].counter, 1);

  const session = await fetch(`${baseUrl}/admin/api/session`, {
    headers: { cookie },
  });
  assert.deepEqual(await session.json(), { authenticated: true });
});

test("passkey login rejects a response without verified device unlock", async (t) => {
  const store = memoryPasskeyStore([
    {
      id: "device_credential_03",
      publicKey: Uint8Array.from([7, 8, 9]),
      counter: 0,
      transports: ["internal"],
      name: "Dispositivo",
    },
  ]);
  const webauthn = {
    generateAuthenticationOptions: async () => ({
      challenge: "unverified-authentication-challenge",
    }),
    verifyAuthenticationResponse: async () => ({
      verified: true,
      authenticationInfo: {
        userVerified: false,
        credentialID: "device_credential_03",
        newCounter: 1,
      },
    }),
  };
  const baseUrl = await startServer(t, { passkeyStore: store, webauthn });
  const origin = new URL(baseUrl).origin;
  const optionsResponse = await fetch(
    `${baseUrl}/admin/api/passkeys/login/options`,
    {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  const { challengeId } = await optionsResponse.json();
  const verifyResponse = await fetch(
    `${baseUrl}/admin/api/passkeys/login/verify`,
    {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        challengeId,
        response: { id: "device_credential_03", type: "public-key" },
      }),
    },
  );

  assert.equal(verifyResponse.status, 401);
  assert.equal(verifyResponse.headers.get("set-cookie"), null);
  assert.equal(store.credentials[0].counter, 0);
});

test("model discovery makes only a GET /models request and never stores the key in the response", async (t) => {
  const calls = [];
  const store = providerStore();
  const baseUrl = await startServer(t, {
    providerStore: store,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "llama-3.1-8b",
              context_window: 131_072,
              architecture: {
                input_modalities: ["text", "image"],
                output_modalities: ["text"],
              },
              pricing: { prompt: "0", completion: "0" },
            },
          ],
        }),
        {
        status: 200,
        headers: { "content-type": "application/json" },
        },
      );
    },
  });
  const { response: loginResponse, cookie } = await login(baseUrl);
  assert.equal(loginResponse.status, 200);

  const discovery = await fetch(`${baseUrl}/admin/api/providers/discover-models`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      provider: "groq",
      apiKey: "provider-secret-test",
    }),
  });

  assert.equal(discovery.status, 200);
  assert.deepEqual(await discovery.json(), {
    models: [
      {
        id: "llama-3.1-8b",
        contextLength: 131_072,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        pricing: { prompt: "0", completion: "0" },
      },
    ],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.groq.com/openai/v1/models");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.authorization, "Bearer provider-secret-test");
});

test("adding free models normalizes provider credentials, filters the catalog, skips configured tuples, and bulk-saves", async (t) => {
  const calls = [];
  const bulkCalls = [];
  const store = providerStore({
    listProviders: async () => [
      {
        provider: "groq",
        baseUrl: "https://api.groq.com/openai/v1",
        model: "already-configured",
      },
      {
        provider: "openai",
        baseUrl: "https://api.groq.com/openai/v1",
        model: "same-id-different-provider",
      },
      {
        provider: "groq",
        baseUrl: "https://another-groq.example/v1",
        model: "same-id-different-base-url",
      },
    ],
    addProvider: async () => {
      throw new Error("Free models must use the bulk storage operation.");
    },
    addProviders: async (providers) => {
      bulkCalls.push(providers);
      return providers.map((value, index) => ({
        id: `saved-${index}`,
        provider: value.provider,
        name: value.name,
        baseUrl: value.baseUrl,
        model: value.model,
        active: true,
        capabilities: value.capabilities,
        priority: value.priority,
        modelMetadata: value.modelMetadata,
        createdAt: "2026-10-01T00:00:00.000Z",
      }));
    },
  });
  const baseUrl = await startServer(t, {
    providerStore: store,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "already-configured",
              pricing: { prompt: "0", completion: "0" },
            },
            {
              id: "new-free-model",
              context_length: 131_072,
              architecture: {
                input_modalities: ["text", "image", "pdf"],
                output_modalities: ["text"],
              },
              pricing: { prompt: "0", completion: "0", request: "0" },
            },
            {
              id: "same-id-different-provider",
              pricing: { prompt: "0", completion: "0" },
            },
            {
              id: "same-id-different-base-url",
              pricing: { prompt: "0", completion: "0" },
            },
            {
              id: "paid-extra-price",
              pricing: { prompt: "0", completion: "0", image: "0.01" },
            },
            { id: "unknown-pricing" },
            { id: "incomplete-pricing", pricing: { prompt: "0" } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const { cookie } = await login(baseUrl);

  const response = await fetch(`${baseUrl}/admin/api/providers/add-free-models`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ provider: " GROQ ", apiKey: "  free-model-key  " }),
  });
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(
    {
      modelsFound: payload.modelsFound,
      freeModelsFound: payload.freeModelsFound,
      addedCount: payload.addedCount,
      alreadyConfiguredCount: payload.alreadyConfiguredCount,
      unknownPricingCount: payload.unknownPricingCount,
    },
    {
      modelsFound: 7,
      freeModelsFound: 4,
      addedCount: 3,
      alreadyConfiguredCount: 1,
      unknownPricingCount: 2,
    },
  );
  assert.equal(payload.providers.length, 3);
  assert.equal(payload.providers[0].model, "new-free-model");
  assert.equal(JSON.stringify(payload).includes("free-model-key"), false);
  assert.equal(bulkCalls.length, 1);
  assert.equal(bulkCalls[0].length, 3);
  assert.deepEqual(
    bulkCalls[0].map(({ model }) => model),
    ["new-free-model", "same-id-different-provider", "same-id-different-base-url"],
  );
  assert.deepEqual(bulkCalls[0][0], {
    provider: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: "free-model-key",
    model: "new-free-model",
    capabilities: ["chat", "vision", "document", "long_context"],
    priority: 50,
    modelMetadata: {
      id: "new-free-model",
      contextLength: 131_072,
      inputModalities: ["text", "image", "pdf"],
      outputModalities: ["text"],
      pricing: { prompt: "0", completion: "0", request: "0" },
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.groq.com/openai/v1/models");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.authorization, "Bearer free-model-key");
});

test("adding free models without an explicitly free catalog entry does not store the API key", async (t) => {
  let bulkCalls = 0;
  const calls = [];
  const store = providerStore({
    addProviders: async () => {
      bulkCalls += 1;
      throw new Error("A key must not be stored without an explicitly free model.");
    },
  });
  const baseUrl = await startServer(t, {
    providerStore: store,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify({
          data: [
            { id: "unknown-price-model" },
            { id: "partial-price-model", pricing: { prompt: "0" } },
            { id: "paid-model", pricing: { prompt: "0", completion: "0.0001" } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const { cookie } = await login(baseUrl);
  const response = await fetch(`${baseUrl}/admin/api/providers/add-free-models`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ provider: "groq", apiKey: "never-save-this-key" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.addedCount, 0);
  assert.equal(payload.freeModelsFound, 0);
  assert.equal(payload.unknownPricingCount, 2);
  assert.deepEqual(payload.providers, []);
  assert.equal(bulkCalls, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "GET");
});

test("Groq Free plan import matches the official quota list, labels it, and excludes unlisted models", async (t) => {
  const calls = [];
  const savedModels = [];
  const store = providerStore({
    addProviders: async (providers) => {
      savedModels.push(...providers);
      return providers.map(({ apiKey, ...provider }, index) => ({
        ...provider,
        id: `saved-groq-free-${index}`,
        active: true,
        createdAt: "2026-10-02T00:00:00.000Z",
      }));
    },
  });
  const baseUrl = await startServer(t, {
    providerStore: store,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "openai/gpt-oss-120b",
              pricing: { prompt: "0.15", completion: "0.60" },
            },
            { id: "openai/gpt-oss-20b" },
            { id: "qwen/qwen3.8-27b" },
            { id: "llama-3.3-70b-versatile" },
            { id: "paid-model-not-on-free-list", pricing: { prompt: "0.01", completion: "0.02" } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const { cookie } = await login(baseUrl);

  const response = await fetch(`${baseUrl}/admin/api/providers/add-free-models`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      provider: "custom",
      name: "Groq",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "groq-free-plan-secret",
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(
    {
      modelsFound: payload.modelsFound,
      freeModelsFound: payload.freeModelsFound,
      addedCount: payload.addedCount,
      freePlanPolicy: payload.freePlanPolicy,
      groqFreePlanMatchedCount: payload.groqFreePlanMatchedCount,
      groqFreePlanAddedCount: payload.groqFreePlanAddedCount,
      unconfirmedModelsCount: payload.unconfirmedModelsCount,
    },
    {
      modelsFound: 5,
      freeModelsFound: 3,
      addedCount: 3,
      freePlanPolicy: "groq_free_plan",
      groqFreePlanMatchedCount: 3,
      groqFreePlanAddedCount: 3,
      unconfirmedModelsCount: 2,
    },
  );
  assert.deepEqual(
    savedModels.map((provider) => provider.model),
    ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
  );
  assert.equal(savedModels[0].modelMetadata.pricing.prompt, "0.15");
  assert.equal(savedModels[0].modelMetadata.freePlanAccess, "groq_free_plan");
  assert.ok(savedModels.every((provider) => provider.modelMetadata.freePlanAccess === "groq_free_plan"));
  assert.equal(JSON.stringify(payload).includes("groq-free-plan-secret"), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.groq.com/openai/v1/models");
  assert.equal(calls[0].options.method, "GET");
});

test("NVIDIA API Catalog imports models for quota-limited prototyping", async (t) => {
  const calls = [];
  const savedModels = [];
  const store = providerStore({
    addProviders: async (providers) => {
      savedModels.push(...providers);
      return providers.map(({ apiKey, ...provider }, index) => ({
        ...provider,
        id: `saved-nvidia-${index}`,
        active: true,
        createdAt: "2026-10-02T00:00:00.000Z",
      }));
    },
  });
  const baseUrl = await startServer(t, {
    providerStore: store,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify({
          data: [
            { id: "nvidia/llama-3.1-nemotron-70b-instruct" },
            {
              id: "meta/llama-3.3-70b-instruct",
              pricing: { prompt: "0.25", completion: "0.80" },
            },
            {
              id: "microsoft/phi-3.5-vision-instruct",
              pricing: { prompt: "0", completion: "0" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const { cookie } = await login(baseUrl);

  const response = await fetch(`${baseUrl}/admin/api/providers/add-free-models`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      provider: "custom",
      name: "NVIDIA",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: "nvidia-catalog-secret",
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(
    {
      modelsFound: payload.modelsFound,
      freeModelsFound: payload.freeModelsFound,
      addedCount: payload.addedCount,
      freePlanPolicy: payload.freePlanPolicy,
      nvidiaApiCatalogMatchedCount: payload.nvidiaApiCatalogMatchedCount,
      nvidiaApiCatalogAddedCount: payload.nvidiaApiCatalogAddedCount,
      unconfirmedModelsCount: payload.unconfirmedModelsCount,
    },
    {
      modelsFound: 3,
      freeModelsFound: 3,
      addedCount: 3,
      freePlanPolicy: "nvidia_api_catalog_prototyping",
      nvidiaApiCatalogMatchedCount: 3,
      nvidiaApiCatalogAddedCount: 3,
      unconfirmedModelsCount: 0,
    },
  );
  assert.deepEqual(
    savedModels.map((provider) => provider.model),
    [
      "nvidia/llama-3.1-nemotron-70b-instruct",
      "meta/llama-3.3-70b-instruct",
      "microsoft/phi-3.5-vision-instruct",
    ],
  );
  assert.ok(
    savedModels.every(
      (provider) =>
        provider.modelMetadata.freePlanAccess === "nvidia_api_catalog_prototyping",
    ),
  );
  assert.equal(JSON.stringify(payload).includes("nvidia-catalog-secret"), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://integrate.api.nvidia.com/v1/models");
  assert.equal(calls[0].options.method, "GET");
});

test("saving requires a model and declared capabilities, then stores a route configuration", async (t) => {
  let savedProvider;
  const store = providerStore({
    addProvider: async (value) => {
      savedProvider = value;
      return {
        id: PROVIDER_ID,
        provider: value.provider,
        name: value.name,
        baseUrl: value.baseUrl,
        model: value.model,
        active: true,
      capabilities: value.capabilities,
      priority: value.priority,
      modelMetadata: value.modelMetadata,
        createdAt: "2026-10-01T00:00:00.000Z",
      };
    },
  });
  const baseUrl = await startServer(t, { providerStore: store });
  const { cookie } = await login(baseUrl);

  const missingModel = await fetch(`${baseUrl}/admin/api/providers`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ provider: "openai", apiKey: "secret" }),
  });
  assert.equal(missingModel.status, 400);

  const missingCapabilities = await fetch(`${baseUrl}/admin/api/providers`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      provider: "openai",
      apiKey: "provider-secret-test",
      model: "gpt-test",
    }),
  });
  assert.equal(missingCapabilities.status, 400);

  const saved = await fetch(`${baseUrl}/admin/api/providers`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      provider: "openai",
      apiKey: "provider-secret-test",
      model: "gpt-test",
      capabilities: ["chat", "reasoning"],
      priority: 75,
      modelMetadata: { contextLength: 64_000, inputModalities: ["text"] },
    }),
  });
  const payloadText = await saved.text();
  assert.equal(saved.status, 201);
  assert.equal(savedProvider.apiKey, "provider-secret-test");
  assert.deepEqual(savedProvider.capabilities, ["chat", "reasoning"]);
  assert.equal(savedProvider.priority, 75);
  assert.equal(savedProvider.modelMetadata.contextLength, 64_000);
  assert.equal(JSON.parse(payloadText).provider.active, true);
  assert.equal(payloadText.includes("provider-secret-test"), false);
});

test("completion rejects a saved model without free eligibility and does not call a provider", async (t) => {
  let providerCalls = 0;
  let storeReads = 0;
  const store = providerStore({
    getActiveProviders: async () => {
      storeReads += 1;
      return [
        {
          id: PROVIDER_ID,
          provider: "custom",
          name: "Unknown pricing",
          baseUrl: "https://provider.example/v1",
          model: "unknown-price-model",
          active: true,
          priority: 50,
          modelMetadata: {},
          apiKey: "test-provider-key",
        },
      ];
    },
  });
  const baseUrl = await startServer(t, {
    providerStore: store,
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("Ineligible models must never call a provider.");
    },
  });
  const completion = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${APP_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "unknown-price-model",
      messages: [{ role: "user", content: "hello" }],
    }),
  });

  assert.equal(completion.status, 404);
  assert.equal((await completion.json()).error.code, "model_unavailable");
  assert.equal(providerCalls, 0);
  assert.equal(storeReads, 1);
});

test("provider list includes active capability routes ordered by priority", async (t) => {
  const store = providerStore({
    listProviders: async () => [
      {
        id: "lower-priority",
        provider: "groq",
        name: "Groq low",
        model: "model-low",
        active: true,
        capabilities: ["chat", "vision"],
        priority: 20,
      },
      {
        id: "higher-priority",
        provider: "openrouter",
        name: "OpenRouter high",
        model: "model-high",
        active: true,
        capabilities: ["chat"],
        priority: 80,
      },
      {
        id: "inactive",
        provider: "openai",
        name: "Inactive",
        model: "model-inactive",
        active: false,
        capabilities: ["chat"],
        priority: 100,
      },
    ],
  });
  const baseUrl = await startServer(t, { providerStore: store });
  const { cookie } = await login(baseUrl);
  const response = await fetch(`${baseUrl}/admin/api/providers`, {
    headers: { cookie },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(
    payload.routes.find((route) => route.capability === "chat").providers.map((provider) => provider.id),
    ["higher-priority", "lower-priority"],
  );
  assert.deepEqual(
    payload.routes.find((route) => route.capability === "vision").providers.map((provider) => provider.id),
    ["lower-priority"],
  );
});

test("provider list gives admins an actionable message when Supabase rejects its service key", async (t) => {
  const store = providerStore({
    listProviders: async () => {
      const error = new Error("Supabase provider storage request failed (HTTP 401).");
      error.statusCode = 401;
      throw error;
    },
  });
  const baseUrl = await startServer(t, { providerStore: store });
  const { cookie } = await login(baseUrl);
  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (message) => loggedErrors.push(message);

  try {
    const response = await fetch(`${baseUrl}/admin/api/providers`, {
      headers: { cookie },
    });
    const payload = await response.json();
    assert.equal(response.status, 502);
    assert.equal(
      payload.error.message,
      "Supabase rechazó la clave de servicio configurada en Router IA.",
    );
    assert.deepEqual(loggedErrors, ["Router IA provider list failed (storage HTTP 401)."]);
  } finally {
    console.error = originalConsoleError;
  }
});