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
/* Moments (朋友圈) — feed, publish, settings */

import { esc, iconHtml, avatarHtml, personaAvatarUrl, profileAvatarUrl, formatMsgTime, placeActionsPop, jsArg } from "./utils.js";
import { api } from "./api.js";
import { state, $, content } from "./state.js";
import { toast, confirm, showSheet, closeOverlay, showLoading, hideLoading } from "./ui.js";
import { setTopBar, goBack, pushPage, registerPageRenderer } from "./navigation.js";
import { renderTextMedia } from "./message_content.js";
import { buildMomentActionsPopHtml, buildMomentMetaHtml } from "./moments_item_chrome.js";
import {
  groupMomentsByYearMonth,
  stablePersonaCoverStyle,
  momentTextExcerpt,
  parseMomentDate,
} from "./moments_timeline.js";

const BASE = () => window.PAWZOCHAT_BASE || "";

/* ---- Shared state across pages ---- */

const _list = {
  items: [],
  hasMore: true,
  loading: false,
  observer: null,
  inListPage: false,
  // Stable author/persona id filter for API list calls. null = global feed.
  authorFilter: null,
  // "feed" | "persona" | "detail"
  view: "feed",
  personaId: null,
  personaMeta: null, // { id, name, signature, has_avatar, avatar_version, ... }
  detailMid: null,
};

const _state = {
  isGenerating: false,
  isRefreshPending: false,
  coverUrl: "",
  personasById: {},      // pid -> {id, name, has_avatar}
};

let _coverChromeController = null;

const _publish = {
  files: [],             // [{file, dataUrl}]
};

// One floating actions popup at a time. Closing handlers are mounted lazily.
const _pop = {
  el: null,
  mid: null,
  outsideHandler: null,
  keyHandler: null,
};

// At most one inline composer is open at a time.
const _composer = {
  mid: null,
  replyTo: null,         // reply id we're replying to, or null for top-level
  replyToLabel: "",
  activeRid: null,       // last-tapped reply id (highlights its "..." trigger)
  outsideHandler: null,  // mounted while open; closes on click outside
};

// Edit modal target: tracked here so the inline Save button (rendered into a
// `showSheet`-managed overlay) knows what id to PATCH against. Cleared on
// every open/close so a stale handler can't accidentally write the wrong row.
const _edit = {
  kind: null,    // "moment" | "reply"
  mid: null,
  rid: null,     // only set for reply edits
};

const _settings = {
  publishers: new Set(),
  repliers: new Set(),
  probabilities: {},      // pid -> int 0..100
  memoryEnabled: {},      // pid -> bool; missing → true
  promptPost: "",
  promptReply: "",
  promptCounterReply: "",
  promptPostDefault: "",
  promptReplyDefault: "",
  promptCounterReplyDefault: "",
  personas: [],
};

/* ---- Helpers ---- */

function _avatarUrl(author) {
  if (!author) return "";
  if (author === "user") return profileAvatarUrl(state.profile);
  return personaAvatarUrl(_state.personasById[author]);
}

function _hasAvatar(author) {
  if (author === "user") return !!state.profile?.has_avatar;
  const p = _state.personasById[author];
  return !!(p && p.has_avatar);
}

function _avatarBlock(author, label) {
  const url = _hasAvatar(author) ? _avatarUrl(author) : "";
  return avatarHtml(label || "?", "sm", url);
}

function _imageUrl(momentId, filename) {
  return `${BASE()}/api/moments/images/${encodeURIComponent(momentId)}/${encodeURIComponent(filename)}`;
}

/** Reply/comment body: shared image parser + lightbox; small thumbs via CSS. */
function _replyTextHtml(text) {
  return renderTextMedia(text, {
    imageClass: "moments-reply-image",
    inline: true,
    preserveNewlines: true,
    // Drop newlines that only sit at text↔image edges (avoids blank <br> rows).
    trimMediaBoundaryNewlines: true,
    stopPropagation: true,
    imageMaxWidth: 96,
    imageMaxHeight: 96,
  });
}

/* ---- List page ---- */

function _listActionsHtml() {
  const isBusy = _state.isGenerating || _state.isRefreshPending;
  const dis = isBusy ? "disabled" : "";
  const refreshTitle = _state.isRefreshPending ? "正在生成动态…" : "刷新";
  const publishTitle = isBusy ? "正在生成…" : "发布";
  const refreshIconCls = _state.isRefreshPending ? "is-spinning" : "";
  return `
    <button class="top-btn moments-action-btn" id="m-refresh-btn" title="${refreshTitle}" ${dis} onclick="PawzoChat.momentsRefresh()">
      ${iconHtml("ri-refresh-line", refreshIconCls)}
    </button>
    <button class="top-btn moments-action-btn" id="m-publish-btn" title="${publishTitle}" ${dis} onclick="PawzoChat.momentsOpenPublish()">
      ${iconHtml("ri-camera-line")}
    </button>
  `;
}

function _setListActions() {
  const actions = $("top-bar-actions");
  if (actions) actions.innerHTML = _listActionsHtml();
}

function _setupCoverTopBar() {
  if (_coverChromeController) _coverChromeController.abort();

  const area = content();
  const cover = $("m-cover");
  const bar = $("top-bar");
  if (!area || !cover || !bar) return;

  const controller = new AbortController();
  _coverChromeController = controller;
  const sync = () => {
    if (!cover.isConnected) {
      controller.abort();
      if (_coverChromeController === controller) _coverChromeController = null;
      return;
    }
    const coverHidden = cover.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top;
    bar.classList.toggle("is-cover-hidden", coverHidden);
  };

  area.addEventListener("scroll", sync, { passive: true, signal: controller.signal });
  sync();
}

async function renderMomentsList() {
  _list.inListPage = true;
  _list.view = "feed";
  _list.authorFilter = null;
  _list.personaId = null;
  _list.personaMeta = null;
  _list.detailMid = null;
  _list.items = [];
  _list.hasMore = true;
  _list.loading = false;

  setTopBar("朋友圈", true, _listActionsHtml(), undefined, "moments-cover-overlay");

  content().innerHTML = `
    <input type="file" id="m-cover-file" accept="image/*" style="display:none" onchange="PawzoChat.momentsOnCoverFile(event)">
    <div class="moments-page" style="position:relative">
      <div class="moments-cover" id="m-cover" onclick="PawzoChat.momentsPickCover()">
        <div class="moments-cover-hint">点击上传朋友圈封面</div>
      </div>
      <div class="moments-feed" id="m-feed">
        <div class="loading-center"><div class="spinner"></div></div>
      </div>
      <div class="moments-bottom-sentinel" id="m-sentinel"></div>
      <div class="moments-end" id="m-end" style="display:none">— 已经到底了 —</div>
      <div class="about-footer" aria-hidden="true" style="position:absolute;right:8px;bottom:4px;font-size:11px;line-height:1;color:var(--text-3);opacity:0.1;white-space:nowrap;pointer-events:none;user-select:none">i^w^y^x^d^x^l</div>
    </div>
  `;
  _setupCoverTopBar();

  // Load state + first page + cover in parallel.
  try {
    const [stateRes, settingsRes, personasRes] = await Promise.all([
      api.get("/api/moments/state"),
      api.get("/api/moments/settings"),
      api.get("/api/personas"),
    ]);
    _state.isGenerating = !!stateRes.is_generating;
    _state.coverUrl = settingsRes.cover_url || "";
    _state.personasById = {};
    for (const p of (personasRes.personas || [])) _state.personasById[p.id] = p;
    _renderCover();
    _setListActions();
  } catch (e) {
    /* tolerate; continue with defaults */
  }

  await _loadNextPage(true);
  _setupObserver();
}

