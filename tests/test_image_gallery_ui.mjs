import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSource = await readFile(join(
  __dirname,
  "../pawzochat/web/static/app.js",
), "utf8");
const gallerySource = await readFile(join(
  __dirname,
  "../pawzochat/web/static/modules/image_gallery.js",
), "utf8");

const personaEntry = appSource.indexOf("<span class=\"row-label\">人设编写助手</span>");
const galleryEntry = appSource.indexOf("<span class=\"row-label\">AI 图库</span>");
assert.ok(personaEntry >= 0, "发现页应保留人设编写助手入口");
assert.ok(galleryEntry > personaEntry, "AI 图库入口应位于人设编写助手下方");
assert.match(gallerySource, /setTopBar\("AI 图库"/u, "页面标题应统一为 AI 图库");
assert.doesNotMatch(
  gallerySource,
  /<p title="\$\{escAttr\(image\.prompt\)\}">/u,
  "图库卡片不应直接展示提示词",
);
assert.match(
  gallerySource,
  /class="image-gallery-thumb"[\s\S]*<time class="image-gallery-time">\$\{esc\(_formatDate\(image\.created_at\)\)\}<\/time>/u,
  "生成时间应显示在图片内部",
);
assert.doesNotMatch(gallerySource, /class="image-gallery-meta"/u, "卡片正文不应保留时间区域");
assert.match(
  gallerySource,
  /openImagePreview\([\s\S]*_gallery\.images\.map\(item => item\.prompt \|\| ""\)/u,
  "图库预览应传入每张图片的提示词",
);
assert.doesNotMatch(
  gallerySource,
  /class="image-gallery-meta"><span>\$\{esc\(image\.provider\)\}/u,
  "卡片元信息不应展示供应商和模型",
);
assert.match(gallerySource, /image-gallery-reference-file/u, "图库应提供参考图文件入口");
assert.match(
  gallerySource,
  /_selectedModelSupportsReference\(\)/u,
  "参考图入口应跟随模型能力显示",
);
assert.match(
  gallerySource,
  /form\.append\("reference", _gallery\.referenceFile\)/u,
  "支持参考图时应通过 multipart 上传文件",
);

console.log("image gallery UI tests passed");