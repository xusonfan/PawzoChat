import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const windowListeners = new Map();
const elements = new Map();

function createElement() {
  const classes = new Set(["hide"]);
  return {
    innerHTML: "",
    classList: {
      add(...names) { names.forEach(name => classes.add(name)); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      contains(name) { return classes.has(name); },
    },
  };
}

for (const id of ["sheet-content", "overlay", "action-sheet"]) {
  elements.set(id, createElement());
}

globalThis.document = {
  getElementById(id) { return elements.get(id) || null; },
};
globalThis.window = {
  addEventListener(type, handler) { windowListeners.set(type, handler); },
};
globalThis.location = { href: "http://localhost/" };
globalThis.requestAnimationFrame = callback => callback();

const baseState = { pawzoNavigation: { session: "test", index: 1 } };
let pushes = 0;
let backs = 0;
globalThis.history = {
  state: baseState,
  pushState(state) { this.state = state; pushes += 1; },
  back() { this.state = baseState; backs += 1; },
};

const ui = await import(pathToFileURL(join(
  __dirname,
  "../pawzochat/web/static/modules/ui.js",
)).href + `?t=${Date.now()}`);

let closes = 0;
ui.showSheet("<div>选择器</div>", () => { closes += 1; });
assert.equal(pushes, 1, "打开弹层应压入一条独立历史记录");
assert.ok(history.state.pawzoOverlay?.token);
assert.equal(elements.get("overlay").classList.contains("show"), true);

// Android 返回键产生 popstate：只关闭弹层，不再调用 history.back。
history.state = baseState;
windowListeners.get("popstate")?.({ state: baseState });
assert.equal(elements.get("overlay").classList.contains("show"), false);
assert.equal(closes, 1);
assert.equal(backs, 0);

// 点击取消关闭时应消费弹层自己的历史项，并在 popstate 完成后才允许后续导航。
ui.showSheet("<div>再次打开</div>");
assert.equal(pushes, 2);
let historyClosed = false;
const closeResult = ui.closeOverlay().then(() => { historyClosed = true; });
assert.equal(backs, 1);
await Promise.resolve();
assert.equal(historyClosed, false, "history.back 尚未生效时不能开始后续导航");
windowListeners.get("popstate")?.({ state: baseState });
await Promise.resolve();
assert.equal(historyClosed, false, "后续导航必须等当前 popstate 分发完成");
await closeResult;
assert.equal(historyClosed, true, "popstate 后应解除后续导航等待");

console.log("overlay history tests passed");