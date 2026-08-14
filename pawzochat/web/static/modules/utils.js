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
const AVATAR_COLORS = [
  "#B08968", "#6AA87A", "#7B8DBF", "#C96B5C", "#A07CC5",
  "#5FA3B0", "#D4A054", "#8B6E5A", "#6B9E78", "#BF7B8D",
];
void "\x69\x77\x79\x78\x64\x78\x6c";
const ICON_SPRITE_PATH = `${window.PAWZOCHAT_BASE || ""}/static/assets/vendor/remixicon/remixicon.symbol.svg`;

// Capability badge icons shared by every model-picker (<option> builders in
// contacts / quick_setup / persona_writer). One source of truth.
export const CAP_ICONS = { vision: "👁", tool_use: "🔧" };

// Characters disallowed in persona / worldbook names (also illegal in Windows
// filenames). Shared by every name-validation site so the rule stays in sync.
export const ILLEGAL_NAME_RE = /[\\/:*?"<>|]/;

export function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export function avatarHtml(name, cls, avatarUrl) {
  const color = avatarColor(name || "?");
  const initial = esc((name || "?").charAt(0));
  const fallback = `<span class="avatar-fallback" aria-hidden="true">${initial}</span>`;
  if (avatarUrl) {
    return `<div class="avatar ${cls || ""}" style="background:${color}">${fallback}<img src="${escAttr(avatarUrl)}" alt="${escAttr(name)}" decoding="async" onerror="this.remove()"></div>`;
  }
  return `<div class="avatar ${cls || ""}" style="background:${color}">${fallback}</div>`;
}

function _versionedAvatarUrl(path, version) {
  return version ? `${path}?v=${encodeURIComponent(version)}` : path;
}

export function personaAvatarUrl(persona) {
  if (!persona || !persona.has_avatar) return "";
  const base = window.PAWZOCHAT_BASE || "";
  const path = `${base}/api/personas/${encodeURIComponent(persona.id)}/avatar`;
  return _versionedAvatarUrl(path, persona.avatar_version);
}

export function profileAvatarUrl(profile) {
  if (!profile || !profile.has_avatar) return "";
  const base = window.PAWZOCHAT_BASE || "";
  return _versionedAvatarUrl(`${base}/api/profile/avatar`, profile.avatar_version);
}

export function iconHtml(iconId, cls, label) {
  const extra = cls ? ` ${cls}` : "";
  const aria = label ? ` role="img" aria-label="${esc(label)}"` : ` aria-hidden="true"`;
  return `<svg class="ui-icon${extra}" viewBox="0 0 24 24"${aria} focusable="false"><use href="${ICON_SPRITE_PATH}#${iconId}"></use></svg>`;
}

// Place a fixed-position floating actions popup near an anchor rect, picking the
// side with enough room and clamping so it never extends past the viewport
// edges. Shared by the moments action pills and the chat long-press quote popup.
export function placeActionsPop(el, rect, preferLeft) {
  const MARGIN = 8;
  const GAP = 6;
  const popW = el.offsetWidth;
  const popH = el.offsetHeight;
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  const leftSide = rect.left - popW - GAP;
  const rightSide = rect.right + GAP;
  const leftFits = leftSide >= MARGIN;
  const rightFits = rightSide + popW <= winW - MARGIN;

  let left;
  let top;
  if (preferLeft ? leftFits : rightFits) {
    left = preferLeft ? leftSide : rightSide;
    top = rect.top + rect.height / 2 - popH / 2;
  } else if (preferLeft ? rightFits : leftFits) {
    left = preferLeft ? rightSide : leftSide;
    top = rect.top + rect.height / 2 - popH / 2;
  } else {
    // Neither side has horizontal room: drop below (or above) the anchor and
    // center under it, so an inline-flex popup squeezed against the viewport
    // edge does not wrap into a tall narrow column.
    left = rect.left + rect.width / 2 - popW / 2;
    top = rect.bottom + GAP + popH <= winH - MARGIN
      ? rect.bottom + GAP
      : rect.top - GAP - popH;
  }
  left = Math.max(MARGIN, Math.min(left, winW - popW - MARGIN));
  top = Math.max(MARGIN, Math.min(top, winH - popH - MARGIN));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

export function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "昨天";
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

export function formatMsgTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return time;
  return `${pad(d.getMonth() + 1)}月${pad(d.getDate())}日 ${time}`;
}

export function esc(s) {
  if (s == null) return "";
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML;
}

// esc() encodes < > & but NOT quotes; use this when interpolating into a
// double-quoted HTML attribute value.
export function escAttr(s) {
  return esc(s).replace(/"/g, "&quot;");
}

// Pick the voice list for a model out of the API's preset_voices payload.
// Falls back to a sibling model's catalog (every model under one provider shares
// it) while a selection is still settling, and to no suggestions at all when even
// that is unknown — suggesting the wrong vendor's ids is worse than suggesting
// none, since they fail at synthesis time.
export function voiceCatalogFor(presetVoices, model, siblingModels) {
  const catalog = model?.voice_catalog || (siblingModels || [])[0]?.voice_catalog;
  return catalog ? ((presetVoices || {})[catalog] || []) : [];
}

// Build <datalist> options for a voice-id picker from an API preset_voices
// catalog ({id, label} entries). The label carries the human name (e.g.
// 青涩青年音色), without which an id like "male-qn-qingse" is unreadable.
export function voiceOptionsHtml(catalog) {
  return (catalog || []).map(v => (
    v.label
      ? `<option value="${escAttr(v.id)}" label="${escAttr(v.label)}">`
      : `<option value="${escAttr(v.id)}">`
  )).join("");
}

// Safely embed an arbitrary string as a JS string literal inside an inline
// on* handler attribute (e.g. onclick="fn(${jsArg(value)})"). Quotes the value
// via JSON.stringify, then HTML-escapes so it can't break out of the attribute.
export function jsArg(value) {
  return JSON.stringify(String(value ?? ""))
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}