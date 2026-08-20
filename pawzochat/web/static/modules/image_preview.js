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
import {
  clampPreviewView,
  isPreviewDoubleTap,
  pinchPreviewView,
  pointerCenter,
  pointerDistance,
  previewSequence,
  previewSwipeDirection,
  zoomPreviewAt,
} from "./image_preview_transform.js";

let _modalEl = null;
let _imgEl = null;
let _currentSrc = "";
let _sources = [];
let _captions = [];
let _sourceIndex = 0;
let _keyHandler = null;
let _historyToken = "";
let _historySequence = 0;
const _historyKey = "pawzoImagePreview";
const _historySources = new Map();
const _pointers = new Map();
let _view = { scale: 1, x: 0, y: 0 };
let _gesture = null;
let _suppressTap = false;
let _lastTap = { time: 0, x: 0, y: 0 };
let _navigationTimer = null;
let _switchTimer = null;
let _isSwitching = false;
const NAVIGATION_VISIBLE_MS = 2600;
const IMAGE_SWITCH_DURATION_MS = 280;

function _hideNavigation() {
  if (_navigationTimer) clearTimeout(_navigationTimer);
  _navigationTimer = null;
  _modalEl?.classList.remove("navigation-visible");
}

function _showNavigationBriefly() {
  if (!_modalEl) return;
  if (_navigationTimer) clearTimeout(_navigationTimer);
  _modalEl.classList.add("navigation-visible");
  _navigationTimer = setTimeout(_hideNavigation, NAVIGATION_VISIBLE_MS);
}

function _imageDimensions() {
  return {
    width: _imgEl?.offsetWidth || 0,
    height: _imgEl?.offsetHeight || 0,
  };
}

function _viewportDimensions() {
  return {
    width: _modalEl?.clientWidth || window.innerWidth || 0,
    height: _modalEl?.clientHeight || window.innerHeight || 0,
  };
}

function _applyView({ settle = false } = {}) {
  if (!_imgEl) return;
  _imgEl.classList.toggle("settling", settle);
  _imgEl.style.transform = `translate3d(${_view.x}px, ${_view.y}px, 0) scale(${_view.scale})`;
  const isZoomed = _view.scale > 1;
  _modalEl?.classList.toggle("is-zoomed", isZoomed);
  if (isZoomed) _hideNavigation();
  if (settle) setTimeout(() => _imgEl?.classList.remove("settling"), 220);
}

function _clampView({ settle = false } = {}) {
  const image = _imageDimensions();
  const viewport = _viewportDimensions();
  _view = clampPreviewView(
    _view,
    image.width,
    image.height,
    viewport.width,
    viewport.height,
  );
  _applyView({ settle });
}

function _resetView() {
  _pointers.clear();
  _gesture = null;
  _suppressTap = false;
  _lastTap = { time: 0, x: 0, y: 0 };
  _view = { scale: 1, x: 0, y: 0 };
  _applyView();
}

function _relativePoint(event) {
  const rect = _modalEl.getBoundingClientRect();
  return {
    x: event.clientX - rect.left - rect.width / 2,
    y: event.clientY - rect.top - rect.height / 2,
  };
}

function _toggleZoom(point) {
  _view = _view.scale > 1
    ? { scale: 1, x: 0, y: 0 }
    : zoomPreviewAt(_view, 2.5, point);
  _clampView({ settle: true });
}

function _syncNavigation() {
  if (!_modalEl) return;
  const hasMultiple = _sources.length > 1;
  const previous = _modalEl.querySelector(".ipv-previous");
  const next = _modalEl.querySelector(".ipv-next");
  const counter = _modalEl.querySelector(".ipv-counter");
  const caption = _modalEl.querySelector(".ipv-caption");
  if (previous) previous.disabled = !hasMultiple || _sourceIndex <= 0;
  if (next) next.disabled = !hasMultiple || _sourceIndex >= _sources.length - 1;
  if (counter) {
    counter.textContent = hasMultiple ? `${_sourceIndex + 1} / ${_sources.length}` : "";
    counter.hidden = !hasMultiple;
  }
  if (caption) {
    caption.textContent = _captions[_sourceIndex] || "";
    caption.hidden = !caption.textContent;
  }
}

function _finishImageSwitch() {
  _isSwitching = false;
  _switchTimer = null;
  _imgEl?.classList.remove("switching-next", "switching-previous");
  _modalEl?.querySelectorAll?.(".ipv-switch-outgoing").forEach(element => element.remove());
}

