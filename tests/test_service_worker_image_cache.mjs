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
  constructor(body, { ok = true, type = "basic" } = {}) {
    this.body = body;
    this.ok = ok;
    this.type = type;
  }
  clone() { return new FakeResponse(this.body, { ok: this.ok, type: this.type }); }
}

let networkFetches = 0;
const context = vm.createContext({
  URL,
  caches,
  console,
  encodeURIComponent,
  fetch: async request => {
    networkFetches += 1;
    return new FakeResponse(`network:${request.url}`);
  },
  self: {
    location: { origin: "https://pawzochat.local" },
    registration: {
      scope: "https://pawzochat.local/",
      async getNotifications() { return []; },
    },
    clients: {
      async claim() {},
      async matchAll() { return []; },
      async openWindow() {},
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

console.log("service worker image cache tests passed");