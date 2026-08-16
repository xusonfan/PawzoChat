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
import {
  state, $, content, sidebar, topTitle, topBack, topActions,
  setMobileTabContentTarget,
} from "./state.js";

const tabRenderers = {};
const pageRenderers = {};

const _historySession = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const _historyKey = "pawzoNavigation";
let _historyIndex = 0;

function _browserRoute() {
  return {
    session: _historySession,
    index: _historyIndex,
    tab: state.currentTab,
    depth: state.pageStack.length,
  };
}

function _writeBrowserRoute(mode) {
  if (isDesktop()) return;
  if (mode === "push") _historyIndex += 1;
  const browserState = { ...(history.state || {}), [_historyKey]: _browserRoute() };
  history[mode === "push" ? "pushState" : "replaceState"](browserState, "", location.href);
}

export function registerTabRenderer(tab, fn) {
  tabRenderers[tab] = fn;
}

export function registerPageRenderer(page, fn) {
  pageRenderers[page] = fn;
}

/* ---- Layout detection ---- */

const _desktopMQ = window.matchMedia("(min-width: 768px)");

export function isDesktop() {
  return _desktopMQ.matches;
}

/* ---- Mobile tab swipe ---- */

const _tabSwipe = {
  startDistance: 8,
  axisRatio: 1.18,
  commitRatio: 0.24,
  commitVelocity: 0.38,
  settleDuration: 180,
};
let _tabSwipeInitialized = false;
let _activeTabSettle = null;

function _isSwipeExcludedTarget(target, boundary) {
  if (!(target instanceof Element)) return true;
  if (target.closest("input, textarea, select, button, a, [contenteditable], [role='slider'], [data-no-tab-swipe]")) return true;

  for (let el = target; el && el !== boundary; el = el.parentElement) {
    const style = getComputedStyle(el);
    const scrollsHorizontally = el.scrollWidth > el.clientWidth
      && (style.overflowX === "auto" || style.overflowX === "scroll");
    if (scrollsHorizontally) return true;
  }
  return false;
}

function _tabNames() {
  return [...document.querySelectorAll("#tab-bar .tab")].map(tab => tab.dataset.tab);
}

function _adjacentTab(delta) {
  const tabs = _tabNames();
  const currentIndex = tabs.indexOf(state.currentTab);
  return tabs[currentIndex + delta] || null;
}

function _clampSwipeDistance(dx, direction, width) {
  if (direction > 0) return Math.max(-width, Math.min(0, dx));
  return Math.min(width, Math.max(0, dx));
}

function _setSwipePosition(stage, dx) {
  const offset = _clampSwipeDistance(dx, stage.direction, stage.width);
  stage.offset = offset;
  stage.track.style.transform = `translate3d(${stage.baseOffset + offset}px, 0, 0)`;
}

function _createSwipeStage(direction) {
  const viewport = $("content-area");
  const currentPanel = _currentMobileTabPanel();
  const targetTab = _adjacentTab(direction);
  if (!viewport || !currentPanel || !targetTab) return null;

  const currentChrome = _snapshotChrome();
  const targetEntry = _takeTabEntry(targetTab);
  const rendered = targetEntry || _renderMobileTabPanel(targetTab, currentPanel, currentChrome);
  if (!rendered?.panel) return null;

  const track = document.createElement("div");
  track.className = "mobile-tab-swipe-track";
  if (direction > 0) {
    track.append(currentPanel, rendered.panel);
  } else {
    track.append(rendered.panel, currentPanel);
  }
  viewport.innerHTML = "";
  viewport.appendChild(track);
  viewport.classList.add("mobile-tab-swipe-active");
  requestAnimationFrame(() => { rendered.panel.scrollTop = rendered.scroll || 0; });

  const width = Math.max(1, viewport.clientWidth);
  const stage = {
    viewport,
    track,
    width,
    direction,
    baseOffset: direction > 0 ? 0 : -width,
    offset: 0,
    currentTab: state.currentTab,
    currentPanel,
    currentChrome,
    targetTab,
    targetPanel: rendered.panel,
    targetChrome: rendered.chrome,
  };
  _setSwipePosition(stage, 0);
  return stage;
}

