import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

class FakeClassList {
  constructor(...values) { this.values = new Set(values); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : force;
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    return enabled;
  }
}

function fakeNode() {
  return {
    classList: new FakeClassList(),
    style: {},
    src: "",
    hidden: false,
    disabled: false,
    textContent: "",
    offsetWidth: 320,
    offsetHeight: 240,
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    stopPropagation() {},
  };
}

const image = fakeNode();
const content = fakeNode();
const modalChildren = new Map([
  ["#ipv-img", image],
  [".ipv-content", content],
  [".ipv-previous", fakeNode()],
  [".ipv-next", fakeNode()],
  [".ipv-counter", fakeNode()],
  [".ipv-caption", fakeNode()],
  [".ipv-backdrop", fakeNode()],
  [".ipv-close", fakeNode()],
  [".ipv-download", fakeNode()],
]);
const modal = {
  id: "",
  className: "",
  clientWidth: 390,
  clientHeight: 844,
  classList: new FakeClassList("hide"),
  getBoundingClientRect() { return { left: 0, top: 0, width: 390, height: 844 }; },
  set innerHTML(_) {},
  querySelector(selector) { return modalChildren.get(selector) || null; },
};

const documentListeners = new Map();
const pageImages = [];
globalThis.document = {
  body: { appendChild() {} },
  createElement() { return modal; },
  getElementById() { return null; },
  querySelectorAll(selector) { return selector === "img" ? pageImages : []; },
  addEventListener(type, handler) { documentListeners.set(type, handler); },
  removeEventListener(type, handler) {
    if (documentListeners.get(type) === handler) documentListeners.delete(type);
  },
};

globalThis.requestAnimationFrame = callback => {
  callback();
  return 1;
};
globalThis.setTimeout = callback => {
  callback();
  return 1;
};
globalThis.clearTimeout = () => {};

globalThis.location = { href: "http://localhost/chat" };
const windowListeners = new Map();
globalThis.window = {
  location: globalThis.location,
  innerWidth: 390,
  innerHeight: 844,
  addEventListener(type, handler) { windowListeners.set(type, handler); },
  open() {},
};

const initialNavigationState = {
  pawzoNavigation: { session: "test", index: 1, tab: "chat", depth: 1 },
};
const historyEntries = [initialNavigationState];
let historyIndex = 0;
globalThis.history = {
  get state() { return historyEntries[historyIndex]; },
  pushState(state) {
    historyEntries.splice(historyIndex + 1, Infinity, state);
    historyIndex += 1;
  },
  back() {
    if (historyIndex === 0) return;
    historyIndex -= 1;
    windowListeners.get("popstate")?.({ state: historyEntries[historyIndex] });
  },
  forward() {
    if (historyIndex >= historyEntries.length - 1) return;
    historyIndex += 1;
    windowListeners.get("popstate")?.({ state: historyEntries[historyIndex] });
  },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(join(
  __dirname,
  "../pawzochat/web/static/modules/image_preview.js",
)).href;
const { closeImagePreview, openImagePreview } = await import(moduleUrl);

// 打开预览时保留当前聊天导航状态，并额外压入图片覆盖层历史项。
openImagePreview("https://cdn.example.com/photo.png");
assert.equal(historyEntries.length, 2);
assert.equal(history.state.pawzoNavigation.index, 1);
assert.ok(history.state.pawzoImagePreview.token);
assert.equal(modal.classList.contains("show"), true);
assert.equal(image.src, "https://cdn.example.com/photo.png");

// 系统返回键只关闭图片，仍停留在原聊天导航项。
history.back();
assert.equal(historyIndex, 0);
assert.deepEqual(history.state, initialNavigationState);
assert.equal(modal.classList.contains("hide"), true);
assert.equal(image.src, "");

// 浏览器前进能恢复同一张预览，不会切换聊天页面。
history.forward();
assert.equal(historyIndex, 1);
assert.equal(modal.classList.contains("show"), true);
assert.equal(image.src, "https://cdn.example.com/photo.png");

// 关闭按钮同样消费预览历史项，而不是保留一个幽灵历史状态。
closeImagePreview();
assert.equal(historyIndex, 0);
assert.equal(modal.classList.contains("hide"), true);

// Escape 与关闭按钮保持一致。
openImagePreview("https://cdn.example.com/second.gif");
documentListeners.get("keydown")?.({ key: "Escape" });
assert.equal(historyIndex, 0);
assert.equal(modal.classList.contains("hide"), true);

// 同组图片支持方向键切换，并在关闭后前进恢复切换后的图片。
openImagePreview("https://cdn.example.com/one.png", [
  "https://cdn.example.com/one.png",
  "https://cdn.example.com/two.png",
], [
  "第一张图片的提示词",
  "第二张图片的提示词",
]);
assert.equal(modalChildren.get(".ipv-caption").textContent, "第一张图片的提示词");
assert.equal(modalChildren.get(".ipv-caption").hidden, false);
documentListeners.get("keydown")?.({ key: "ArrowRight" });
assert.equal(image.src, "https://cdn.example.com/two.png");
assert.equal(modalChildren.get(".ipv-counter").textContent, "2 / 2");
assert.equal(modalChildren.get(".ipv-caption").textContent, "第二张图片的提示词");
closeImagePreview();
history.forward();
assert.equal(image.src, "https://cdn.example.com/two.png");
assert.equal(modalChildren.get(".ipv-caption").textContent, "第二张图片的提示词");
history.back();

// 自动收集聊天页照片时应跳过表情，只在普通图片之间切换。
pageImages.push(
  {
    hidden: false,
    src: "https://cdn.example.com/chat-one.png",
    closest(selector) { return selector.includes(".msg-image") ? {} : null; },
  },
  {
    hidden: false,
    src: "https://cdn.example.com/sticker.png",
    closest(selector) { return selector.includes(".msg-emoji") ? {} : null; },
  },
  {
    hidden: false,
    src: "https://cdn.example.com/chat-two.png",
    closest(selector) { return selector.includes(".msg-image") ? {} : null; },
  },
);
openImagePreview("https://cdn.example.com/chat-one.png");
assert.equal(modalChildren.get(".ipv-counter").textContent, "1 / 2");
documentListeners.get("keydown")?.({ key: "ArrowRight" });
assert.equal(image.src, "https://cdn.example.com/chat-two.png");
closeImagePreview();

console.log("image preview history tests passed");