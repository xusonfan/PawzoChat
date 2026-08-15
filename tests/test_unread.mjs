import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeBadge(className, count) {
  return {
    className,
    dataset: { count: String(count) },
    textContent: count > 99 ? "99+" : String(count),
    getAttribute(name) {
      if (name === "aria-label") return this._ariaLabel || "";
      return null;
    },
    setAttribute(name, value) {
      if (name === "aria-label") this._ariaLabel = value;
      if (name === "aria-hidden") this._ariaHidden = value;
    },
    removeAttribute(name) {
      if (name === "aria-label") delete this._ariaLabel;
    },
    remove() {
      this._removed = true;
      const parent = this._parent;
      if (!parent) return;
      parent._children = parent._children.filter(c => c !== this);
    },
  };
}

function makeWrap(count) {
  const wrap = {
    _children: [],
    querySelector(sel) {
      if (sel === ".conv-unread-badge") {
        return this._children.find(c => c.className === "conv-unread-badge" && !c._removed) || null;
      }
      return null;
    },
    insertAdjacentHTML(_pos, html) {
      const m = html.match(/data-count="(\d+)"/);
      const badge = makeBadge("conv-unread-badge", Number(m?.[1] || 0));
      badge._parent = this;
      this._children.push(badge);
    },
  };
  if (count) {
    const badge = makeBadge("conv-unread-badge", count);
    badge._parent = wrap;
    wrap._children.push(badge);
  }
  return wrap;
}

function makeTab(count) {
  const tab = {
    _children: [],
    _attrs: {},
    querySelector(sel) {
      if (sel === ".tab-unread-badge") {
        return this._children.find(c => c.className === "tab-unread-badge" && !c._removed) || null;
      }
      return null;
    },
    setAttribute(name, value) { this._attrs[name] = value; },
    removeAttribute(name) { delete this._attrs[name]; },
    appendChild(node) {
      node._parent = this;
      this._children.push(node);
    },
  };
  if (count) {
    const badge = makeBadge("tab-unread-badge", count);
    badge._parent = tab;
    tab._children.push(badge);
    tab._attrs["aria-label"] = `聊天，${count} 条未读消息`;
  }
  return tab;
}

const wrapsByPersona = new Map();
const chatTabs = [];

globalThis.document = {
  createElement(tag) {
    if (tag !== "span") throw new Error(`unexpected createElement(${tag})`);
    return {
      className: "",
      dataset: {},
      textContent: "",
      setAttribute(name, value) {
        if (name === "aria-hidden") this._ariaHidden = value;
      },
    };
  },
  querySelectorAll(sel) {
    if (sel === ".conv-item[data-persona-id]") {
      return Array.from(wrapsByPersona.entries()).map(([personaId, wrap]) => ({
        dataset: { personaId },
        querySelector(s) {
          if (s === ".conv-avatar-wrap") return wrap;
          return null;
        },
      }));
    }
    if (sel === ".tab[data-tab='chat']") return chatTabs.slice();
    return [];
  },
};

const mod = await import(pathToFileURL(
  join(__dirname, "../pawzochat/web/static/modules/unread.js"),
).href + `?t=${Date.now()}`);

assert.equal(mod.formatUnreadCount(0), "0");
assert.equal(mod.formatUnreadCount(99), "99");
assert.equal(mod.formatUnreadCount(100), "99+");
const conversations = [
  { persona_id: "cat", unread_count: 2 },
  { persona_id: "dog", unread_count: 5 },
  { persona_id: "fox", unread_count: 0 },
];
assert.equal(mod.totalUnread(conversations), 7);
assert.equal(mod.markConversationReadLocal(conversations, "cat"), true);
assert.equal(conversations[0].unread_count, 0);
assert.equal(mod.totalUnread(conversations), 5);
assert.equal(mod.unreadBadgeHtml(0), "");
assert.match(mod.unreadBadgeHtml(3), /role="status"/);
assert.match(mod.unreadBadgeHtml(3), /data-count="3"/);
assert.match(mod.unreadBadgeHtml(3), /3 条未读消息/);