function _cacheSwipePanel(tab, panel, chrome) {
  _tabCache.set(tab, {
    panel,
    scroll: panel.scrollTop,
    mode: "mobile",
    chrome,
  });
}

function _finishSwipeStage(stage, committed) {
  const selectedPanel = committed ? stage.targetPanel : stage.currentPanel;
  const discardedPanel = committed ? stage.currentPanel : stage.targetPanel;
  const selectedTab = committed ? stage.targetTab : stage.currentTab;
  const discardedTab = committed ? stage.currentTab : stage.targetTab;
  const selectedChrome = committed ? stage.targetChrome : stage.currentChrome;
  const discardedChrome = committed ? stage.currentChrome : stage.targetChrome;

  selectedPanel.remove();
  discardedPanel.remove();
  stage.track.remove();
  stage.viewport.classList.remove("mobile-tab-swipe-active");
  stage.viewport.appendChild(selectedPanel);
  setMobileTabContentTarget(selectedPanel);
  _cacheSwipePanel(discardedTab, discardedPanel, discardedChrome);
  _restoreChrome(selectedChrome);

  if (committed) {
    state.tabScrollPos[stage.currentTab] = stage.currentPanel.scrollTop;
    _activateTab(selectedTab);
    _writeBrowserRoute("replace");
  }
}

function _settleSwipeStage(stage, committed) {
  const destination = committed ? -stage.direction * stage.width : 0;
  const remaining = Math.abs(destination - stage.offset);
  if (remaining < 1) {
    _finishSwipeStage(stage, committed);
    return;
  }

  const duration = Math.round(Math.max(
    70,
    _tabSwipe.settleDuration * Math.min(1, remaining / stage.width),
  ));
  stage.track.style.setProperty("--tab-swipe-settle-duration", `${duration}ms`);
  stage.track.classList.add("settling");

  let finished = false;
  let fallbackTimer = null;
  const onTransitionEnd = event => {
    if (event.target === stage.track && event.propertyName === "transform") finish();
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    if (fallbackTimer) clearTimeout(fallbackTimer);
    stage.track.removeEventListener("transitionend", onTransitionEnd);
    if (_activeTabSettle?.finish === finish) _activeTabSettle = null;
    _finishSwipeStage(stage, committed);
  };
  _activeTabSettle = { finish };
  stage.track.addEventListener("transitionend", onTransitionEnd);
  requestAnimationFrame(() => _setSwipePosition(stage, destination));
  fallbackTimer = setTimeout(finish, duration + 40);
}

function _finishActiveTabSettle() {
  _activeTabSettle?.finish();
}

