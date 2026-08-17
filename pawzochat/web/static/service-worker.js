/* PawzoChat PWA Service Worker */
const STATIC_CACHE_PREFIX = "pawzochat-static";
const STATIC_CACHE_VERSION = "v1";
const STATIC_CACHE_NAME = `${STATIC_CACHE_PREFIX}-${STATIC_CACHE_VERSION}`;
const IMAGE_CACHE_PREFIX = "pawzochat-images";
const IMAGE_CACHE_VERSION = "v1";
const IMAGE_CACHE_NAME = `${IMAGE_CACHE_PREFIX}-${IMAGE_CACHE_VERSION}`;
const MAX_NOTIFICATION_ICON_BYTES = 2 * 1024 * 1024;
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

async function hasVisibleWindow() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return windows.some(client => client.visibilityState === "visible");
}

function notificationMessageKey(notification) {
  return notification?.data?.messageKey || notification?.tag || "";
}

function personaIdFromNotification(notification) {
  const explicit = notification?.data?.personaId;
  if (explicit) return explicit;
  const messageKey = notificationMessageKey(notification);
  const separator = messageKey.lastIndexOf(":");
  return separator > 0 ? messageKey.slice(0, separator) : "";
}

async function closePersonaNotifications(personaId) {
  if (!personaId) return [];
  const handledMessageKeys = [];
  const notifications = await self.registration.getNotifications();
  for (const notification of notifications) {
    if (personaIdFromNotification(notification) !== personaId) continue;
    const messageKey = notificationMessageKey(notification);
    if (messageKey) handledMessageKeys.push(messageKey);
    notification.close();
  }
  return handledMessageKeys;
}

self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let payload = {};
    try {
      payload = event.data?.json() || {};
    } catch (_) {
      payload = { body: event.data?.text() || "收到一条新消息" };
    }

    if (await hasVisibleWindow()) return;

    const fallbackIcon = `${basePath || ""}/static/logo.png`;
    const icon = await notificationIcon(payload, fallbackIcon);
    if (await hasVisibleWindow()) return;
    await self.registration.showNotification(payload.title || "PawzoChat", {
      body: payload.body || "收到一条新消息",
      icon,
      badge: `${basePath || ""}/static/pwa-icon-192.png`,
      tag: payload.messageKey || undefined,
      renotify: false,
      data: {
        personaId: payload.personaId || "",
        messageKey: payload.messageKey || "",
      },
    });
  })());
});

self.addEventListener("notificationclick", event => {
  const personaId = personaIdFromNotification(event.notification);
  const handledMessageKeys = new Set([
    notificationMessageKey(event.notification),
  ].filter(Boolean));
  event.notification.close();

  event.waitUntil((async () => {
    const closedMessageKeys = await closePersonaNotifications(personaId);
    for (const messageKey of closedMessageKeys) handledMessageKeys.add(messageKey);

    const messageKeys = [...handledMessageKeys].slice(0, 100);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const target = windows[0];
    if (target) {
      for (const client of windows) {
        client.postMessage({
          type: "notification_messages_handled",
          handledMessageKeys: messageKeys,
        });
      }
      await target.focus();
      target.postMessage({ type: "open_conversation", personaId });
      return;
    }

    const url = new URL(`${basePath || ""}/`, self.location.origin);
    if (personaId) url.searchParams.set("openChat", personaId);
    for (const messageKey of messageKeys) {
      url.searchParams.append("handledMessageKey", messageKey);
    }
    await self.clients.openWindow(`${url.pathname}${url.search}`);
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type !== "clear_persona_notifications") return;
  const personaId = event.data.personaId || "";
  event.waitUntil((async () => {
    const handledMessageKeys = await closePersonaNotifications(personaId);
    if (handledMessageKeys.length === 0) return;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      client.postMessage({
        type: "notification_messages_handled",
        handledMessageKeys,
      });
    }
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

function imageDataUrl(response) {
  return response.blob().then(async blob => {
    if (!blob.type.startsWith("image/") || blob.size > MAX_NOTIFICATION_ICON_BYTES) return "";
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return `data:${blob.type};base64,${btoa(binary)}`;
  });
}

async function notificationIcon(payload, fallbackIcon) {
  if (!payload.personaId || !payload.avatarVersion) return fallbackIcon;
  const path = `${basePath || ""}/api/personas/${encodeURIComponent(payload.personaId)}/avatar?v=${encodeURIComponent(payload.avatarVersion)}`;
  const request = new Request(new URL(path, self.location.origin), {
    credentials: "same-origin",
  });
  try {
    const response = await cachedImageResponse(request);
    if (!response.ok) return fallbackIcon;
    return await imageDataUrl(response.clone()) || fallbackIcon;
  } catch (_) {
    return fallbackIcon;
  }
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