// Preserve last known unread when server omits the field mid-refresh.
const merged = mod.mergeConversationsPreserveUnread(
  [{ persona_id: "cat", unread_count: 4, preview: "old" }],
  [{ persona_id: "cat", preview: "new" }, { persona_id: "dog", unread_count: 1 }],
);
assert.equal(merged[0].unread_count, 4);
assert.equal(merged[0].preview, "new");
assert.equal(merged[1].unread_count, 1);

// Same count must not rebuild avatar badge DOM (no remove / insert).
const catWrap = makeWrap(3);
wrapsByPersona.set("cat", catWrap);
const firstBadge = catWrap.querySelector(".conv-unread-badge");
assert.equal(mod.setConversationUnreadBadge(catWrap, 3), false);
assert.equal(catWrap.querySelector(".conv-unread-badge"), firstBadge);
assert.equal(firstBadge._removed, undefined);
assert.equal(mod.updateConversationUnread([{ persona_id: "cat", unread_count: 3 }]), false);
assert.equal(catWrap.querySelector(".conv-unread-badge"), firstBadge);

// Count change updates in place without a remove flash when badge already exists.
assert.equal(mod.setConversationUnreadBadge(catWrap, 7), true);
assert.equal(catWrap.querySelector(".conv-unread-badge"), firstBadge);
assert.equal(firstBadge.dataset.count, "7");
assert.equal(firstBadge.textContent, "7");

// Zero removes once; second apply is a no-op.
assert.equal(mod.setConversationUnreadBadge(catWrap, 0), true);
assert.equal(catWrap.querySelector(".conv-unread-badge"), null);
assert.equal(mod.setConversationUnreadBadge(catWrap, 0), false);

// Tab badge: identical total does not remove/recreate.
const tab = makeTab(5);
chatTabs.push(tab);
const tabBadge = tab.querySelector(".tab-unread-badge");
assert.equal(mod.updateChatTabUnread([
  { persona_id: "cat", unread_count: 2 },
  { persona_id: "dog", unread_count: 3 },
]), false);
assert.equal(tab.querySelector(".tab-unread-badge"), tabBadge);
assert.equal(tabBadge._removed, undefined);

// Tab total change updates text in place.
assert.equal(mod.updateChatTabUnread([
  { persona_id: "cat", unread_count: 9 },
]), true);
assert.equal(tab.querySelector(".tab-unread-badge"), tabBadge);
assert.equal(tabBadge.dataset.count, "9");
assert.equal(tabBadge.textContent, "9");
assert.equal(tab._attrs["aria-label"], "聊天，9 条未读消息");

// Clear tab badge once, then stable.
assert.equal(mod.updateChatTabUnread([{ persona_id: "cat", unread_count: 0 }]), true);
assert.equal(tab.querySelector(".tab-unread-badge"), null);
assert.equal(mod.updateChatTabUnread([{ persona_id: "cat", unread_count: 0 }]), false);

// Simulate refresh-list paint: HTML built with badge present, then same-count
// projection must not tear it down (repro of "角标闪一下").
wrapsByPersona.clear();
const refreshWrap = makeWrap(0);
refreshWrap.insertAdjacentHTML("beforeend", mod.unreadBadgeHtml(4, "conv-unread-badge"));
wrapsByPersona.set("bird", refreshWrap);
const painted = refreshWrap.querySelector(".conv-unread-badge");
assert.equal(painted.dataset.count, "4");
const snapshots = [];
for (let i = 0; i < 3; i++) {
  mod.updateConversationUnread([{ persona_id: "bird", unread_count: 4 }]);
  snapshots.push({
    sameNode: refreshWrap.querySelector(".conv-unread-badge") === painted,
    count: mod.readBadgeCount(refreshWrap.querySelector(".conv-unread-badge")),
    removed: !!painted._removed,
  });
}
assert.ok(snapshots.every(s => s.sameNode && s.count === 4 && !s.removed),
  `badge must stay stable across same-count refreshes: ${JSON.stringify(snapshots)}`);

console.log("unread tests passed");