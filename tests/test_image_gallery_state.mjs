import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(join(
  __dirname,
  "../pawzochat/web/static/modules/image_gallery_state.js",
)).href;
const {
  allImageIds,
  chooseImageModel,
  toggleImageSelection,
} = await import(moduleUrl);

const providers = [
  { name: "未配置", api_key_set: false, models: [{ id: "hidden" }] },
  { name: "PawAPI", api_key_set: true, models: [{ id: "image-a" }, { id: "image-b" }] },
  { name: "空模型", api_key_set: true, models: [] },
];

assert.deepEqual(
  chooseImageModel(providers, "PawAPI", "image-b"),
  { providers: [providers[1]], provider: "PawAPI", model: "image-b" },
  "应保留仍可用的历史服务商和模型",
);
assert.equal(
  chooseImageModel(providers, "不存在", "不存在").model,
  "image-a",
  "历史选择失效时应回退到首个可用模型",
);
assert.deepEqual(
  chooseImageModel([], "", ""),
  { providers: [], provider: "", model: "" },
  "没有可用配置时应返回空选择",
);

const selected = toggleImageSelection(new Set(["img_a"]), "img_b");
assert.deepEqual([...selected], ["img_a", "img_b"], "点击未选图片应加入选择集");
assert.deepEqual(
  [...toggleImageSelection(selected, "img_a")],
  ["img_b"],
  "再次点击已选图片应取消选择",
);
assert.deepEqual(
  allImageIds([{ id: "img_a" }, null, { id: "" }, { id: "img_b" }]),
  ["img_a", "img_b"],
  "全选载荷应只包含有效图片 ID",
);

console.log("生图图库状态测试通过");