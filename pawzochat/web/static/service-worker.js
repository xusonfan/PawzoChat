/* PawzoChat PWA Service Worker */
const STATIC_CACHE_PREFIX = "pawzochat-static";
const STATIC_CACHE_VERSION = "v4";
const STATIC_CACHE_NAME = `${STATIC_CACHE_PREFIX}-${STATIC_CACHE_VERSION}`;
const IMAGE_CACHE_PREFIX = "pawzochat-images";
const IMAGE_CACHE_VERSION = "v1";
const IMAGE_CACHE_NAME = `${IMAGE_CACHE_PREFIX}-${IMAGE_CACHE_VERSION}`;
const IMAGE_CACHE_MAX_ENTRIES = 160;
const IMAGE_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const MAX_NOTIFICATION_ICON_BYTES = 2 * 1024 * 1024;
const basePath = new URL(self.registration.scope).pathname.replace(/\/$/, "");
const staticPrefix = `${basePath}/static/`;
const appPath = `${basePath || ""}/`;
const APP_SHELL_PATHS = [
  appPath,
  `${basePath}/static/style.css`,
  `${basePath}/static/desktop.css`,
  `${basePath}/static/app.js`,
  `${basePath}/static/logo.png`,
  `${basePath}/static/pwa-icon-192.png`,
  `${basePath}/static/pwa/icon-512.png`,
  `${basePath}/static/pwa/maskable-512.png`,
  `${basePath}/static/assets/vendor/remixicon/remixicon.symbol.svg`,
  ...[
    "api", "chat", "chat_message_identity", "chat_message_time", "chat_pending",
    "chat_scroll", "choice_picker", "contacts", "contacts_index", "conversation_list_ownership",
    "conversation_menu", "drafts", "error_banner", "error_feedback", "history_edit",
    "image_gallery", "image_gallery_state", "image_layout_cache", "image_preview",
    "image_preview_transform", "mcp", "memory", "message_content", "moments",
    "moments_item_chrome", "moments_timeline", "navigation", "notification_feedback",
    "offline_store", "persona_writer", "plugins", "push_notifications", "pwa", "qr_verify",
    "quick_setup", "radar", "settings", "share_target_store", "shared_import", "state", "sticker_maker",
    "sticker_maker_capabilities", "theme", "ui", "unread", "utils", "worldbook",
  ].map(name => `${basePath}/static/modules/${name}.js`),
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE_NAME);
    await cache.addAll(APP_SHELL_PATHS);
    await self.skipWaiting();
  })());
});

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

async function syncAppBadge(count) {
  if (count == null) return;
  const value = Math.max(0, Number(count) || 0);
  try {
    if (value > 0 && typeof self.navigator?.setAppBadge === "function") {
      await self.navigator.setAppBadge(value);
    } else if (value === 0 && typeof self.navigator?.clearAppBadge === "function") {
      await self.navigator.clearAppBadge();
    }
  } catch (_) {
    // Badging is optional and may still be rejected by browser policy.
  }
}

self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let payload = {};
    try {
      payload = event.data?.json() || {};
    } catch (_) {
      payload = { body: event.data?.text() || "收到一条新消息" };
    }

    await syncAppBadge(payload.totalUnread);
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
  if (event.data?.type === "clear_local_cache") {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys
        .filter(key => key.startsWith("pawzochat-"))
        .map(key => caches.delete(key)));
      const appCache = await caches.open(STATIC_CACHE_NAME);
      await appCache.addAll(APP_SHELL_PATHS);
      event.source?.postMessage?.({ type: "local_cache_cleared" });
    })());
    return;
  }
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

async function responseSize(response) {
  const value = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(value) && value > 0) return value;
  try { return Number((await response.clone().blob()).size) || 0; } catch (_) { return 0; }
}

async function trimImageCache(cache) {
  if (typeof cache.keys !== "function" || typeof cache.delete !== "function") return;
  const keys = await cache.keys();
  let totalBytes = 0;
  const entries = [];
  for (const key of keys) {
    const response = await cache.match(key);
    const bytes = await responseSize(response);
    totalBytes += bytes;
    entries.push({ key, bytes });
  }
  while (entries.length > IMAGE_CACHE_MAX_ENTRIES || totalBytes > IMAGE_CACHE_MAX_BYTES) {
    const oldest = entries.shift();
    if (!oldest) break;
    await cache.delete(oldest.key);
    totalBytes -= oldest.bytes;
  }
}

async function cachedImageResponse(request) {
  const cache = await caches.open(IMAGE_CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    // Cache Storage keeps insertion order. Reinsert hits so trimming removes
    // genuinely least-recently-used images first.
    if (typeof cache.delete === "function") {
      try {
        await cache.delete(request);
        await cache.put(request, cached.clone());
      } catch (_) { /* a cache hit remains usable even if the LRU touch fails */ }
    }
    return cached;
  }

  const response = await fetch(request);
  if (response.ok || response.type === "opaque") {
    try {
      await cache.put(request, response.clone());
      await trimImageCache(cache);
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

async function storeSharedPayload(formData) {
  const id = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const files = formData.getAll("files").filter(value => value instanceof File && value.size > 0);
  const payload = {
    id,
    title: String(formData.get("title") || ""),
    text: String(formData.get("text") || ""),
    url: String(formData.get("url") || ""),
    files,
    createdAt: Date.now(),
  };

  await new Promise((resolve, reject) => {
    const request = indexedDB.open("pawzo-share-targets", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("payloads")) {
        db.createObjectStore("payloads", { keyPath: "id" });
      }
    };
    request.onerror = () => reject(request.error || new Error("无法打开分享暂存区"));
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("payloads", "readwrite");
      transaction.objectStore("payloads").put(payload);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => { db.close(); reject(transaction.error || new Error("无法暂存分享内容")); };
      transaction.onabort = transaction.onerror;
    };
  });
  return id;
}

async function receiveShareTarget(request) {
  const launchUrl = new URL(appPath, self.location.origin);
  try {
    const id = await storeSharedPayload(await request.formData());
    launchUrl.searchParams.set("shareTarget", id);
  } catch (_) {
    launchUrl.searchParams.set("shareError", "1");
  }
  return Response.redirect(launchUrl.href, 303);
}

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);

  if (
    request.method === "POST"
    && url.origin === self.location.origin
    && url.pathname === `${basePath}/share-target`
  ) {
    event.respondWith(receiveShareTarget(request));
    return;
  }

  if (request.method !== "GET") return;

  if (request.destination === "image") {
    event.respondWith(cachedImageResponse(request));
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch (error) {
        const cached = await caches.match(appPath);
        if (cached) return cached;
        throw error;
      }
    })());
    return;
  }

  if (!url.pathname.startsWith(staticPrefix)) return;

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