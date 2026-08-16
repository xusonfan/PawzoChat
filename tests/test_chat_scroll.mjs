import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { createChatBottomAnchor } = await import(pathToFileURL(join(
  __dirname,
  "../pawzochat/web/static/modules/chat_scroll.js",
)).href);

function frameQueue() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    request(callback) { const id = nextId++; callbacks.set(id, callback); return id; },
    cancel(id) { callbacks.delete(id); },
    flush() {
      while (callbacks.size) {
        const pending = [...callbacks.values()];
        callbacks.clear();
        for (const callback of pending) callback();
      }
    },
    get size() { return callbacks.size; },
  };
}

class FakeImage {
  constructor({ complete = false } = {}) {
    this.complete = complete;
    this.listeners = new Map();
  }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  removeEventListener(type, handler) {
    if (this.listeners.get(type) === handler) this.listeners.delete(type);
  }
  emit(type) { this.listeners.get(type)?.(); }
}

class FakeScroller {
  constructor(images = []) {
    this.scrollTop = 0;
    this.clientHeight = 200;
    this.scrollHeight = 1000;
    this.images = images;
    this.children = [];
    this.listeners = new Map();
    this.lastElementChild = null;
  }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  removeEventListener(type, handler) {
    if (this.listeners.get(type) === handler) this.listeners.delete(type);
  }
  querySelectorAll(selector) {
    assert.equal(selector, "img[data-message-media]");
    return this.images;
  }
  userScroll(top) {
    this.scrollTop = top;
    this.listeners.get("scroll")?.();
  }
}

class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
    this.disconnectCount = 0;
  }
  observe(target) { this.targets.add(target); }
  disconnect() {
    this.disconnectCount += 1;
    this.targets.clear();
  }
  notify(target) {
    if (this.targets.has(target)) this.callback([{ target }]);
  }
}

function harness({ withResizeObserver = false } = {}) {
  const frames = frameQueue();
  const observers = [];
  const anchor = createChatBottomAnchor({
    requestFrame: callback => frames.request(callback),
    cancelFrame: id => frames.cancel(id),
    createResizeObserver: withResizeObserver
      ? callback => {
        const observer = new FakeResizeObserver(callback);
        observers.push(observer);
        return observer;
      }
      : null,
  });
  return { anchor, frames, observers };
}

// 初始历史里的延迟图片完成后继续锚定底部。
{
  const image = new FakeImage();
  const scroller = new FakeScroller([image]);
  const { anchor, frames } = harness();
  anchor.bind(scroller, { initial: true });
  const render = anchor.beginRender(scroller);
  anchor.finishRender(render, scroller);
  assert.equal(scroller.scrollTop, 1000);
  scroller.scrollHeight = 1500;
  image.emit("load");
  frames.flush();
  assert.equal(scroller.scrollTop, 1500);
  assert.equal(image.listeners.size, 0);
}

// 用户主动上滚立即取消初始锚定，后到图片不能强拉回。
{
  const image = new FakeImage();
  const scroller = new FakeScroller([image]);
  const { anchor, frames } = harness();
  anchor.bind(scroller, { initial: true });
  const render = anchor.beginRender(scroller);
  anchor.finishRender(render, scroller);
  scroller.userScroll(100);
  scroller.scrollHeight = 1600;
  image.emit("load");
  frames.flush();
  assert.equal(scroller.scrollTop, 100);
}

// 缓存图 complete 路径在下一帧按真实高度对齐。
{
  const image = new FakeImage({ complete: true });
  const scroller = new FakeScroller([image]);
  const { anchor, frames } = harness();
  anchor.bind(scroller, { initial: true });
  const render = anchor.beginRender(scroller);
  anchor.finishRender(render, scroller);
  scroller.scrollHeight = 1700;
  frames.flush();
  assert.equal(scroller.scrollTop, 1700);
  assert.equal(image.listeners.size, 0);
}

// 失败图 error 同样结算布局，并清理 load/error 两条监听。
{
  const image = new FakeImage();
  const scroller = new FakeScroller([image]);
  const { anchor, frames } = harness();
  anchor.bind(scroller, { initial: true });
  const render = anchor.beginRender(scroller);
  anchor.finishRender(render, scroller);
  scroller.scrollHeight = 1300;
  image.emit("error");
  frames.flush();
  assert.equal(scroller.scrollTop, 1300);
  assert.equal(image.listeners.size, 0);
}

