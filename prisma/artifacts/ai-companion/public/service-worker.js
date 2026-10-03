const CACHE_PREFIX = "prisma-offline-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.add("/offline.html")));
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Only page navigations: never cache API calls, credentials or conversations.
  if (request.method !== "GET" || request.mode !== "navigate" ||
      url.origin !== self.location.origin || url.pathname === "/api" ||
      url.pathname.startsWith("/api/")) return;
  event.respondWith(fetch(request).catch(async () =>
    (await caches.match("/offline.html")) ?? new Response("Sin conexión. Volvé a intentar cuando tengas internet.", {
      status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
  ));
});
