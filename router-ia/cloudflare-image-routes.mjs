import { timingSafeEqual } from "node:crypto";
import { isCloudflareWorkersAiBaseUrl } from "./provider-adapter.mjs";

const MAX_JSON_BYTES = 1_048_576;
const MAX_MULTIPART_BYTES = 12_582_912;
const MAX_IMAGE_BYTES = 20_971_520;

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function validToken(request, expected) {
  const authorization = request.headers.authorization;
  if (!expected || typeof authorization !== "string") return false;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) return false;
  const supplied = Buffer.from(match[1], "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

async function readBuffer(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Request too large."), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const buffer = await readBuffer(request, MAX_JSON_BYTES);
  const value = JSON.parse(buffer.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("Invalid JSON body."), { statusCode: 400 });
  return value;
}

async function readForm(request) {
  const contentType = request.headers["content-type"] ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw Object.assign(new Error("Content-Type must be multipart/form-data."), { statusCode: 415 });
  const buffer = await readBuffer(request, MAX_MULTIPART_BYTES);
  return new Request("http://router.local/upload", { method: "POST", headers: { "content-type": contentType }, body: buffer }).formData();
}

function isEligibleCloudflare(provider, capability) {
  return provider?.active === true &&
    isCloudflareWorkersAiBaseUrl(provider.baseUrl) &&
    Array.isArray(provider.capabilities) &&
    provider.capabilities.includes(capability) &&
    provider.modelMetadata?.freePlanAccess === "cloudflare_workers_ai_free" &&
    typeof provider.apiKey === "string" && provider.apiKey.length > 0;
}

function verificationRank(provider, capability) {
  const status = provider?.modelMetadata?.capabilityVerification?.checks?.[capability]?.status;
  if (status === "verified") return 3;
  if (status === "blocked" || status === "retired" || status === "unsupported") return 0;
  return 2;
}

function generationPreference(model) {
  if (model === "@cf/black-forest-labs/flux-1-schnell") return 40;
  if (model === "@cf/black-forest-labs/flux-2-klein-4b") return 30;
  if (model === "@cf/black-forest-labs/flux-2-klein-9b") return 20;
  return 10;
}

function selectProvider(providers, capability, requestedModel) {
  const eligible = providers.filter((provider) => isEligibleCloudflare(provider, capability));
  if (requestedModel && requestedModel !== "router-ia-auto") return eligible.find((provider) => provider.model === requestedModel) ?? null;
  return eligible
    .filter((provider) => verificationRank(provider, capability) > 0)
    .sort((a, b) => {
      const verified = verificationRank(b, capability) - verificationRank(a, capability);
      if (verified) return verified;
      const priority = (Number(b.priority) || 0) - (Number(a.priority) || 0);
      if (priority) return priority;
      return generationPreference(b.model) - generationPreference(a.model);
    })[0] ?? null;
}

async function readUpstreamImage(upstream) {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (/^image\//i.test(contentType)) {
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Provider image response is too large.");
    return { base64: bytes.toString("base64"), mime: contentType.split(";")[0] };
  }
  const payload = await upstream.json();
  const result = payload?.result ?? payload;
  const encoded = typeof result === "string"
    ? result
    : typeof result?.image === "string"
      ? result.image
      : typeof payload?.image === "string"
        ? payload.image
        : null;
  if (!encoded || encoded.length > MAX_IMAGE_BYTES * 2) throw new Error("Provider did not return image data.");
  return { base64: encoded.replace(/^data:image\/[^;]+;base64,/, ""), mime: "image/jpeg" };
}

async function providerError(upstream) {
  try {
    const payload = await upstream.json();
    return payload?.errors?.[0]?.message ?? payload?.error?.message ?? `Cloudflare HTTP ${upstream.status}`;
  } catch {
    return `Cloudflare HTTP ${upstream.status}`;
  }
}

async function runGeneration(provider, prompt, options, fetchImpl) {
  const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/run/${provider.model}`;
  let requestOptions;
  if (/flux-2-(?:dev|klein)/i.test(provider.model)) {
    const form = new FormData();
    form.set("prompt", prompt);
    if (Number.isInteger(options.width)) form.set("width", String(options.width));
    if (Number.isInteger(options.height)) form.set("height", String(options.height));
    if (Number.isInteger(options.seed)) form.set("seed", String(options.seed));
    requestOptions = { method: "POST", headers: { authorization: `Bearer ${provider.apiKey}` }, body: form };
  } else {
    requestOptions = {
      method: "POST",
      headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt, ...(Number.isInteger(options.seed) ? { seed: options.seed } : {}), ...(Number.isInteger(options.steps) ? { steps: options.steps } : {}) }),
    };
  }
  const upstream = await fetchImpl(endpoint, { ...requestOptions, redirect: "error", signal: AbortSignal.timeout(90_000) });
  if (!upstream.ok) throw Object.assign(new Error(await providerError(upstream)), { statusCode: upstream.status });
  return readUpstreamImage(upstream);
}

async function runEdit(provider, prompt, image, fetchImpl) {
  const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/run/${provider.model}`;
  const form = new FormData();
  form.set("prompt", prompt);
  form.set("input_image_0", image, image.name || "input.png");
  const upstream = await fetchImpl(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${provider.apiKey}` },
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(90_000),
  });
  if (!upstream.ok) throw Object.assign(new Error(await providerError(upstream)), { statusCode: upstream.status });
  return readUpstreamImage(upstream);
}

export function createCloudflareImageHandler({ appToken, providerStore, fetchImpl = globalThis.fetch }) {
  return async function handleCloudflareImage(request, response, url) {
    const generation = request.method === "POST" && url.pathname === "/api/v1/images/generations";
    const editing = request.method === "POST" && url.pathname === "/api/v1/images/edits";
    if (!generation && !editing) return false;
    if (!validToken(request, appToken)) {
      request.resume();
      sendJson(response, 401, { error: { code: "unauthorized", message: "Unauthorized." } });
      return true;
    }
    try {
      const providers = await providerStore.getActiveProviders();
      if (generation) {
        const body = await readJson(request);
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt || prompt.length > 2048) throw Object.assign(new Error("Provide an image prompt."), { statusCode: 400 });
        const model = typeof body.model === "string" ? body.model.trim() : "router-ia-auto";
        const provider = selectProvider(providers, "image_generation", model);
        if (!provider) return false;
        const image = await runGeneration(provider, prompt, body, fetchImpl);
        sendJson(response, 200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: image.base64 }], model: "router-ia-auto", router: { capability: "image_generation" } });
        return true;
      }

      const form = await readForm(request);
      const prompt = typeof form.get("prompt") === "string" ? form.get("prompt").trim() : "";
      const image = form.get("image");
      const modelValue = form.get("model");
      const model = typeof modelValue === "string" ? modelValue.trim() : "router-ia-auto";
      if (!prompt || !(image instanceof File)) throw Object.assign(new Error("Provide prompt and image."), { statusCode: 400 });
      const provider = selectProvider(providers, "image_editing", model);
      if (!provider) return false;
      const output = await runEdit(provider, prompt, image, fetchImpl);
      sendJson(response, 200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: output.base64 }], model: "router-ia-auto", router: { capability: "image_editing" } });
      return true;
    } catch (error) {
      sendJson(response, Number.isInteger(error?.statusCode) ? error.statusCode : 502, { error: { code: "cloudflare_image_failed", message: error?.message ?? "Cloudflare image request failed." } });
      return true;
    }
  };
}
