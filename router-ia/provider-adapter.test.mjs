import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverModels,
  GROQ_FREE_PLAN_MODEL_IDS,
  inferModelCapabilities,
  isExplicitlyFreeModel,
  isGroqFreePlanBaseUrl,
  isGroqFreePlanModel,
  isNvidiaApiCatalogBaseUrl,
  normalizeProviderInput,
  normalizeModelMetadata,
} from "./provider-adapter.mjs";

test("catalog discovery uses GET only and retains whitelisted provider metadata", async () => {
  const calls = [];
  const result = await discoverModels({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "provider-secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "provider/model",
              context_length: 128_000,
              architecture: {
                input_modalities: ["text", "image"],
                output_modalities: ["text"],
              },
              supported_parameters: ["temperature", "max_tokens"],
              pricing: { prompt: "0", completion: "0" },
              private_data: "must not reach the admin panel",
            },
            { id: "provider/model" },
            "text-only-model",
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models, [
    {
      id: "provider/model",
      contextLength: 128_000,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportedParameters: ["temperature", "max_tokens"],
      pricing: { prompt: "0", completion: "0" },
    },
    { id: "text-only-model" },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/models");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.authorization, "Bearer provider-secret");
});

test("provider input validates capability assignments and priority", () => {
  const normalized = normalizeProviderInput({
    provider: "openai",
    apiKey: "provider-secret",
    model: "gpt-model",
    capabilities: ["chat", "vision", "chat"],
    priority: "80",
    modelMetadata: {
      contextLength: 64_000,
      inputModalities: ["text", "image"],
      pricing: { prompt: "0", completion: "0", hidden: "no" },
      freePlanAccess: "spoofed_value",
    },
  });

  assert.deepEqual(normalized.capabilities, ["chat", "vision"]);
  assert.equal(normalized.priority, 80);
  assert.deepEqual(normalized.modelMetadata, {
    contextLength: 64_000,
    inputModalities: ["text", "image"],
  });
  assert.throws(
    () =>
      normalizeProviderInput({
        provider: "openai",
        apiKey: "provider-secret",
        model: "gpt-model",
        capabilities: ["unknown"],
      }),
    /capacidades seleccionadas no son válidas/,
  );
  assert.throws(
    () =>
      normalizeProviderInput({
        provider: "openai",
        apiKey: "provider-secret",
        model: "gpt-model",
        capabilities: ["chat"],
        priority: 101,
      }),
    /prioridad/,
  );
});

test("untrusted metadata is reduced to bounded fields", () => {
  assert.deepEqual(
    normalizeModelMetadata({
      contextLength: Number.MAX_SAFE_INTEGER + 1,
      inputModalities: ["text", "x".repeat(65), 2],
      pricing: { prompt: "0", completion: "free", request: 0 },
      privateKey: "do not store",
      freePlanAccess: "spoofed_value",
    }),
    {
      inputModalities: ["text"],
    },
  );
});

test("a model is explicitly free only when prompt, completion, and every published price are zero", () => {
  assert.equal(isExplicitlyFreeModel({}), false);
  assert.equal(isExplicitlyFreeModel({ pricing: {} }), false);
  assert.equal(isExplicitlyFreeModel({ pricing: { prompt: "0" } }), false);
  assert.equal(isExplicitlyFreeModel({ pricing: { completion: "0" } }), false);
  assert.equal(
    isExplicitlyFreeModel({ pricing: { prompt: "0", completion: "0", image: "0.01" } }),
    false,
  );
  assert.equal(
    isExplicitlyFreeModel({ pricing: { prompt: "0.001", completion: "0" } }),
    false,
  );
  assert.equal(
    isExplicitlyFreeModel({ pricing: { prompt: "free", completion: "0" } }),
    false,
  );
  assert.equal(
    isExplicitlyFreeModel({ pricing: { prompt: "0", completion: "0", request: 0 } }),
    true,
  );
});

test("Groq Free plan matching uses the official model list and exact API base URL", () => {
  const baseUrl = "https://api.groq.com/openai/v1";
  assert.equal(GROQ_FREE_PLAN_MODEL_IDS.length, 10);
  assert.equal(isGroqFreePlanBaseUrl(baseUrl), true);
  assert.equal(isGroqFreePlanBaseUrl(`${baseUrl}/`), true);
  assert.equal(isGroqFreePlanBaseUrl("https://api.groq.com.attacker.example/openai/v1"), false);
  assert.equal(isGroqFreePlanBaseUrl("https://api.groq.com/openai/v1?plan=free"), false);
  assert.equal(isGroqFreePlanModel({ id: "OPENAI/GPT-OSS-20B" }, baseUrl), true);
  assert.equal(isGroqFreePlanModel({ id: "llama-3.3-70b-versatile" }, baseUrl), false);
  assert.equal(
    isGroqFreePlanModel({ id: "openai/gpt-oss-20b" }, "https://api.example.com/openai/v1"),
    false,
  );
});

test("NVIDIA API Catalog recognition requires its exact HTTPS base URL", () => {
  const baseUrl = "https://integrate.api.nvidia.com/v1";
  assert.equal(isNvidiaApiCatalogBaseUrl(baseUrl), true);
  assert.equal(isNvidiaApiCatalogBaseUrl(`${baseUrl}/`), true);
  assert.equal(isNvidiaApiCatalogBaseUrl("https://integrate.api.nvidia.com.attacker.example/v1"), false);
  assert.equal(isNvidiaApiCatalogBaseUrl("http://integrate.api.nvidia.com/v1"), false);
  assert.equal(isNvidiaApiCatalogBaseUrl("https://integrate.api.nvidia.com/v1?mode=paid"), false);
  assert.equal(isNvidiaApiCatalogBaseUrl("https://api.nvidia.com/v1"), false);
});

test("provider normalization preserves only trusted Groq and NVIDIA access labels", () => {
  const nvidia = normalizeProviderInput({
    provider: "custom",
    name: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey: "provider-secret",
    model: "nvidia/llama-3.1-nemotron-70b-instruct",
    modelMetadata: { freePlanAccess: "nvidia_api_catalog_prototyping" },
  });
  assert.equal(
    nvidia.modelMetadata.freePlanAccess,
    "nvidia_api_catalog_prototyping",
  );

  const groq = normalizeProviderInput({
    provider: "custom",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: "provider-secret",
    model: "openai/gpt-oss-20b",
    modelMetadata: { freePlanAccess: "groq_free_plan" },
  });
  assert.equal(groq.modelMetadata.freePlanAccess, "groq_free_plan");

  const unrelated = normalizeProviderInput({
    provider: "custom",
    name: "Other",
    baseUrl: "https://api.otherprovider.com/v1",
    apiKey: "provider-secret",
    model: "other/model",
    modelMetadata: { freePlanAccess: "nvidia_api_catalog_prototyping" },
  });
  assert.equal(unrelated.modelMetadata.freePlanAccess, undefined);
});

test("model capabilities are inferred from normalized modalities and context length", () => {
  assert.deepEqual(
    inferModelCapabilities({
      inputModalities: ["TEXT", "image", "pdf"],
      outputModalities: ["text"],
      contextLength: 100_000,
    }),
    ["chat", "vision", "document", "long_context"],
  );
  assert.deepEqual(
    inferModelCapabilities({
      inputModalities: ["audio"],
      outputModalities: ["audio"],
      contextLength: 99_999,
    }),
    [],
  );
});