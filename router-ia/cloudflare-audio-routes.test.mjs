import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createCloudflareAudioHandler } from "./cloudflare-audio-routes.mjs";

const BASE = "https://api.cloudflare.com/client/v4/accounts/993afa8220ecc4281e5b351f3fb41b3f/ai";

function provider(model, capabilities) {
  return {
    active: true,
    baseUrl: BASE,
    apiKey: "cf-test-token",
    model,
    capabilities,
    priority: 50,
    modelMetadata: { freePlanAccess: "cloudflare_workers_ai_free" },
  };
}

async function startServer({ providers, fetchImpl }) {
  const handler = createCloudflareAudioHandler({
    appToken: "router-test-token",
    providerStore: { async getActiveProviders() { return providers; } },
    fetchImpl,
  });
  const server = http.createServer(async (request, response) => {
    const handled = await handler(request, response, new URL(request.url, "http://localhost"));
    if (!handled) {
      response.writeHead(418, { "content-type": "application/json" });
      response.end(JSON.stringify({ fellThrough: true }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}` };
}

test("speech maps OpenAI-ish input to Aura 2 ES", async () => {
  let upstreamUrl = "";
  let upstreamBody = null;
  const { server, url } = await startServer({
    providers: [provider("@cf/deepgram/aura-2-es", ["speech"])],
    fetchImpl: async (requestUrl, options) => {
      upstreamUrl = requestUrl;
      upstreamBody = JSON.parse(options.body);
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    },
  });
  try {
    const response = await fetch(`${url}/api/v1/audio/speech`, {
      method: "POST",
      headers: { authorization: "Bearer router-test-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "@cf/deepgram/aura-2-es", input: "Hola mundo", voice: "javier", response_format: "mp3" }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/mpeg");
    assert.match(upstreamUrl, /aura-2-es$/);
    assert.deepEqual(upstreamBody, { text: "Hola mundo", speaker: "javier", encoding: "mp3" });
  } finally {
    server.close();
  }
});

test("transcription maps multipart audio to Cloudflare base64 JSON", async () => {
  let upstreamBody = null;
  const { server, url } = await startServer({
    providers: [provider("@cf/openai/whisper-large-v3-turbo", ["transcription"])],
    fetchImpl: async (_requestUrl, options) => {
      upstreamBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ result: { text: "hola" } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    const form = new FormData();
    form.set("model", "@cf/openai/whisper-large-v3-turbo");
    form.set("language", "es");
    form.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }), "probe.wav");
    const response = await fetch(`${url}/api/v1/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: "Bearer router-test-token" },
      body: form,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "hola" });
    assert.equal(upstreamBody.audio, Buffer.from([1, 2, 3]).toString("base64"));
    assert.equal(upstreamBody.task, "transcribe");
    assert.equal(upstreamBody.language, "es");
  } finally {
    server.close();
  }
});

test("missing explicit Cloudflare audio model returns 404", async () => {
  let called = false;
  const { server, url } = await startServer({
    providers: [provider("@cf/deepgram/aura-2-es", ["speech"])],
    fetchImpl: async () => {
      called = true;
      return new Response(new Uint8Array([1]), { status: 200 });
    },
  });
  try {
    const response = await fetch(`${url}/api/v1/audio/speech`, {
      method: "POST",
      headers: { authorization: "Bearer router-test-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "missing/model", input: "hola" }),
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "model_unavailable");
    assert.equal(called, false);
  } finally {
    server.close();
  }
});
