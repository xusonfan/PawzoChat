import assert from "node:assert/strict";

const { detectSharedImport, importDetectedSharedFile } = await import(
  "../pawzochat/web/static/modules/shared_import.js"
);

function pngWithCharacterCard(keyword, card = { data: { name: "小猫" } }) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const encodedCard = Buffer.from(JSON.stringify(card), "utf8").toString("base64");
  const data = Buffer.from(`${keyword}\0${encodedCard}`, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write("tEXt", 4, "ascii");
  data.copy(chunk, 8);
  return new File([signature, chunk], "card.png", { type: "image/png" });
}

function zipWithFirstEntry(name) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  const encodedName = Buffer.from(name, "utf8");
  header.writeUInt16LE(encodedName.length, 26);
  return new File([header, encodedName], "bundle.zip", { type: "application/zip" });
}

const personaJson = new File([
  JSON.stringify({ spec: "chara_card_v3", data: { name: "小猫" } }),
], "cat.json", { type: "application/json" });
const worldbookJson = new File([
  JSON.stringify({ name: "设定", entries: {} }),
], "lore.json", { type: "application/json" });
const ordinaryJson = new File([JSON.stringify({ hello: "world" })], "data.json", {
  type: "application/json",
});

assert.equal((await detectSharedImport({ files: [personaJson] }))?.kind, "persona");
assert.equal((await detectSharedImport({ files: [worldbookJson] }))?.kind, "worldbook");
const detectedCcv3Png = await detectSharedImport({ files: [pngWithCharacterCard("ccv3")] });
assert.equal(detectedCcv3Png?.kind, "persona");
assert.equal(detectedCcv3Png?.name, "小猫", "应读取 PNG 角色卡中的角色名");
assert.equal(detectedCcv3Png?.preview, "image", "PNG 角色卡应使用卡图作为头像预览");
assert.equal(
  (await detectSharedImport({
    files: [pngWithCharacterCard("chara", { name: "狐狸" })],
  }))?.name,
  "狐狸",
);
assert.equal((await detectSharedImport({ files: [zipWithFirstEntry("pawzochat.json")] }))?.kind, "persona");
assert.equal(await detectSharedImport({ files: [ordinaryJson] }), null);
assert.equal(await detectSharedImport({ files: [zipWithFirstEntry("other.json")] }), null);
assert.equal(
  await detectSharedImport({ files: [new File(["普通文本"], "notes.txt", { type: "text/plain" })] }),
  null,
  "TXT 不应自动导入",
);
assert.equal(
  await detectSharedImport({ files: [personaJson, worldbookJson] }),
  null,
  "多文件分享存在歧义时不应自动导入",
);

let request = null;
globalThis.fetch = async (url, options) => {
  request = { url, options };
  return {
    ok: true,
    async json() { return { book: { name: "设定" } }; },
  };
};
const detectedWorldbook = await detectSharedImport({ files: [worldbookJson] });
assert.equal(detectedWorldbook.name, "设定");
const result = await importDetectedSharedFile(detectedWorldbook, "/secret");
assert.deepEqual(result, {
  matched: true,
  imported: true,
  kind: "worldbook",
  data: { book: { name: "设定" } },
});
assert.equal(request.url, "/secret/api/worldbooks/_import");
assert.equal(request.options.method, "POST");
assert.equal(request.options.body.get("file").name, "lore.json");

console.log("shared import tests passed");