function _renderCover() {
  const el = $("m-cover");
  if (!el) return;
  // cover_url already carries ?v=<mtime> from the API; do not append Date.now()
  // or re-entering moments would force a full re-download every time.
  const url = _state.coverUrl ? `${BASE()}${_state.coverUrl}` : "";
  if (url) {
    el.style.backgroundImage = `url('${url}')`;
    el.classList.add("has-image");
    el.innerHTML = "";
  } else {
    el.style.backgroundImage = "";
    el.classList.remove("has-image");
    el.innerHTML = `<div class="moments-cover-hint">点击上传朋友圈封面</div>`;
  }
}

async function _loadNextPage(isFirst) {
  if (_list.loading) return;
  if (!_list.hasMore && !isFirst) return;
  _list.loading = true;
  let url = "/api/moments?limit=20";
  if (_list.authorFilter) {
    url += `&author=${encodeURIComponent(_list.authorFilter)}`;
  }
  if (!isFirst && _list.items.length > 0) {
    const oldestTs = _list.items[_list.items.length - 1].timestamp;
    url += `&before=${encodeURIComponent(oldestTs)}`;
  }
  try {
    const res = await api.get(url);
    const items = res.moments || [];
    if (isFirst) {
      _list.items = items;
    } else {
      const seen = new Set(_list.items.map(m => m.id));
      for (const it of items) if (!seen.has(it.id)) _list.items.push(it);
    }
    _list.hasMore = !!res.has_more;
    _renderLiveView();
  } catch (e) {
    toast("加载失败", "error");
    if (isFirst && _list.view === "persona") {
      const feed = $("pm-feed");
      if (feed) {
        feed.innerHTML = `<div class="moments-empty">加载失败，请返回后重试</div>`;
      }
    }
  } finally {
    _list.loading = false;
  }
}

function _preserveComposer() {
  if (!_composer.mid) return null;
  const inp = document.getElementById(`m-comp-input-${_composer.mid}`);
  if (!inp) return null;
  return {
    mid: _composer.mid,
    value: inp.value,
    selStart: inp.selectionStart,
    selEnd: inp.selectionEnd,
    wasFocused: document.activeElement === inp,
  };
}

function _restoreComposer(preserved) {
  if (!preserved) return;
  const inp = document.getElementById(`m-comp-input-${preserved.mid}`);
  if (!inp) return;
  inp.value = preserved.value;
  if (preserved.wasFocused) {
    inp.focus();
    try { inp.setSelectionRange(preserved.selStart, preserved.selEnd); } catch (e) { /* ignore */ }
  }
}

/** Re-render whichever moments surface is currently mounted. */
function _renderLiveView() {
  if (_list.view === "persona" && $("pm-feed")) {
    _renderPersonaTimeline();
    return;
  }
  if (_list.view === "detail" && $("md-body")) {
    _renderMomentDetailBody();
    return;
  }
  _renderItems();
}

function _renderItems() {
  const feed = $("m-feed");
  if (!feed) return;
  if (_list.items.length === 0) {
    feed.innerHTML = `<div class="moments-empty">还没有朋友圈，点击右上角刷新或发布</div>`;
    const end = $("m-end"); if (end) end.style.display = "none";
    return;
  }
  // Snapshot composer state (text + caret) so SSE-triggered re-renders
  // don't drop what the user is currently typing.
  const preserved = _preserveComposer();
  feed.innerHTML = _list.items.map(_momentHtml).join("");
  const end = $("m-end");
  if (end) end.style.display = _list.hasMore ? "none" : "";
  _restoreComposer(preserved);
}

