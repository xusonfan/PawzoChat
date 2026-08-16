import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(join(
  __dirname,
  "../pawzochat/web/static/modules/sticker_maker_capabilities.js",
)).href;
const {
  availableStickerProviders,
  modelSupportsReferenceImages,
  nextStickerGroupName,
  selectedStickerModel,
} = await import(moduleUrl);

const providers = availableStickerProviders([
  {
    name: "mixed",
    api_key_set: true,
    models: [
      { id: "plain", type: "openai_image", supports_reference_images: false },
      { id: "reference", type: "gemini_image", supports_reference_images: true },
    ],
  },
  {
    name: "missing-key",
    api_key_set: false,
    models: [{ id: "hidden", supports_reference_images: true }],
  },
]);

assert.equal(providers.length, 1);
assert.deepEqual(providers[0].models.map(model => model.id), ["plain", "reference"]);
assert.equal(selectedStickerModel(providers, "mixed", "plain")?.type, "openai_image");
assert.equal(modelSupportsReferenceImages(providers, "mixed", "plain"), false);
assert.equal(modelSupportsReferenceImages(providers, "mixed", "reference"), true);
assert.equal(modelSupportsReferenceImages(providers, "mixed", "missing"), false);

assert.equal(nextStickerGroupName([]), "我的表情包");
assert.equal(nextStickerGroupName([{ name: "我的表情包" }]), "我的表情包 2");
assert.equal(
  nextStickerGroupName([
    { name: "我的表情包" },
    { name: "我的表情包 2" },
    { name: "我的表情包 4" },
  ]),
  "我的表情包 3",
);
assert.equal(nextStickerGroupName(["自定义", "自定义 2"], "自定义"), "自定义 3");

const stickerMakerSource = readFileSync(join(
  __dirname,
  "../pawzochat/web/static/modules/sticker_maker.js",
), "utf8");
assert.doesNotMatch(stickerMakerSource, /\/api\/personas/);
assert.doesNotMatch(stickerMakerSource, /sticker-persona|persona_id|_maker\.personas/);
assert.match(stickerMakerSource, /form\.append\("reference", _maker\.referenceFile\)/);
assert.match(stickerMakerSource, /api\.get\("\/api\/emoji\/groups", \{ bypassCache: true \}\)/);
assert.match(stickerMakerSource, /_renderForm\(nextStickerGroupName\(groupResult\.groups\)\)/);

console.log("sticker maker capability tests passed");