export function initMobileTabSwipe() {
  if (_tabSwipeInitialized) return;
  const area = $("content-area");
  if (!area) return;
  _tabSwipeInitialized = true;

  let gesture = null;
  const reset = () => { gesture = null; };

  area.addEventListener("touchstart", event => {
    _finishActiveTabSettle();
    if (isDesktop()
      || state.pageStack.length !== 0
      || event.touches.length !== 1) {
      reset();
      return;
    }
    const touch = event.touches[0];
    gesture = _isSwipeExcludedTarget(event.target, area)
      ? null
      : {
          startX: touch.clientX,
          startY: touch.clientY,
          origin: event.target,
          lastX: touch.clientX,
          lastTime: event.timeStamp,
          velocityX: 0,
          horizontal: false,
          stage: null,
        };
  }, { passive: true });

  area.addEventListener("touchmove", event => {
    if (!gesture || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const dx = touch.clientX - gesture.startX;
    const dy = touch.clientY - gesture.startY;

    if (!gesture.horizontal) {
      if (Math.abs(dy) > _tabSwipe.startDistance && Math.abs(dy) >= Math.abs(dx)) {
        reset();
        return;
      }
      if (Math.abs(dx) < _tabSwipe.startDistance
        || Math.abs(dx) < Math.abs(dy) * _tabSwipe.axisRatio) return;
      gesture.horizontal = true;
      gesture.origin?.dispatchEvent(new CustomEvent("pawzo:tab-swipe-start", { bubbles: true }));
      gesture.stage = _createSwipeStage(dx < 0 ? 1 : -1);
    }

    event.preventDefault();
    const elapsed = Math.max(1, event.timeStamp - gesture.lastTime);
    gesture.velocityX = (touch.clientX - gesture.lastX) / elapsed;
    gesture.lastX = touch.clientX;
    gesture.lastTime = event.timeStamp;
    if (gesture.stage) _setSwipePosition(gesture.stage, dx);
  }, { passive: false });

  area.addEventListener("touchend", event => {
    if (!gesture || event.changedTouches.length !== 1) {
      reset();
      return;
    }
    const { stage, velocityX } = gesture;
    reset();
    if (!stage || isDesktop() || state.pageStack.length !== 0) return;

    const progress = Math.abs(stage.offset) / stage.width;
    const velocityCommits = Math.abs(velocityX) >= _tabSwipe.commitVelocity
      && Math.sign(velocityX) === -stage.direction;
    _settleSwipeStage(stage, progress >= _tabSwipe.commitRatio || velocityCommits);
  }, { passive: true });

  area.addEventListener("touchcancel", () => {
    const stage = gesture?.stage;
    reset();
    if (stage) _settleSwipeStage(stage, false);
  }, { passive: true });
}

/* ---- Top / Sidebar bar helpers ---- */

export function setTopBar(title, showBack, actionsHtml, leftHtml, variant = "") {
  topTitle().textContent = title;
  const bar = $("top-bar");
  bar.classList.toggle("moments-cover-overlay", variant === "moments-cover-overlay");
  bar.classList.remove("is-cover-hidden");
  const back = topBack();
  if (leftHtml) {
    back.classList.add("hide");
    let slot = $("top-bar-left");
    if (!slot) {
      slot = document.createElement("div");
      slot.id = "top-bar-left";
      back.parentNode.insertBefore(slot, back);
    }
    slot.innerHTML = leftHtml;
    slot.classList.remove("hide");
    bar.classList.add("contextual");
  } else {
    back.classList.toggle("hide", !showBack);
    const slot = $("top-bar-left");
    if (slot) { slot.innerHTML = ""; slot.classList.add("hide"); }
    bar.classList.remove("contextual");
  }
  topActions().innerHTML = actionsHtml || "";
  if (isDesktop()) bar.classList.remove("desktop-hidden");
}

export function setSidebarBar(title, actionsHtml) {
  const el = $("sidebar-title");
  if (el) el.textContent = title;
  const act = $("sidebar-actions");
  if (act) act.innerHTML = actionsHtml || "";
}

/* ---- Rendering ---- */

function resetContentScroll() {
  const el = content();
  if (el) el.style.overflow = "";
}

function renderCurrentTab() {
  resetContentScroll();
  const fn = tabRenderers[state.currentTab];
  return fn ? fn() : undefined;
}

function renderPage(name, data) {
  resetContentScroll();
  const fn = pageRenderers[name];
  return fn ? fn(data) : undefined;
}

function _restoreContentScroll(scrollTop, renderResult) {
  if (!Number.isFinite(scrollTop)) return;
  const restore = () => requestAnimationFrame(() => {
    const area = content();
    if (area) area.scrollTop = scrollTop;
  });
  if (renderResult && typeof renderResult.then === "function") {
    Promise.resolve(renderResult).then(restore, restore);
  } else {
    restore();
  }
}

export function refreshSidebar() {
  if (!isDesktop()) return;
  renderCurrentTab();
}

/* ---- Desktop welcome screen ---- */

function showDesktopWelcome() {
  setMobileTabContentTarget(null);
  const viewport = $("content-area");
  $("top-bar").classList.add("desktop-hidden");
  viewport.style.overflow = "";
  const base = window.PAWZOCHAT_BASE || "";
  viewport.innerHTML = `<div class="desktop-welcome">
    <div class="welcome-icon"><img src="${base}/static/logo.png" alt="PawzoChat"></div>
    <div class="welcome-title">PawzoChat</div>
  </div>`;
}

/* ---- Tab DOM cache ---- */

// Detach each rendered tab root before navigating away so the next visit can
// restore it instantly. Mobile roots remain independent scroll panels; desktop
// roots remain document fragments. Both preserve input state and event listeners.
// Snapshots are dropped on api.invalidate so stale server data is never restored.
const _tabCache = new Map();

function _activeMode() {
  return isDesktop() ? "desktop" : "mobile";
}

function _createMobileTabPanel(tab) {
  const panel = document.createElement("div");
  panel.className = "mobile-tab-panel";
  panel.dataset.tabPanel = tab;
  return panel;
}

function _currentMobileTabPanel() {
  const target = content();
  return target?.classList?.contains("mobile-tab-panel") ? target : null;
}

function _preparePageContent() {
  if (isDesktop()) return;
  setMobileTabContentTarget(null);
  const viewport = $("content-area");
  viewport.classList.remove("mobile-tab-swipe-active");
  viewport.innerHTML = "";
}

function _takeTabEntry(tab) {
  const entry = _tabCache.get(tab);
  if (!entry) return null;
  _tabCache.delete(tab);
  if (entry.mode !== _activeMode()) return null;
  return entry;
}

function _renderMobileTabPanel(tab, returnPanel = null, returnChrome = null) {
  const panel = _createMobileTabPanel(tab);
  const previousTab = state.currentTab;
  state.currentTab = tab;
  setMobileTabContentTarget(panel);
  const fn = tabRenderers[tab];
  if (fn) fn();
  const chrome = _snapshotChrome();
  state.currentTab = previousTab;
  setMobileTabContentTarget(returnPanel);
  if (returnChrome) _restoreChrome(returnChrome);
  return {
    panel,
    chrome,
    mode: "mobile",
    scroll: state.tabScrollPos[tab] || 0,
  };
}

function _mountFreshMobileTab(tab) {
  const viewport = $("content-area");
  const panel = _createMobileTabPanel(tab);
  viewport.classList.remove("mobile-tab-swipe-active");
  viewport.innerHTML = "";
  viewport.appendChild(panel);
  setMobileTabContentTarget(panel);
  renderCurrentTab();
  panel.scrollTop = state.tabScrollPos[tab] || 0;
}

function _snapshotChrome() {
  const slot = $("top-bar-left");
  const bar = $("top-bar");
  return {
    topTitle: $("top-bar-title")?.textContent || "",
    topActions: $("top-bar-actions")?.innerHTML || "",
    topBackHidden: $("top-bar-back")?.classList.contains("hide") ?? true,
    topLeftHtml: slot?.innerHTML || "",
    topLeftHidden: slot ? slot.classList.contains("hide") : true,
    topBarContextual: bar?.classList.contains("contextual") || false,
    topBarMomentsCoverOverlay: bar?.classList.contains("moments-cover-overlay") || false,
    topBarCoverHidden: bar?.classList.contains("is-cover-hidden") || false,
    sidebarTitle: $("sidebar-title")?.textContent || "",
    sidebarActions: $("sidebar-actions")?.innerHTML || "",
  };
}

function _restoreChrome(chrome) {
  if (!chrome) return;
  const tt = $("top-bar-title"); if (tt) tt.textContent = chrome.topTitle;
  const ta = $("top-bar-actions"); if (ta) ta.innerHTML = chrome.topActions;
  const tb = $("top-bar-back"); if (tb) tb.classList.toggle("hide", chrome.topBackHidden);
  // top-bar-left slot + the "contextual" class on the bar are managed by
  // setTopBar's leftHtml branch (e.g. theme selection mode). They can be left
  // dirty by a renderer that skipped a clean setTopBar call, so restore them
  // explicitly instead of trusting them to be reset by the next render.
  const slot = $("top-bar-left");
  if (slot) {
    slot.innerHTML = chrome.topLeftHtml || "";
    slot.classList.toggle("hide", chrome.topLeftHidden !== false);
  }
  const bar = $("top-bar");
  if (bar) {
    bar.classList.toggle("contextual", !!chrome.topBarContextual);
    bar.classList.toggle("moments-cover-overlay", !!chrome.topBarMomentsCoverOverlay);
    bar.classList.toggle("is-cover-hidden", !!chrome.topBarCoverHidden);
  }
  const st = $("sidebar-title"); if (st) st.textContent = chrome.sidebarTitle;
  const sa = $("sidebar-actions"); if (sa) sa.innerHTML = chrome.sidebarActions;
}

function _saveTabDom(tab) {
  if (state.pageStack.length !== 0) return;

  if (!isDesktop()) {
    const panel = _currentMobileTabPanel();
    if (!panel) return;
    panel.remove();
    _tabCache.set(tab, {
      panel,
      scroll: panel.scrollTop,
      mode: "mobile",
      chrome: _snapshotChrome(),
    });
    setMobileTabContentTarget(null);
    return;
  }

  const container = sidebar();
  if (!container || !container.firstChild) return;
  const fragment = document.createDocumentFragment();
  while (container.firstChild) fragment.appendChild(container.firstChild);
  _tabCache.set(tab, {
    container,
    fragment,
    scroll: container.scrollTop,
    mode: "desktop",
    chrome: _snapshotChrome(),
  });
}

function _restoreTabDom(tab) {
  const entry = _takeTabEntry(tab);
  if (!entry) return false;

  if (!isDesktop()) {
    const viewport = $("content-area");
    viewport.classList.remove("mobile-tab-swipe-active");
    viewport.innerHTML = "";
    viewport.appendChild(entry.panel);
    setMobileTabContentTarget(entry.panel);
    _restoreChrome(entry.chrome);
    requestAnimationFrame(() => { entry.panel.scrollTop = entry.scroll; });
    return true;
  }

  const container = sidebar();
  if (!container) return false;
  container.innerHTML = "";
  container.appendChild(entry.fragment);
  _restoreChrome(entry.chrome);
  requestAnimationFrame(() => { container.scrollTop = entry.scroll; });
  return true;
}

// Any API-level cache invalidation (writes from this client, or explicit
// invalidations from SSE handlers) may have changed data that's baked into a
// cached tab DOM snapshot. Conservative: drop them all and let the next visit
// re-render — that re-render is cheap because the SWR cache typically still
// holds the fresh response from the same write.
window.addEventListener("pawzo:api-invalidated", () => {
  _tabCache.clear();
});

/* ---- Core navigation ---- */

function _activateTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === tab)
  );
}

