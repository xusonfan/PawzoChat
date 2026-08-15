import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = await readFile(join(
  __dirname,
  "../pawzochat/web/static/style.css",
), "utf8");

function exactRuleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m"));
  assert.ok(match, `missing exact CSS rule: ${selector}`);
  return match[1];
}

const itemRule = exactRuleBody(".conv-item");
assert.match(itemRule, /(?:^|;)\s*user-select\s*:\s*none\s*;/);
assert.match(itemRule, /(?:^|;)\s*-webkit-user-select\s*:\s*none\s*;/);

const mobileRule = css.match(
  /@media\s*\([^{}]*(?:max-width|hover|pointer)[^{}]*\)\s*(?:,\s*\([^{}]*(?:max-width|hover|pointer)[^{}]*\))*\s*\{\s*\.conv-item\s*\{([^}]*)\}/,
);
assert.ok(mobileRule, "missing mobile-scoped .conv-item rule");
assert.match(mobileRule[1], /-webkit-touch-callout\s*:\s*none\s*;/);

const imageRule = exactRuleBody(".conv-item img");
assert.match(imageRule, /-webkit-user-drag\s*:\s*none\s*;/);

// Selection suppression must stay on conversation rows, never message/input/moments selectors.
for (const selector of [".msg-bubble", ".chat-input", ".moments-item"]) {
  assert.doesNotMatch(
    exactRuleBody(selector),
    /(?:-webkit-)?user-select\s*:\s*none/,
  );
}
assert.doesNotMatch(
  css,
  /\.conv-item\s*,\s*[^{}]*(?:\.msg-|\.chat-input|\.moments-)[^{}]*\{/,
);

console.log("conversation list selection scope tests passed");