import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(join(
  __dirname,
  "../pawzochat/web/static/modules/contacts_index.js",
)).href;
const { CONTACT_INDEX_LETTERS, groupPersonasByInitial } = await import(moduleUrl);

assert.equal(CONTACT_INDEX_LETTERS.length, 27);
assert.equal(CONTACT_INDEX_LETTERS[0], "A");
assert.equal(CONTACT_INDEX_LETTERS.at(-1), "#");

const groups = groupPersonasByInitial([
  { id: "x", name: "小晚", sort_key: "xiaowan", initial: "X" },
  { id: "a2", name: "阿紫", sort_key: "azi", initial: "A" },
  { id: "other", name: "123", sort_key: "123", initial: "#" },
  { id: "a1", name: "阿澈", sort_key: "ache", initial: "A" },
]);

assert.deepEqual(groups.map(group => group.initial), ["A", "X", "#"]);
assert.deepEqual(groups[0].personas.map(persona => persona.id), ["a1", "a2"]);
assert.deepEqual(groups[1].personas.map(persona => persona.id), ["x"]);

console.log("contacts index tests passed");