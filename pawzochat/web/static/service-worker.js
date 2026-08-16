/* PawzoChat PWA Service Worker */
const STATIC_CACHE_PREFIX = "pawzochat-static";
const STATIC_CACHE_VERSION = "v1";
const STATIC_CACHE_NAME = `${STATIC_CACHE_PREFIX}-${STATIC_CACHE_VERSION}`;
const IMAGE_CACHE_PREFIX = "pawzochat-images";
const IMAGE_CACHE_VERSION = "v1";
const IMAGE_CACHE_NAME = `${IMAGE_CACHE_PREFIX}-${IMAGE_CACHE_VERSION}`;
const basePath = new URL(self.registration.scope).pathname.replace(/\/$/, "");
const staticPrefix = `${basePath}/static/`;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const retained = new Set([STATIC_CACHE_NAME, IMAGE_CACHE_NAME]);
    await Promise.all(
      keys
        .filter(key => (
          key.startsWith(`${STATIC_CACHE_PREFIX}-`)
          || key.startsWith(`${IMAGE_CACHE_PREFIX}-`)
        ) && !retained.has(key))
        .map(key => caches.delete(key)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const personaId = event.notification.data?.personaId || "";
  event.waitUntil((async () => {
    const notifications = await self.registration.getNotifications();
    for (const notification of notifications) {
      if (notification.data?.personaId === personaId) notification.close();
    }

    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const target = windows[0];
    if (target) {
      await target.focus();
      target.postMessage({ type: "open_conversation", personaId });
      return;
    }
    const url = `${basePath || ""}/?openChat=${encodeURIComponent(personaId)}`;
    await self.clients.openWindow(url);
  })());
});

async function cachedImageResponse(request) {
  const cache = await caches.open(IMAGE_CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok || response.type === "opaque") {
    try {
      await cache.put(request, response.clone());
    } catch (_) {
      // Quota and browser privacy policies may reject persistent caching.
    }
  }
  return response;
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  if (request.destination === "image") {
    event.respondWith(cachedImageResponse(request));
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(staticPrefix)) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(STATIC_CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request);
      if (cached) return cached;
      throw error;
    }
  })());
});