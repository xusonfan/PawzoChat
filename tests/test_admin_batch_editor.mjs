import assert from "node:assert/strict";
import test from "node:test";

import { buildOperation, describeOperation } from "../pawzochat/web/static/admin/batch-editor.js";
import { buildCreationPayload } from "../pawzochat/web/static/admin/persona-creator.js";

const label = value => value;

test("builds tri-state-compatible boolean set operation", () => {
  assert.deepEqual(buildOperation("memory.enabled", { value: "false" }), {
    kind: "set",
    path: "memory.enabled",
    value: false,
  });
});

test("builds prompt replacement operation", () => {
  assert.deepEqual(buildOperation("character_prompt", {
    mode: "replace",
    find: "旧设定",
    value: "新设定",
  }), {
    kind: "prompt",
    field: "character_prompt",
    mode: "replace",
    find: "旧设定",
    value: "新设定",
    separator: "\n",
  });
});

test("normalizes comma-separated tool names", () => {
  const operation = buildOperation("tool_policy.list", { value: "search, image, search" });
  assert.deepEqual(operation.value, ["search", "image", "search"]);
  assert.match(describeOperation(operation, label), /tool_policy\.list/);
});

test("rejects empty name affix operation", () => {
  assert.throws(() => buildOperation("name_affix", { prefix: "", suffix: "" }), /前缀或后缀/);
});

test("builds a reviewed creation payload with generated assets", () => {
  assert.deepEqual(buildCreationPayload({
    enabled: true,
    name: "  雾港守灯人  ",
    signature: "  守住最后一束光  ",
    llm_provider: "main",
    llm_model: "writer",
    character_prompt: "人设",
    output_examples: "示例",
    system_instructions: "系统",
    avatar_prompt: "银发守灯人",
    avatar_image: "avatar-base64",
    moments_cover_image: "cover-base64",
  }), {
    enabled: true,
    name: "雾港守灯人",
    signature: "守住最后一束光",
    llm_provider: "main",
    llm_model: "writer",
    character_prompt: "人设",
    output_examples: "示例",
    system_instructions: "系统",
    image_generation: { style_prefix: "银发守灯人" },
    avatar_image: "avatar-base64",
    moments_cover_image: "cover-base64",
  });
});