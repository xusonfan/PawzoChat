/**
 * Regression tests for shared text/image parsing and rendering.
 * Run: node tests/test_message_content.mjs
 * Avoids network; mocks minimal browser globals for esc/escAttr.
 */

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal browser globals used by utils.js / message_content.js
globalThis.window = { PAWZOCHAT_BASE: "" };
const storedValues = new Map();
globalThis.localStorage = {
  getItem(key) { return storedValues.get(key) ?? null; },
  setItem(key, value) { storedValues.set(key, String(value)); },
};
globalThis.document = {
  baseURI: "http://pawzochat.local/app/",
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
  join(__dirname, "../pawzochat/web/static/modules/message_content.js"),
).href;
const { parseTextMedia, renderTextMedia } = await import(modUrl);
const imageLayoutModUrl = pathToFileURL(
  join(__dirname, "../pawzochat/web/static/modules/image_layout_cache.js"),
).href;
const { imageLayoutAttributes, rememberImageLayout } = await import(imageLayoutModUrl);

function types(segments) {
  return segments.map((s) => s.type);
}

function imageUrls(segments) {
  return segments.filter((s) => s.type === "image").map((s) => s.url);
}

// ---- parseTextMedia ----

{
  const segs = parseTextMedia("https://cdn.example.com/a.png");
  assert.deepEqual(types(segs), ["image"]);
  assert.equal(segs[0].url, "https://cdn.example.com/a.png");
}

{
  const segs = parseTextMedia("![猫](https://cdn.example.com/cat.jpg)");
  assert.deepEqual(types(segs), ["image"]);
  assert.equal(segs[0].url, "https://cdn.example.com/cat.jpg");
  assert.equal(segs[0].alt, "猫");
}

{
  const segs = parseTextMedia("看看 [图片链接](https://cdn.example.com/x.webp) 吧");
  assert.equal(imageUrls(segs).length, 1);
  assert.equal(imageUrls(segs)[0], "https://cdn.example.com/x.webp");
  assert.ok(segs.some((s) => s.type === "text" && s.text.includes("看看")));
}

{
  const segs = parseTextMedia("图文 https://cdn.example.com/mix.gif 混合\n第二行");
  assert.deepEqual(types(segs), ["text", "image", "text"]);
  assert.ok(segs[2].text.includes("第二行"));
}

{
  const segs = parseTextMedia("普通链接 https://example.com/page 不要当图");
  assert.deepEqual(types(segs), ["text"]);
  assert.ok(!segs.some((s) => s.type === "image"));
}

{
  const segs = parseTextMedia("[官网](https://example.com/docs)");
  assert.deepEqual(types(segs), ["text"]);
}

{
  const segs = parseTextMedia("<https://cdn.example.com/angle.png>");
  assert.deepEqual(types(segs), ["image"]);
  assert.equal(segs[0].url, "https://cdn.example.com/angle.png");
}

{
  const segs = parseTextMedia("[截图](https://cdn.example.com/shot.jpeg)");
  assert.deepEqual(types(segs), ["image"]);
}

// ---- renderTextMedia (chat-compatible defaults) ----

{
  const html = renderTextMedia("你好", { textClass: "msg-bubble", imageClass: "msg-image" });
  assert.match(html, /class="msg-bubble"/);
  assert.match(html, /你好/);
  assert.doesNotMatch(html, /<img/);
}

{
  const html = renderTextMedia("https://cdn.example.com/a.png", {
    textClass: "msg-bubble",
    imageClass: "msg-image",
  });
  assert.match(html, /class="msg-image linked-image"/);
  assert.match(html, /src="https:\/\/cdn\.example\.com\/a\.png"/);
  assert.match(html, /onclick="PawzoChat\.openImagePreview\(this\.src\)"/);
  assert.match(html, /onerror="this\.hidden=true;this\.nextElementSibling\.hidden=false"/);
  assert.match(html, /class="linked-image-fallback"/);
  assert.match(html, /hidden/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /onload="PawzoChat\.rememberImageLayout\(this\)"/);
  assert.match(html, /alt="图片"/);
  assert.doesNotMatch(html, /event\.stopPropagation/);
}

// 已加载图片的天然尺寸会被持久化；角色再次渲染时立即预留空间。
{
  const source = "https://cdn.example.com/wide.png#preview";
  assert.equal(imageLayoutAttributes(source), "");
  assert.equal(rememberImageLayout({
    currentSrc: source,
    naturalWidth: 1200,
    naturalHeight: 600,
  }), true);
  assert.equal(
    imageLayoutAttributes("https://cdn.example.com/wide.png"),
    ' style="width:240px;height:auto;aspect-ratio:1200 / 600"',
  );

  const html = renderTextMedia("![宽图](https://cdn.example.com/wide.png)", {
    textClass: "msg-bubble",
    imageClass: "msg-image",
  });
  assert.match(html, /style="width:240px;height:auto;aspect-ratio:1200 \/ 600"/);
  assert.ok(storedValues.has("pawzochat-image-layout-v1"));
}

