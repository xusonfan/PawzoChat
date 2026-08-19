import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const moduleUrl = name => pathToFileURL(join(
  __dirname,
  `../pawzochat/web/static/modules/${name}`,
)).href + `?t=${Date.now()}`;

const feedback = await import(moduleUrl("error_feedback.js"));

assert.deepEqual(feedback.errorNoticeFromEvent({
  type: "operation_error",
  title: "消息回复失败",
  message: "HTTP 503: upstream unavailable",
}), {
  title: "消息回复失败",
  message: "HTTP 503: upstream unavailable",
});
assert.deepEqual(feedback.errorNoticeFromEvent({
  type: "assistant_message_updated",
  message: {
    content: [{
      type: "image",
      status: "failed",
      error: "图片生成失败：请求超时",
    }],
  },
}), {
  title: "图片生成失败",
  message: "图片生成失败：请求超时",
});
assert.equal(feedback.errorNoticeFromEvent({
  type: "assistant_message_updated",
  message: { content: [{ type: "image", status: "pending" }] },
}), null);

function classList(initial = []) {
  const values = new Set(initial);
  return {
    add(...names) { names.forEach(name => values.add(name)); },
    remove(...names) { names.forEach(name => values.delete(name)); },
    contains(name) { return values.has(name); },
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : force;
      if (enabled) values.add(name); else values.delete(name);
      return enabled;
    },
  };
}

const title = { textContent: "" };
const message = { textContent: "", scrollHeight: 120, clientHeight: 60 };
const toggle = { textContent: "", classList: classList(["hide"]) };
const banner = {
  classList: classList(["hide"]),
  querySelector(selector) {
    return {
      ".error-banner-title": title,
      ".error-banner-message": message,
      ".error-banner-toggle": toggle,
    }[selector];
  },
};
globalThis.document = {
  getElementById(id) { return id === "error-banner" ? banner : null; },
};
globalThis.requestAnimationFrame = callback => { callback(); return 1; };

const ui = await import(moduleUrl("error_banner.js"));
ui.showErrorBanner("一段很长的上游异常", "图片生成失败");
assert.equal(title.textContent, "图片生成失败");
assert.equal(message.textContent, "一段很长的上游异常");
assert.equal(banner.classList.contains("show"), true);
assert.equal(toggle.classList.contains("hide"), false);
assert.equal(toggle.textContent, "展开详情");

ui.toggleErrorBanner();
assert.equal(banner.classList.contains("expanded"), true);
assert.equal(toggle.textContent, "收起详情");
ui.closeErrorBanner();
assert.equal(banner.classList.contains("show"), false);