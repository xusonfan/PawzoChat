import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(
  join(__dirname, "../pawzochat/web/static/modules/location_map.js"),
).href;
const { clampMapZoom, coordinateAtMapPoint, mapTiles } = await import(moduleUrl);

assert.equal(clampMapZoom(1), 3);
assert.equal(clampMapZoom(20), 19);
assert.equal(clampMapZoom(15.4), 15);

const center = { latitude: 31.2304, longitude: 121.4737 };
const size = { width: 360, height: 320 };
const selectedCenter = coordinateAtMapPoint(center, 16, { x: 180, y: 160 }, size);
assert.ok(Math.abs(selectedCenter.latitude - center.latitude) < 1e-9);
assert.ok(Math.abs(selectedCenter.longitude - center.longitude) < 1e-9);

const selectedEast = coordinateAtMapPoint(center, 16, { x: 250, y: 160 }, size);
assert.ok(selectedEast.longitude > center.longitude);

const tiles = mapTiles(center, 16, size);
assert.ok(tiles.length >= 4);
assert.ok(tiles.every(tile => /^https:\/\/tile\.openstreetmap\.org\/16\/\d+\/\d+\.png$/.test(tile.url)));

console.log("location map tests passed");