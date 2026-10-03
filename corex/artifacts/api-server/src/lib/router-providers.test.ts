import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
// @ts-expect-error The workspace test runner bundles TypeScript extensions explicitly.
import { createProvider, deleteProvider, listProviders, RouterProviderApiError, updateProvider } from "./router-providers.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ROUTER_IA_URL;
  delete process.env.ROUTER_IA_TOKEN;
  delete process.env.ROUTER_URL;
  delete process.env.ROUTER_APP_KEY;
});

const provider = {
  id: "provider-123",
  name: "Primary",
  kind: "openai",
  baseUrl: null,
  model: "gpt-test",
  apiKeyPreview: "sk-te••••••1234",
  isDefault: true,
  capabilities: ["chat"],
  priority: 50,
  isActive: true,
  status: "untested",
  healthStatus: "available",
  lastTestAt: null,
};

test("lists providers from Router IA using the signed-in Supabase bearer token", async () => {
  process.env.ROUTER_IA_URL = "https://router.example.test/api/v1/chat/completions";
  let requestUrl = "";
  let requestHeaders: Headers | undefined;

  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify([provider]), { status: 200 });
  }) as typeof fetch;

  const result = await listProviders("local-supabase-session");

  assert.deepEqual(result, [provider]);
  assert.equal(requestUrl, "https://router.example.test/api/providers");
  assert.equal(requestHeaders?.get("authorization"), "Bearer local-supabase-session");
  assert.equal(requestHeaders?.get("cache-control"), "no-store");
});

test("creates providers only through Router IA and does not retain the submitted key", async () => {
  process.env.ROUTER_URL = "https://router.example.test";
  const input = {
    name: "Primary",
    kind: "openai",
    model: "gpt-test",
    apiKey: "provider-key-used-only-in-this-test",
  };
  let requestUrl = "";
  let requestBody: Record<string, unknown> | undefined;

  globalThis.fetch = (async (inputUrl, init) => {
    requestUrl = String(inputUrl);
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(provider), { status: 201 });
  }) as typeof fetch;

  const result = await createProvider("local-supabase-session", input);

  assert.equal(requestUrl, "https://router.example.test/api/providers");
  assert.equal(requestBody?.apiKey, input.apiKey);
  assert.deepEqual(result, provider);
});

test("redacts a provider key if Router IA echoes it in an error response", async () => {
  process.env.ROUTER_URL = "https://router.example.test";
  const apiKey = "provider-key-used-only-in-this-test";
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ error: `Rejected ${apiKey}` }),
    { status: 400 },
  )) as typeof fetch;

  await assert.rejects(
    createProvider("local-supabase-session", { apiKey }),
    (error: unknown) => {
      assert.ok(error instanceof RouterProviderApiError);
      assert.equal(error.statusCode, 400);
      assert.doesNotMatch(error.message, new RegExp(apiKey));
      assert.match(error.message, /\[redactado\]/);
      return true;
    },
  );
});

test("updates and deletes providers on their Router IA routes", async () => {
  process.env.ROUTER_URL = "https://router.example.test";
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), method: String(init?.method) });
    return init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(provider), { status: 200 });
  }) as typeof fetch;

  await updateProvider("local-supabase-session", "provider-123", { priority: 10 });
  await deleteProvider("local-supabase-session", "provider-123");

  assert.deepEqual(calls, [
    {
      url: "https://router.example.test/api/providers/provider-123",
      method: "PATCH",
    },
    {
      url: "https://router.example.test/api/providers/provider-123",
      method: "DELETE",
    },
  ]);
});