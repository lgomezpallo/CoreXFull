import assert from "node:assert/strict";
import test from "node:test";
import { buildCapabilityRoutes } from "./provider-capabilities.mjs";

test("routes include only active providers with the requested capability", () => {
  const routes = buildCapabilityRoutes([
    {
      id: "groq-primary",
      provider: "groq",
      name: "Groq primary",
      model: "model-a",
      capabilities: ["chat", "vision"],
      priority: 90,
      active: true,
    },
    {
      id: "openrouter-secondary",
      provider: "openrouter",
      name: "OpenRouter secondary",
      model: "model-b",
      capabilities: ["chat"],
      priority: 50,
      active: true,
    },
    {
      id: "inactive",
      provider: "openai",
      name: "Inactive",
      model: "model-c",
      capabilities: ["chat", "coding"],
      priority: 100,
      active: false,
    },
  ]);

  assert.deepEqual(
    routes.find((route) => route.capability === "chat").providers.map(({ id }) => id),
    ["groq-primary", "openrouter-secondary"],
  );
  assert.deepEqual(
    routes.find((route) => route.capability === "vision").providers.map(({ id }) => id),
    ["groq-primary"],
  );
  assert.deepEqual(
    routes.find((route) => route.capability === "document").providers,
    [],
  );
});