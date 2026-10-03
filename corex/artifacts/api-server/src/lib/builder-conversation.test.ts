import assert from "node:assert/strict";
import test from "node:test";
import { BuilderConversationBody, BuilderConversationResponse } from "@workspace/api-zod";
import { converseAboutApp } from "./builder-conversation";

const input = { prompt: "Sí", designBrief: "App para una cafetería, para el encargado. Falta definir el flujo.", previousBlueprint: null, history: [{ role: "user" as const, content: "Es para mi cafetería" }], referenceFiles: [] };

test("conversation accepts short answers and validates its own bounded response", () => {
  assert.equal(BuilderConversationBody.parse(input).prompt, "Sí");
  assert.equal(BuilderConversationBody.safeParse({ ...input, prompt: " " }).success, false);
  assert.equal(BuilderConversationResponse.safeParse({ assistantMessage: "¿Qué necesita hacer el encargado?", designBrief: input.designBrief, readyToBuild: "yes" }).success, false);
});

test("continuing the chat preserves build availability without generating a blueprint", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.ROUTER_IA_TOKEN;
  const originalUrl = process.env.ROUTER_IA_URL;
  process.env.ROUTER_IA_TOKEN = "conversation-test-token";
  process.env.ROUTER_IA_URL = "https://router.example";
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.ROUTER_IA_TOKEN; else process.env.ROUTER_IA_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.ROUTER_IA_URL; else process.env.ROUTER_IA_URL = originalUrl;
  });
  let completions = 0;
  globalThis.fetch = async (_url, options) => {
    if (options?.method !== "POST") return new Response(null, { status: 204 });
    completions += 1;
    const body = JSON.parse(String(options.body));
    assert.equal(body.task_type, "chat");
    assert.deepEqual(body.response_format, { type: "json_object" });
    const context = JSON.parse(body.messages[1].content);
    assert.equal(context.designBrief, input.designBrief);
    assert.deepEqual(body.messages.slice(2, -1), input.history);
    assert.deepEqual(body.messages.at(-1), { role: "user", content: "Sí" });
    assert.equal("history" in context, false);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ assistantMessage: "¿Qué necesita hacer el encargado?", designBrief: input.designBrief, readyToBuild: false }) } }] });
  };
  const result = await converseAboutApp({ ...input, readyToBuild: true });
  assert.equal(result.readyToBuild, true);
  assert.equal(completions, 1);
  assert.equal("blueprint" in result, false);
});
