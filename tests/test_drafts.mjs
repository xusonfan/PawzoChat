import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const values = new Map();
globalThis.localStorage = {
  getItem(key) { return values.get(key) ?? null; },
  setItem(key, value) { values.set(key, value); },
  removeItem(key) { values.delete(key); },
};

const {
  clearDraft,
  getDraftSummary,
  loadDraft,
  saveDraft,
  saveDraftMetadata,
} = await import("../pawzochat/web/static/modules/drafts.js");

saveDraftMetadata("chat", "alice", { text: "稍后发送", quote: "上一条消息" });
saveDraftMetadata("chat", "bob", { text: "另一个联系人", quote: "" });
assert.deepEqual(
  getDraftSummary("chat", "alice"),
  {
    text: "稍后发送",
    quote: "上一条消息",
    attachmentCount: 0,
    attachmentNames: [],
    updatedAt: getDraftSummary("chat", "alice").updatedAt,
  },
  "文本和引用应按 scopeId 隔离",
);
assert.equal(getDraftSummary("chat", "bob").text, "另一个联系人");
assert.equal(getDraftSummary("moments", "alice"), null, "不同业务命名空间不得共享草稿");

const image = new File(["image bytes"], "cat.png", { type: "image/png" });
await saveDraft("chat", "alice", {
  text: "带图片",
  quote: "",
  attachments: [{ kind: "image", file: image }],
});
const summary = getDraftSummary("chat", "alice");
assert.equal(summary.attachmentCount, 1);
assert.deepEqual(summary.attachmentNames, ["cat.png"]);
assert.equal(
  [...values.values()].some(value => value.includes("image bytes")),
  false,
  "localStorage 只能保存附件元数据，不能保存二进制内容",
);
assert.deepEqual(
  (await loadDraft("chat", "alice")).attachments,
  [],
  "IndexedDB 不可用时仍应恢复文本元数据",
);

saveDraftMetadata("chat", "alice", { text: "", quote: "" });
assert.equal(
  getDraftSummary("chat", "alice")?.attachmentCount,
  1,
  "清空文本不能误删仍含附件的草稿",
);
await clearDraft("chat", "alice");
assert.equal(getDraftSummary("chat", "alice"), null, "显式清理应删除草稿元数据");

saveDraftMetadata("prompt", "global", { text: "long prompt", quote: "" });
assert.equal(getDraftSummary("prompt", "global").text, "long prompt", "存储模块应可复用于长文本编辑器");

const __dirname = dirname(fileURLToPath(import.meta.url));
const chatSource = await readFile(join(
  __dirname,
  "../pawzochat/web/static/modules/chat.js",
), "utf8");
const draftSource = await readFile(join(
  __dirname,
  "../pawzochat/web/static/modules/drafts.js",
), "utf8");
const css = await readFile(join(
  __dirname,
  "../pawzochat/web/static/style.css",
), "utf8");

assert.match(draftSource, /createObjectStore\(ATTACHMENT_STORE, \{ keyPath: "id" \}\)/);
assert.match(draftSource, /store\.createIndex\("draftKey", "draftKey", \{ unique: false \}\)/);
assert.match(draftSource, /blob: file/, "附件 Blob 应写入 IndexedDB 记录");
assert.match(chatSource, /_restoreChatDraft\(\s*renderedPersonaId/);
assert.match(chatSource, /generation !== _draftRestoreGeneration[\s\S]*?personaId !== chatPersonaId/);
assert.match(chatSource, /await clearDraft\(_CHAT_DRAFT_NAMESPACE, personaId\)/, "成功发送后应清理对应联系人草稿");
assert.match(chatSource, /if \(sendFailed\)[\s\S]*?_pendingImages = \[\.\.\.imagesToSend, \.\.\._pendingImages\]/, "发送失败应恢复待发送附件");
assert.match(chatSource, /class="conv-draft-label">草稿<\/span>/);
assert.match(css, /\.conv-draft-label\s*\{[^}]*color:\s*var\(--danger\)/s);

console.log("draft tests passed");