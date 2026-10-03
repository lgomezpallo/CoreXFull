const CACHE_NAME = "router-ia-admin-shell-v2";
const CACHE_PREFIX = "router-ia-admin-shell-";
const SHELL_PATHS = [
  "/admin/",
  "/admin/admin.css",
  "/admin/admin.js",
  "/admin/manifest.webmanifest",
  "/admin/icons/icon-192.png",
  "/admin/icons/icon-512.png",
  "/admin/icons/icon-512-maskable.png",
  "/admin/icons/apple-touch-icon.png",
];
const SHELL_PATH_SET = new Set(SHELL_PATHS);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(SHELL_PATHS);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.search || url.hash) return;
  if (url.pathname.startsWith("/admin/api/")) return;
  if (!SHELL_PATH_SET.has(url.pathname)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        return (
          cached ??
          new Response("Conectate a internet para acceder al panel.", {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
          })
        );
      }
    })(),
  );
});