function _momentHtml(m) {
  const author = m.author || "";
  const label = m.author_label || author || "?";
  const time = formatMsgTime(m.timestamp);
  const imgs = (m.images || []).filter(Boolean);
  const imgGridClass =
    imgs.length === 1 ? "moments-imgs n1"
    : imgs.length === 2 ? "moments-imgs n2"
    : imgs.length === 4 ? "moments-imgs n4"
    : "moments-imgs n3";
  const imgsHtml = imgs.length === 0 ? "" : `
    <div class="${imgGridClass}">
      ${imgs.map(fn => {
        const url = _imageUrl(m.id, fn);
        return `<div class="moments-img" style="background-image:url('${url}')" onclick="PawzoChat.openImagePreview('${url}')"></div>`;
      }).join("")}
    </div>`;

  const likesList = m.likes || [];
  const likesHtml = likesList.length === 0 ? "" : `
    <div class="moments-likes">
      ${iconHtml("ri-heart-fill")}<span class="moments-likes-names">${likesList.map(l => {
        const likeAuthor = l.author || "";
        const likeLabel = l.author_label || likeAuthor || "?";
        if (!likeAuthor) return esc(likeLabel);
        const safeLabel = esc(likeLabel);
        return `<button type="button" class="moments-like-author" title="查看${safeLabel}的资料" aria-label="查看${safeLabel}的资料" onclick="PawzoChat.momentsOpenAuthor(event,${jsArg(likeAuthor)})">${safeLabel}</button>`;
      }).join("、")}</span>
    </div>`;

  const repliesList = m.replies || [];
  const repliesHtml = repliesList.length === 0 ? "" : `
    <div class="moments-replies">
      ${repliesList.map(r => {
        const rid = esc(r.id);
        const author = esc(r.author_label || r.author || "?");
        const prefix = (r.reply_to && r.reply_to_label)
          ? `${author} 回复 ${esc(r.reply_to_label)}`
          : author;
        const activeCls = (_composer.mid === m.id && _composer.activeRid === r.id) ? " is-active" : "";
        const ownerActions = (r.can_edit === true || r.can_delete === true)
          ? `<button class="moments-reply-more" title="操作" onclick="event.stopPropagation();PawzoChat.momentsReplyMenu(event,'${esc(m.id)}','${rid}')">${iconHtml("ri-more-fill")}</button>`
          : "";
        return `<div class="moments-reply${activeCls}" data-rid="${rid}" onclick="event.stopPropagation();PawzoChat.momentsReplyTo('${esc(m.id)}','${rid}')">
          <span class="moments-reply-body"><span class="moments-reply-author">${prefix}</span><span class="moments-reply-sep">：</span><span class="moments-reply-text">${_replyTextHtml(r.text || "")}</span></span>
          ${ownerActions}
        </div>`;
      }).join("")}
    </div>`;

  // Tiny divider only when both blocks are present, to mimic WeChat.
  const interactDividerHtml = (likesList.length > 0 && repliesList.length > 0)
    ? `<div class="moments-likes-divider"></div>`
    : "";
  const interactBlockHtml = (likesList.length > 0 || repliesList.length > 0)
    ? `<div class="moments-interact">${likesHtml}${interactDividerHtml}${repliesHtml}</div>`
    : "";

  const composerHtml = _composer.mid === m.id ? _composerHtml(m.id) : "";

  const textHtml = m.text ? `<div class="moments-text">${esc(m.text).replace(/\n/g, "<br>")}</div>` : "";
  const authorLabel = esc(label);
  const openAuthor = `PawzoChat.momentsOpenAuthor(event,${jsArg(author)})`;
  return `
    <div class="moments-item" data-mid="${esc(m.id)}">
      <div class="moments-avatar">
        <button type="button" class="moments-author-link moments-avatar-link" title="查看${authorLabel}的资料" aria-label="查看${authorLabel}的资料" onclick="${openAuthor}">
          ${_avatarBlock(author, label)}
        </button>
      </div>
      <div class="moments-body">
        <button type="button" class="moments-author moments-author-link" title="查看${authorLabel}的资料" aria-label="查看${authorLabel}的资料" onclick="${openAuthor}">${authorLabel}</button>
        ${textHtml}
        ${imgsHtml}
        ${buildMomentMetaHtml(m.id, time, { canDelete: m.can_delete === true })}
        ${interactBlockHtml}
        ${composerHtml}
      </div>
    </div>`;
}

function _composerHtml(mid) {
  const placeholder = _composer.replyTo
    ? `回复 ${_composer.replyToLabel || ""}…`
    : "评论…";
  return `
    <div class="moments-composer" data-mid="${esc(mid)}" onclick="event.stopPropagation()">
      <input type="text" class="moments-composer-input" id="m-comp-input-${esc(mid)}" maxlength="500"
        placeholder="${esc(placeholder)}"
        onkeydown="if(event.key==='Enter'){event.preventDefault();PawzoChat.momentsSubmitReply('${esc(mid)}')}else if(event.key==='Escape'){PawzoChat.momentsCloseComposer()}">
      <button class="moments-composer-send" onclick="PawzoChat.momentsSubmitReply('${esc(mid)}')">发送</button>
    </div>`;
}

function _setupObserver() {
  if (_list.observer) { try { _list.observer.disconnect(); } catch (e) { /* ignore */ } }
  const sentinel = $("m-sentinel") || $("pm-sentinel");
  if (!sentinel) return;
  _list.observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && _list.hasMore && !_list.loading) {
        _loadNextPage(false);
      }
    }
  }, { rootMargin: "200px 0px" });
  _list.observer.observe(sentinel);
}

/* ---- Persona personal moments ---- */

export function openPersonaMoments(personaId) {
  if (!personaId) return;
  pushPage("personaMoments", { personaId });
}

async function renderPersonaMoments(data) {
  const personaId = data?.personaId;
  if (!personaId) {
    toast("作者无效", "error");
    return;
  }

  _list.inListPage = true;
  _list.view = "persona";
  _list.authorFilter = personaId;
  _list.personaId = personaId;
  _list.detailMid = null;
  _list.items = [];
  _list.hasMore = true;
  _list.loading = false;

  setTopBar("朋友圈", true, "");
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;

  const isUser = personaId === "user";
  let persona = null;
  try {
    const personaRequest = isUser
      ? Promise.resolve({
          id: "user",
          name: state.profile?.name || "我",
          has_avatar: !!state.profile?.has_avatar,
          avatar_version: state.profile?.avatar_version || "",
        })
      : api.get(`/api/personas/${encodeURIComponent(personaId)}`);
    const [p, stateRes, settingsRes, personasRes] = await Promise.all([
      personaRequest,
      api.get("/api/moments/state"),
      api.get("/api/moments/settings"),
      api.get("/api/personas"),
    ]);
    persona = p;
    _state.isGenerating = !!stateRes.is_generating;
    _state.coverUrl = settingsRes.cover_url || "";
    _state.personasById = {};
    for (const row of (personasRes.personas || [])) _state.personasById[row.id] = row;
    // Ensure current persona is present for avatar lookup even if list is stale.
    _state.personasById[personaId] = {
      ...(_state.personasById[personaId] || {}),
      id: personaId,
      name: p.name,
      has_avatar: p.has_avatar,
      avatar_version: p.avatar_version,
      moments_cover_url: p.moments_cover_url || "",
    };
  } catch (e) {
    toast("加载失败", "error");
    content().innerHTML = `<div class="moments-empty">无法加载个人朋友圈</div>`;
    return;
  }

  _list.personaMeta = persona;
  const name = persona.name || (isUser ? "我" : "角色");
  const signature = isUser
    ? ""
    : ((persona.signature || "").trim() || "这个人很神秘，什么都没写");
  const avUrl = isUser ? profileAvatarUrl(persona) : personaAvatarUrl(persona);
  const avatarBlock = avatarHtml(name, "lg", avUrl);

  content().innerHTML = `
    <div class="persona-moments-page" id="pm-page">
      <div class="persona-moments-cover" id="pm-cover" aria-hidden="true"></div>
      <div class="persona-moments-identity">
        <div class="persona-moments-avatar">${avatarBlock}</div>
        <div class="persona-moments-name">${esc(name)}</div>
      </div>
      ${signature ? `<div class="persona-moments-signature">${esc(signature)}</div>` : ""}
      <div class="persona-moments-feed" id="pm-feed">
        <div class="loading-center"><div class="spinner"></div></div>
      </div>
      <div class="moments-bottom-sentinel" id="pm-sentinel"></div>
      <div class="moments-end" id="pm-end" style="display:none">— 已经到底了 —</div>
    </div>
  `;

  _renderPersonaCover();
  await _loadNextPage(true);
  _setupObserver();
}

