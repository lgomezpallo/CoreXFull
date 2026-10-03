import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CreateRouterProviderBody,
  ListRouterProvidersResponse,
  UpdateRouterProviderBody,
} from "@workspace/api-zod";

test("accepts Router IA's Groq provider input without a per-provider key", () => {
  const result = CreateRouterProviderBody.safeParse({
    name: "Groq",
    kind: "groq",
    model: "llama-test",
    isDefault: true,
  });
  assert.equal(result.success, true);
});

test("matches Router IA provider limits before proxying the request", () => {
  const tooHighPriority = CreateRouterProviderBody.safeParse({
    name: "OpenAI",
    kind: "openai",
    model: "gpt-test",
    apiKey: "test-only-provider-key",
    isDefault: true,
    priority: 101,
  });
  const tooLongName = CreateRouterProviderBody.safeParse({
    name: "x".repeat(81),
    kind: "openai",
    model: "gpt-test",
    apiKey: "test-only-provider-key",
    isDefault: true,
  });
  const clearsUrlWithUnsupportedNull = UpdateRouterProviderBody.safeParse({
    baseUrl: null,
  });

  assert.equal(tooHighPriority.success, false);
  assert.equal(tooLongName.success, false);
  assert.equal(clearsUrlWithUnsupportedNull.success, false);
});

test("accepts Router IA response capabilities for fast and long-context providers", () => {
  const result = ListRouterProvidersResponse.safeParse([
    {
      id: "3a03fd33-3b2b-4c11-a338-41e55b55ed11",
      name: "Fast model",
      kind: "openai-compatible",
      baseUrl: "https://provider.example.test/v1",
      model: "fast-test",
      apiKeyPreview: "test••••••1234",
      isDefault: true,
      capabilities: ["fast", "long_context"],
      priority: 100,
      isActive: true,
      status: "connected",
      healthStatus: "healthy",
      lastTestAt: null,
      consecutiveFailures: 0,
      cooldownUntil: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
  ]);

  assert.equal(result.success, true);
});