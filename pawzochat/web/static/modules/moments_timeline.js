/*!
 * PawzoChat - Multi-platform LLM-powered chatbot
 * Copyright (C) 2026  iwyxdxl
 *
 * Pure helpers for persona personal-moments timeline grouping and cover style.
 * No DOM / network dependencies — safe to unit-test under node.
 */

/**
 * Parse a moment timestamp into local calendar parts.
 * Accepts ISO strings; falls back to epoch on invalid input.
 * @param {string} ts
 * @returns {{ year: number, month: number, day: number, date: Date }}
 */
export function parseMomentDate(ts) {
  const d = ts ? new Date(ts) : new Date(NaN);
  if (Number.isNaN(d.getTime())) {
    const fallback = new Date(0);
    return {
      year: fallback.getFullYear(),
      month: fallback.getMonth() + 1,
      day: fallback.getDate(),
      date: fallback,
    };
  }
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    date: d,
  };
}

/**
 * Group moments (newest-first) into year → month → items timeline buckets.
 * Uses each moment's stable `timestamp`; does not sort by author name.
 *
 * @param {Array<{ id?: string, timestamp?: string }>} moments
 * @returns {Array<{ year: number, months: Array<{ month: number, items: object[] }> }>}
 */
export function groupMomentsByYearMonth(moments) {
  const list = Array.isArray(moments) ? moments : [];
  const years = [];
  const yearMap = new Map();

  for (const m of list) {
    const { year, month } = parseMomentDate(m?.timestamp);
    let yEntry = yearMap.get(year);
    if (!yEntry) {
      yEntry = { year, months: [], _monthMap: new Map() };
      yearMap.set(year, yEntry);
      years.push(yEntry);
    }
    let mEntry = yEntry._monthMap.get(month);
    if (!mEntry) {
      mEntry = { month, items: [] };
      yEntry._monthMap.set(month, mEntry);
      yEntry.months.push(mEntry);
    }
    mEntry.items.push(m);
  }

  return years.map(({ year, months }) => ({ year, months }));
}

/**
 * Stable theme background for a persona when no cover image is available.
 * Derived from the persona id so it never flickers across re-renders.
 *
 * @param {string} personaId
 * @returns {{ backgroundImage: string, className: string }}
 */
export function stablePersonaCoverStyle(personaId) {
  const id = String(personaId || "");
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  // Fixed palette — no Math.random().
  const palettes = [
    ["#c4a484", "#8b6b4a"],
    ["#7a9e9f", "#3d5a5b"],
    ["#b089a0", "#6d4c6e"],
    ["#8f9e6e", "#4f5d32"],
    ["#9a8c7a", "#5c4e3f"],
    ["#6e8fad", "#3a5570"],
  ];
  const [a, b] = palettes[Math.abs(hash) % palettes.length];
  return {
    backgroundImage: `linear-gradient(145deg, ${a} 0%, ${b} 100%)`,
    className: "persona-moments-cover--theme",
  };
}

/**
 * One-line text excerpt for timeline rows.
 * @param {string} text
 * @param {number} [maxLen=80]
 */
export function momentTextExcerpt(text, maxLen = 80) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}…`;
}