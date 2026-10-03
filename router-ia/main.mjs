import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCapabilitiesHandler } from "./capabilities-route.mjs";
import { createSmartChatHandler } from "./chat-handler.mjs";
import { createMultimodalHandler } from "./multimodal-routes.mjs";
import { createSupabaseProviderStore } from "./provider-store.mjs";
import { createRouterServer } from "./server.mjs";

function createProviderStoreFromEnvironment(fetchImpl = globalThis.fetch) {
  const supabaseUrl = process.env.ROUTER_SUPABASE_URL?.trim() ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const encryptionKey = process.env.ROUTER_PROVIDER_ENCRYPTION_KEY?.trim() ?? "";
  if (!supabaseUrl || !serviceRoleKey || !encryptionKey) return null;
  return createSupabaseProviderStore({
    supabaseUrl,
    serviceRoleKey,
    encryptionKey,
    fetchImpl,
  });
}

export function createRouterApp(overrides = {}) {
  const fetchImpl = overrides.fetchImpl ?? globalThis.fetch;
  const appToken = overrides.appToken ?? process.env.ROUTER_APP_TOKEN?.trim() ?? "";
  const providerStore =
    overrides.providerStore === undefined
      ? createProviderStoreFromEnvironment(fetchImpl)
      : overrides.providerStore;

  const server = createRouterServer({
    ...overrides,
    appToken,
    fetchImpl,
    providerStore,
  });
  const existingHandlers = server.listeners("request");
  const baseHandler = existingHandlers[0];
  server.removeAllListeners("request");

  const capabilitiesHandler = createCapabilitiesHandler({
    appToken,
    providerStore,
  });
  const smartChatHandler = createSmartChatHandler({
    appToken,
    providerStore,
    fetchImpl,
  });
  const multimodalHandler = createMultimodalHandler({
    appToken,
    providerStore,
    fetchImpl,
  });

  server.on("request", async (request, response) => {
    const url = new URL(request.url ?? "/", "http://router.local");
    try {
      if (await capabilitiesHandler(request, response, url)) return;
      if (await smartChatHandler(request, response, url)) return;
      if (await multimodalHandler(request, response, url)) return;
      return await baseHandler(request, response);
    } catch {
      if (!response.headersSent) {
        const body = JSON.stringify({
          error: { code: "router_internal_error", message: "Router IA could not complete the request." },
        });
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

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

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
