/**
 * Unit tests for persona moments timeline grouping / stable cover.
 * Run: node tests/test_moments_timeline.mjs
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modUrl = pathToFileURL(
  join(__dirname, "../pawzochat/web/static/modules/moments_timeline.js"),
).href;
const {
  groupMomentsByYearMonth,
  stablePersonaCoverStyle,
  momentTextExcerpt,
  parseMomentDate,
} = await import(modUrl);

// ---- parseMomentDate ----
{
  const d = parseMomentDate("2024-03-15T12:00:00+00:00");
  assert.equal(typeof d.year, "number");
  assert.equal(typeof d.month, "number");
  assert.equal(typeof d.day, "number");
  assert.ok(d.month >= 1 && d.month <= 12);
}

// ---- group by year / month (newest-first input order preserved inside buckets) ----
{
  const moments = [
    { id: "1", timestamp: "2025-02-10T10:00:00+08:00", author: "a" },
    { id: "2", timestamp: "2025-02-01T10:00:00+08:00", author: "a" },
    { id: "3", timestamp: "2024-12-20T10:00:00+08:00", author: "a" },
    { id: "4", timestamp: "2024-03-05T10:00:00+08:00", author: "b" },
  ];
  const groups = groupMomentsByYearMonth(moments);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].year, 2025);
  assert.equal(groups[0].months.length, 1);
  assert.equal(groups[0].months[0].month, 2);
  assert.deepEqual(groups[0].months[0].items.map(m => m.id), ["1", "2"]);
  assert.equal(groups[1].year, 2024);
  assert.equal(groups[1].months.length, 2);
  assert.equal(groups[1].months[0].month, 12);
  assert.equal(groups[1].months[1].month, 3);
}

// ---- empty / invalid input ----
{
  assert.deepEqual(groupMomentsByYearMonth([]), []);
  assert.deepEqual(groupMomentsByYearMonth(null), []);
}

// ---- stable cover: same id → same style; no random flicker ----
{
  const a1 = stablePersonaCoverStyle("persona_abc");
  const a2 = stablePersonaCoverStyle("persona_abc");
  const b = stablePersonaCoverStyle("persona_xyz");
  assert.equal(a1.backgroundImage, a2.backgroundImage);
  assert.match(a1.backgroundImage, /linear-gradient/);
  // Different ids may share a palette slot; just ensure shape is stable.
  assert.match(b.backgroundImage, /linear-gradient/);
}

// ---- excerpt ----
{
  assert.equal(momentTextExcerpt(""), "");
  assert.equal(momentTextExcerpt("hello"), "hello");
  const long = "x".repeat(100);
  const ex = momentTextExcerpt(long, 80);
  assert.equal(ex.length, 81); // 80 + ellipsis
  assert.ok(ex.endsWith("…"));
}

console.log("moments timeline tests passed");