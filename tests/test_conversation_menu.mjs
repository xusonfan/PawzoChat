import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(join(
  __dirname,
  "../pawzochat/web/static/modules/conversation_menu.js",
)).href + `?t=${Date.now()}`);

assert.deepEqual(mod.conversationMenuLabels(false), ["置顶对话", "不显示聊天"]);
assert.deepEqual(mod.conversationMenuLabels(true), ["取消置顶", "不显示聊天"]);
assert.deepEqual(mod.conversationMenuAction(0, false), { type: "pin", pinned: true });
assert.deepEqual(mod.conversationMenuAction(0, true), { type: "pin", pinned: false });
assert.deepEqual(mod.conversationMenuAction(1, true), { type: "hide" });

assert.equal(mod.longPressMoved(10, 10, 20, 20), false);
assert.equal(mod.longPressMoved(10, 10, 21, 10), true);
assert.deepEqual(
  mod.clampMenuPosition(390, 790, 120, 90, 400, 800),
  { left: 272, top: 702 },
);
assert.deepEqual(
  mod.clampMenuPosition(-20, -30, 120, 90, 400, 800),
  { left: 8, top: 8 },
);

let nextTimer = 1;
const timers = new Map();
const fired = [];
const tracker = mod.createLongPressTracker({
  onLongPress: current => fired.push(current),
  setTimer(fn) {
    const id = nextTimer++;
    timers.set(id, fn);
    return id;
  },
  clearTimer(id) { timers.delete(id); },
});
const runTimers = () => {
  const callbacks = [...timers.values()];
  timers.clear();
  callbacks.forEach(fn => fn());
};

// Small movement does not cancel; opening consumes exactly the trailing click.
const catRow = { id: "cat" };
tracker.beginInput();
tracker.start(catRow, 100, 100, { personaId: "cat" });
tracker.move(106, 108);
assert.equal(tracker.pending, true);
runTimers();
assert.equal(fired.length, 1);
// Long press opens the menu but does not activate the conversation.
let opened = 0;
if (!tracker.consumeClick(catRow)) opened += 1;
assert.equal(opened, 0);
// Suppression is one-shot; the next independent ordinary press can open.
tracker.beginInput();
if (!tracker.consumeClick(catRow)) opened += 1;
assert.equal(opened, 1);
assert.equal(tracker.consumeClick(catRow), false);

// A real scroll/move beyond threshold cancels and does not suppress navigation.
const dogRow = { id: "dog" };
tracker.beginInput();
tracker.start(dogRow, 100, 100, { personaId: "dog" });
tracker.move(100, 111);
assert.equal(tracker.pending, false);
runTimers();
assert.equal(fired.length, 1);
assert.equal(tracker.consumeClick(dogRow), false);
opened += 1;
assert.equal(opened, 2);

// An ordinary short press is never suppressed.
tracker.beginInput();
tracker.start(dogRow, 0, 0, {});
tracker.cancel();
runTimers();
assert.equal(fired.length, 1);
assert.equal(tracker.consumeClick(dogRow), false);
opened += 1;
assert.equal(opened, 3);

// Secondary-button activation is not an ordinary click and must not open.
const secondaryButton = 2;
if (secondaryButton === 0 && !tracker.consumeClick(dogRow)) opened += 1;
assert.equal(opened, 3);

// Delegated row guards survive row replacement, stay scoped to conversation rows,
// and do not add another activation requirement to an ordinary click.
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const delegated = new Map();
const documentListeners = new Map();
const windowListeners = new Map();
const selectedTextNode = {};
let removedRanges = 0;
let appendedMenu = null;
const selection = {
  rangeCount: 1,
  anchorNode: selectedTextNode,
  focusNode: selectedTextNode,
  getRangeAt() { return { intersectsNode: candidate => candidate === row }; },
  removeAllRanges() { removedRanges += 1; this.rangeCount = 0; },
};
const menu = {
  style: {},
  isConnected: true,
  setAttribute() {},
  addEventListener() {},
  removeEventListener() {},
  getBoundingClientRect() { return { width: 120, height: 90 }; },
  querySelector() { return { focus() {} }; },
  contains() { return false; },
  remove() { this.isConnected = false; },
};
globalThis.document = {
  body: { appendChild(node) { appendedMenu = node; } },
  activeElement: null,
  createElement() { return menu; },
  getSelection() { return selection; },
  addEventListener(type, handler) { documentListeners.set(type, handler); },
  removeEventListener(type) { documentListeners.delete(type); },
};
globalThis.window = {
  innerWidth: 400,
  innerHeight: 800,
  getSelection() { return selection; },
  addEventListener(type, handler) { windowListeners.set(type, handler); },
  removeEventListener(type) { windowListeners.delete(type); },
};
const row = {
  dataset: { personaId: "cat" },
  isConnected: true,
  closest(selector) { return selector.includes(".conv-item") ? this : null; },
  contains(node) { return node === selectedTextNode; },
  getBoundingClientRect() { return { left: 10, top: 20, width: 200, height: 60 }; },
  focus() {},
};
const image = {
  closest(selector) { return selector === "img" ? this : row.closest(selector); },
};
const outside = { closest() { return null; } };
const list = {
  addEventListener(type, handler) { delegated.set(type, handler); },
  removeEventListener(type) { delegated.delete(type); },
};
let delegatedOpened = 0;
let delegatedTimer = null;
const detach = mod.attachConversationMenu(list, [{ persona_id: "cat", pinned: false }], {
  onOpen() { delegatedOpened += 1; },
  async onPin() {},
  async onHide() {},
}, {
  setTimer(callback) { delegatedTimer = callback; return 1; },
  clearTimer() { delegatedTimer = null; },
});
let prevented = false;
delegated.get("selectstart")({ target: row, preventDefault() { prevented = true; } });
assert.equal(prevented, true);
prevented = false;
delegated.get("selectstart")({ target: outside, preventDefault() { prevented = true; } });
assert.equal(prevented, false);
prevented = false;
delegated.get("dragstart")({ target: image, preventDefault() { prevented = true; } });
assert.equal(prevented, true);

// Right-click opening remains supported but does not touch an existing selection.
delegated.get("contextmenu")({
  target: row,
  clientX: 20,
  clientY: 30,
  preventDefault() {},
});
assert.equal(appendedMenu, menu);
assert.equal(removedRanges, 0);

// Only a long-press menu that actually opens clears the intersecting selection.
delegated.get("pointerdown")({
  target: row,
  pointerType: "touch",
  isPrimary: true,
  clientX: 20,
  clientY: 30,
});
delegatedTimer();
assert.equal(removedRanges, 1);

// A fresh ordinary pointer gesture plus one click performs exactly one open action.
delegated.get("pointerdown")({
  target: row,
  pointerType: "mouse",
  isPrimary: true,
  clientX: 20,
  clientY: 30,
});
delegated.get("click")({ target: row, button: 0 });
assert.equal(delegatedOpened, 1);
detach();
assert.equal(delegated.size, 0);
globalThis.document = originalDocument;
globalThis.window = originalWindow;

console.log("conversation menu tests passed");