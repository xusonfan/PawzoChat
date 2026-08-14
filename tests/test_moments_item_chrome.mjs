/**
 * Static layout checks for moment card actions / meta chrome.
 * Run: node tests/test_moments_item_chrome.mjs
 */

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

globalThis.window = { PAWZOCHAT_BASE: "" };
globalThis.document = {
  createElement() {
    let text = "";
    return {
      set textContent(v) {
        text = String(v ?? "");
      },
      get textContent() {
        return text;
      },
      get innerHTML() {
        return text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      },
    };
  },
};

const modUrl = pathToFileURL(
  join(__dirname, "../pawzochat/web/static/modules/moments_item_chrome.js"),
).href;
const { buildMomentActionsPopHtml, buildMomentMetaHtml } = await import(modUrl);

function actionOrder(html) {
  const labels = [];
  for (const m of html.matchAll(/<span>([^<]*)<\/span>/g)) labels.push(m[1]);
  return labels;
}

// ---- Owner: 编辑 → 赞 → 评论；弹层无删除 ----
{
  const html = buildMomentActionsPopHtml("m1", { canEdit: true, liked: false });
  assert.deepEqual(actionOrder(html), ["编辑", "赞", "评论"]);
  assert.match(html, /momentsEdit\('m1'\)/);
  assert.match(html, /momentsLikeToggle\('m1'\)/);
  assert.match(html, /momentsOpenComposer\('m1'\)/);
  assert.doesNotMatch(html, /momentsDelete/);
  assert.doesNotMatch(html, /删除/);
  assert.doesNotMatch(html, /ri-delete-bin/);
}

// ---- Owner liked label ----
{
  const html = buildMomentActionsPopHtml("m1", { canEdit: true, liked: true });
  assert.deepEqual(actionOrder(html), ["编辑", "已赞", "评论"]);
}

// ---- Non-owner: 赞 → 评论；无编辑/删除 ----
{
  const html = buildMomentActionsPopHtml("m2", { canEdit: false, liked: false });
  assert.deepEqual(actionOrder(html), ["赞", "评论"]);
  assert.doesNotMatch(html, /momentsEdit/);
  assert.doesNotMatch(html, /momentsDelete/);
  assert.doesNotMatch(html, /编辑/);
}

// ---- Meta: owner has trash by time ----
{
  const html = buildMomentMetaHtml("m1", "刚刚", { canDelete: true });
  assert.match(html, /class="moments-time"/);
  assert.match(html, /刚刚/);
  assert.match(html, /class="moments-delete"/);
  assert.match(html, /title="删除"/);
  assert.match(html, /aria-label="删除"/);
  assert.match(html, /momentsDelete\('m1'\)/);
  assert.match(html, /event\.stopPropagation\(\)/);
  assert.match(html, /ri-delete-bin-line/);
  assert.match(html, /class="moments-more"/);
  // trash appears before the more button
  const delIdx = html.indexOf("moments-delete");
  const moreIdx = html.indexOf("moments-more");
  assert.ok(delIdx > 0 && moreIdx > delIdx);
}

// ---- Meta: non-owner no trash ----
{
  const html = buildMomentMetaHtml("m2", "昨天", { canDelete: false });
  assert.match(html, /昨天/);
  assert.doesNotMatch(html, /moments-delete/);
  assert.doesNotMatch(html, /momentsDelete/);
  assert.match(html, /moments-more/);
}

// ---- Escaping mid / time ----
{
  const html = buildMomentMetaHtml(`"><x`, `<script>`, { canDelete: true });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;|&quot;/);
}

console.log("test_moments_item_chrome.mjs: all passed");