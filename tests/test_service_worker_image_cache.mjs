import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(
  __dirname,
  "../pawzochat/web/static/service-worker.js",
), "utf8");

const handlers = new Map();
const cacheStores = new Map();

function requestKey(request) {
  return request.url;
}

function cacheStore(name) {
  if (!cacheStores.has(name)) cacheStores.set(name, new Map());
  const values = cacheStores.get(name);
  return {
    async match(request) { return values.get(requestKey(request)); },
    async put(request, response) { values.set(requestKey(request), response); },
  };
}

const caches = {
  async keys() { return [...cacheStores.keys()]; },
  async open(name) { return cacheStore(name); },
  async delete(name) { return cacheStores.delete(name); },
  async match(request) {
    for (const values of cacheStores.values()) {
      if (values.has(requestKey(request))) return values.get(requestKey(request));
    }
    return undefined;
  },
};

class FakeResponse {
  constructor(body, { ok = true, type = "basic", contentType = "application/octet-stream" } = {}) {
    this.body = body;
    this.ok = ok;
    this.type = type;
    this.contentType = contentType;
  }
  clone() {
    return new FakeResponse(this.body, {
      ok: this.ok,
      type: this.type,
      contentType: this.contentType,
    });
  }
  async blob() {
    const bytes = Buffer.from(this.body);
    return {
      type: this.contentType,
      size: bytes.length,
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }
}

let networkFetches = 0;
let availableNotifications = [];
let clientWindows = [];
const openedWindows = [];
const shownNotifications = [];
const context = vm.createContext({
  URL,
  Request,
  Uint8Array,
  btoa,
  caches,
  console,
  encodeURIComponent,
  fetch: async request => {
    networkFetches += 1;
    if (request.url.includes("/api/personas/cat/avatar")) {
      return new FakeResponse("avatar-bytes", { contentType: "image/png" });
    }
    return new FakeResponse(`network:${request.url}`);
  },
  self: {
    location: { origin: "https://pawzochat.local" },
    registration: {
      scope: "https://pawzochat.local/",
      async getNotifications() { return availableNotifications; },
      async showNotification(title, payload) { shownNotifications.push({ title, payload }); },
    },
    clients: {
      async claim() {},
      async matchAll() { return clientWindows; },
      async openWindow(url) { openedWindows.push(url); },
    },
    skipWaiting() {},
    addEventListener(type, handler) { handlers.set(type, handler); },
  },
});

vm.runInContext(source, context, { filename: "service-worker.js" });

async function dispatchFetch(request) {
  let responsePromise = null;
  handlers.get("fetch")({
    request,
    respondWith(value) { responsePromise = Promise.resolve(value); },
  });
  return responsePromise ? responsePromise : null;
}

const markdownImage = {
  method: "GET",
  destination: "image",
  url: "https://cdn.example.com/message.gif",
};

const first = await dispatchFetch(markdownImage);
assert.equal(first.body, "network:https://cdn.example.com/message.gif");
assert.equal(networkFetches, 1);

const second = await dispatchFetch(markdownImage);
assert.equal(second.body, first.body);
assert.equal(networkFetches, 1, "第二次图片请求必须直接使用持久缓存");
assert.equal(
  cacheStores.get("pawzochat-images-v1").has(markdownImage.url),
  true,
);

const unrelatedRemoteRequest = {
  method: "GET",
  destination: "",
  url: "https://cdn.example.com/data.json",
};
assert.equal(await dispatchFetch(unrelatedRemoteRequest), null);
assert.equal(networkFetches, 1);

async function dispatchPush(payload) {
  let completion = null;
  handlers.get("push")({
    data: { json() { return payload; } },
    waitUntil(value) { completion = Promise.resolve(value); },
  });
  await completion;
}

await dispatchPush({
  title: "小猫",
  body: "在吗",
  personaId: "cat",
  avatarVersion: "7",
  messageKey: "cat:7",
});
assert.equal(shownNotifications.length, 1);
assert.equal(shownNotifications[0].title, "小猫");
assert.match(shownNotifications[0].payload.icon, /^data:image\/png;base64,/);
assert.equal(shownNotifications[0].payload.tag, "cat:7");
assert.equal(shownNotifications[0].payload.data.messageKey, "cat:7");

function fakeNotification(personaId, messageKey) {
  return {
    tag: messageKey,
    data: { personaId, messageKey },
    closed: false,
    close() { this.closed = true; },
  };
}

async function dispatchNotificationClick(notification) {
  let completion = null;
  handlers.get("notificationclick")({
    notification,
    waitUntil(value) { completion = Promise.resolve(value); },
  });
  await completion;
}

async function dispatchMessage(data) {
  let completion = null;
  handlers.get("message")({
    data,
    waitUntil(value) { completion = Promise.resolve(value); },
  });
  if (completion) await completion;
}

// Opening a new PWA window carries all closed notification keys in the URL,
// so the page can suppress replay before it starts SSE.
const clickedNotification = fakeNotification("cat", "cat:7");
const siblingNotification = fakeNotification("", "cat:8");
const unrelatedNotification = fakeNotification("dog", "dog:2");
availableNotifications = [siblingNotification, unrelatedNotification];
await dispatchNotificationClick(clickedNotification);
assert.equal(clickedNotification.closed, true);
assert.equal(siblingNotification.closed, true);
assert.equal(unrelatedNotification.closed, false);
assert.equal(openedWindows.length, 1);
const openedUrl = new URL(openedWindows[0], "https://pawzochat.local");
assert.equal(openedUrl.searchParams.get("openChat"), "cat");
assert.deepEqual(
  [...openedUrl.searchParams.getAll("handledMessageKey")],
  ["cat:7", "cat:8"],
);

// An already running PWA receives the keys before focus can trigger SSE reconnect.
const postedMessages = [];
const clientEvents = [];
let focusCalls = 0;
clientWindows = [{
  async focus() { focusCalls += 1; clientEvents.push("focus"); },
  postMessage(message) {
    postedMessages.push(message);
    clientEvents.push(`post:${message.type}`);
  },
}];
availableNotifications = [];
await dispatchNotificationClick(fakeNotification("cat", "cat:9"));
assert.equal(focusCalls, 1);
assert.deepEqual(clientEvents, [
  "post:notification_messages_handled",
  "focus",
  "post:open_conversation",
]);
assert.equal(postedMessages.length, 2);
assert.equal(postedMessages[0].type, "notification_messages_handled");
assert.deepEqual([...postedMessages[0].handledMessageKeys], ["cat:9"]);
assert.equal(postedMessages[1].type, "open_conversation");
assert.equal(postedMessages[1].personaId, "cat");

// The opened PWA performs a second cleanup pass for notifications that arrived
// after notificationclick had already enumerated the tray.
const latePersonaNotification = fakeNotification("", "cat:10");
const otherPersonaNotification = fakeNotification("dog", "dog:3");
availableNotifications = [latePersonaNotification, otherPersonaNotification];
await dispatchMessage({ type: "clear_persona_notifications", personaId: "cat" });
assert.equal(latePersonaNotification.closed, true);
assert.equal(otherPersonaNotification.closed, false);
assert.equal(postedMessages.length, 3);
assert.equal(postedMessages[2].type, "notification_messages_handled");
assert.deepEqual([...postedMessages[2].handledMessageKeys], ["cat:10"]);

// A window becoming visible while its avatar is loading prevents a late push
// notification from being shown after the conversation has opened.
let visibilityChecks = 0;
clientWindows = [{
  get visibilityState() {
    visibilityChecks += 1;
    return visibilityChecks === 1 ? "hidden" : "visible";
  },
}];
const notificationsBeforeVisibleRace = shownNotifications.length;
await dispatchPush({
  title: "小猫",
  body: "稍晚到达",
  personaId: "cat",
  avatarVersion: "7",
  messageKey: "cat:11",
});
assert.equal(visibilityChecks, 2);
assert.equal(shownNotifications.length, notificationsBeforeVisibleRace);

console.log("service worker image cache tests passed");
