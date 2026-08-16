/*!
 * PawzoChat - persistent image layout metadata for stable message rendering.
 */

const STORAGE_KEY = "pawzochat-image-layout-v1";
const MAX_ENTRIES = 512;

let entries = null;

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch (_) {
    return null;
  }
}

function normalizeSource(source) {
  if (!source) return "";
  try {
    const base = globalThis.document?.baseURI
      || globalThis.location?.href
      || "http://pawzochat.local/";
    const url = new URL(String(source), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    return url.href;
  } catch (_) {
    return "";
  }
}

function loadEntries() {
  if (entries) return entries;
  try {
    const parsed = JSON.parse(storage()?.getItem(STORAGE_KEY) || "{}");
    entries = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (_) {
    entries = {};
  }
  return entries;
}

function persistEntries() {
  const store = storage();
  if (!store) return;
  try {
    const values = Object.entries(loadEntries());
    if (values.length > MAX_ENTRIES) {
      values.sort(([, left], [, right]) => (right.usedAt || 0) - (left.usedAt || 0));
      entries = Object.fromEntries(values.slice(0, MAX_ENTRIES));
    }
    store.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (_) {
    // Storage can be unavailable or full in embedded/private contexts.
  }
}

export function imageLayoutAttributes(source, {
  maxWidth = 240,
  maxHeight = maxWidth,
} = {}) {
  const key = normalizeSource(source);
  const layout = key ? loadEntries()[key] : null;
  const naturalWidth = Number(layout?.width);
  const naturalHeight = Number(layout?.height);
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return "";

  layout.usedAt = Date.now();
  const scale = Math.min(1, maxWidth / naturalWidth, maxHeight / naturalHeight);
  const width = Math.max(1, Math.round(naturalWidth * scale));
  return ` style="width:${width}px;height:auto;aspect-ratio:${naturalWidth} / ${naturalHeight}"`;
}

export function rememberImageLayout(image) {
  const key = normalizeSource(image?.currentSrc || image?.src);
  const width = Number(image?.naturalWidth);
  const height = Number(image?.naturalHeight);
  if (!key || !(width > 0) || !(height > 0)) return false;

  const layouts = loadEntries();
  const current = layouts[key];
  if (current?.width === width && current?.height === height) {
    current.usedAt = Date.now();
    return true;
  }

  layouts[key] = { width, height, usedAt: Date.now() };
  persistEntries();
  return true;
}