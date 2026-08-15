/*!
 * PawzoChat - Multi-platform LLM-powered chatbot
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
import { api } from "./api.js";
import { state } from "./state.js";

const STORAGE_KEY = "pawzo_theme_cache";
const EARLY_TAG_ID = "pawzo-theme-early";
const _cssCache = new Map();

function resolveMode(mode) {
  if (mode === "auto") {
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode === "dark" ? "dark" : "light";
}

function syncBrowserChrome() {
  const color = getComputedStyle(document.documentElement).getPropertyValue("--card").trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (color && meta) meta.setAttribute("content", color);
}

function applyMode(mode) {
  document.documentElement.dataset.theme = resolveMode(mode);
  syncBrowserChrome();
}

async function fetchCss(name) {
  if (_cssCache.has(name)) return _cssCache.get(name);
  try {
    const data = await api.get(`/api/themes/${encodeURIComponent(name)}`);
    const css = typeof data?.css === "string" ? data.css : "";
    _cssCache.set(name, css);
    return css;
  } catch {
    _cssCache.set(name, "");
    return "";
  }
}

async function applyCustomThemes(names) {
  const nameSet = new Set(names);
  document.querySelectorAll('style[data-pawzo-theme]').forEach((el) => {
    if (!nameSet.has(el.dataset.pawzoTheme)) el.remove();
  });
  for (const name of names) {
    const css = await fetchCss(name);
    let el = document.querySelector(`style[data-pawzo-theme="${CSS.escape(name)}"]`);
    if (!el) {
      el = document.createElement("style");
      el.dataset.pawzoTheme = name;
    }
    el.textContent = css;
    document.head.appendChild(el); // re-append to enforce order
  }
  // Remove early-injected combined style once real per-name tags are in place
  const early = document.getElementById(EARLY_TAG_ID);
  if (early) early.remove();
}

function cacheForEarlyInject(theme) {
  const combined = (theme.active || [])
    .map((name) => _cssCache.get(name) || "")
    .join("\n");
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: theme.mode || "light", css: combined })
    );
  } catch {
    /* ignore quota errors */
  }
}

export async function applyThemeFromState() {
  const theme = state.settings?.theme || { mode: "light", active: [] };
  applyMode(theme.mode);
  await applyCustomThemes(theme.active || []);
  syncBrowserChrome();
  cacheForEarlyInject(theme);
}

export function watchSystemTheme() {
  const mq = matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", () => {
    if (state.settings?.theme?.mode === "auto") {
      applyMode("auto");
    }
  });
}

export function invalidateCache(name) {
  if (name) _cssCache.delete(name);
  else _cssCache.clear();
}
