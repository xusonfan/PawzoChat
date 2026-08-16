import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

globalThis.window = { PAWZOCHAT_BASE: "" };
globalThis.document = {
  createElement() {
    return {
      innerHTML: "",
      set textContent(value) {
        this.innerHTML = String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      },
    };
  },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(join(
  __dirname,
  "../pawzochat/web/static/modules/choice_picker.js",
)).href;
const { buildChoicePickerHtml } = await import(moduleUrl);

const html = buildChoicePickerHtml({
  title: "选择模型",
  selectedValue: "model-b",
  options: [
    { value: "model-a", label: "Model A", description: "plain" },
    { value: "model-b", label: "Model <B>", description: "vision", disabled: false },
    { value: "disabled", label: "Disabled", disabled: true },
  ],
});

assert.match(html, /class="choice-picker-option" role="radio" aria-checked="false"/);
assert.match(html, /class="choice-picker-option is-selected" role="radio" aria-checked="true"/);
assert.match(html, /Model &lt;B&gt;/);
assert.match(html, /class="choice-picker-option is-disabled"[^>]*disabled/);
assert.match(html, /PawzoChat\.choicePickerSelect\(&quot;model-b&quot;\)/);
assert.doesNotMatch(html, /<select|<option/);

const emptyHtml = buildChoicePickerHtml({ title: "空", options: [] });
assert.match(emptyHtml, /暂无可选项/);

console.log("choice picker tests passed");