// 切换会话会移除旧图监听；旧媒体事件不影响新会话。
{
  const oldImage = new FakeImage();
  const oldScroller = new FakeScroller([oldImage]);
  const newScroller = new FakeScroller();
  const { anchor, frames } = harness();
  anchor.bind(oldScroller, { initial: true });
  const oldRender = anchor.beginRender(oldScroller);
  anchor.finishRender(oldRender, oldScroller);
  anchor.bind(newScroller, { initial: true });
  newScroller.scrollHeight = 1400;
  newScroller.scrollTop = 200;
  oldScroller.scrollHeight = 1900;
  oldImage.emit("load");
  frames.flush();
  assert.equal(oldImage.listeners.size, 0);
  assert.equal(newScroller.scrollTop, 200);
}

// 消息行在图片事件之后继续变高时，只要仍贴底就再次校正。
{
  const row = {};
  const scroller = new FakeScroller();
  scroller.children = [row];
  scroller.lastElementChild = row;
  const { anchor, frames, observers } = harness({ withResizeObserver: true });
  anchor.bind(scroller, { initial: true });
  const render = anchor.beginRender(scroller);
  anchor.finishRender(render, scroller);
  assert.equal(observers.length, 1);
  assert.equal(observers[0].targets.has(row), true);
  scroller.scrollHeight = 1800;
  observers[0].notify(row);
  frames.flush();
  assert.equal(scroller.scrollTop, 1800);
}

// 用户主动上滑后，后续尺寸变化不能强制拉回底部。
{
  const row = {};
  const scroller = new FakeScroller();
  scroller.children = [row];
  const { anchor, frames, observers } = harness({ withResizeObserver: true });
  anchor.bind(scroller, { initial: true });
  const render = anchor.beginRender(scroller);
  anchor.finishRender(render, scroller);
  scroller.userScroll(100);
  scroller.scrollHeight = 1800;
  observers[0].notify(row);
  frames.flush();
  assert.equal(scroller.scrollTop, 100);
  assert.equal(frames.size, 0);
}

// 重绑和销毁都会断开旧观察器，已排队的旧回调也不能再生效。
{
  const oldRow = {};
  const newRow = {};
  const scroller = new FakeScroller();
  scroller.children = [oldRow];
  const { anchor, frames, observers } = harness({ withResizeObserver: true });
  anchor.bind(scroller, { initial: true });
  const oldRender = anchor.beginRender(scroller);
  anchor.finishRender(oldRender, scroller);
  const oldObserver = observers[0];

  anchor.bind(scroller, { initial: true });
  assert.equal(oldObserver.disconnectCount, 2);
  scroller.scrollTop = 100;
  oldObserver.callback([{ target: oldRow }]);
  frames.flush();
  assert.equal(scroller.scrollTop, 100);

  scroller.children = [newRow];
  const newRender = anchor.beginRender(scroller);
  anchor.finishRender(newRender, scroller);
  const activeObserver = observers[1];
  anchor.dispose();
  assert.equal(activeObserver.disconnectCount, 2);
  scroller.scrollTop = 120;
  activeObserver.callback([{ target: newRow }]);
  frames.flush();
  assert.equal(scroller.scrollTop, 120);
}

// 页面根节点替换时，生命周期观察器立即释放旧媒体监听。
{
  const OriginalMutationObserver = globalThis.MutationObserver;
  let observer = null;
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {}
    disconnect() { this.disconnected = true; }
    notify() { this.callback(); }
  };
  const image = new FakeImage();
  const scroller = new FakeScroller([image]);
  scroller.isConnected = true;
  const { anchor } = harness();
  anchor.bind(scroller, { initial: true, lifecycleRoot: {} });
  const render = anchor.beginRender(scroller);
  anchor.finishRender(render, scroller);
  scroller.isConnected = false;
  observer.notify();
  assert.equal(observer.disconnected, true);
  assert.equal(image.listeners.size, 0);
  globalThis.MutationObserver = OriginalMutationObserver;
}

console.log("chat scroll anchoring tests passed");