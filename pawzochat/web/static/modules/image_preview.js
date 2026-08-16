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
import { toast } from "./ui.js";

let _modalEl = null;
let _imgEl = null;
let _currentSrc = "";
let _keyHandler = null;
let _historyToken = "";
let _historySequence = 0;
const _historyKey = "pawzoImagePreview";
const _historySources = new Map();

function _ensureModal() {
  if (_modalEl) return;

  _modalEl = document.createElement("div");
  _modalEl.id = "image-preview-modal";
  _modalEl.className = "image-preview-modal hide";
  _modalEl.innerHTML = `
    <div class="ipv-backdrop"></div>
    <div class="ipv-content">
      <img id="ipv-img" alt="preview">
    </div>
    <button class="ipv-close" type="button" aria-label="关闭">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
    </button>
    <button class="ipv-download" type="button" aria-label="下载">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </button>
  `;

  document.body.appendChild(_modalEl);

  _imgEl = _modalEl.querySelector("#ipv-img");

  _modalEl.querySelector(".ipv-backdrop").addEventListener("click", closeImagePreview);
  _modalEl.querySelector(".ipv-close").addEventListener("click", closeImagePreview);
  _modalEl.querySelector(".ipv-download").addEventListener("click", (e) => {
    e.stopPropagation();
    _download(_currentSrc);
  });
  _imgEl.addEventListener("click", (e) => e.stopPropagation());
}

function _filenameFromSrc(src) {
  try {
    const u = new URL(src, window.location.href);
    const name = u.pathname.split("/").pop();
    return name || "image";
  } catch {
    return "image";
  }
}

async function _download(src) {
  if (!src) return;
  const filename = _filenameFromSrc(src);
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
  } catch (err) {
    toast("下载失败，已在新标签打开", "error");
    window.open(src, "_blank");
  }
}

function _showImagePreview(src) {
  _ensureModal();
  _currentSrc = src;
  _imgEl.src = src;
  _modalEl.classList.remove("hide");
  requestAnimationFrame(() => _modalEl.classList.add("show"));

  if (!_keyHandler) {
    _keyHandler = (e) => {
      if (e.key === "Escape") closeImagePreview();
    };
    document.addEventListener("keydown", _keyHandler);
  }
}

function _hideImagePreview() {
  if (!_modalEl) return;
  _modalEl.classList.remove("show");
  setTimeout(() => {
    if (_modalEl && !_modalEl.classList.contains("show")) {
      _modalEl.classList.add("hide");
      if (_imgEl) _imgEl.src = "";
      _currentSrc = "";
    }
  }, 200);
  if (_keyHandler) {
    document.removeEventListener("keydown", _keyHandler);
    _keyHandler = null;
  }
}

window.addEventListener("popstate", event => {
  const token = event.state?.[_historyKey]?.token || "";
  const source = token ? _historySources.get(token) : "";
  if (source) {
    _historyToken = token;
    _showImagePreview(source);
    return;
  }

  if (_historyToken || (_modalEl && !_modalEl.classList.contains("hide"))) {
    _historyToken = "";
    _hideImagePreview();
  }
});

export function openImagePreview(src) {
  if (!src) return;
  _showImagePreview(src);

  if (_historyToken && history.state?.[_historyKey]?.token === _historyToken) return;
  const token = `${Date.now()}-${++_historySequence}`;
  try {
    history.pushState({
      ...(history.state || {}),
      [_historyKey]: { token },
    }, "", location.href);
    _historyToken = token;
    _historySources.set(token, src);
    if (_historySources.size > 32) {
      _historySources.delete(_historySources.keys().next().value);
    }
  } catch (_) {
    _historyToken = "";
  }
}

export function closeImagePreview() {
  const ownsHistoryEntry = !!_historyToken
    && history.state?.[_historyKey]?.token === _historyToken;
  _historyToken = "";
  _hideImagePreview();
  if (ownsHistoryEntry) history.back();
}
