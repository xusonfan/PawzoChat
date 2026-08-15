/* PawzoChat PWA Service Worker */
const CACHE_PREFIX = "pawzochat-static";
const CACHE_VERSION = "v1";
const CACHE_NAME = `${CACHE_PREFIX}-${CACHE_VERSION}`;
const basePath = new URL(self.registration.scope).pathname.replace(/\/$/, "");
const staticPrefix = `${basePath}/static/`;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(key => key.startsWith(`${CACHE_PREFIX}-`) && key !== CACHE_NAME)
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

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(staticPrefix)) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
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