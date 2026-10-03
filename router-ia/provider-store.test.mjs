import assert from "node:assert/strict";
import test from "node:test";
import { createSupabaseProviderStore } from "./provider-store.mjs";

const SUPABASE_KEY = "test-supabase-service-role";
const ENCRYPTION_KEY = "8a".repeat(32);
const API_KEY = "provider-api-key-that-must-not-be-stored-in-plain-text";
const PROVIDER_ID = "c05d7c85-4614-4fd4-9465-5096677c6f45";

test("provider credentials are encrypted before storage and only decrypted for active providers", async () => {
  let storedRow;
  const calls = [];
  const store = createSupabaseProviderStore({
    supabaseUrl: "https://router-project.supabase.co",
    serviceRoleKey: SUPABASE_KEY,
    encryptionKey: ENCRYPTION_KEY,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === "POST" && url.includes("router_ia_providers?select=")) {
        const inserted = JSON.parse(options.body);
        assert.equal(inserted.api_key_ciphertext.includes(API_KEY), false);
        storedRow = {
          id: PROVIDER_ID,
          provider: inserted.provider,
          name: inserted.name,
          base_url: inserted.base_url,
          model: inserted.model,
          api_key_ciphertext: inserted.api_key_ciphertext,
          api_key_iv: inserted.api_key_iv,
          api_key_tag: inserted.api_key_tag,
          is_active: true,
          capabilities: inserted.capabilities,
          priority: inserted.priority,
          model_metadata: inserted.model_metadata,
          catalog_checked_at: "2026-10-02T00:00:00.000Z",
          created_at: "2026-10-01T00:00:00.000Z",
        };
        return new Response(
          JSON.stringify([storedRow]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (options.method === "GET" && url.includes("is_active=eq.true")) {
        return new Response(JSON.stringify([storedRow, { ...storedRow, id: "another-provider" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/rpc/router_ia_activate_provider")) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/rpc/router_ia_deactivate_provider")) {
        return new Response(null, { status: 204 });
      }
      if (options.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`Unexpected store request: ${url}`);
    },
  });

  const saved = await store.addProvider({
    provider: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-test",
    apiKey: API_KEY,
    capabilities: ["chat", "vision"],
    priority: 80,
    modelMetadata: { contextLength: 128_000, inputModalities: ["text", "image"] },
  });
  assert.equal(saved.id, PROVIDER_ID);
  assert.equal(saved.active, true);
  assert.deepEqual(saved.capabilities, ["chat", "vision"]);
  assert.equal(saved.priority, 80);
  assert.equal(saved.modelMetadata.contextLength, 128_000);
  assert.equal(JSON.stringify(saved).includes(API_KEY), false);

  const active = await store.getActiveProviders();
  assert.equal(active.length, 2);
  assert.equal(active[0].apiKey, API_KEY);
  assert.equal(active[0].model, "llama-test");
  assert.equal(active[0].active, true);

  await store.activateProvider(PROVIDER_ID);
  await store.deactivateProvider(PROVIDER_ID);
  await store.deleteProvider(PROVIDER_ID);
  assert.ok(calls.every(({ options }) => options.headers.apikey === SUPABASE_KEY));
  assert.ok(calls.every(({ options }) => options.headers.authorization === `Bearer ${SUPABASE_KEY}`));
});

test("addProviders posts an encrypted PostgREST array and returns public provider rows", async () => {
  const apiKeys = ["first-provider-secret", "second-provider-secret"];
  const calls = [];
  let insertedRows;
  const store = createSupabaseProviderStore({
    supabaseUrl: "https://router-project.supabase.co",
    serviceRoleKey: SUPABASE_KEY,
    encryptionKey: ENCRYPTION_KEY,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === "POST") {
        insertedRows = JSON.parse(options.body);
        assert.ok(Array.isArray(insertedRows));
        return new Response(
          JSON.stringify(
            insertedRows.map((row, index) => ({
              id: `bulk-provider-${index}`,
              ...row,
              catalog_checked_at: null,
              created_at: `2026-10-0${index + 1}T00:00:00.000Z`,
            })),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected store request: ${url}`);
    },
  });

  const saved = await store.addProviders([
    {
      provider: "groq",
      name: "Groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "free-model-one",
      apiKey: apiKeys[0],
      capabilities: ["chat"],
      priority: 50,
      modelMetadata: { pricing: { prompt: "0", completion: "0" } },
    },
    {
      provider: "openrouter",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "free-model-two",
      apiKey: apiKeys[1],
      capabilities: ["vision"],
      priority: 50,
      modelMetadata: { inputModalities: ["image"] },
    },
  ]);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rest\/v1\/router_ia_providers\?select=/);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.prefer, "return=representation");
  assert.equal(insertedRows.length, 2);
  for (const [index, row] of insertedRows.entries()) {
    assert.equal(row.api_key_ciphertext.includes(apiKeys[index]), false);
    assert.ok(row.api_key_ciphertext);
    assert.ok(row.api_key_iv);
    assert.ok(row.api_key_tag);
    assert.equal(row.is_active, true);
    assert.equal(row.api_key, undefined);
  }
  assert.deepEqual(
    saved.map(({ id, provider, model, active, capabilities, baseUrl }) => ({
      id,
      provider,
      model,
      active,
      capabilities,
      baseUrl,
    })),
    [
      {
        id: "bulk-provider-0",
        provider: "groq",
        model: "free-model-one",
        active: true,
        capabilities: ["chat"],
        baseUrl: "https://api.groq.com/openai/v1",
      },
      {
        id: "bulk-provider-1",
        provider: "openrouter",
        model: "free-model-two",
        active: true,
        capabilities: ["vision"],
        baseUrl: "https://openrouter.ai/api/v1",
      },
    ],
  );
  assert.equal(JSON.stringify(saved).includes(apiKeys[0]), false);
  assert.equal(JSON.stringify(saved).includes(apiKeys[1]), false);
  assert.equal(saved[0].modelMetadata.pricing.prompt, "0");
});

test("provider storage rejects a URL with a non-root path or query", () => {
  assert.throws(
    () =>
      createSupabaseProviderStore({
        supabaseUrl: "https://router-project.supabase.co/path",
        serviceRoleKey: SUPABASE_KEY,
        encryptionKey: ENCRYPTION_KEY,
      }),
    /Supabase URL/,
  );
  assert.throws(
    () =>
      createSupabaseProviderStore({
        supabaseUrl: "https://router-project.supabase.co/?override=1",
        serviceRoleKey: SUPABASE_KEY,
        encryptionKey: ENCRYPTION_KEY,
      }),
    /Supabase URL/,
  );
});

test("provider storage preserves the upstream HTTP status without exposing its response body", async () => {
  const store = createSupabaseProviderStore({
    supabaseUrl: "https://router-project.supabase.co",
    serviceRoleKey: SUPABASE_KEY,
    encryptionKey: ENCRYPTION_KEY,
    fetchImpl: async () =>
      new Response(JSON.stringify({ message: "Invalid API key" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    store.listProviders(),
    (error) =>
      error.statusCode === 401 &&
      /HTTP 401/.test(error.message) &&
      !error.message.includes("Invalid API key"),
  );
});