function _renderPersonaCover() {
  const el = $("pm-cover");
  if (!el) return;
  const personaCoverUrl = _list.personaMeta?.moments_cover_url || "";
  // Existing personas without their own cover keep the former global cover as
  // a compatibility fallback. Newly generated personas persist a dedicated URL.
  const coverUrl = personaCoverUrl || _state.coverUrl;
  const url = coverUrl ? `${BASE()}${coverUrl}` : "";
  if (url) {
    el.style.backgroundImage = `url('${url}')`;
    el.classList.add("has-image");
    el.classList.remove("persona-moments-cover--theme");
  } else {
    const style = stablePersonaCoverStyle(_list.personaId || "");
    el.style.backgroundImage = style.backgroundImage;
    el.classList.remove("has-image");
    el.classList.add(style.className);
  }
}

function _renderPersonaTimeline() {
  const feed = $("pm-feed");
  if (!feed) return;
  if (_list.items.length === 0) {
    feed.innerHTML = `<div class="moments-empty">还没有发布过朋友圈</div>`;
    const end = $("pm-end"); if (end) end.style.display = "none";
    return;
  }

  const groups = groupMomentsByYearMonth(_list.items);
  const currentYear = new Date().getFullYear();
  let html = "";

  for (const y of groups) {
    if (y.year !== currentYear) {
      html += `<div class="persona-moments-year" role="heading" aria-level="2">${y.year}年</div>`;
    }
    for (const mo of y.months) {
      html += `<div class="persona-moments-month-block">`;
      let firstInMonth = true;
      for (const m of mo.items) {
        html += _personaTimelineRowHtml(m, { showMonth: firstInMonth, month: mo.month });
        firstInMonth = false;
      }
      html += `</div>`;
    }
  }

  feed.innerHTML = html;
  const end = $("pm-end");
  if (end) end.style.display = _list.hasMore ? "none" : "";
}

function _personaTimelineRowHtml(m, { showMonth, month }) {
  const { day } = parseMomentDate(m.timestamp);
  const imgs = (m.images || []).filter(Boolean);
  const thumbs = imgs.slice(0, 4).map(fn => {
    const url = _imageUrl(m.id, fn);
    return `<div class="persona-moments-thumb" style="background-image:url('${url}')" aria-hidden="true"></div>`;
  }).join("");
  const more = imgs.length > 4
    ? `<span class="persona-moments-thumb-more">+${imgs.length - 4}</span>`
    : "";
  const mediaHtml = thumbs
    ? `<div class="persona-moments-thumbs">${thumbs}${more}</div>`
    : `<div class="persona-moments-thumbs persona-moments-thumbs--empty" aria-hidden="true"></div>`;
  const excerpt = momentTextExcerpt(m.text || "");
  const textHtml = excerpt
    ? `<div class="persona-moments-excerpt">${esc(excerpt)}</div>`
    : (imgs.length
      ? `<div class="persona-moments-excerpt persona-moments-excerpt--muted">分享了 ${imgs.length} 张图片</div>`
      : `<div class="persona-moments-excerpt persona-moments-excerpt--muted">动态</div>`);

  const dateLabel = showMonth
    ? `<span class="persona-moments-day-num">${day}</span><span class="persona-moments-day-month">${month}月</span>`
    : `<span class="persona-moments-day-num">${day}</span>`;

  const mid = esc(m.id);
  return `
    <button type="button" class="persona-moments-row"
      data-mid="${mid}"
      aria-label="查看这条朋友圈"
      onclick="PawzoChat.momentsOpenDetail('${mid}')">
      <div class="persona-moments-date">${dateLabel}</div>
      <div class="persona-moments-row-body">
        ${mediaHtml}
        ${textHtml}
      </div>
    </button>
  `;
}

export function momentsOpenDetail(momentId) {
  if (!momentId) return;
  // Keep return chain: personaMoments stays under this page on the stack.
  pushPage("momentDetail", {
    momentId,
    personaId: _list.personaId || undefined,
  });
}

async function renderMomentDetail(data) {
  const mid = data?.momentId;
  if (!mid) {
    toast("动态无效", "error");
    return;
  }

  _list.inListPage = true;
  _list.view = "detail";
  _list.detailMid = mid;
  // Keep authorFilter if we came from a persona page so SSE filtering stays consistent.
  if (data?.personaId) {
    _list.authorFilter = data.personaId;
    _list.personaId = data.personaId;
  }

  setTopBar("详情", true, "");
  content().innerHTML = `
    <div class="page moment-detail-page" id="md-page">
      <div class="moment-detail-body" id="md-body">
        <div class="loading-center"><div class="spinner"></div></div>
      </div>
    </div>
  `;

  // Ensure personas cache for avatars.
  if (!Object.keys(_state.personasById).length) {
    try {
      const personasRes = await api.get("/api/personas");
      for (const p of (personasRes.personas || [])) _state.personasById[p.id] = p;
    } catch (e) { /* tolerate */ }
  }

  let m = _list.items.find(x => x.id === mid);
  if (!m) {
    try {
      const res = await api.get(`/api/moments/${encodeURIComponent(mid)}`);
      m = res.moment;
      if (m) {
        // Seed into shared list so like/reply handlers can find it without duplicating state.
        _list.items = [m, ..._list.items.filter(x => x.id !== m.id)];
      }
    } catch (e) {
      toast("加载失败", "error");
    }
  }
  _renderMomentDetailBody();
}

function _renderMomentDetailBody() {
  const host = $("md-body");
  if (!host) return;
  const mid = _list.detailMid;
  const m = _list.items.find(x => x.id === mid);
  if (!m) {
    host.innerHTML = `<div class="moments-empty">这条朋友圈不存在或已删除</div>`;
    return;
  }
  const preserved = _preserveComposer();
  host.innerHTML = _momentHtml(m);
  _restoreComposer(preserved);
}

/* ---- Refresh / Publish actions ---- */

export function momentsOpenAuthor(event, author) {
  if (event?.preventDefault) event.preventDefault();
  if (event?.stopPropagation) event.stopPropagation();
  if (!author) return;
  if (author === "user") {
    pushPage("profileDetail");
    return;
  }
  pushPage("personaDetail", { personaId: author });
}

export async function momentsRefresh() {
  if (_state.isGenerating || _state.isRefreshPending) {
    toast("正在生成中…", "info");
    return;
  }
  const area = content();
  if (area) area.scrollTo({ top: 0, behavior: "smooth" });
  _state.isRefreshPending = true;
  _setListActions();
  try {
    const res = await api.post("/api/moments/refresh", {});
    if (res.status >= 400) {
      _state.isRefreshPending = false;
      _setListActions();
      toast(res.data?.error || "刷新失败", "error");
      return;
    }
    toast("正在生成…", "info");
  } catch (e) {
    _state.isRefreshPending = false;
    _setListActions();
    toast("刷新失败", "error");
  }
}

