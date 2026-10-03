import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAdminExtraHandler } from "./admin-extra-routes.mjs";
import { createCapabilitiesHandler } from "./capabilities-route.mjs";
import { createSmartChatHandler } from "./chat-handler.mjs";
import { createMultimodalHandler } from "./multimodal-routes.mjs";
import { createCloudflareImageHandler } from "./cloudflare-image-routes.mjs";
import { syncCloudflareCatalog } from "./cloudflare-sync.mjs";
import { auditAllProviders } from "./provider-auditor.mjs";
import { auditVisionProviders } from "./vision-auditor.mjs";
import { makeSilenceWav, makeSolidPng } from "./probe-assets.mjs";
import { createSupabaseProviderStore } from "./provider-store.mjs";
import { createRouterServer } from "./server.mjs";

function createProviderStoreFromEnvironment(fetchImpl = globalThis.fetch) {
  const supabaseUrl = process.env.ROUTER_SUPABASE_URL?.trim() ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const encryptionKey = process.env.ROUTER_PROVIDER_ENCRYPTION_KEY?.trim() ?? "";
  if (!supabaseUrl || !serviceRoleKey || !encryptionKey) return null;
  return createSupabaseProviderStore({ supabaseUrl, serviceRoleKey, encryptionKey, fetchImpl });
}

export function createRouterApp(overrides = {}) {
  const fetchImpl = overrides.fetchImpl ?? globalThis.fetch;
  const appToken = overrides.appToken ?? process.env.ROUTER_APP_TOKEN?.trim() ?? "";
  const providerStore = overrides.providerStore === undefined
    ? createProviderStoreFromEnvironment(fetchImpl)
    : overrides.providerStore;

  const server = createRouterServer({ ...overrides, appToken, fetchImpl, providerStore });
  const existingHandlers = server.listeners("request");
  const baseHandler = existingHandlers[0];
  server.removeAllListeners("request");

  const adminExtraHandler = createAdminExtraHandler();
  const capabilitiesHandler = createCapabilitiesHandler({ appToken, providerStore });
  const smartChatHandler = createSmartChatHandler({ appToken, providerStore, fetchImpl });
  const cloudflareImageHandler = createCloudflareImageHandler({ appToken, providerStore, fetchImpl });
  const multimodalHandler = createMultimodalHandler({ appToken, providerStore, fetchImpl });

  server.on("request", async (request, response) => {
    const url = new URL(request.url ?? "/", "http://router.local");
    try {
      if (await adminExtraHandler(request, response, url)) return;
      if (await capabilitiesHandler(request, response, url)) return;
      if (await smartChatHandler(request, response, url)) return;
      if (await cloudflareImageHandler(request, response, url)) return;
      if (await multimodalHandler(request, response, url)) return;
      return await baseHandler(request, response);
    } catch {
      if (!response.headersSent) {
        const body = JSON.stringify({ error: { code: "router_internal_error", message: "Router IA could not complete the request." } });
        response.writeHead(500, {
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        response.end(body);
      } else {
        response.destroy();
      }
    }
  });

  return server;
}

async function runStartupSmokeTest({ port, appToken, fetchImpl = globalThis.fetch }) {
  if (process.env.ROUTER_PROVIDER_SMOKE_TEST !== "1") return;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${appToken}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "router-ia-auto", messages: [{ role: "user", content: "Respond briefly." }], max_tokens: 16 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      console.error(`ROUTER_PROVIDER_SMOKE_FAIL status=${response.status}`);
      return;
    }
    const payload = await response.json();
    if (Array.isArray(payload?.choices) && payload.choices.length > 0) console.log("ROUTER_PROVIDER_SMOKE_OK");
    else console.error("ROUTER_PROVIDER_SMOKE_FAIL invalid_response");
  } catch (error) {
    console.error(`ROUTER_PROVIDER_SMOKE_FAIL ${error?.name ?? "error"}`);
  }
}