function _animateImageSwitch(delta) {
  const direction = delta > 0 ? "next" : "previous";
  const content = _modalEl?.querySelector(".ipv-content");
  const outgoing = _imgEl?.cloneNode?.(false);
  if (outgoing && content?.appendChild) {
    outgoing.removeAttribute?.("id");
    outgoing.className = `ipv-switch-outgoing switching-${direction}`;
    outgoing.removeAttribute?.("style");
    outgoing.setAttribute?.("aria-hidden", "true");
    content.appendChild(outgoing);
  }

  _isSwitching = true;
  _imgEl?.classList.remove("switching-next", "switching-previous");
  _imgEl?.classList.add(`switching-${direction}`);
  if (_switchTimer) clearTimeout(_switchTimer);
  _switchTimer = setTimeout(_finishImageSwitch, IMAGE_SWITCH_DURATION_MS);
}

function _switchImage(delta) {
  const nextIndex = _sourceIndex + delta;
  if (_isSwitching || nextIndex < 0 || nextIndex >= _sources.length || !_imgEl) return false;
  _animateImageSwitch(delta);
  _sourceIndex = nextIndex;
  _currentSrc = _sources[_sourceIndex];
  _resetView();
  _imgEl.src = _currentSrc;
  if (_historyToken) {
    _historySources.set(_historyToken, {
      src: _currentSrc,
      sources: [..._sources],
      captions: [..._captions],
    });
  }
  _syncNavigation();
  _showNavigationBriefly();
  return true;
}

function _collectPageSources(src) {
  const candidates = [...(document.querySelectorAll?.("img") || [])]
    .filter(image => !image.hidden && image.src && image !== _imgEl)
    .filter(image => image.closest?.(".msg-image, .he-media, .moments-img, .image-gallery-item, .persona-moments-thumbs"))
    .map(image => image.src);
  return previewSequence(src, candidates);
}

function _startGesture() {
  const points = [..._pointers.values()];
  if (points.length >= 2) {
    _suppressTap = true;
    _gesture = {
      type: "pinch",
      startView: { ..._view },
      center: pointerCenter(points[0], points[1]),
      distance: Math.max(1, pointerDistance(points[0], points[1])),
    };
  } else if (points.length === 1) {
    _gesture = {
      type: "pan",
      startView: { ..._view },
      point: points[0],
    };
  }
}

function _bindGestures(contentEl) {
  contentEl.addEventListener("pointerdown", event => {
    if (event.target.closest?.("button")) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    contentEl.setPointerCapture?.(event.pointerId);
    _pointers.set(event.pointerId, _relativePoint(event));
    _startGesture();
  });
  contentEl.addEventListener("pointermove", event => {
    if (!_pointers.has(event.pointerId)) return;
    event.preventDefault();
    _pointers.set(event.pointerId, _relativePoint(event));
    const points = [..._pointers.values()];
    if (_gesture?.type === "pinch" && points.length >= 2) {
      const center = pointerCenter(points[0], points[1]);
      _view = pinchPreviewView(
        _gesture.startView,
        _gesture.center,
        center,
        pointerDistance(points[0], points[1]) / _gesture.distance,
      );
      _applyView();
    } else if (_gesture?.type === "pan" && points.length === 1 && _view.scale > 1) {
      _view = {
        ..._gesture.startView,
        x: _gesture.startView.x + points[0].x - _gesture.point.x,
        y: _gesture.startView.y + points[0].y - _gesture.point.y,
      };
      _applyView();
    }
  });
  const finishPointer = event => {
    if (!_pointers.has(event.pointerId)) return;
    const completedGesture = _gesture;
    const point = _pointers.get(event.pointerId);
    _pointers.delete(event.pointerId);
    if (
      completedGesture?.type === "pan"
      && completedGesture.startView.scale === 1
      && _pointers.size === 0
    ) {
      const direction = previewSwipeDirection(
        completedGesture.point,
        point,
        completedGesture.startView.scale,
      );
      if (direction) {
        _suppressTap = false;
        _gesture = null;
        _switchImage(direction);
        return;
      }
    }
    if (event.pointerType !== "mouse" && _pointers.size === 0 && !_suppressTap) {
      const currentTap = { time: Date.now(), ...point };
      if (isPreviewDoubleTap(_lastTap, currentTap)) {
        _lastTap = { time: 0, x: 0, y: 0 };
        _toggleZoom(point);
        return;
      }
      _lastTap = currentTap;
    }
    if (_pointers.size === 0) _suppressTap = false;
    _clampView({ settle: true });
    _startGesture();
  };
  contentEl.addEventListener("pointerup", finishPointer);
  contentEl.addEventListener("pointercancel", finishPointer);
  contentEl.addEventListener("dblclick", event => {
    event.preventDefault();
    _toggleZoom(_relativePoint(event));
  });
  contentEl.addEventListener("wheel", event => {
    event.preventDefault();
    const multiplier = Math.exp(-event.deltaY * 0.002);
    _view = zoomPreviewAt(_view, _view.scale * multiplier, _relativePoint(event));
    _clampView();
  }, { passive: false });
}