function _showNavigationRoot({ renderDesktopTab = false } = {}) {
  if (isDesktop()) {
    if (renderDesktopTab) renderCurrentTab();
    showDesktopWelcome();
  } else {
    $("tab-bar").classList.remove("hide");
    if (!_restoreTabDom(state.currentTab)) {
      _mountFreshMobileTab(state.currentTab);
    }
  }
}

function _restoreReturnState(returnState) {
  _activateTab(returnState.tab);
  state.pageStack = returnState.pages.map(page => ({ ...page }));

  if (state.pageStack.length === 0) {
    _showNavigationRoot({ renderDesktopTab: true });
    return;
  }

  if (isDesktop()) renderCurrentTab();
  else _preparePageContent();
  $("tab-bar").classList.add("hide");
  const previous = state.pageStack[state.pageStack.length - 1];
  renderPage(previous.name, previous.data);
}

function _samePage(left, name, data) {
  if (left?.name !== name) return false;
  const leftData = left.data || {};
  const rightData = data || {};
  const keys = new Set([...Object.keys(leftData), ...Object.keys(rightData)]);
  return [...keys].every(key => leftData[key] === rightData[key]);
}

export function navigateToPage(tab, name, data, { collapsePreviousTarget = false } = {}) {
  const returnPages = state.pageStack.map(previous => ({ ...previous }));
  if (collapsePreviousTarget && returnPages.length >= 2) {
    const previousIndex = returnPages.length - 2;
    if (_samePage(returnPages[previousIndex], name, data)) {
      returnPages.splice(previousIndex, 1);
    }
  }

  const page = {
    name,
    data,
    returnState: {
      tab: state.currentTab,
      pages: returnPages,
    },
  };

  if (!isDesktop() && state.pageStack.length === 0) {
    state.tabScrollPos[state.currentTab] = content()?.scrollTop || 0;
    _saveTabDom(state.currentTab);
  }
  if (!isDesktop()) _preparePageContent();
  _activateTab(tab);
  state.pageStack = [page];
  $("tab-bar").classList.add("hide");
  if (isDesktop()) renderCurrentTab();
  renderPage(name, data);
  if (!isDesktop()) _writeBrowserRoute("push");
}