export function momentsOpenPublish() {
  if (_state.isGenerating || _state.isRefreshPending) {
    toast("正在生成中…", "info");
    return;
  }
  _publish.files = [];
  pushPage("momentsPublish", {});
}

export function momentsItemMenu(event, mid) {
  if (event && event.stopPropagation) event.stopPropagation();
  const anchor = event?.currentTarget || event?.target || null;
  _closeActionsPop();

  const moment = _list.items.find(m => m.id === mid);
  if (!moment) return;
  const liked = !!(moment.likes || []).find(l => l.author === "user");

  const el = document.createElement("div");
  el.className = "moments-actions-pop";
  el.setAttribute("data-mid", mid);
  el.addEventListener("click", e => e.stopPropagation());
  el.innerHTML = buildMomentActionsPopHtml(mid, {
    canEdit: moment.can_edit === true,
    liked,
  });
  document.body.appendChild(el);

  // Prefer placing the pill to the left of the "..." button — moments live
  // far enough from the right edge that left almost always wins.
  if (anchor && anchor.getBoundingClientRect) {
    const rect = anchor.getBoundingClientRect();
    el.style.visibility = "hidden";
    requestAnimationFrame(() => {
      placeActionsPop(el, rect, /* preferLeft */ true);
      el.style.visibility = "";
    });
  }

  _pop.el = el;
  _pop.mid = mid;
  _pop.outsideHandler = (e) => {
    if (_pop.el && !_pop.el.contains(e.target)) _closeActionsPop();
  };
  _pop.keyHandler = (e) => { if (e.key === "Escape") _closeActionsPop(); };
  // Defer until after this click finishes propagating.
  setTimeout(() => {
    document.addEventListener("click", _pop.outsideHandler, true);
    document.addEventListener("keydown", _pop.keyHandler);
  }, 0);
}

export function momentsReplyMenu(event, mid, rid) {
  if (event && event.stopPropagation) event.stopPropagation();
  const anchor = event?.currentTarget || event?.target || null;
  _closeActionsPop();

  const moment = _list.items.find(m => m.id === mid);
  const reply = (moment?.replies || []).find(r => r.id === rid);
  if (!reply || (reply.can_edit !== true && reply.can_delete !== true)) return;
  const ownerActions = `
    ${reply.can_edit === true ? `
      <button class="map-btn" onclick="PawzoChat.momentsEditReply('${esc(mid)}','${esc(rid)}')">
        ${iconHtml("ri-edit-line")}<span>编辑</span>
      </button>` : ""}
    ${reply.can_edit === true && reply.can_delete === true ? `<span class="map-divider"></span>` : ""}
    ${reply.can_delete === true ? `
      <button class="map-btn map-btn-danger" onclick="PawzoChat.momentsDeleteReply('${esc(mid)}','${esc(rid)}')">
        ${iconHtml("ri-delete-bin-line")}<span>删除</span>
      </button>` : ""}
  `;

  const el = document.createElement("div");
  el.className = "moments-actions-pop";
  el.setAttribute("data-mid", mid);
  el.setAttribute("data-rid", rid);
  el.addEventListener("click", e => e.stopPropagation());
  el.innerHTML = ownerActions;
  document.body.appendChild(el);

  // Reply "..." buttons hug the right edge of the reply row, so try the left
  // side first — the helper falls back to the right and clamps to the
  // viewport if neither side fully fits.
  if (anchor && anchor.getBoundingClientRect) {
    const rect = anchor.getBoundingClientRect();
    el.style.visibility = "hidden";
    requestAnimationFrame(() => {
      placeActionsPop(el, rect, /* preferLeft */ true);
      el.style.visibility = "";
    });
  }

  _pop.el = el;
  _pop.mid = mid;
  _pop.outsideHandler = (e) => {
    if (_pop.el && !_pop.el.contains(e.target)) _closeActionsPop();
  };
  _pop.keyHandler = (e) => { if (e.key === "Escape") _closeActionsPop(); };
  setTimeout(() => {
    document.addEventListener("click", _pop.outsideHandler, true);
    document.addEventListener("keydown", _pop.keyHandler);
  }, 0);
}

function _closeActionsPop() {
  if (_pop.el) {
    try { _pop.el.remove(); } catch (e) { /* ignore */ }
  }
  if (_pop.outsideHandler) {
    document.removeEventListener("click", _pop.outsideHandler, true);
  }
  if (_pop.keyHandler) {
    document.removeEventListener("keydown", _pop.keyHandler);
  }
  _pop.el = null;
  _pop.mid = null;
  _pop.outsideHandler = null;
  _pop.keyHandler = null;
}

export async function momentsLikeToggle(mid) {
  _closeActionsPop();
  const moment = _list.items.find(m => m.id === mid);
  if (!moment) return;
  const liked = !!(moment.likes || []).find(l => l.author === "user");
  try {
    const res = liked
      ? await api.del(`/api/moments/${encodeURIComponent(mid)}/like`)
      : await api.post(`/api/moments/${encodeURIComponent(mid)}/like`, {});
    if (res.status >= 400) {
      toast(res.data?.error || "操作失败", "error");
      return;
    }
    // SSE will refresh the moment; do an optimistic local patch for snappy UI.
    const userName = state.profile?.name || "我";
    if (liked) {
      moment.likes = (moment.likes || []).filter(l => l.author !== "user");
    } else {
      moment.likes = [...(moment.likes || []), { author: "user", author_label: userName }];
    }
    _renderLiveView();
  } catch (e) { toast("操作失败", "error"); }
}

export function momentsOpenComposer(mid) {
  _closeActionsPop();
  _composer.mid = mid;
  _composer.replyTo = null;
  _composer.replyToLabel = "";
  _composer.activeRid = null;
  _mountComposerOutside();
  _renderLiveView();
  _focusComposer(mid);
}

export function momentsReplyTo(mid, rid) {
  _closeActionsPop();
  const moment = _list.items.find(m => m.id === mid);
  if (!moment) return;
  const r = (moment.replies || []).find(x => x.id === rid);
  if (!r) return;
  // Replying to your own reply is a no-op (no AI counter, nothing to address).
  if (r.author === "user") {
    _composer.mid = mid;
    _composer.replyTo = null;
    _composer.replyToLabel = "";
  } else {
    _composer.mid = mid;
    _composer.replyTo = rid;
    _composer.replyToLabel = r.author_label || r.author || "";
  }
  _composer.activeRid = rid;
  _mountComposerOutside();
  _renderLiveView();
  _focusComposer(mid);
}

export function momentsCloseComposer() {
  if (_composer.mid === null) return;
  _composer.mid = null;
  _composer.replyTo = null;
  _composer.replyToLabel = "";
  _composer.activeRid = null;
  _unmountComposerOutside();
  _renderLiveView();
}

