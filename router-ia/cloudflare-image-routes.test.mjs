import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createCloudflareImageHandler } from "./cloudflare-image-routes.mjs";

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
  const handler = createCloudflareImageHandler({
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

function jsonImageResponse() {
  return new Response(JSON.stringify({ result: { image: "aGVsbG8=" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("router-auto prefers FLUX.1 Schnell and normalizes image output", async () => {
  const calls = [];
  const { server, url } = await startServer({
    providers: [
      provider("@cf/black-forest-labs/flux-2-klein-4b", ["image_generation", "image_editing"]),
      provider("@cf/black-forest-labs/flux-1-schnell", ["image_generation"]),
    ],
    fetchImpl: async (requestUrl, options) => {
      calls.push({ requestUrl, options });
      return jsonImageResponse();
    },
  });
  try {
    const response = await fetch(`${url}/api/v1/images/generations`, {
      method: "POST",
      headers: { authorization: "Bearer router-test-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "router-ia-auto", prompt: "red circle" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data[0].b64_json, "aGVsbG8=");
    assert.equal(body.router.capability, "image_generation");
    assert.match(calls[0].requestUrl, /flux-1-schnell$/);
    assert.equal(typeof calls[0].options.body, "string");
  } finally {
    server.close();
  }
});

test("explicit FLUX.2 edit maps image to input_image_0", async () => {
  let upstreamForm = null;
  let upstreamUrl = "";
  const { server, url } = await startServer({
    providers: [provider("@cf/black-forest-labs/flux-2-klein-4b", ["image_generation", "image_editing"])],
    fetchImpl: async (requestUrl, options) => {
      upstreamUrl = requestUrl;
      upstreamForm = options.body;
      return jsonImageResponse();
    },
  });
  try {
    const form = new FormData();
    form.set("model", "@cf/black-forest-labs/flux-2-klein-4b");
    form.set("prompt", "make it blue");
    form.set("image", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "input.png");
    const response = await fetch(`${url}/api/v1/images/edits`, {
      method: "POST",
      headers: { authorization: "Bearer router-test-token" },
      body: form,
    });
    assert.equal(response.status, 200);
    assert.match(upstreamUrl, /flux-2-klein-4b$/);
    assert.equal(upstreamForm instanceof FormData, true);
    assert.equal(upstreamForm.get("prompt"), "make it blue");
    assert.equal(upstreamForm.get("input_image_0") instanceof File, true);
  } finally {
    server.close();
  }
});

test("unavailable explicit image model returns 404 and never falls through", async () => {
  let upstreamCalled = false;
  const { server, url } = await startServer({
    providers: [provider("@cf/black-forest-labs/flux-1-schnell", ["image_generation"])],
    fetchImpl: async () => {
      upstreamCalled = true;
      return jsonImageResponse();
    },
  });
  try {
    const response = await fetch(`${url}/api/v1/images/generations`, {
      method: "POST",
      headers: { authorization: "Bearer router-test-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "missing/model", prompt: "red circle" }),
    });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, "model_unavailable");
    assert.equal(upstreamCalled, false);
  } finally {
    server.close();
  }
});