function _ensureModal() {
  if (_modalEl) return;

  _modalEl = document.createElement("div");
  _modalEl.id = "image-preview-modal";
  _modalEl.className = "image-preview-modal hide";
  _modalEl.innerHTML = `
    <div class="ipv-backdrop"></div>
    <div class="ipv-content">
      <img id="ipv-img" alt="preview" draggable="false">
      <button class="ipv-download" type="button" aria-label="下载">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>
    </div>
    <button class="ipv-previous" type="button" aria-label="上一张">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>
    </button>
    <button class="ipv-next" type="button" aria-label="下一张">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>
    </button>
    <div class="ipv-counter" hidden></div>
    <div class="ipv-caption" hidden></div>
    <button class="ipv-close" type="button" aria-label="关闭">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
    </button>
  `;

  document.body.appendChild(_modalEl);

  _imgEl = _modalEl.querySelector("#ipv-img");
  const contentEl = _modalEl.querySelector(".ipv-content");

  _modalEl.querySelector(".ipv-backdrop").addEventListener("click", closeImagePreview);
  _modalEl.querySelector(".ipv-previous").addEventListener("click", event => {
    event.stopPropagation();
    _switchImage(-1);
  });
  _modalEl.querySelector(".ipv-next").addEventListener("click", event => {
    event.stopPropagation();
    _switchImage(1);
  });
  _modalEl.querySelector(".ipv-close").addEventListener("click", closeImagePreview);
  _modalEl.querySelector(".ipv-download").addEventListener("click", (e) => {
    e.stopPropagation();
    _download(_currentSrc);
  });
  _imgEl.addEventListener("click", (e) => e.stopPropagation());
  _imgEl.addEventListener("load", _resetView);
  _bindGestures(contentEl);
  window.addEventListener("resize", () => _clampView());
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

function _showImagePreview(src, sources = null, captions = null) {
  _ensureModal();
  const sequence = sources
    ? previewSequence(src, sources)
    : _collectPageSources(src);
  const captionBySource = new Map(
    (sources || []).map((source, index) => [source, captions?.[index] || ""]),
  );
  _sources = sequence.sources;
  _captions = _sources.map(source => captionBySource.get(source) || "");
  _sourceIndex = sequence.index;
  _resetView();
  _currentSrc = _sources[_sourceIndex] || src;
  _imgEl.src = _currentSrc;
  _syncNavigation();
  _showNavigationBriefly();
  _modalEl.classList.remove("hide");
  requestAnimationFrame(() => _modalEl.classList.add("show"));

  if (!_keyHandler) {
    _keyHandler = (e) => {
      if (e.key === "Escape") closeImagePreview();
      else if (e.key === "ArrowLeft") _switchImage(-1);
      else if (e.key === "ArrowRight") _switchImage(1);
    };
    document.addEventListener("keydown", _keyHandler);
  }
}

function _hideImagePreview() {
  if (!_modalEl) return;
  _hideNavigation();
  if (_switchTimer) clearTimeout(_switchTimer);
  _finishImageSwitch();
  _resetView();
  _modalEl.classList.remove("show");
  setTimeout(() => {
    if (_modalEl && !_modalEl.classList.contains("show")) {
      _modalEl.classList.add("hide");
      if (_imgEl) _imgEl.src = "";
      _currentSrc = "";
      _sources = [];
      _captions = [];
      _sourceIndex = 0;
    }
  }, 200);
  if (_keyHandler) {
    document.removeEventListener("keydown", _keyHandler);
    _keyHandler = null;
  }
}

window.addEventListener("popstate", event => {
  const token = event.state?.[_historyKey]?.token || "";
  const preview = token ? _historySources.get(token) : null;
  if (preview?.src) {
    _historyToken = token;
    _showImagePreview(preview.src, preview.sources, preview.captions);
    return;
  }

  if (_historyToken || (_modalEl && !_modalEl.classList.contains("hide"))) {
    _historyToken = "";
    _hideImagePreview();
  }
});

export function openImagePreview(src, sources = null, captions = null) {
  if (!src) return;
  _showImagePreview(src, sources, captions);

  if (_historyToken && history.state?.[_historyKey]?.token === _historyToken) return;
  const token = `${Date.now()}-${++_historySequence}`;
  try {
    history.pushState({
      ...(history.state || {}),
      [_historyKey]: { token },
    }, "", location.href);
    _historyToken = token;
    _historySources.set(token, {
      src: _currentSrc,
      sources: [..._sources],
      captions: [..._captions],
    });
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
