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
import { state, $ } from "./state.js";

let toastTimer = null;
let overlayCloseTimer = null;
let overlayHistoryToken = "";
let overlayHistorySequence = 0;
const OVERLAY_HISTORY_KEY = "pawzoOverlay";

export function toast(msg, type = "info") {
  const el = $("toast");
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "hide"; }, 3000);
}

export function confirm(title, desc, danger) {
  return new Promise(resolve => {
    const dlg = $("confirm-dialog");
    dlg.querySelector(".dialog-title").textContent = title;
    dlg.querySelector(".dialog-desc").textContent = desc;
    const ok = dlg.querySelector(".dialog-ok");
    ok.className = danger ? "dialog-ok danger" : "dialog-ok";
    ok.textContent = danger ? "删除" : "确认";
    dlg.classList.remove("hide");
    requestAnimationFrame(() => dlg.classList.add("show"));
    state.confirmCb = resolve;
  });
}

export function closeConfirm(result) {
  const dlg = $("confirm-dialog");
  dlg.classList.remove("show");
  setTimeout(() => dlg.classList.add("hide"), 200);
  if (state.confirmCb) { state.confirmCb(result); state.confirmCb = null; }
}

let _onOverlayClose = null;

function _pushOverlayHistory() {
  if (overlayHistoryToken
    && history.state?.[OVERLAY_HISTORY_KEY]?.token === overlayHistoryToken) return;

  const token = `${Date.now()}-${++overlayHistorySequence}`;
  try {
    history.pushState({
      ...(history.state || {}),
      [OVERLAY_HISTORY_KEY]: { token },
    }, "", location.href);
    overlayHistoryToken = token;
  } catch (_) {
    overlayHistoryToken = "";
  }
}

export function showSheet(html, onClose) {
  _onOverlayClose = onClose || null;
  clearTimeout(overlayCloseTimer);
  $("sheet-content").innerHTML = html;
  $("overlay").classList.remove("hide");
  $("action-sheet").classList.remove("hide");
  _pushOverlayHistory();
  requestAnimationFrame(() => {
    $("overlay").classList.add("show");
    $("action-sheet").classList.add("show");
  });
}

export function closeOverlay({ fromHistory = false } = {}) {
  const ownsHistoryEntry = !!overlayHistoryToken
    && history.state?.[OVERLAY_HISTORY_KEY]?.token === overlayHistoryToken;
  overlayHistoryToken = "";
  $("overlay").classList.remove("show");
  $("action-sheet").classList.remove("show");
  clearTimeout(overlayCloseTimer);
  overlayCloseTimer = setTimeout(() => {
    $("overlay").classList.add("hide");
    $("action-sheet").classList.add("hide");
  }, 300);
  const cb = _onOverlayClose;
  _onOverlayClose = null;
  if (cb) cb();
  if (!fromHistory && ownsHistoryEntry) history.back();
}

globalThis.window?.addEventListener?.("popstate", event => {
  if (!overlayHistoryToken) return;
  const currentToken = event.state?.[OVERLAY_HISTORY_KEY]?.token;
  if (currentToken === overlayHistoryToken) return;
  closeOverlay({ fromHistory: true });
});

let loadingTimer = null;

export function showLoading(text = "处理中…") {
  clearTimeout(loadingTimer);
  const el = $("loading-hud");
  if (!el) return;
  const txt = el.querySelector(".loading-hud-text");
  if (txt) txt.textContent = text;
  el.classList.remove("hide");
  requestAnimationFrame(() => el.classList.add("show"));
}

export function hideLoading() {
  const el = $("loading-hud");
  if (!el) return;
  el.classList.remove("show");
  clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => el.classList.add("hide"), 200);
}

export function step(id, delta, min = 1) {
  const el = $(id);
  let v = parseInt(el.textContent) + delta;
  if (v < min) v = min;
  el.textContent = v;
}