function _mountComposerOutside() {
  if (_composer.outsideHandler) return;
  const handler = (e) => {
    if (!_composer.mid) return;
    const t = e.target;
    if (t && t.closest && t.closest(".moments-composer, .moments-reply, .moments-actions-pop, .moments-author-link")) return;
    momentsCloseComposer();
  };
  _composer.outsideHandler = handler;
  // Defer past the click that opened the composer.
  setTimeout(() => {
    if (_composer.outsideHandler === handler) {
      document.addEventListener("click", handler, true);
    }
  }, 0);
}

function _unmountComposerOutside() {
  if (_composer.outsideHandler) {
    document.removeEventListener("click", _composer.outsideHandler, true);
    _composer.outsideHandler = null;
  }
}

function _focusComposer(mid) {
  // After re-render, the input exists; focus on next tick.
  setTimeout(() => {
    const inp = document.getElementById(`m-comp-input-${mid}`);
    if (inp) inp.focus();
  }, 0);
}

export async function momentsSubmitReply(mid) {
  const inp = document.getElementById(`m-comp-input-${mid}`);
  if (!inp) return;
  const text = (inp.value || "").trim();
  if (!text) return;
  const replyTo = _composer.mid === mid ? _composer.replyTo : null;
  try {
    const res = await api.post(`/api/moments/${encodeURIComponent(mid)}/replies`, {
      text,
      reply_to: replyTo,
    });
    if (res.status >= 400) {
      toast(res.data?.error || "评论失败", "error");
      return;
    }
    // Close composer; SSE will re-render the moment with the new reply.
    _composer.mid = null;
    _composer.replyTo = null;
    _composer.replyToLabel = "";
    _composer.activeRid = null;
    _unmountComposerOutside();
    _renderLiveView();
  } catch (e) { toast("评论失败", "error"); }
}

export async function momentsDeleteReply(mid, rid) {
  _closeActionsPop();
  const ok = await confirm("删除评论", "确认删除该评论？后续回复也会一并删除。", true);
  if (!ok) return;
  showLoading("删除中…");
  try {
    const res = await api.del(`/api/moments/${encodeURIComponent(mid)}/replies/${encodeURIComponent(rid)}`);
    if (res.status >= 400) { toast(res.data?.error || "删除失败", "error"); return; }
    const deleted = new Set(res.data?.deleted_ids || [rid]);
    const moment = _list.items.find(m => m.id === mid);
    if (moment) moment.replies = (moment.replies || []).filter(r => !deleted.has(r.id));
    _renderLiveView();
  } catch (e) { toast("删除失败", "error"); }
  finally { hideLoading(); }
}

/* ---- Edit (moment text / reply text) ---- */

const _EDIT_LIMITS = { moment: 2000, reply: 500 };

function _openEditSheet({ kind, mid, rid, label, current, maxlen, rows }) {
  _closeActionsPop();
  _edit.kind = kind;
  _edit.mid = mid;
  _edit.rid = rid;
  const safeCurrent = esc(current);
  const minH = kind === "reply" ? 72 : 140;
  showSheet(
    `<div style="padding:8px 20px 20px">
      <div class="sheet-title">${esc(label)}</div>
      <div class="card" style="margin:0">
        <textarea id="m-edit-text" class="form-textarea" rows="${rows}"
          maxlength="${maxlen}"
          placeholder="${kind === "reply" ? "评论内容…" : "这一刻的想法…"}"
          style="min-height:${minH}px">${safeCurrent}</textarea>
      </div>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button onclick="PawzoChat.closeOverlay()"
          style="flex:1;padding:10px;border:none;border-radius:var(--radius-btn);background:var(--bg);color:var(--text-2);font-size:15px;cursor:pointer;font-family:var(--font)">取消</button>
        <button onclick="PawzoChat.momentsSubmitEdit()"
          style="flex:1;padding:10px;border:none;border-radius:var(--radius-btn);background:var(--primary);color:#fff;font-size:15px;cursor:pointer;font-family:var(--font)">保存</button>
      </div>
    </div>`,
    () => { _edit.kind = null; _edit.mid = null; _edit.rid = null; },
  );
  // Focus + place caret at end so editing feels immediate.
  setTimeout(() => {
    const ta = document.getElementById("m-edit-text");
    if (!ta) return;
    ta.focus();
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) { /* ignore */ }
  }, 50);
}

export function momentsEdit(mid) {
  const moment = _list.items.find(m => m.id === mid);
  if (!moment) return;
  _openEditSheet({
    kind: "moment",
    mid,
    rid: null,
    label: "编辑朋友圈",
    current: moment.text || "",
    maxlen: _EDIT_LIMITS.moment,
    rows: 6,
  });
}

export function momentsEditReply(mid, rid) {
  const moment = _list.items.find(m => m.id === mid);
  if (!moment) return;
  const r = (moment.replies || []).find(x => x.id === rid);
  if (!r) return;
  _openEditSheet({
    kind: "reply",
    mid,
    rid,
    label: "编辑评论",
    current: r.text || "",
    maxlen: _EDIT_LIMITS.reply,
    rows: 3,
  });
}

export async function momentsSubmitEdit() {
  const ta = document.getElementById("m-edit-text");
  if (!ta) return;
  const text = ta.value.trim();
  const { kind, mid, rid } = _edit;
  if (!kind || !mid) { closeOverlay(); return; }
  if (kind === "reply" && !text) {
    toast("评论内容不能为空", "error");
    return;
  }
  if (kind === "moment") {
    const moment = _list.items.find(m => m.id === mid);
    const hasImages = !!(moment && (moment.images || []).length);
    if (!text && !hasImages) {
      toast("文案与图片不能同时为空", "error");
      return;
    }
  }
  showLoading("保存中…");
  try {
    const url = kind === "reply"
      ? `/api/moments/${encodeURIComponent(mid)}/replies/${encodeURIComponent(rid)}`
      : `/api/moments/${encodeURIComponent(mid)}`;
    const res = await api.patch(url, { text });
    if (res.status >= 400) {
      toast(res.data?.error || "保存失败", "error");
      return;
    }
    // Optimistic local patch; SSE will reconfirm.
    const moment = _list.items.find(m => m.id === mid);
    if (moment) {
      if (kind === "moment") {
        moment.text = res.data?.text ?? text;
      } else {
        const r = (moment.replies || []).find(x => x.id === rid);
        if (r) r.text = res.data?.text ?? text;
      }
      _renderLiveView();
    }
    closeOverlay();
  } catch (e) { toast("保存失败", "error"); }
  finally { hideLoading(); }
}

