import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ADMIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "admin");

export function createAdminExtraHandler() {
  return async function handleAdminExtra(request, response, url) {
    if (request.method !== "GET" || url.pathname !== "/admin/provider-form.js") return false;
    try {
      const body = await readFile(resolve(ADMIN_DIR, "provider-form.js"));
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": body.byteLength,
        "content-type": "text/javascript; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
    return true;
  };
}
