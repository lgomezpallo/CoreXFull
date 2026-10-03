import { timingSafeEqual } from "node:crypto";
import { PROVIDER_CAPABILITIES } from "./provider-adapter.mjs";

function hasValidAppToken(request, expectedToken) {
  const authorization = request.headers.authorization;
  if (!expectedToken || typeof authorization !== "string") return false;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) return false;
  const supplied = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

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

export function createCapabilitiesHandler({ appToken, providerStore }) {
  return async function handleCapabilities(request, response, url) {
    if (request.method !== "GET" || url.pathname !== "/api/v1/capabilities") return false;

    if (!appToken || !hasValidAppToken(request, appToken)) {
      sendJson(response, 401, { error: { code: "unauthorized", message: "Unauthorized." } });
      return true;
    }
    if (!providerStore || typeof providerStore.getActiveProviders !== "function") {
      sendJson(response, 503, {
        error: { code: "provider_storage_unavailable", message: "Provider storage is not configured." },
      });
      return true;
    }

    try {
      const providers = await providerStore.getActiveProviders();
      const counts = Object.fromEntries(PROVIDER_CAPABILITIES.map((capability) => [capability, 0]));
      for (const provider of Array.isArray(providers) ? providers : []) {
        if (provider?.active !== true || !Array.isArray(provider.capabilities)) continue;
        for (const capability of provider.capabilities) {
          if (Object.hasOwn(counts, capability)) counts[capability] += 1;
        }
      }

      sendJson(response, 200, {
        service: "router-ia",
        capabilities: Object.entries(counts).map(([capability, providerCount]) => ({
          capability,
          available: providerCount > 0,
          providerCount,
        })),
      });
    } catch {
      sendJson(response, 503, {
        error: { code: "provider_storage_unavailable", message: "Saved providers could not be loaded." },
      });
    }
    return true;
  };
}
