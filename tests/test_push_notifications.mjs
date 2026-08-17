import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicKey = Buffer.from([4, ...new Array(64).fill(7)]).toString("base64url");
const calls = [];
const fakeFetch = async (url, options = {}) => {
  calls.push({ url, options });
  if (url.endsWith("/api/push/public-key")) {
    return { ok: true, status: 200, async json() { return { public_key: publicKey }; } };
  }
  if (url.endsWith("/api/push/subscriptions") && options.method === "POST") {
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  }
  if (url.endsWith("/api/push/subscriptions") && options.method === "DELETE") {
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  }
  throw new Error(`unexpected request: ${url}`);
};

globalThis.CustomEvent = class CustomEvent {};
const storedPreferences = new Map();
globalThis.window = {
  PAWZOCHAT_BASE: "/secret",
  isSecureContext: true,
  fetch: fakeFetch,
  dispatchEvent() {},
  localStorage: {
    getItem(key) { return storedPreferences.get(key) ?? null; },
    setItem(key, value) { storedPreferences.set(key, value); },
  },
};
globalThis.fetch = fakeFetch;
globalThis.document = { addEventListener() {}, removeEventListener() {} };
globalThis.Notification = { permission: "granted" };
globalThis.PushManager = class PushManager {};

let currentSubscription = null;
let subscribeOptions = null;
let unsubscribeCalls = 0;
const createdSubscription = {
  endpoint: "https://fcm.googleapis.com/push/device",
  options: { applicationServerKey: Buffer.from([4, ...new Array(64).fill(7)]) },
  toJSON() {
    return {
      endpoint: "https://fcm.googleapis.com/push/device",
      keys: { p256dh: "key", auth: "auth" },
    };
  },
  async unsubscribe() {
    unsubscribeCalls += 1;
    currentSubscription = null;
    return true;
  },
};
const registration = {
  pushManager: {
    async getSubscription() { return currentSubscription; },
    async subscribe(options) {
      subscribeOptions = options;
      currentSubscription = createdSubscription;
      return createdSubscription;
    },
  },
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { serviceWorker: { ready: Promise.resolve(registration) } },
});

const moduleUrl = pathToFileURL(join(
  __dirname,
  "../pawzochat/web/static/modules/push_notifications.js",
)).href + `?t=${Date.now()}`;
const mod = await import(moduleUrl);

assert.equal(mod.webPushState(), "disabled");
assert.equal(mod.systemNotificationsEnabled(), false);
assert.equal(await mod.subscribeWebPush(), "enabled");
assert.equal(mod.systemNotificationsEnabled(), true);
assert.equal(storedPreferences.get("pawzochat-system-notifications"), "enabled");
assert.equal(subscribeOptions.userVisibleOnly, true);
assert.equal(subscribeOptions.applicationServerKey.length, 65);
assert.equal(calls.filter(call => call.options.method === "POST").length, 1);
assert.deepEqual(
  JSON.parse(calls.find(call => call.options.method === "POST").options.body),
  { subscription: createdSubscription.toJSON() },
);

mod.resetWebPushStateForTests();
assert.equal(await mod.syncWebPushSubscription(), "enabled");
assert.equal(mod.systemNotificationsEnabled(), true);
assert.equal(calls.filter(call => call.options.method === "POST").length, 2);

assert.equal(await mod.unsubscribeWebPush(), "disabled");
assert.equal(mod.systemNotificationsEnabled(), false);
assert.equal(storedPreferences.get("pawzochat-system-notifications"), "disabled");
assert.equal(unsubscribeCalls, 1);
const deleteCall = calls.find(call => call.options.method === "DELETE");
assert.deepEqual(JSON.parse(deleteCall.options.body), {
  endpoint: createdSubscription.endpoint,
});
assert.equal(await mod.syncWebPushSubscription(), "disabled");
assert.equal(calls.filter(call => call.options.method === "POST").length, 2);

Notification.permission = "denied";
assert.equal(mod.webPushState(), "denied");

console.log("push notification subscription tests passed");