function sanitizeDiagnostic(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

async function readSmokeFailure(response) {
  let diagnostic = "";
  try {
    const payload = await response.json();
    diagnostic = sanitizeDiagnostic(payload?.error?.message ?? payload?.error?.code);
  } catch {}
  return diagnostic;
}

async function runStartupImageSmokeTest({ port, appToken, fetchImpl = globalThis.fetch }) {
  if (process.env.ROUTER_CLOUDFLARE_IMAGE_SMOKE !== "1") return;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/v1/images/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${appToken}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "@cf/black-forest-labs/flux-1-schnell", prompt: "A peaceful landscape of green hills under a clear blue sky" }),
      signal: AbortSignal.timeout(100_000),
    });
    if (!response.ok) {
      const diagnostic = await readSmokeFailure(response);
      console.error(`ROUTER_IMAGE_SMOKE_FAIL status=${response.status}${diagnostic ? ` detail=${diagnostic}` : ""}`);
      return;
    }
    const payload = await response.json();
    const encoded = payload?.data?.[0]?.b64_json;
    if (typeof encoded === "string" && encoded.length > 100) console.log("ROUTER_IMAGE_SMOKE_OK");
    else console.error("ROUTER_IMAGE_SMOKE_FAIL invalid_response");
  } catch (error) {
    console.error(`ROUTER_IMAGE_SMOKE_FAIL ${error?.name ?? "error"}`);
  }
}

async function runStartupImageEditSmokeTest({ port, appToken, fetchImpl = globalThis.fetch }) {
  if (process.env.ROUTER_CLOUDFLARE_IMAGE_EDIT_SMOKE !== "1") return;
  try {
    const form = new FormData();
    form.set("model", "@cf/black-forest-labs/flux-2-klein-4b");
    form.set("prompt", "Change the blue square to a green square on the same plain background");
    form.set("image", new Blob([makeSolidPng(64, 64)], { type: "image/png" }), "probe.png");
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/v1/images/edits`, {
      method: "POST",
      headers: { authorization: `Bearer ${appToken}` },
      body: form,
      signal: AbortSignal.timeout(100_000),
    });
    if (!response.ok) {
      const diagnostic = await readSmokeFailure(response);
      console.error(`ROUTER_IMAGE_EDIT_SMOKE_FAIL status=${response.status}${diagnostic ? ` detail=${diagnostic}` : ""}`);
      return;
    }
    const payload = await response.json();
    const encoded = payload?.data?.[0]?.b64_json;
    if (typeof encoded === "string" && encoded.length > 100) console.log("ROUTER_IMAGE_EDIT_SMOKE_OK");
    else console.error("ROUTER_IMAGE_EDIT_SMOKE_FAIL invalid_response");
  } catch (error) {
    console.error(`ROUTER_IMAGE_EDIT_SMOKE_FAIL ${error?.name ?? "error"}`);
  }
}

async function runStartupCloudflareSpeechSmoke({ port, appToken, fetchImpl = globalThis.fetch }) {
  if (process.env.ROUTER_CLOUDFLARE_SPEECH_SMOKE !== "1") return;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/v1/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${appToken}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "@cf/deepgram/aura-2-es", input: "Hola", voice: "aquila", response_format: "mp3" }),
      signal: AbortSignal.timeout(70_000),
    });
    if (!response.ok) {
      const diagnostic = await readSmokeFailure(response);
      console.error(`ROUTER_SPEECH_SMOKE_FAIL status=${response.status}${diagnostic ? ` detail=${diagnostic}` : ""}`);
      return;
    }
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length > 32) console.log("ROUTER_SPEECH_SMOKE_OK");
    else console.error("ROUTER_SPEECH_SMOKE_FAIL invalid_response");
  } catch (error) {
    console.error(`ROUTER_SPEECH_SMOKE_FAIL ${error?.name ?? "error"}`);
  }
}

async function runStartupCloudflareTranscriptionSmoke({ port, appToken, fetchImpl = globalThis.fetch }) {
  if (process.env.ROUTER_CLOUDFLARE_TRANSCRIPTION_SMOKE !== "1") return;
  try {
    const form = new FormData();
    form.set("model", "@cf/openai/whisper-large-v3-turbo");
    form.set("language", "es");
    form.set("file", new Blob([makeSilenceWav({ durationMs: 500 })], { type: "audio/wav" }), "probe.wav");
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/v1/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${appToken}` },
      body: form,
      signal: AbortSignal.timeout(70_000),
    });
    if (!response.ok) {
      const diagnostic = await readSmokeFailure(response);
      console.error(`ROUTER_TRANSCRIPTION_SMOKE_FAIL status=${response.status}${diagnostic ? ` detail=${diagnostic}` : ""}`);
      return;
    }
    const payload = await response.json();
    if (typeof payload?.text === "string") console.log("ROUTER_TRANSCRIPTION_SMOKE_OK");
    else console.error("ROUTER_TRANSCRIPTION_SMOKE_FAIL invalid_response");
  } catch (error) {
    console.error(`ROUTER_TRANSCRIPTION_SMOKE_FAIL ${error?.name ?? "error"}`);
  }
}