export async function momentsDelete(mid) {
  _closeActionsPop();
  const ok = await confirm("删除朋友圈", "确认删除这条朋友圈？此操作不可撤销。", true);
  if (!ok) return;
  showLoading("删除中…");
  try {
    const res = await api.del(`/api/moments/${encodeURIComponent(mid)}`);
    if (res.status >= 400) { toast(res.data?.error || "删除失败", "error"); return; }
    // SSE will also remove it, but update locally for snappy response.
    _list.items = _list.items.filter(m => m.id !== mid);
    _renderLiveView();
  } catch (e) { toast("删除失败", "error"); }
  finally { hideLoading(); }
}

/* ---- Cover ---- */

export function momentsPickCover() {
  if (_state.coverUrl) {
    // Has cover → open menu instead of immediately uploading
    momentsCoverMenu();
    return;
  }
  const inp = $("m-cover-file");
  if (inp) { inp.value = ""; inp.click(); }
}

export function momentsCoverMenu() {
  showSheet(`<div style="padding:20px">
    <div class="sheet-title">朋友圈封面</div>
    <div class="card" style="margin:8px 0">
      <div class="card-row" style="cursor:pointer" onclick="PawzoChat.closeOverlay();PawzoChat.momentsPickCoverFile()">
        <span class="row-label">更换封面</span><span class="row-arrow">›</span>
      </div>
      <div class="card-row danger-row" style="cursor:pointer" onclick="PawzoChat.momentsCoverDelete()">
        <span class="row-label" style="color:#e15151">移除封面</span>
      </div>
    </div>
    <button onclick="PawzoChat.closeOverlay()" style="width:100%;padding:10px;border:none;border-radius:var(--radius-btn);background:var(--bg);color:var(--text-2);font-size:15px;cursor:pointer;font-family:var(--font)">取消</button>
  </div>`);
}

export function momentsPickCoverFile() {
  const inp = $("m-cover-file");
  if (inp) { inp.value = ""; inp.click(); }
}

export async function momentsOnCoverFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("cover", file);
  showLoading("上传中…");
  try {
    const r = await fetch(`${BASE()}/api/moments/cover`, { method: "POST", body: fd });
    const data = await r.json();
    if (r.status >= 400) { toast(data?.error || "上传失败", "error"); return; }
    _state.coverUrl = data?.cover_url || "/api/moments/cover";
    _renderCover();
    toast("封面已更新", "success");
  } catch (e) { toast("上传失败", "error"); }
  finally { hideLoading(); }
  event.target.value = "";
}

export async function momentsCoverDelete() {
  closeOverlay();
  const ok = await confirm("移除封面", "确认移除当前封面图？", true);
  if (!ok) return;
  showLoading("处理中…");
  try {
    const res = await api.del("/api/moments/cover");
    if (res.status >= 400) {
      toast(res.data?.error || "失败", "error");
      return;
    }
    _state.coverUrl = "";
    _renderCover();
  } catch (e) { toast("失败", "error"); }
  finally { hideLoading(); }
}

/* ---- SSE handlers ---- */

// True iff a moments surface that shares _list state is currently mounted.
// The _list.inListPage flag alone is unreliable because nothing resets it when
// the user switches to a different top-level tab — checking for live roots
// keeps SSE side-effects scoped to when the page is actually visible.
function _isListPageVisible() {
  if (!_list.inListPage) return false;
  return !!(
    document.getElementById("m-feed")
    || document.getElementById("pm-feed")
    || document.getElementById("md-body")
  );
}

export async function momentsOnUpdate(data) {
  if (!_isListPageVisible()) return;
  const action = data.action;
  const mid = data.moment_id;
  const authorId = data.author_id;
  if (action === "author_deleted") {
    if (!authorId) return;
    _list.items = _list.items.filter(m => {
      if (m.author === authorId) return false;
      // Also strip this author from replies and likes on remaining items.
      if (m.replies) m.replies = m.replies.filter(r => r.author !== authorId);
      if (m.likes) m.likes = m.likes.filter(l => l.author !== authorId);
      return true;
    });
    _renderLiveView();
    return;
  }
  if (!mid) return;
  try {
    if (action === "deleted") {
      _list.items = _list.items.filter(m => m.id !== mid);
      if (_list.view === "detail" && _list.detailMid === mid) {
        _renderLiveView();
        return;
      }
      _renderLiveView();
      return;
    }
    if (action === "reply_deleted") {
      const deleted = new Set(data.reply_ids || []);
      const idx = _list.items.findIndex(x => x.id === mid);
      if (idx >= 0) {
        _list.items[idx].replies =
          (_list.items[idx].replies || []).filter(r => !deleted.has(r.id));
        _renderLiveView();
      }
      return;
    }
    const res = await api.get(`/api/moments/${encodeURIComponent(mid)}`);
    if (!res.moment) return;
    const m = res.moment;
    // When viewing a persona album, ignore moments from other authors.
    if (_list.authorFilter && m.author !== _list.authorFilter) {
      // Still allow updates to an already-listed item (shouldn't happen for author mismatch).
      const existing = _list.items.findIndex(x => x.id === mid);
      if (existing < 0) return;
    }
    const idx = _list.items.findIndex(x => x.id === mid);
    if (idx >= 0) {
      _list.items[idx] = m;
    } else if (action === "added" || action === "reply_added" || action === "like_changed") {
      if (_list.authorFilter && m.author !== _list.authorFilter) return;
      // Promote off-window moments to the top only when they grew (new post,
      // new reply, or like change). Edits never reorder the feed.
      _list.items.unshift(m);
    }
    _renderLiveView();
    if (action === "added" && _state.isRefreshPending) {
      _state.isRefreshPending = false;
      if (_list.view === "feed") _setListActions();
    }
  } catch (e) { /* silent */ }
}

export function momentsOnGenerating(isGenerating) {
  _state.isGenerating = !!isGenerating;
  if (!_state.isGenerating) _state.isRefreshPending = false;
  if (_isListPageVisible() && _list.view === "feed") _setListActions();
}

/* ---- Publish page ---- */

function renderMomentsPublish() {
  _list.inListPage = false;
  _list.view = "feed";
  setTopBar("发布朋友圈", true, `
    <button class="btn-text" onclick="PawzoChat.momentsSubmitPublish()" style="font-size:15px;font-weight:500;padding:8px 8px">发表</button>
  `);

  content().innerHTML = `
    <input type="file" id="m-pub-file" accept="image/*" multiple style="display:none" onchange="PawzoChat.momentsOnPublishFiles(event)">
    <div class="page moments-publish-page">
      <div class="card">
        <textarea id="m-pub-text" class="form-textarea" rows="6" placeholder="这一刻的想法…" style="width:100%;border:none;background:transparent;font-size:15px;line-height:1.6;color:var(--text-1);resize:vertical;padding:14px 16px;font-family:var(--font);outline:none"></textarea>
      </div>
      <div class="card">
        <div class="moments-pub-imgs" id="m-pub-imgs"></div>
        <div class="moments-pub-hint">最多 9 张图片，单张上限 10 MB</div>
      </div>
    </div>
  `;
  _renderPublishImages();
}