export function switchTab(tab) {
  if (isDesktop()) {
    setMobileTabContentTarget(null);
    state.sidebarScrollPos[state.currentTab] = sidebar()?.scrollTop || 0;
    _saveTabDom(state.currentTab);
    _activateTab(tab);
    state.pageStack = [];
    if (!_restoreTabDom(tab)) {
      renderCurrentTab();
      requestAnimationFrame(() => {
        const sb = sidebar();
        if (sb) sb.scrollTop = state.sidebarScrollPos[tab] || 0;
      });
    }
    showDesktopWelcome();
  } else {
    const currentPanel = _currentMobileTabPanel();
    state.tabScrollPos[state.currentTab] = currentPanel?.scrollTop || 0;
    _saveTabDom(state.currentTab);
    _activateTab(tab);
    state.pageStack = [];
    $("tab-bar").classList.remove("hide");
    if (!_restoreTabDom(tab)) {
      _mountFreshMobileTab(tab);
    }
    _writeBrowserRoute("replace");
  }
}

export function pushPage(name, data) {
  if (isDesktop()) {
    // Desktop keeps the sidebar's tab content visible while the sub-page
    // takes over the main content area — no need to detach anything.
    state.pageStack.push({ name, data, scrollTop: content()?.scrollTop || 0 });
    $("top-bar").classList.remove("desktop-hidden");
    renderPage(name, data);
  } else {
    const rootScrollTop = content()?.scrollTop || 0;
    state.tabScrollPos[state.currentTab] = rootScrollTop;
    _saveTabDom(state.currentTab);
    state.pageStack.push({ name, data, scrollTop: rootScrollTop });
    _preparePageContent();
    $("tab-bar").classList.add("hide");
    renderPage(name, data);
    _writeBrowserRoute("push");
  }
}