// 同一尺寸元数据按当前场景约束缩放，朋友圈缩略图不会使用聊天宽度。
{
  assert.equal(
    imageLayoutAttributes("https://cdn.example.com/wide.png", {
      maxWidth: 96,
      maxHeight: 96,
    }),
    ' style="width:96px;height:auto;aspect-ratio:1200 / 600"',
  );
}

// ---- renderTextMedia (moments comment mode) ----

const momentsOpts = {
  imageClass: "moments-reply-image",
  inline: true,
  preserveNewlines: true,
  trimMediaBoundaryNewlines: true,
  stopPropagation: true,
};

{
  const html = renderTextMedia("纯图 https://cdn.example.com/e.png", momentsOpts);
  assert.match(html, /纯图 /);
  assert.match(html, /class="moments-reply-image linked-image"/);
  assert.match(html, /<span class="moments-reply-image/);
  assert.doesNotMatch(html, /<div class=/);
  assert.match(html, /event\.stopPropagation\(\);PawzoChat\.openImagePreview\(this\.src\)/);
  assert.match(html, /onclick="event\.stopPropagation\(\)"/);
  assert.match(html, /onerror="this\.hidden=true;this\.nextElementSibling\.hidden=false"/);
}

{
  const html = renderTextMedia("第一行\n第二行", momentsOpts);
  assert.match(html, /第一行<br>第二行/);
}

// text\nimage: no blank <br> immediately before the thumbnail
{
  const html = renderTextMedia("你好呀\nhttps://cdn.example.com/a.png", momentsOpts);
  assert.match(html, /你好呀/);
  assert.match(html, /src="https:\/\/cdn\.example\.com\/a\.png"/);
  assert.doesNotMatch(html, /你好呀<br>/);
  assert.doesNotMatch(html, /<br><span class="moments-reply-image/);
}

// pure image: no leading <br>
{
  const html = renderTextMedia("\nhttps://cdn.example.com/only.png\n", momentsOpts);
  assert.match(html, /^<span class="moments-reply-image/);
  assert.doesNotMatch(html, /^<br>/);
  assert.doesNotMatch(html, /<br><span/);
  assert.doesNotMatch(html, /<\/span><br>/);
}

// explicit double newline between text paragraphs stays
{
  const html = renderTextMedia("第一段\n\n第二段", momentsOpts);
  assert.match(html, /第一段<br><br>第二段/);
}

// multi-image: no empty <br> rows between thumbs
{
  const html = renderTextMedia(
    "https://cdn.example.com/1.png\nhttps://cdn.example.com/2.png",
    momentsOpts,
  );
  assert.equal((html.match(/<img /g) || []).length, 2);
  assert.doesNotMatch(html, /<\/span><br><span/);
  assert.doesNotMatch(html, /<\/span>\s*<br>\s*<span/);
}

// chat defaults still keep boundary newlines (option off)
{
  const html = renderTextMedia("你好呀\nhttps://cdn.example.com/a.png", {
    textClass: "msg-bubble",
    imageClass: "msg-image",
  });
  // Default: text segment keeps trailing newline; non-empty after esc → bubble
  assert.match(html, /class="msg-bubble"/);
  assert.match(html, /class="msg-image linked-image"/);
  assert.match(html, /src="https:\/\/cdn\.example\.com\/a\.png"/);
  // preserveNewlines off → raw \n is escaped away as text content, not <br>
  assert.doesNotMatch(html, /<br>/);
}

{
  const evil = '"><img src=x onerror=alert(1)>';
  const html = renderTextMedia(evil, {
    imageClass: "moments-reply-image",
    inline: true,
    preserveNewlines: true,
    stopPropagation: true,
  });
  // Must be escaped text only — no real img/script injection
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<img[^>]*onerror=alert/);
  assert.match(html, /&lt;img|&quot;&gt;/);
  assert.ok(html.includes("onerror=alert") === false || html.includes("&lt;"));
}

{
  const evilUrl = 'https://cdn.example.com/a.png" onload="alert(1)';
  // Not a valid image URL path match after quote — should stay text or be attr-escaped if matched
  const html = renderTextMedia(`![x](${evilUrl})`, {
    imageClass: "moments-reply-image",
    inline: true,
    stopPropagation: true,
  });
  // Either not parsed as image, or attributes escaped — never raw onload injection
  assert.doesNotMatch(html, /onload="alert/);
  if (html.includes("<img")) {
    assert.match(html, /&quot;|&#34;/);
  }
}

{
  // Markdown image mixed with text
  const html = renderTextMedia("前 ![表情](https://cdn.example.com/e.gif) 后", {
    imageClass: "moments-reply-image",
    inline: true,
    preserveNewlines: true,
    stopPropagation: true,
  });
  assert.match(html, /前 /);
  assert.match(html, /alt="表情"/);
  assert.match(html, / 后/);
  assert.match(html, /src="https:\/\/cdn\.example\.com\/e\.gif"/);
}

{
  // Normal page link must not become img
  const html = renderTextMedia("见 https://example.com/about 文档", {
    imageClass: "moments-reply-image",
    inline: true,
    preserveNewlines: true,
    stopPropagation: true,
  });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /https:\/\/example\.com\/about/);
}

console.log("test_message_content.mjs: all passed");