function _renderPublishImages() {
  const host = $("m-pub-imgs");
  if (!host) return;
  const thumbs = _publish.files.map((f, i) => `
    <div class="m-pub-thumb" style="background-image:url('${f.dataUrl}')">
      <button class="m-pub-thumb-del" onclick="PawzoChat.momentsRemovePubImage(${i})">×</button>
    </div>
  `).join("");
  const addBtn = _publish.files.length < 9
    ? `<button class="m-pub-add" onclick="PawzoChat.momentsPickPubImages()">+</button>`
    : "";
  host.innerHTML = thumbs + addBtn;
}

export function momentsPickPubImages() {
  const inp = $("m-pub-file");
  if (inp) { inp.value = ""; inp.click(); }
}

export async function momentsOnPublishFiles(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  const remaining = Math.max(0, 9 - _publish.files.length);
  if (!remaining) {
    toast("已达到 9 张图片上限", "info");
    event.target.value = "";
    return;
  }
  const accepted = files.slice(0, remaining);
  if (files.length > remaining) toast(`仅添加前 ${remaining} 张图片`, "info");
  for (const file of accepted) {
    if (file.size > 10 * 1024 * 1024) {
      toast(`「${file.name}」超过 10 MB`, "error");
      continue;
    }
    const dataUrl = await new Promise(resolve => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => resolve("");
      fr.readAsDataURL(file);
    });
    if (dataUrl) _publish.files.push({ file, dataUrl });
  }
  _renderPublishImages();
  event.target.value = "";
}

export function momentsRemovePubImage(idx) {
  _publish.files.splice(idx, 1);
  _renderPublishImages();
}

export async function momentsSubmitPublish() {
  const text = ($("m-pub-text")?.value || "").trim();
  if (!text && _publish.files.length === 0) {
    toast("文案与图片不能同时为空", "error");
    return;
  }
  const fd = new FormData();
  fd.append("text", text);
  for (const f of _publish.files) fd.append("images", f.file);

  showLoading("发布中…");
  try {
    const r = await fetch(`${BASE()}/api/moments`, { method: "POST", body: fd });
    const data = await r.json();
    if (r.status >= 400) {
      toast(data?.error || "发布失败", "error");
      return;
    }
    toast("已发布", "success");
    _publish.files = [];
    goBack();
  } catch (e) { toast("发布失败", "error"); }
  finally { hideLoading(); }
}

/* ---- Settings page ---- */

async function renderMomentsSettings() {
  _list.inListPage = false;
  _list.view = "feed";
  setTopBar("朋友圈设置", true, `
    <button class="btn-text" onclick="PawzoChat.momentsSaveSettings()">保存</button>
  `);

  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  try {
    const res = await api.get("/api/moments/settings");
    _settings.promptPost = res.prompts?.post || "";
    _settings.promptReply = res.prompts?.reply || "";
    _settings.promptCounterReply = res.prompts?.counter_reply || "";
    _settings.promptPostDefault = res.prompts?.post_default || "";
    _settings.promptReplyDefault = res.prompts?.reply_default || "";
    _settings.promptCounterReplyDefault = res.prompts?.counter_reply_default || "";
  } catch (e) { toast("加载失败", "error"); return; }

  content().innerHTML = `
    <div class="page">
      <div class="card">
        <div class="card-header-row">
          <span class="card-header" style="flex:1">文案生成提示词</span>
          <button class="btn-text btn-sm" onclick="PawzoChat.momentsResetPrompt('post')">恢复默认</button>
        </div>
        <div class="form-group" style="padding:0 16px 14px">
          <textarea id="m-set-post" class="form-textarea moments-prompt-area" rows="6">${esc(_settings.promptPost)}</textarea>
          <div class="form-hint">刷新朋友圈时调用 LLM 的指令模板</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header-row">
          <span class="card-header" style="flex:1">回复生成提示词</span>
          <button class="btn-text btn-sm" onclick="PawzoChat.momentsResetPrompt('reply')">恢复默认</button>
        </div>
        <div class="form-group" style="padding:0 16px 14px">
          <textarea id="m-set-reply" class="form-textarea moments-prompt-area" rows="6">${esc(_settings.promptReply)}</textarea>
          <div class="form-hint">可用占位符：<code>{author}</code>（发布者名字）、<code>{text}</code>（朋友圈正文）</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header-row">
          <span class="card-header" style="flex:1">反向回复提示词</span>
          <button class="btn-text btn-sm" onclick="PawzoChat.momentsResetPrompt('counter_reply')">恢复默认</button>
        </div>
        <div class="form-group" style="padding:0 16px 14px">
          <textarea id="m-set-counter" class="form-textarea moments-prompt-area" rows="6">${esc(_settings.promptCounterReply)}</textarea>
          <div class="form-hint">用户回复角色时使用。可用占位符：<code>{moment_author}</code>、<code>{moment_text}</code>、<code>{user_name}</code>、<code>{user_reply}</code>、<code>{thread}</code>（之前的对话）</div>
        </div>
      </div>
    </div>
  `;
}

export function momentsResetPrompt(kind) {
  if (kind === "post") {
    const el = $("m-set-post");
    if (el) el.value = _settings.promptPostDefault;
  } else if (kind === "counter_reply") {
    const el = $("m-set-counter");
    if (el) el.value = _settings.promptCounterReplyDefault;
  } else {
    const el = $("m-set-reply");
    if (el) el.value = _settings.promptReplyDefault;
  }
}

export async function momentsSaveSettings() {
  const post = $("m-set-post")?.value || "";
  const reply = $("m-set-reply")?.value || "";
  const counter_reply = $("m-set-counter")?.value || "";

  showLoading("保存中…");
  try {
    const res = await api.put("/api/moments/settings", {
      prompts: { post, reply, counter_reply },
    });
    if (res.status >= 400) { toast(res.data?.error || "保存失败", "error"); return; }
    toast("已保存", "success");
    goBack();
  } catch (e) { toast("保存失败", "error"); }
  finally { hideLoading(); }
}

/* ---- Page registration ---- */

registerPageRenderer("momentsList", renderMomentsList);
registerPageRenderer("momentsPublish", renderMomentsPublish);
registerPageRenderer("momentsSettings", renderMomentsSettings);
registerPageRenderer("personaMoments", renderPersonaMoments);
registerPageRenderer("momentDetail", renderMomentDetail);