function _renderPreviousPage() {
  const current = state.pageStack.pop();
  if (current?.returnState) {
    _restoreReturnState(current.returnState);
    return;
  }
  if (state.pageStack.length === 0) {
    _showNavigationRoot();
  } else {
    const prev = state.pageStack[state.pageStack.length - 1];
    const renderResult = renderPage(prev.name, prev.data);
    _restoreContentScroll(current?.scrollTop, renderResult);
  }
}

export function goBack() {
  if (state.pageStack.length === 0) return;
  const route = history.state?.[_historyKey];
  if (!isDesktop() && route?.session === _historySession) {
    history.back();
    return;
  }
  _renderPreviousPage();
}

window.addEventListener("popstate", event => {
  if (isDesktop() || state.pageStack.length === 0) return;

  const route = event.state?.[_historyKey];
  const targetIndex = route?.session === _historySession
    ? route.index
    : Math.max(0, _historyIndex - 1);
  const steps = Math.max(0, _historyIndex - targetIndex);
  for (let i = 0; i < steps && state.pageStack.length > 0; i += 1) {
    _renderPreviousPage();
  }
  _historyIndex = targetIndex;

  if (route?.session !== _historySession) {
    // The root entry may predate this module. Keep the user inside the app for
    // the first Android back action, then let a later back leave from the root.
    _writeBrowserRoute("replace");
  }
});

/* ---- Layout change handler (desktop ↔ mobile transition) ---- */

_desktopMQ.addEventListener("change", () => {
  if (!$("phone-shell")) return;
  _tabCache.clear();
  setMobileTabContentTarget(null);
  const viewport = $("content-area");
  viewport.classList.remove("mobile-tab-swipe-active");
  viewport.innerHTML = "";
  const savedPages = [...state.pageStack];
  switchTab(state.currentTab);
  for (const p of savedPages) {
    pushPage(p.name, p.data);
  }
});
