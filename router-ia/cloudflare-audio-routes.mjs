import { timingSafeEqual } from "node:crypto";
import { isCloudflareWorkersAiBaseUrl } from "./provider-adapter.mjs";

const MAX_JSON_BYTES = 1_048_576;
const MAX_MULTIPART_BYTES = 26_214_400;
const MAX_AUDIO_BYTES = 26_214_400;

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
  try {
    const value = JSON.parse(buffer.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error("Invalid JSON body."), { statusCode: 400 });
  }
}

async function readForm(request) {
  const contentType = request.headers["content-type"] ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw Object.assign(new Error("Content-Type must be multipart/form-data."), { statusCode: 415 });
  const buffer = await readBuffer(request, MAX_MULTIPART_BYTES);
  return new Request("http://router.local/upload", { method: "POST", headers: { "content-type": contentType }, body: buffer }).formData();
}

function isEligible(provider, capability) {
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
  if (["blocked", "retired", "unsupported"].includes(status)) return 0;
  return 2;
}

function transcriptionPreference(model) {
  if (model === "@cf/openai/whisper-large-v3-turbo") return 40;
  if (model === "@cf/openai/whisper") return 30;
  if (model === "@cf/deepgram/nova-3") return 20;
  return 10;
}

function speechPreference(model, input) {
  const spanish = /[áéíóúñ¿¡]|\b(?:hola|gracias|para|que|con|una|este|esta|por|como|buenos|días)\b/i.test(input);
  if (spanish && model === "@cf/deepgram/aura-2-es") return 50;
  if (!spanish && model === "@cf/deepgram/aura-2-en") return 50;
  if (model === "@cf/deepgram/aura-1") return 30;
  if (model === "@cf/myshell-ai/melotts") return 20;
  return 10;
}

function selectProvider(providers, capability, requestedModel, input = "") {
  const eligible = providers.filter((provider) => isEligible(provider, capability));
  if (requestedModel && requestedModel !== "router-ia-auto") return eligible.find((provider) => provider.model === requestedModel) ?? null;
  return eligible
    .filter((provider) => verificationRank(provider, capability) > 0)
    .sort((a, b) => {
      const verified = verificationRank(b, capability) - verificationRank(a, capability);
      if (verified) return verified;
      const priority = (Number(b.priority) || 0) - (Number(a.priority) || 0);
      if (priority) return priority;
      return capability === "speech"
        ? speechPreference(b.model, input) - speechPreference(a.model, input)
        : transcriptionPreference(b.model) - transcriptionPreference(a.model);
    })[0] ?? null;
}

async function providerError(upstream) {
  try {
    const payload = await upstream.json();
    return payload?.errors?.[0]?.message ?? payload?.error?.message ?? payload?.message ?? `Cloudflare HTTP ${upstream.status}`;
  } catch {
    return `Cloudflare HTTP ${upstream.status}`;
  }
}

function speechRequestBody(provider, body) {
  const requestedFormat = typeof body.response_format === "string" ? body.response_format.toLowerCase() : "mp3";
  const encoding = ["flac", "mulaw", "alaw", "mp3", "opus", "aac"].includes(requestedFormat) ? requestedFormat : "mp3";
  const explicitVoice = typeof body.voice === "string" ? body.voice.trim().toLowerCase() : "";
  const spanishVoices = new Set(["sirio", "nestor", "carina", "celeste", "alvaro", "diana", "aquila", "selena", "estrella", "javier"]);
  const speaker = /aura-2-es$/i.test(provider.model) && spanishVoices.has(explicitVoice) ? explicitVoice : /aura-2-es$/i.test(provider.model) ? "aquila" : explicitVoice || "asteria";
  return { text: body.input, speaker, encoding };
}

