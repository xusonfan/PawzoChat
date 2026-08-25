import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const storageValues = new Map();
globalThis.localStorage = {
  getItem(key) { return storageValues.get(key) ?? null; },
  setItem(key, value) { storageValues.set(key, value); },
};

const {
  recentForwardPersonas,
  recentSharedPersonas,
  rememberForwardPersona,
  sharedPayloadText,
} = await import(
  "../pawzochat/web/static/modules/share_target_store.js"
);

assert.equal(
  sharedPayloadText({ title: "页面标题", text: "页面摘要", url: "https://example.com" }),
  "页面标题\n页面摘要\nhttps://example.com",
);
assert.equal(
  sharedPayloadText({ title: "https://example.com", url: "https://example.com" }),
  "https://example.com",
  "相同的分享字段不应重复填入发送框",
);

const personas = [
  { id: "cat", name: "小猫" },
  { id: "dog", name: "小狗" },
  { id: "fox", name: "狐狸" },
];
assert.deepEqual(
  recentSharedPersonas(personas, [
    { persona_id: "cat", updated_at: "2026-08-20T10:00:00Z", pinned: true },
    { persona_id: "removed", updated_at: "2026-08-25T12:00:00Z" },
    { persona_id: "dog", updated_at: "2026-08-24T10:00:00Z" },
    { persona_id: "fox", updated_at: "2026-08-23T10:00:00Z" },
  ], 2),
  [personas[1], personas[2]],
  "最近聊天应按活跃时间排序、忽略已删除人物，且不受置顶状态影响",
);
rememberForwardPersona("dog");
rememberForwardPersona("cat");
rememberForwardPersona("dog");
assert.deepEqual(
  recentForwardPersonas(personas),
  [personas[1], personas[0]],
  "最近转发应独立记录选择顺序，并把重复人物移到最前",
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const serviceWorkerSource = await readFile(join(
  __dirname,
  "../pawzochat/web/static/service-worker.js",
), "utf8");
const appSource = await readFile(join(
  __dirname,
  "../pawzochat/web/static/app.js",
), "utf8");
const chatSource = await readFile(join(
  __dirname,
  "../pawzochat/web/static/modules/chat.js",
), "utf8");
const cssSource = await readFile(join(
  __dirname,
  "../pawzochat/web/static/style.css",
), "utf8");

assert.match(serviceWorkerSource, /request\.method === "POST"[\s\S]*?\/share-target/);
assert.match(serviceWorkerSource, /await request\.formData\(\)/);
assert.match(serviceWorkerSource, /indexedDB\.open\("pawzo-share-targets", 1\)/);
assert.match(serviceWorkerSource, /Response\.redirect\(launchUrl\.href, 303\)/);
assert.match(appSource, /readSharedPayload\(id\)/);
assert.match(appSource, /await detectSharedImport\(payload\)/);
assert.match(appSource, /const accepted = await confirmSharedImport\(detectedImport\)/);
assert.match(appSource, /showSheet\([\s\S]*?shared-import-confirm[\s\S]*?shared-import-submit/);
assert.match(appSource, /URL\.createObjectURL\(detected\.file\)/);
assert.match(appSource, /URL\.revokeObjectURL\(previewUrl\)/);
assert.match(appSource, /if \(!accepted\) \{[\s\S]*?await deleteSharedPayload\(id\);[\s\S]*?return;/);
assert.match(appSource, /await importDetectedSharedFile\([\s\S]*?detectedImport/);
assert.match(appSource, /if \(!importResult\.imported\) \{[\s\S]*?toast\(importResult\.error[\s\S]*?return;/);
assert.match(appSource, /await chooseSharedContent\(payload\)/);
assert.ok(
  appSource.indexOf("await detectSharedImport(payload)") < appSource.indexOf("await confirmSharedImport(detectedImport)")
    && appSource.indexOf("await confirmSharedImport(detectedImport)") < appSource.indexOf("await importDetectedSharedFile("),
  "应先识别、再展示定制确认弹层，用户确认后才能调用导入接口",
);
assert.doesNotMatch(
  appSource,
  /if \(!accepted\)[\s\S]{0,180}?chooseSharedContent/,
  "取消导入必须直接结束，不能回退到人物发送",
);
assert.match(chatSource, /选择接收分享的角色/);
assert.match(chatSource, /recentForwardPersonas\(state\.personas\)/);
assert.match(chatSource, /recentSharedPersonas\(state\.personas, state\.conversations, state\.conversations\.length\)/);
assert.match(chatSource, /id="share-forward-title">最近转发/);
assert.match(chatSource, /class="share-section-title share-chat-title">最近聊天/);
assert.match(chatSource, /class="share-recent-list"[\s\S]*?startSharedChat/);
assert.match(chatSource, /rememberForwardPersona\(personaId\)/);
assert.match(cssSource, /\.share-recent-list\s*\{[^}]*grid-auto-flow:\s*column;[^}]*overflow-x:\s*auto;/s);
assert.match(cssSource, /\.share-recent-person \.avatar\s*\{[^}]*border-radius:\s*14px;/s);
assert.match(chatSource, /await _saveSharedContentAsDraft\(personaId, selection\.payload\)/);
assert.match(chatSource, /attachments: \[\.\.\.\(draft\?\.attachments \|\| \[\]\), \.\.\.sharedAttachments\]/);
assert.doesNotMatch(chatSource, /startSharedChat[\s\S]{0,1800}sendChat\(/, "系统分享不得绕过用户确认直接发送");

console.log("share target tests passed");