async function runStartupVisionAudit() {
  if (process.env.ROUTER_PROVIDER_VISION_AUDIT !== "1") return;
  const providerStore = createProviderStoreFromEnvironment();
  if (!providerStore) {
    console.error("ROUTER_VISION_AUDIT_FAIL provider_store_unavailable");
    return;
  }
  try {
    console.log("ROUTER_VISION_AUDIT_START");
    const result = await auditVisionProviders({ providerStore, concurrency: 2 });
    console.log(`ROUTER_VISION_AUDIT_OK total=${result.total} verified=${result.verified} unsupported=${result.unsupported} blocked=${result.blocked} retired=${result.retired} inconclusive=${result.inconclusive}`);
  } catch (error) {
    console.error(`ROUTER_VISION_AUDIT_FAIL ${error?.name ?? "error"}`);
  }
}

async function runStartupCapabilityAudit() {
  if (process.env.ROUTER_PROVIDER_CAPABILITY_AUDIT !== "1") return;
  const providerStore = createProviderStoreFromEnvironment();
  if (!providerStore) {
    console.error("ROUTER_CAPABILITY_AUDIT_FAIL provider_store_unavailable");
    return;
  }
  try {
    const inconclusiveOnly = process.env.ROUTER_PROVIDER_CAPABILITY_AUDIT_INCONCLUSIVE_ONLY === "1";
    console.log(`ROUTER_CAPABILITY_AUDIT_START mode=${inconclusiveOnly ? "inconclusive" : "all"}`);
    const result = await auditAllProviders({ providerStore, concurrency: 2, inconclusiveOnly });
    console.log(`ROUTER_CAPABILITY_AUDIT_OK total=${result.total} verified=${result.verifiedModels} inconclusive=${result.inconclusiveModels}`);
  } catch (error) {
    console.error(`ROUTER_CAPABILITY_AUDIT_FAIL ${error?.name ?? "error"}`);
  }
}

async function runStartupCloudflareSync() {
  if (process.env.ROUTER_CLOUDFLARE_CATALOG_SYNC !== "1") return;
  const providerStore = createProviderStoreFromEnvironment();
  if (!providerStore) {
    console.error("ROUTER_CLOUDFLARE_SYNC_FAIL provider_store_unavailable");
    return;
  }
  try {
    console.log("ROUTER_CLOUDFLARE_SYNC_START");
    const result = await syncCloudflareCatalog({ providerStore });
    console.log(`ROUTER_CLOUDFLARE_SYNC_OK found=${result.found} eligible=${result.eligible} classified=${result.classified ?? 0} added=${result.added}`);
  } catch (error) {
    console.error(`ROUTER_CLOUDFLARE_SYNC_FAIL ${error?.name ?? "error"}`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const appToken = process.env.ROUTER_APP_TOKEN?.trim();
  if (!appToken) {
    console.error("Set ROUTER_APP_TOKEN before starting Router IA.");
    process.exitCode = 1;
  } else {
    const port = Number(process.env.PORT ?? 8080);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error("PORT must be a valid TCP port.");
      process.exitCode = 1;
    } else {
      const server = createRouterApp();
      server.listen(port, "0.0.0.0", () => {
        console.log(`Router IA listening on port ${port}.`);
        void runStartupSmokeTest({ port, appToken });
        void runStartupImageSmokeTest({ port, appToken });
        void runStartupImageEditSmokeTest({ port, appToken });
        void runStartupCloudflareSpeechSmoke({ port, appToken });
        void runStartupCloudflareTranscriptionSmoke({ port, appToken });
        void runStartupCloudflareSync();
        void runStartupVisionAudit();
        void runStartupCapabilityAudit();
      });
      const shutdown = () => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 8_000).unref();
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    }
  }
}