async function runSpeech(provider, body, fetchImpl) {
  const upstream = await fetchImpl(`${provider.baseUrl.replace(/\/+$/, "")}/run/${provider.model}`, {
    method: "POST",
    headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json", accept: "*/*" },
    body: JSON.stringify(speechRequestBody(provider, body)),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!upstream.ok) throw Object.assign(new Error(await providerError(upstream)), { statusCode: upstream.status });
  const audio = Buffer.from(await upstream.arrayBuffer());
  if (!audio.length || audio.length > MAX_AUDIO_BYTES) throw new Error("Provider returned invalid audio data.");
  return { audio, contentType: upstream.headers.get("content-type") ?? "audio/mpeg" };
}

async function runTranscription(provider, file, form, fetchImpl) {
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_MULTIPART_BYTES) throw Object.assign(new Error("Provide a valid audio file."), { statusCode: 400 });
  const body = {
    audio: bytes.toString("base64"),
    task: "transcribe",
    ...(typeof form.get("language") === "string" && form.get("language").trim() ? { language: form.get("language").trim() } : {}),
  };
  const upstream = await fetchImpl(`${provider.baseUrl.replace(/\/+$/, "")}/run/${provider.model}`, {
    method: "POST",
    headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!upstream.ok) throw Object.assign(new Error(await providerError(upstream)), { statusCode: upstream.status });
  const payload = await upstream.json();
  const result = payload?.result ?? payload;
  if (!result || typeof result !== "object" || typeof result.text !== "string") throw new Error("Provider returned an invalid transcription response.");
  return result;
}

function sendUnavailable(response, capability, model) {
  sendJson(response, 404, { error: { code: "model_unavailable", message: model && model !== "router-ia-auto" ? `The requested ${capability} model is not available.` : `No active Cloudflare ${capability} model is available.` } });
}

export function createCloudflareAudioHandler({ appToken, providerStore, fetchImpl = globalThis.fetch }) {
  return async function handleCloudflareAudio(request, response, url) {
    const speech = request.method === "POST" && url.pathname === "/api/v1/audio/speech";
    const transcription = request.method === "POST" && url.pathname === "/api/v1/audio/transcriptions";
    if (!speech && !transcription) return false;
    if (!validToken(request, appToken)) {
      request.resume();
      sendJson(response, 401, { error: { code: "unauthorized", message: "Unauthorized." } });
      return true;
    }
    try {
      if (!providerStore || typeof providerStore.getActiveProviders !== "function") {
        request.resume();
        sendJson(response, 503, { error: { code: "provider_storage_unavailable", message: "Provider storage is unavailable." } });
        return true;
      }
      const providers = await providerStore.getActiveProviders();
      if (speech) {
        const body = await readJson(request);
        if (typeof body.input !== "string" || !body.input.trim() || body.input.length > 20_000) throw Object.assign(new Error("Provide speech input text."), { statusCode: 400 });
        body.input = body.input.trim();
        const model = typeof body.model === "string" ? body.model.trim() : "router-ia-auto";
        const provider = selectProvider(providers, "speech", model, body.input);
        if (!provider) {
          sendUnavailable(response, "speech", model);
          return true;
        }
        const output = await runSpeech(provider, body, fetchImpl);
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-length": output.audio.length,
          "content-type": output.contentType,
          "x-content-type-options": "nosniff",
        });
        response.end(output.audio);
        return true;
      }

      const form = await readForm(request);
      const modelValue = form.get("model");
      const model = typeof modelValue === "string" ? modelValue.trim() : "router-ia-auto";
      const file = form.get("file");
      if (!(file instanceof File)) throw Object.assign(new Error("Provide an audio file."), { statusCode: 400 });
      const provider = selectProvider(providers, "transcription", model);
      if (!provider) {
        sendUnavailable(response, "transcription", model);
        return true;
      }
      const result = await runTranscription(provider, file, form, fetchImpl);
      sendJson(response, 200, result);
      return true;
    } catch (error) {
      sendJson(response, Number.isInteger(error?.statusCode) ? error.statusCode : 502, { error: { code: "cloudflare_audio_failed", message: error?.message ?? "Cloudflare audio request failed." } });
      return true;
    }
  };
}
