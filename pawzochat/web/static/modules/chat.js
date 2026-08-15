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
import { avatarHtml, personaAvatarUrl, profileAvatarUrl, formatTime, formatMsgTime, esc, escAttr, iconHtml, placeActionsPop, jsArg } from "./utils.js";
import { renderTextMedia, summarizeConversationMessage } from "./message_content.js";
import {
  markConversationReadLocal, mergeConversationsPreserveUnread, unreadBadgeHtml,
  updateChatTabUnread, updateConversationUnread,
} from "./unread.js";
import { api } from "./api.js";
import { state, $, content, sidebar } from "./state.js";
import { toast, confirm, showSheet, closeOverlay, showLoading, hideLoading } from "./ui.js";
import {
  setTopBar, pushPage, goBack, switchTab,
  registerTabRenderer, registerPageRenderer,
  isDesktop, setSidebarBar, refreshSidebar,
} from "./navigation.js";

export let chatPersonaId = null;
let _pendingImages = [];
let _pendingFiles = [];
let _pendingQuote = "";
// Monotonic token for conversation-list / unread fetches: only the latest
// response may write state + DOM, so concurrent SSE refreshes cannot flash
// badges by applying an older payload after a newer one.
let _conversationsFetchGen = 0;

let _mobileViewportReady = false;
let _viewportSyncFrame = 0;
let _pinBottomForKeyboard = false;
let _keyboardBlurTimer = 0;

const _chatScrollState = {
  el: null,
  followBottom: true,
  suppressScroll: false,
  mediaEpoch: 0,
  alignFrame: 0,
};

// "via <channel>" tag under a message that arrived from an external channel.
// Web/LLM-sourced messages get no tag.
const _MSG_FRAGMENT = "lxdxywi";
function sourceBadge(source) {
  let label = "";
  if (source === "wechat") label = "微信";
  else if (source === "qq") label = "QQ";
  else if (source === _MSG_FRAGMENT) label = "";
  else if (typeof source === "string" && source.startsWith("plugin:")) label = "插件";
  return label ? `<div class="msg-source">via ${esc(label)}</div>` : "";
}

/* ---- Long-press message action popup state ---- */

const _quotePop = {
  el: null,
  quoteText: "",
  voiceEl: null,
  outsideHandler: null,
  keyHandler: null,
};
let _lpTimer = null;
let _lpStartX = 0;
let _lpStartY = 0;
let _suppressedVoiceEl = null;
// The click generated when releasing a long-press must not immediately close
// the just-opened popup; swallow exactly that one click in the outside-handler.
let _ignoreNextDocClick = false;
// Voice transcript expansion is UI-only, but keep it through SSE re-renders
// while the current page remains open.
const _expandedVoiceTranscripts = new Set();

/* ---- Emoji Picker State ---- */

let _emojiPickerOpen = false;
let _emojiGroups = null;
let _emojiGroupCache = {};
let _emojiActiveTab = 0;

/* ---- Plus Menu State ---- */

let _plusMenuOpen = false;

const _STANDARD_EMOJIS = [
  "\u{1F600}","\u{1F603}","\u{1F604}","\u{1F601}","\u{1F606}","\u{1F605}","\u{1F602}","\u{1F923}","\u{1F60A}","\u{1F607}",
  "\u{1F642}","\u{1F643}","\u{1F609}","\u{1F60C}","\u{1F60D}","\u{1F970}","\u{1F618}","\u{1F617}","\u{1F619}","\u{1F61A}",
  "\u{1F60B}","\u{1F61B}","\u{1F61C}","\u{1F92A}","\u{1F61D}","\u{1F911}","\u{1F917}","\u{1F92D}","\u{1F92B}","\u{1F914}",
  "\u{1F910}","\u{1F928}","\u{1F610}","\u{1F611}","\u{1F636}","\u{1F60F}","\u{1F612}","\u{1F644}","\u{1F62C}","\u{1F925}",
  "\u{1F60E}","\u{1F913}","\u{1F978}","\u{1F9D0}","\u{1F615}","\u{1F61F}","\u{1F641}","\u{2639}\u{FE0F}","\u{1F62E}","\u{1F62F}",
  "\u{1F632}","\u{1F633}","\u{1F97A}","\u{1F979}","\u{1F626}","\u{1F627}","\u{1F628}","\u{1F630}","\u{1F625}","\u{1F622}",
  "\u{1F62D}","\u{1F631}","\u{1F616}","\u{1F623}","\u{1F61E}","\u{1F613}","\u{1F629}","\u{1F62A}","\u{1F924}","\u{1F634}",
  "\u{1F637}","\u{1F912}","\u{1F915}","\u{1F922}","\u{1F92E}","\u{1F927}","\u{1F975}","\u{1F976}","\u{1F974}","\u{1F635}",
  "\u{1F621}","\u{1F620}","\u{1F92C}","\u{1F608}","\u{1F47F}","\u{1F480}","\u{1F4A9}","\u{1F921}","\u{1F47B}","\u{1F47D}",
  "\u{1F916}","\u{1F63A}","\u{1F638}","\u{1F639}","\u{1F63B}","\u{1F63C}","\u{1F63D}","\u{1F640}","\u{1F63F}","\u{1F63E}",
  "\u{1F44D}","\u{1F44E}","\u{1F44A}","\u{270A}","\u{1F91B}","\u{1F91C}","\u{1F44F}","\u{1F64C}","\u{1F450}","\u{1F932}",
  "\u{1F91D}","\u{1F64F}","\u{270C}\u{FE0F}","\u{1F91E}","\u{1F91F}","\u{1F918}","\u{1F44C}","\u{1F90C}","\u{1F448}","\u{1F449}",
  "\u{1F446}","\u{1F447}","\u{261D}\u{FE0F}","\u{1F44B}","\u{1F919}","\u{1F4AA}","\u{1F9B5}","\u{1F9B6}","\u{1F442}","\u{1F440}",
  "\u{2764}\u{FE0F}","\u{1F9E1}","\u{1F49B}","\u{1F49A}","\u{1F499}","\u{1F49C}","\u{1F5A4}","\u{1F90D}","\u{1F90E}","\u{1F494}",
  "\u{1F495}","\u{1F49E}","\u{1F493}","\u{1F497}","\u{1F496}","\u{1F498}","\u{1F49D}","\u{1F48C}","\u{1F4AF}","\u{1F4A2}",
  "\u{1F4A5}","\u{1F4AB}","\u{1F4A6}","\u{1F4A8}","\u{1F525}","\u{2B50}","\u{1F31F}","\u{2728}","\u{1F389}","\u{1F388}",
  "\u{1F381}","\u{1F380}","\u{1F3C6}","\u{1F3C5}","\u{1F947}","\u{1F948}","\u{1F949}","\u{26BD}","\u{1F3B5}","\u{1F3B6}",
  "\u{1F436}","\u{1F431}","\u{1F42D}","\u{1F439}","\u{1F430}","\u{1F98A}","\u{1F43B}","\u{1F43C}","\u{1F428}","\u{1F42F}",
  "\u{1F981}","\u{1F42E}","\u{1F437}","\u{1F438}","\u{1F435}","\u{1F412}","\u{1F414}","\u{1F427}","\u{1F426}","\u{1F985}",
  "\u{1F339}","\u{1F33B}","\u{1F337}","\u{1F338}","\u{1F33A}","\u{1F340}","\u{1F343}","\u{1F341}","\u{1F342}","\u{1F334}",
  "\u{1F349}","\u{1F34A}","\u{1F34B}","\u{1F34C}","\u{1F34D}","\u{1F34E}","\u{1F350}","\u{1F351}","\u{1F352}","\u{1F353}",
  "\u{2615}","\u{1F375}","\u{1F37A}","\u{1F37B}","\u{1F942}","\u{1F377}","\u{1F378}","\u{1F379}","\u{1F354}","\u{1F355}",
];

/* ---- Chat List (Tab) ---- */

function _paintChatList(target, desktop) {
  if (state.conversations.length === 0) {
    target.innerHTML = `
      <div class="empty-state" style="position:relative">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
        <div class="empty-text">还没有对话</div>
        <button onclick="PawzoChat.newConversation()">发起新对话</button>
        <div class="about-footer" aria-hidden="true" style="position:absolute;right:8px;bottom:4px;font-size:11px;line-height:1;color:var(--text-3);opacity:0.1;white-space:nowrap;pointer-events:none;user-select:none">i*w*y*x*d*x*l</div>
      </div>`;
    updateChatTabUnread(state.conversations);
    return;
  }

  const searchHtml = `<div class="search-bar">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    <input placeholder="搜索" oninput="PawzoChat.filterConvs(this.value)">
  </div>`;

  const listHtml = state.conversations.map(c => {
    const pname = c.persona_name || c.persona_id;
    const persona = state.personas.find(pp => pp.id === c.persona_id);
    const avUrl = personaAvatarUrl(persona);
    const preview = summarizeConversationMessage(c.last_message);
    const time = c.last_message ? formatTime(c.last_message.timestamp) : "";
    const wechatBadge = c.wechat_linked
      ? `<span class="wechat-badge"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg></span>` : "";
    const active = (desktop && chatPersonaId === c.persona_id) ? " active" : "";
    const unreadBadge = unreadBadgeHtml(c.unread_count, "conv-unread-badge");
    return `<div class="conv-item${active}" data-persona-id="${c.persona_id}" onclick="PawzoChat.openChat('${c.persona_id}')">
      <div class="conv-avatar-wrap">${avatarHtml(pname, "", avUrl)}${unreadBadge}</div>
      <div class="conv-info">
        <div class="conv-name">${esc(pname)} ${wechatBadge}</div>
        <div class="conv-preview">${esc(preview)}</div>
      </div>
      <div class="conv-meta"><div class="conv-time">${time}</div></div>
    </div>`;
  }).join("");

  // Single write: session rows + unread badges from the same state snapshot.
  target.innerHTML = `<div class="page" id="conv-list-page" style="position:relative">${searchHtml}<div class="card" id="conv-list-items">${listHtml}</div>
    <div class="about-footer" aria-hidden="true" style="position:absolute;right:8px;bottom:4px;font-size:11px;line-height:1;color:var(--text-3);opacity:0.1;white-space:nowrap;pointer-events:none;user-select:none">i*w*y*x*d*x*l</div>
  </div>`;
  updateChatTabUnread(state.conversations);
}

async function renderChatList() {
  const desktop = isDesktop();
  const target = desktop ? sidebar() : content();
  const actionBtn = `<button class="top-btn" onclick="PawzoChat.newConversation()">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
  </button>`;

  if (desktop) setSidebarBar("聊天", actionBtn);
  else setTopBar("聊天", false, actionBtn);

  // Keep the last painted list (and its badges) until fresh data arrives.
  // Wiping to a spinner was the main avatar-badge flash on SSE refresh.
  const hasListDom = !!(target.querySelector("#conv-list-page") || target.querySelector(".conv-item"));
  if (!hasListDom) {
    target.innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  }

  const gen = ++_conversationsFetchGen;
  try {
    const [res, pres] = await Promise.all([
      api.get("/api/conversations"),
      api.get("/api/personas"),
    ]);
    if (gen !== _conversationsFetchGen) return;
    state.conversations = mergeConversationsPreserveUnread(
      state.conversations,
      res.conversations || [],
    );
    state.personas = pres.personas || [];
  } catch (e) {
    if (gen !== _conversationsFetchGen) return;
    if (!hasListDom) toast("加载失败", "error");
    return;
  }

  if (gen !== _conversationsFetchGen) return;
  _paintChatList(target, desktop);
}

export { renderChatList };

export function filterConvs(val) {
  const items = document.querySelectorAll(".conv-item");
  const v = val.toLowerCase();
  items.forEach(el => {
    const name = el.querySelector(".conv-name").textContent.toLowerCase();
    el.style.display = name.includes(v) ? "" : "none";
  });
}

export async function newConversation() {
  try {
    const pres = await api.get("/api/personas");
    state.personas = pres.personas || [];
  } catch (e) { toast("加载失败", "error"); return; }

  const convSet = new Set(state.conversations.map(c => c.persona_id));
  const items = state.personas.map(p => {
    const hasConv = convSet.has(p.id);
    const sub = hasConv ? "进入对话 →" : `${p.llm_provider}`;
    const avUrl = personaAvatarUrl(p);
    return `<div class="sheet-item" onclick="PawzoChat.startChat('${p.id}', ${hasConv})">
      ${avatarHtml(p.name, "sm", avUrl)}
      <div style="flex:1"><div style="font-weight:500">${esc(p.name)}</div><div style="font-size:12px;color:var(--text-3)">${esc(sub)}</div></div>
    </div>`;
  }).join("");

  showSheet(`<div class="sheet-title">选择聊天角色</div>${items}<div class="sheet-cancel" onclick="PawzoChat.closeOverlay()">取消</div>`);
}

export async function startChat(personaId, hasConv) {
  closeOverlay();
  if (!hasConv) {
    showLoading("创建中…");
    try {
      const res = await api.post("/api/conversations", { persona_id: personaId });
      if (res.status >= 400) {
        toast(res.data?.error || "创建失败", "error");
        return;
      }
    } catch (e) {
      toast("创建失败", "error");
      return;
    } finally {
      hideLoading();
    }
  }
  openChat(personaId);
}

export function isViewingChat(personaId = chatPersonaId) {
  if (!personaId || document.visibilityState !== "visible") return false;
  const topPage = state.pageStack[state.pageStack.length - 1];
  return chatPersonaId === personaId && topPage?.name === "chatWindow";
}

export async function markConversationRead(personaId = chatPersonaId) {
  if (!isViewingChat(personaId)) return;
  markConversationReadLocal(state.conversations, personaId);
  updateConversationUnread(state.conversations);
  updateChatTabUnread(state.conversations);
  try {
    await api.post(`/api/conversations/${encodeURIComponent(personaId)}/read`, {});
  } catch (e) { /* the next list refresh restores server truth */ }
}

export async function openChat(personaId) {
  state.pageStack = [];
  pushPage("chatWindow", { personaId });
  markConversationRead(personaId);

  if (isDesktop()) {
    document.querySelectorAll("#sidebar-body .conv-item").forEach(el => {
      el.classList.toggle("active", el.dataset.personaId === personaId);
    });
  }
}

function renderContentBlocks(content, renderLinkedImages = false) {
  const blocks = Array.isArray(content) ? content : [];
  const emojiBlocks = blocks.filter(b => b.type === "emoji");
  if (emojiBlocks.length > 0) {
    const base = window.PAWZOCHAT_BASE || "";
    return emojiBlocks
      .map(b => `<div class="msg-emoji"><img src="${esc(base + b.url)}" alt="emoji" data-message-media onclick="PawzoChat.openImagePreview(this.src)"></div>`)
      .join("");
  }
  const base = window.PAWZOCHAT_BASE || "";
  let parts = "";
  for (const b of blocks) {
    if (b.type === "image") {
      let src = "";
      if (b.url) {
        src = /^https?:\/\//i.test(b.url) ? b.url : base + b.url;
      } else if (b.path) {
        const filename = b.path.split(/[\\/]/).pop();
        src = base + "/api/images/" + chatPersonaId + "/" + filename;
      }
      if (src) {
        const safeSrc = escAttr(src);
        parts += `<div class="msg-image linked-image">
          <img src="${safeSrc}" alt="image" loading="lazy" data-message-media
            onclick="PawzoChat.openImagePreview(this.src)"
            onerror="this.hidden=true;this.nextElementSibling.hidden=false">
          <a class="linked-image-fallback" href="${safeSrc}" target="_blank" rel="noopener noreferrer" hidden>图片加载失败，打开原链接</a>
        </div>`;
      }
    } else if (b.type === "file") {
      const diskName = (b.path || "").split(/[\\/]/).pop() || "";
      const displayName = b.name || diskName || "文件";
      const href = diskName ? base + "/api/files/" + chatPersonaId + "/" + diskName : "#";
      parts += `<a class="msg-file" href="${esc(href)}" download="${esc(displayName)}" title="${esc(displayName)}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span class="msg-file-name">${esc(displayName)}</span>
        <svg class="msg-file-dl" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </a>`;
    } else if (b.type === "voice") {
      const fname = (b.path || "").split(/[\\/]/).pop() || "";
      const src = fname ? base + "/api/audio/" + chatPersonaId + "/" + fname : "";
      if (src) {
        const secs = Math.max(1, Math.round((b.duration_ms || 0) / 1000));
        const voiceKey = `${chatPersonaId || ""}/${fname}`;
        const transcript = b.text || "";
        const expanded = _expandedVoiceTranscripts.has(voiceKey);
        // WeChat-style: the longer the duration, the wider the bubble (fixed
        // pixel width — the parent container is a shrink-to-fit flex item, so
        // a percentage width would collapse to the minimum content width)
        const width = Math.min(220, 84 + secs * 6);
        parts += `<div class="msg-voice-wrap" data-voice-key="${escAttr(voiceKey)}">
          <div class="msg-voice" style="width:${width}px" data-src="${escAttr(src)}" data-transcript="${escAttr(transcript)}" onclick="PawzoChat.playVoiceMessage(this)">
            <svg class="msg-voice-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path class="v1" d="M8.5 9.5a4 4 0 010 5"/><path class="v2" d="M11.5 7a8 8 0 010 10"/><path class="v3" d="M14.5 4.5a12.5 12.5 0 010 15"/></svg>
            <span class="msg-voice-dur">${secs}″</span>
          </div>
          <div class="msg-voice-transcript"${expanded ? "" : " hidden"}>${esc(transcript)}</div>
        </div>`;
      }
    } else if (b.type === "text" && b.text) {
      parts += renderLinkedImages
        ? renderTextMedia(b.text, { textClass: "msg-bubble", imageClass: "msg-image" })
        : `<div class="msg-bubble">${esc(b.text)}</div>`;
    }
  }
  if (!parts) {
    const text = blocks.map(c => c.text || "").join("");
    return `<div class="msg-bubble">${esc(text)}</div>`;
  }
  return parts;
}

// ---- Voice bubble playback (singleton Audio; playing a new one auto-stops the previous) ----
let _voiceAudio = null;
let _voiceEl = null;

export function playVoiceMessage(el) {
  if (el === _suppressedVoiceEl) {
    _suppressedVoiceEl = null;
    return;
  }
  const src = el?.dataset?.src;
  if (!src) return;
  if (_voiceEl === el && _voiceAudio && !_voiceAudio.paused) {
    // Clicking the same one again = stop
    _voiceAudio.pause();
    el.classList.remove("playing");
    _voiceEl = null;
    return;
  }
  if (_voiceEl) _voiceEl.classList.remove("playing");
  if (!_voiceAudio) _voiceAudio = new Audio();
  _voiceAudio.onended = _voiceAudio.onerror = () => {
    if (_voiceEl) _voiceEl.classList.remove("playing");
    _voiceEl = null;
  };
  _voiceAudio.src = src;
  _voiceEl = el;
  el.classList.add("playing");
  _voiceAudio.play().catch(() => {
    el.classList.remove("playing");
    if (_voiceEl === el) _voiceEl = null;
  });
}

function _isNearBottom(el) {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
}

function _bindChatScroll(el) {
  if (_chatScrollState.alignFrame) {
    cancelAnimationFrame(_chatScrollState.alignFrame);
    _chatScrollState.alignFrame = 0;
  }
  _chatScrollState.el = el;
  _chatScrollState.followBottom = true;
  _chatScrollState.suppressScroll = false;
  _chatScrollState.mediaEpoch += 1;
  el.addEventListener("scroll", () => {
    if (_chatScrollState.el !== el || _chatScrollState.suppressScroll) return;
    _chatScrollState.followBottom = _isNearBottom(el);
  }, { passive: true });
}

function _alignChatBottom(el) {
  if (_chatScrollState.el !== el || !_chatScrollState.followBottom) return;
  el.scrollTop = el.scrollHeight;
}

function _scheduleChatBottom(el) {
  if (_chatScrollState.el !== el || !_chatScrollState.followBottom || _chatScrollState.alignFrame) return;
  _chatScrollState.alignFrame = requestAnimationFrame(() => {
    _chatScrollState.alignFrame = 0;
    _alignChatBottom(el);
  });
}

// Message renderers mark layout-affecting images with data-message-media. The
// chat layer owns the follow decision: each image gets bounded one-shot
// listeners, while cached images are settled on the next frame as well.
function _watchMessageMedia(root, el, epoch = _chatScrollState.mediaEpoch) {
  for (const img of root.querySelectorAll("img[data-message-media]")) {
    const settled = () => {
      if (_chatScrollState.el === el && _chatScrollState.mediaEpoch === epoch) {
        _scheduleChatBottom(el);
      }
    };
    if (img.complete) {
      requestAnimationFrame(settled);
    } else {
      img.addEventListener("load", settled, { once: true });
      img.addEventListener("error", settled, { once: true });
    }
  }
}

function _scrollAfterInsert(el, insertedRoot = el.lastElementChild) {
  _alignChatBottom(el);
  requestAnimationFrame(() => _scheduleChatBottom(el));
  if (insertedRoot) _watchMessageMedia(insertedRoot, el);
}

function _syncMobileViewport() {
  if (_viewportSyncFrame) cancelAnimationFrame(_viewportSyncFrame);
  _viewportSyncFrame = requestAnimationFrame(() => {
    _viewportSyncFrame = 0;
    if (isDesktop()) {
      document.documentElement.style.removeProperty("--app-viewport-height");
      return;
    }

    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    document.documentElement.style.setProperty(
      "--app-viewport-height",
      `${Math.round(viewportHeight)}px`,
    );

    if (_pinBottomForKeyboard && document.activeElement === $("chat-input")) {
      const msgsEl = $("chat-msgs");
      if (msgsEl) _scrollAfterInsert(msgsEl);
    }
  });
}

function _setupMobileChatViewport(chatInput) {
  if (!_mobileViewportReady) {
    _mobileViewportReady = true;
    window.addEventListener("resize", _syncMobileViewport, { passive: true });
    window.visualViewport?.addEventListener("resize", _syncMobileViewport, { passive: true });
    window.visualViewport?.addEventListener("scroll", _syncMobileViewport, { passive: true });
  }

  chatInput.addEventListener("focus", () => {
    if (isDesktop()) return;
    if (_keyboardBlurTimer) clearTimeout(_keyboardBlurTimer);
    _pinBottomForKeyboard = true;
    _syncMobileViewport();
    const msgsEl = $("chat-msgs");
    if (msgsEl) _scrollAfterInsert(msgsEl);
  });

  chatInput.addEventListener("blur", () => {
    if (_keyboardBlurTimer) clearTimeout(_keyboardBlurTimer);
    _keyboardBlurTimer = window.setTimeout(() => {
      _pinBottomForKeyboard = false;
      _syncMobileViewport();
    }, 200);
  });

  _syncMobileViewport();
}

/* ---- Quoted-message bubble + long-press quote ---- */

// WeChat-style gray quote box rendered below a message that quotes another.
function renderQuoteBox(quote) {
  if (!quote) return "";
  return `<div class="msg-quote">${esc(quote)}</div>`;
}

// Extract the quotable text of a rendered message row from the DOM. Reading
// textContent (rather than a data-attribute) sidesteps attribute-escaping and
// always yields the original text; the ``.msg-quote`` box is excluded so
// quoting a reply quotes its own text, not what it already quoted.
function _quoteTextFromRow(row) {
  const bubbles = row.querySelectorAll(".msg-bubble");
  if (bubbles.length) {
    return Array.from(bubbles).map(b => b.textContent).join("\n").trim();
  }
  if (row.querySelector(".msg-emoji")) return "[表情]";
  if (row.querySelector(".msg-image")) return "[图片]";
  if (row.querySelector(".msg-file, .msg-file-inline")) return "[文件]";
  const voice = row.querySelector(".msg-voice");
  if (voice) {
    const transcript = (voice.dataset.transcript || "").trim();
    return transcript ? `[语音] ${transcript}` : "[语音]";
  }
  return "";
}

function _voiceFromTarget(target) {
  const direct = target?.closest?.(".msg-voice");
  if (direct) return direct;
  return target?.closest?.(".msg-voice-wrap")?.querySelector(".msg-voice") || null;
}

function _quoteTextFromVoice(voiceEl) {
  const transcript = (voiceEl?.dataset?.transcript || "").trim();
  return transcript ? `[语音] ${transcript}` : "[语音]";
}

function _closeQuotePop() {
  if (_quotePop.el) {
    try { _quotePop.el.remove(); } catch (e) { /* ignore */ }
  }
  if (_quotePop.outsideHandler) {
    document.removeEventListener("click", _quotePop.outsideHandler, true);
  }
  if (_quotePop.keyHandler) {
    document.removeEventListener("keydown", _quotePop.keyHandler);
  }
  _quotePop.el = null;
  _quotePop.quoteText = "";
  _quotePop.voiceEl = null;
  _quotePop.outsideHandler = null;
  _quotePop.keyHandler = null;
  _ignoreNextDocClick = false;
}

// armIgnore: swallow the one trailing click a long-press *release* generates so
// the popup is not closed immediately. A right-click/contextmenu produces no
// such click, so it must NOT arm the flag (else the first dismiss click is
// wrongly eaten — and the popup needs two clicks to close).
function _openQuotePop(row, armIgnore, voiceEl = null) {
  _closeQuotePop();
  const quoteText = voiceEl ? _quoteTextFromVoice(voiceEl) : _quoteTextFromRow(row);
  if (!quoteText) return;

  const isUser = row.classList.contains("user");
  const anchor = voiceEl || row.querySelector(
    ".msg-bubble, .msg-image, .msg-emoji, .msg-file, .msg-file-inline, .msg-voice",
  ) || row;
  const rect = anchor.getBoundingClientRect();

  const el = document.createElement("div");
  el.className = "moments-actions-pop";
  el.addEventListener("click", e => e.stopPropagation());
  let buttons = "";
  if (quoteText) {
    buttons += `<button class="map-btn" onclick="PawzoChat.quoteMessage()">${iconHtml("ri-chat-quote-line")}<span>引用</span></button>`;
  }
  if (voiceEl) {
    const transcriptEl = voiceEl.closest(".msg-voice-wrap")?.querySelector(".msg-voice-transcript");
    if (transcriptEl && !transcriptEl.hidden) {
      buttons += `<button class="map-btn" onclick="PawzoChat.toggleVoiceTranscript()">${iconHtml("ri-eye-close-line")}<span>收起文字</span></button>`;
    } else {
      buttons += `<button class="map-btn" onclick="PawzoChat.toggleVoiceTranscript()">${iconHtml("ri-file-text-line")}<span>转文字</span></button>`;
    }
  }
  el.innerHTML = buttons;
  document.body.appendChild(el);
  el.style.visibility = "hidden";
  requestAnimationFrame(() => {
    placeActionsPop(el, rect, /* preferLeft */ isUser);
    el.style.visibility = "";
  });

  _quotePop.el = el;
  _quotePop.quoteText = quoteText;
  _quotePop.voiceEl = voiceEl;
  _ignoreNextDocClick = !!armIgnore;
  _quotePop.outsideHandler = (e) => {
    if (_ignoreNextDocClick) { _ignoreNextDocClick = false; return; }
    if (_quotePop.el && !_quotePop.el.contains(e.target)) _closeQuotePop();
  };
  _quotePop.keyHandler = (e) => { if (e.key === "Escape") _closeQuotePop(); };
  setTimeout(() => {
    document.addEventListener("click", _quotePop.outsideHandler, true);
    document.addEventListener("keydown", _quotePop.keyHandler);
  }, 0);
}

function _cancelLongPress() {
  if (_lpTimer !== null) { clearTimeout(_lpTimer); _lpTimer = null; }
}

function _onMsgPointerDown(e) {
  if (e.button !== 0) return;  // primary button / touch only; right-click uses contextmenu
  if (e.target.closest(".avatar")) return;  // avatars navigate; never arm the quote popup
  const row = e.target.closest(".msg-row");
  if (!row) return;
  _suppressedVoiceEl = null;
  _lpStartX = e.clientX;
  _lpStartY = e.clientY;
  _cancelLongPress();
  _lpTimer = setTimeout(() => {
    _lpTimer = null;
    const voiceEl = _voiceFromTarget(e.target);
    if (voiceEl) _suppressedVoiceEl = voiceEl;
    _openQuotePop(row, /* armIgnore */ true, voiceEl);
  }, 500);
}

function _onMsgPointerMove(e) {
  if (_lpTimer === null) return;
  if (Math.abs(e.clientX - _lpStartX) > 10 || Math.abs(e.clientY - _lpStartY) > 10) {
    _cancelLongPress();
  }
}

function _onMsgContextMenu(e) {
  if (e.target.closest(".avatar")) return;  // avatars navigate; never arm the quote popup
  const row = e.target.closest(".msg-row");
  if (!row) return;
  const voiceEl = _voiceFromTarget(e.target);
  e.preventDefault();
  _cancelLongPress();  // don't let a pending long-press timer re-open over this
  if (_quotePop.el) return;  // a touch long-press may also fire contextmenu — don't reopen
  _openQuotePop(row, /* armIgnore */ false, voiceEl);
}

// Tapping an avatar in the message stream opens its owner's page: the persona
// detail for the assistant, the user's own profile for the self side.
function _onMsgAvatarClick(e) {
  const av = e.target.closest(".avatar");
  if (!av) return;
  const row = av.closest(".msg-row");
  if (!row) return;
  if (row.classList.contains("assistant")) {
    pushPage("personaDetail", { personaId: chatPersonaId });
  } else {
    pushPage("profileEdit");
  }
}

function _setupLongPress(msgsEl) {
  if (!msgsEl) return;
  msgsEl.addEventListener("pointerdown", _onMsgPointerDown);
  msgsEl.addEventListener("pointermove", _onMsgPointerMove);
  msgsEl.addEventListener("pointerup", _cancelLongPress);
  msgsEl.addEventListener("pointercancel", _cancelLongPress);
  msgsEl.addEventListener("contextmenu", _onMsgContextMenu);
  msgsEl.addEventListener("click", _onMsgAvatarClick);
  msgsEl.addEventListener("scroll", () => { _cancelLongPress(); _closeQuotePop(); }, { passive: true });
}

function _renderQuotePreview() {
  const bar = $("quote-preview-bar");
  if (!bar) return;
  if (!_pendingQuote) { bar.style.display = "none"; bar.innerHTML = ""; return; }
  bar.style.display = "flex";
  bar.innerHTML = `<div class="quote-preview-text">${esc(_pendingQuote)}</div>
    <button class="quote-preview-remove" onclick="PawzoChat.clearPendingQuote()" title="取消引用">&times;</button>`;
}

// Invoked by the popup's "引用" button — arm the pending quote for the next send.
export function quoteMessage() {
  const q = _quotePop.quoteText || "";
  _closeQuotePop();
  if (!q) return;
  _pendingQuote = q;
  _renderQuotePreview();
  const inp = $("chat-input");
  if (inp) inp.focus();
}

export function toggleVoiceTranscript() {
  const voiceEl = _quotePop.voiceEl;
  const wrap = voiceEl?.closest(".msg-voice-wrap");
  const transcriptEl = wrap?.querySelector(".msg-voice-transcript");
  if (!wrap || !transcriptEl) {
    _closeQuotePop();
    return;
  }
  const visible = transcriptEl.hidden;
  const key = wrap.dataset.voiceKey || "";
  transcriptEl.hidden = !visible;
  if (key) {
    if (visible) _expandedVoiceTranscripts.add(key);
    else _expandedVoiceTranscripts.delete(key);
  }
  _closeQuotePop();
}

export function clearPendingQuote() {
  _pendingQuote = "";
  _renderQuotePreview();
}

/* ---- Chat Window ---- */

async function renderChatWindow(data) {
  chatPersonaId = data.personaId;
  const renderedPersonaId = chatPersonaId;
  const messagesUrl = `/api/conversations/${renderedPersonaId}/messages?rounds=10`;
  const cachedMessages = api.peek(messagesUrl);
  const pname = state.personas.find(p => p.id === chatPersonaId)?.name || chatPersonaId;

  setTopBar(pname, true,
    `<button class="top-btn" onclick="PawzoChat.chatMore()">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
    </button>`
  );

  _pendingImages = [];
  _pendingFiles = [];
  _pendingQuote = "";
  _closeQuotePop();  // never let a popup (in document.body) outlive the chat that spawned it
  content().innerHTML = `<div class="chat-container">
    <div class="chat-messages" id="chat-msgs">${cachedMessages ? "" : `<div class="loading-center"><div class="spinner"></div></div>`}</div>
    <div id="img-preview-bar" class="img-preview-bar" style="display:none"></div>
    <div id="file-preview-bar" class="file-preview-bar" style="display:none"></div>
    <div id="quote-preview-bar" class="quote-preview-bar" style="display:none"></div>
    <div id="emoji-picker-panel" class="emoji-picker-panel" style="display:none"></div>
    <div id="plus-menu-panel" class="plus-menu-panel" style="display:none"></div>
    <div class="chat-input-bar">
      <button class="img-upload-btn" id="emoji-picker-btn" onclick="PawzoChat.toggleEmojiPicker()" title="表情">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
      </button>
      <button class="img-upload-btn" id="plus-menu-btn" onclick="PawzoChat.togglePlusMenu()" title="更多">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="7" x2="12" y2="17"/><line x1="7" y1="12" x2="17" y2="12"/></svg>
      </button>
      <textarea class="chat-input" id="chat-input" rows="1" placeholder="输入消息…" oninput="PawzoChat.onChatInput()" onkeydown="PawzoChat.onChatKey(event)"></textarea>
      <button class="send-btn" id="send-btn" onclick="PawzoChat.sendChat()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
    </div>
    <input type="file" id="img-file-input" accept="image/*" multiple style="display:none" onchange="PawzoChat.onImageSelected(this)">
    <input type="file" id="file-file-input" multiple style="display:none" onchange="PawzoChat.onFileSelected(this)">
  </div>`;

  content().style.overflow = "hidden";

  const messagesEl = $("chat-msgs");
  if (messagesEl) _bindChatScroll(messagesEl);

  const chatInput = $("chat-input");
  if (chatInput) {
    _setupMobileChatViewport(chatInput);
    chatInput.addEventListener("paste", (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) _addPendingImage(file);
        }
      }
    });
  }

  const chatContainer = content().querySelector(".chat-container");
  if (chatContainer) {
    chatContainer.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); });
    chatContainer.addEventListener("drop", e => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer?.files) {
        for (const f of e.dataTransfer.files) {
          if (f.type.startsWith("image/")) _addPendingImage(f);
          else _addPendingFile(f);
        }
      }
    });
  }

  document.addEventListener("click", _onDocumentClickForPicker);
  _setupLongPress($("chat-msgs"));

  const emojiPanel = $("emoji-picker-panel");
  if (emojiPanel) {
    emojiPanel.addEventListener("click", e => e.stopPropagation());
  }

  _emojiPickerOpen = false;
  _emojiGroups = null;
  _emojiGroupCache = {};
  _emojiActiveTab = 0;
  _plusMenuOpen = false;

  if (cachedMessages) renderMessages(cachedMessages.messages || []);

  try {
    const res = await api.get(messagesUrl, {
      onUpdate: fresh => {
        if (_isActiveChatWindow(renderedPersonaId)) {
          renderMessages(fresh.messages || []);
        }
      },
    });
    if (!cachedMessages && _isActiveChatWindow(renderedPersonaId)) {
      renderMessages(res.messages || []);
    }
  } catch (e) {
    if (!cachedMessages) toast("加载消息失败", "error");
  }

  if (_isActiveChatWindow(renderedPersonaId) && state.processingPersonas.has(renderedPersonaId)) {
    showTypingIndicator();
  }
}

function renderMessages(messages) {
  const el = $("chat-msgs");
  if (!el) return;
  _closeQuotePop();  // a full in-place re-render (e.g. SSE refresh) detaches the popup anchor

  const followBottom = _chatScrollState.el !== el || _chatScrollState.followBottom;
  const previousScrollTop = el.scrollTop;
  const mediaEpoch = ++_chatScrollState.mediaEpoch;
  _chatScrollState.suppressScroll = true;

  if (messages.length === 0) {
    el.innerHTML = `<div class="empty-state" style="padding:40px"><div class="empty-text">开始对话吧</div></div>`;
    requestAnimationFrame(() => {
      if (_chatScrollState.el === el && _chatScrollState.mediaEpoch === mediaEpoch) {
        _chatScrollState.suppressScroll = false;
      }
    });
    return;
  }

  const _persona = state.personas.find(p => p.id === chatPersonaId);
  const _pname = _persona?.name || chatPersonaId;
  const _avUrl = personaAvatarUrl(_persona);

  const _userName = state.profile?.name || "我";
  const _userAvUrl = profileAvatarUrl(state.profile);

  let html = "";
  let lastTime = 0;
  for (const m of messages) {
    const mt = new Date(m.timestamp).getTime();
    if (mt - lastTime > 300000) {
      html += `<div class="msg-time">${formatMsgTime(m.timestamp)}</div>`;
    }
    lastTime = mt;

    const role = m.role;
    const av = role === "assistant"
      ? avatarHtml(_pname, "sm", _avUrl)
      : avatarHtml(_userName, "sm", _userAvUrl);
    const source = sourceBadge(m.source);
    const bubbleHtml = renderContentBlocks(m.content, role === "assistant");

    html += `<div class="msg-row ${role}">
      ${av}
      <div>
        ${bubbleHtml}
        ${renderQuoteBox(m.quote)}
        ${source}
      </div>
    </div>`;
  }
  el.innerHTML = html;
  requestAnimationFrame(() => {
    if (_chatScrollState.el !== el || _chatScrollState.mediaEpoch !== mediaEpoch) return;
    _chatScrollState.followBottom = followBottom;
    _chatScrollState.suppressScroll = false;
    if (followBottom) {
      _alignChatBottom(el);
    } else {
      el.scrollTop = previousScrollTop;
    }
    _watchMessageMedia(el, el, mediaEpoch);
  });
}

export function onChatInput() {
  const inp = $("chat-input");
  const btn = $("send-btn");
  inp.style.height = "auto";
  inp.style.height = Math.min(inp.scrollHeight, 100) + "px";
  btn.classList.toggle("active", inp.value.trim().length > 0 || _pendingImages.length > 0 || _pendingFiles.length > 0);
  if (_pinBottomForKeyboard && document.activeElement === inp) {
    const msgsEl = $("chat-msgs");
    if (msgsEl) requestAnimationFrame(() => _scrollAfterInsert(msgsEl));
  }
}

export function onChatKey(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
}

export function pickImage() {
  const input = $("img-file-input");
  if (input) input.click();
}

export function onImageSelected(input) {
  if (!input.files) return;
  for (const f of input.files) {
    if (f.type.startsWith("image/")) _addPendingImage(f);
  }
  input.value = "";
}

function _addPendingImage(file) {
  const url = URL.createObjectURL(file);
  _pendingImages.push({ file, url });
  _renderImagePreviews();
  onChatInput();
}

export function removePendingImage(idx) {
  const removed = _pendingImages.splice(idx, 1);
  if (removed[0]) URL.revokeObjectURL(removed[0].url);
  _renderImagePreviews();
  onChatInput();
}

function _renderImagePreviews() {
  const bar = $("img-preview-bar");
  if (!bar) return;
  if (_pendingImages.length === 0) { bar.style.display = "none"; bar.innerHTML = ""; return; }
  bar.style.display = "flex";
  bar.innerHTML = _pendingImages.map((img, i) =>
    `<div class="img-preview-thumb">
      <img src="${img.url}" alt="preview">
      <button class="img-preview-remove" onclick="PawzoChat.removePendingImage(${i})">&times;</button>
    </div>`
  ).join("");
}

export function pickFile() {
  const input = $("file-file-input");
  if (input) input.click();
}

export function onFileSelected(input) {
  if (!input.files) return;
  for (const f of input.files) {
    if (f.type.startsWith("image/")) _addPendingImage(f);
    else _addPendingFile(f);
  }
  input.value = "";
}

function _addPendingFile(file) {
  _pendingFiles.push({ file, name: file.name });
  _renderFilePreviews();
  onChatInput();
}

export function removePendingFile(idx) {
  _pendingFiles.splice(idx, 1);
  _renderFilePreviews();
  onChatInput();
}

function _renderFilePreviews() {
  const bar = $("file-preview-bar");
  if (!bar) return;
  if (_pendingFiles.length === 0) { bar.style.display = "none"; bar.innerHTML = ""; return; }
  bar.style.display = "flex";
  bar.innerHTML = _pendingFiles.map((f, i) =>
    `<div class="file-preview-chip">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span class="file-preview-name">${esc(f.name)}</span>
      <button class="file-preview-remove" onclick="PawzoChat.removePendingFile(${i})">&times;</button>
    </div>`
  ).join("");
}

export async function sendChat() {
  const inp = $("chat-input");
  const text = inp.value.trim();
  const hasImages = _pendingImages.length > 0;
  const hasFiles = _pendingFiles.length > 0;
  if (!text && !hasImages && !hasFiles) return;

  inp.value = "";
  onChatInput();

  const msgsEl = $("chat-msgs");
  const emptyState = msgsEl.querySelector(".empty-state");
  if (emptyState) emptyState.remove();

  const _uName = state.profile?.name || "我";
  const _uAvUrl = profileAvatarUrl(state.profile);

  let userBubble = "";
  if (text) userBubble += `<div class="msg-bubble">${esc(text)}</div>`;
  for (const img of _pendingImages) {
    userBubble += `<div class="msg-image"><img src="${img.url}" alt="image"></div>`;
  }
  for (const f of _pendingFiles) {
    userBubble += `<div class="msg-file-inline">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span>${esc(f.name)}</span>
    </div>`;
  }
  const quoteToSend = _pendingQuote;
  msgsEl.insertAdjacentHTML("beforeend", `<div class="msg-row user">${avatarHtml(_uName, "sm", _uAvUrl)}<div>${userBubble}${renderQuoteBox(quoteToSend)}</div></div>`);
  _scrollAfterInsert(msgsEl);

  const imagesToSend = [..._pendingImages];
  const filesToSend = [..._pendingFiles];
  _pendingImages = [];
  _pendingFiles = [];
  _pendingQuote = "";
  _renderImagePreviews();
  _renderFilePreviews();
  _renderQuotePreview();

  try {
    if (imagesToSend.length > 0 || filesToSend.length > 0) {
      const fd = new FormData();
      fd.append("text", text);
      if (quoteToSend) fd.append("quote", quoteToSend);
      for (const img of imagesToSend) fd.append("images", img.file);
      for (const f of filesToSend) fd.append("files", f.file);
      const base = window.PAWZOCHAT_BASE || "";
      const resp = await fetch(`${base}/api/conversations/${chatPersonaId}/messages`, {
        method: "POST",
        body: fd,
      });
      const res = await resp.json();
      if (resp.status >= 400) toast(res.error || "发送失败", "error");
    } else {
      const body = quoteToSend ? { text, quote: quoteToSend } : { text };
      const res = await api.post(`/api/conversations/${chatPersonaId}/messages`, body);
      if (res.status >= 400) toast(res.data.error || "发送失败", "error");
    }
  } catch (e) {
    toast("网络错误", "error");
  }

  for (const img of imagesToSend) URL.revokeObjectURL(img.url);
}

function _isActiveChatWindow(personaId = chatPersonaId) {
  const topPage = state.pageStack[state.pageStack.length - 1];
  return topPage?.name === "chatWindow"
    && topPage.data?.personaId === personaId
    && !!$("chat-msgs");
}

export function showTypingIndicator() {
  if (!state.settings?.reply?.show_typing_indicator || !_isActiveChatWindow()) return;
  const el = $("top-bar-title");
  if (el) el.textContent = "对方正在输入…";
}

function hideTypingIndicator() {
  if (!_isActiveChatWindow()) return;
  const pname = state.personas.find(p => p.id === chatPersonaId)?.name || chatPersonaId;
  const el = $("top-bar-title");
  if (el) el.textContent = pname;
}

export function appendAssistantMessage(message, isLast) {
  const msgsEl = $("chat-msgs");
  if (!msgsEl) return;

  const wasAtBottom = _chatScrollState.el === msgsEl
    ? _chatScrollState.followBottom
    : _isNearBottom(msgsEl);

  const persona = state.personas.find(p => p.id === chatPersonaId);
  const pname = persona?.name || chatPersonaId;
  const avUrl = personaAvatarUrl(persona);
  const source = sourceBadge(message.source);
  const bubbleHtml = renderContentBlocks(message.content, true);

  msgsEl.insertAdjacentHTML("beforeend", `<div class="msg-row assistant">
    ${avatarHtml(pname, "sm", avUrl)}
    <div>
      ${bubbleHtml}
      ${renderQuoteBox(message.quote)}
      ${source}
    </div>
  </div>`);

  if (isLast) {
    hideTypingIndicator();
  } else {
    showTypingIndicator();
  }

  if (wasAtBottom) _scrollAfterInsert(msgsEl);
}

/* ---- Emoji Picker ---- */

function _onDocumentClickForPicker(e) {
  if (!_emojiPickerOpen && !_plusMenuOpen) return;
  const emojiPanel = $("emoji-picker-panel");
  const emojiBtn = $("emoji-picker-btn");
  const plusPanel = $("plus-menu-panel");
  const plusBtn = $("plus-menu-btn");
  const hitEmoji = (emojiPanel && emojiPanel.contains(e.target)) || (emojiBtn && emojiBtn.contains(e.target));
  const hitPlus = (plusPanel && plusPanel.contains(e.target)) || (plusBtn && plusBtn.contains(e.target));
  if (!hitEmoji && !hitPlus) {
    _closeEmojiPicker();
    _closePlusMenu();
  }
}

function _closeEmojiPicker() {
  _emojiPickerOpen = false;
  const panel = $("emoji-picker-panel");
  if (panel) panel.style.display = "none";
  const btn = $("emoji-picker-btn");
  if (btn) btn.classList.remove("active");
}

export async function toggleEmojiPicker() {
  // close plus menu if open — only one panel at a time
  if (_plusMenuOpen) _closePlusMenu();

  if (_emojiPickerOpen) {
    _closeEmojiPicker();
    return;
  }
  _emojiPickerOpen = true;
  const btn = $("emoji-picker-btn");
  if (btn) btn.classList.add("active");

  if (!_emojiGroups) {
    try {
      const res = await api.get("/api/emoji/groups");
      _emojiGroups = (res.groups || []).filter(g => g.total_images > 0);
    } catch (e) {
      _emojiGroups = [];
    }
  }

  _emojiActiveTab = 0;
  _renderEmojiPicker();
}

function _renderEmojiPicker() {
  const panel = $("emoji-picker-panel");
  if (!panel) return;
  panel.style.display = "flex";

  const groups = _emojiGroups || [];
  let tabsHtml = `<button class="ep-tab${_emojiActiveTab === 0 ? " active" : ""}" onclick="PawzoChat.switchEmojiTab(0)">Emoji</button>`;
  groups.forEach((g, i) => {
    const idx = i + 1;
    tabsHtml += `<button class="ep-tab${_emojiActiveTab === idx ? " active" : ""}" onclick="PawzoChat.switchEmojiTab(${idx})">${esc(g.name)}</button>`;
  });

  panel.innerHTML = `<div class="ep-tabs">${tabsHtml}</div><div class="ep-content" id="ep-content"></div>`;

  if (_emojiActiveTab === 0) {
    _renderStandardEmojiGrid();
  } else {
    const group = groups[_emojiActiveTab - 1];
    if (group) _renderStickerGrid(group.name);
  }
}

export function switchEmojiTab(idx) {
  _emojiActiveTab = idx;
  _renderEmojiPicker();
}

function _renderStandardEmojiGrid() {
  const el = $("ep-content");
  if (!el) return;
  el.innerHTML = `<div class="emoji-grid">${
    _STANDARD_EMOJIS.map(e => `<button class="emoji-cell" onclick="PawzoChat.insertEmoji('${e}')">${e}</button>`).join("")
  }</div>`;
}

async function _renderStickerGrid(groupName) {
  const el = $("ep-content");
  if (!el) return;

  if (_emojiGroupCache[groupName]) {
    _renderStickerImages(el, _emojiGroupCache[groupName]);
    return;
  }

  el.innerHTML = `<div class="ep-loading"><div class="spinner"></div></div>`;
  try {
    const base = window.PAWZOCHAT_BASE || "";
    const res = await api.get(`/api/emoji/groups/${encodeURIComponent(groupName)}/all-images`);
    const images = res.images || [];
    _emojiGroupCache[groupName] = images;
    if (_emojiActiveTab > 0 && (_emojiGroups || [])[_emojiActiveTab - 1]?.name === groupName) {
      _renderStickerImages(el, images);
    }
  } catch (e) {
    el.innerHTML = `<div class="ep-empty">加载失败</div>`;
  }
}

function _renderStickerImages(el, images) {
  if (images.length === 0) {
    el.innerHTML = `<div class="ep-empty">暂无表情包</div>`;
    return;
  }
  const base = window.PAWZOCHAT_BASE || "";
  el.innerHTML = `<div class="sticker-grid">${
    images.map(img =>
      `<button class="sticker-cell" onclick="PawzoChat.sendSticker('${esc(img.url)}')"><img src="${esc(base + img.url)}" alt="${esc(img.filename)}" loading="lazy"></button>`
    ).join("")
  }</div>`;
}

/* ---- Plus Menu (图片 / 文件) ---- */

function _closePlusMenu() {
  _plusMenuOpen = false;
  const panel = $("plus-menu-panel");
  if (panel) panel.style.display = "none";
  const btn = $("plus-menu-btn");
  if (btn) btn.classList.remove("active");
}

export function togglePlusMenu() {
  // close emoji picker if open — only one panel at a time
  if (_emojiPickerOpen) _closeEmojiPicker();

  if (_plusMenuOpen) { _closePlusMenu(); return; }
  _plusMenuOpen = true;
  const btn = $("plus-menu-btn");
  if (btn) btn.classList.add("active");

  const panel = $("plus-menu-panel");
  if (!panel) return;
  panel.style.display = "flex";
  panel.innerHTML = `
    <button class="plus-menu-item" onclick="PawzoChat.pickImage();PawzoChat.togglePlusMenu()">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
      <span>图片</span>
    </button>
    <button class="plus-menu-item" onclick="PawzoChat.pickFile();PawzoChat.togglePlusMenu()">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span>文件</span>
    </button>`;
}

export function insertEmoji(emoji) {
  const inp = $("chat-input");
  if (!inp) return;
  const start = inp.selectionStart;
  const end = inp.selectionEnd;
  const before = inp.value.substring(0, start);
  const after = inp.value.substring(end);
  inp.value = before + emoji + after;
  const newPos = start + emoji.length;
  inp.selectionStart = newPos;
  inp.selectionEnd = newPos;
  onChatInput();
  _closeEmojiPicker();
  inp.focus();
}

export async function sendSticker(stickerUrl) {
  _closeEmojiPicker();
  if (!chatPersonaId) return;

  const msgsEl = $("chat-msgs");
  if (!msgsEl) return;
  const emptyState = msgsEl.querySelector(".empty-state");
  if (emptyState) emptyState.remove();

  const _base = window.PAWZOCHAT_BASE || "";
  const _uName = state.profile?.name || "我";
  const _uAvUrl = profileAvatarUrl(state.profile);

  const imgSrc = _base + stickerUrl;
  msgsEl.insertAdjacentHTML("beforeend",
    `<div class="msg-row user">${avatarHtml(_uName, "sm", _uAvUrl)}<div><div class="msg-image"><img src="${esc(imgSrc)}" alt="sticker" onclick="PawzoChat.openImagePreview(this.src)"></div></div></div>`
  );
  _scrollAfterInsert(msgsEl);

  try {
    const res = await api.post(`/api/conversations/${chatPersonaId}/messages`, { sticker_url: stickerUrl });
    if (res.status >= 400) toast(res.data?.error || "发送失败", "error");
  } catch (e) {
    toast("网络错误", "error");
  }
}

/* ---- Chat Actions ---- */

export function chatMore() {
  const conv = state.conversations.find(c => c.persona_id === chatPersonaId);
  const linked = conv?.wechat_linked;
  let items = `
    <div class="sheet-item" onclick="PawzoChat.viewPersonaFromChat()">${iconHtml("ri-id-card-line")}<span>查看角色资料</span></div>
    <div class="sheet-item" onclick="PawzoChat.viewMemoryFromChat()">${iconHtml("ri-brain-line")}<span>查看记忆</span></div>
    <div class="sheet-item" onclick="PawzoChat.openHistoryEdit()">${iconHtml("ri-edit-line")}<span>编辑历史消息</span></div>
    <div class="sheet-item" onclick="PawzoChat.clearChat()">${iconHtml("ri-delete-bin-line")}<span>清空聊天记录</span></div>
    <div class="sheet-item danger" onclick="PawzoChat.deleteChat()">${iconHtml("ri-close-line")}<span>删除对话</span></div>
    <div class="sheet-divider"></div>`;

  if (linked) {
    items += `<div class="sheet-item danger" onclick="PawzoChat.unlinkWechat()">${iconHtml("ri-smartphone-line")}<span>断开账号链接</span></div>`;
  } else {
    items += `<div class="sheet-item" onclick="PawzoChat.linkWechat()">${iconHtml("ri-smartphone-line")}<span>链接聊天账号</span></div>`;
  }

  showSheet(`<div class="sheet-title">更多操作</div>${items}<div class="sheet-cancel" onclick="PawzoChat.closeOverlay()">取消</div>`);
}

export async function clearChat() {
  closeOverlay();
  const ok = await confirm("清空聊天记录", "消息将被永久删除，但对话会保留", true);
  if (!ok) return;
  showLoading("操作中…");
  try {
    await api.del(`/api/conversations/${chatPersonaId}/messages`);
    renderMessages([]);
    refreshSidebar();
    toast("已清空", "success");
  } catch (e) { toast("操作失败", "error"); }
  finally { hideLoading(); }
}

export async function deleteChat() {
  closeOverlay();
  const ok = await confirm("删除对话", "确认删除这个对话？", true);
  if (!ok) return;
  showLoading("删除中…");
  try {
    await api.del(`/api/conversations/${chatPersonaId}`);
    toast("已删除", "success");
    goBack();
    refreshSidebar();
  } catch (e) { toast("操作失败", "error"); }
  finally { hideLoading(); }
}

/* ---- Channel account link ---- */

export async function linkWechat() {
  closeOverlay();
  try {
    const [acctRes, linkRes] = await Promise.all([
      api.get("/api/accounts"),
      api.get("/api/wechat-links"),
    ]);
    const accounts = acctRes.accounts || [];
    const links = linkRes.links || [];
    const linkMap = {};
    links.forEach(l => { linkMap[l.account_id] = l; });

    let items = accounts.map(a => {
      const linked = linkMap[a.bot_id];
      const chTag = a.channel_name ? `<span style="color:var(--text-3);font-size:12px;margin-left:4px">[${esc(a.channel_name)}]</span>` : "";
      const idHint = `<span style="color:var(--text-3);font-size:13px;margin-left:4px">(${esc(a.bot_id.substring(0, 10))}…)</span>`;
      const label = (a.note ? `${esc(a.note)} ${idHint}` : `${esc(a.bot_id.substring(0, 12))}…`) + chTag;
      if (linked && linked.persona_id !== chatPersonaId) {
        return `<div class="sheet-item disabled">${iconHtml("ri-smartphone-line")}<span>${label} — 已被「${esc(linked.persona_name)}」占用</span></div>`;
      }
      const statusCls = a.online ? "online" : "offline";
      return `<div class="sheet-item" onclick="PawzoChat.doLinkWechat(${jsArg(a.bot_id)})">${iconHtml("ri-smartphone-line")}<span class="account-status"><span class="presence-dot ${statusCls}"></span>${label}</span></div>`;
    }).join("");

    if (accounts.length === 0) items = `<div class="sheet-item disabled">还没有添加任何账号</div>`;
    showSheet(`<div class="sheet-title">选择聊天账号</div>${items}<div class="sheet-cancel" onclick="PawzoChat.closeOverlay()">取消</div>`);
  } catch (e) { toast("加载失败", "error"); }
}

export async function doLinkWechat(accountId) {
  closeOverlay();
  showLoading("操作中…");
  try {
    const res = await api.post(`/api/conversations/${chatPersonaId}/wechat-link`, { account_id: accountId });
    if (res.status >= 400) { toast(res.data.error, "error"); return; }
    toast("已链接账号", "success");
    const convRes = await api.get("/api/conversations");
    state.conversations = convRes.conversations || [];
  } catch (e) { toast("操作失败", "error"); }
  finally { hideLoading(); }
}

export async function unlinkWechat() {
  closeOverlay();
  const ok = await confirm("断开账号链接", "断开后该账号的消息将不再进入此对话", false);
  if (!ok) return;
  showLoading("操作中…");
  try {
    await api.del(`/api/conversations/${chatPersonaId}/wechat-link`);
    toast("已断开", "success");
    const convRes = await api.get("/api/conversations");
    state.conversations = convRes.conversations || [];
  } catch (e) { toast("操作失败", "error"); }
  finally { hideLoading(); }
}

export function viewPersonaFromChat() {
  closeOverlay();
  pushPage("personaDetail", { personaId: chatPersonaId });
}

export function viewMemoryFromChat() {
  closeOverlay();
  pushPage("memoryManage", { personaId: chatPersonaId });
}

export function openHistoryEdit() {
  closeOverlay();
  pushPage("historyEdit", { personaId: chatPersonaId });
}

/* ---- SSE helper ---- */

export async function refreshUnreadCounts() {
  const gen = ++_conversationsFetchGen;
  try {
    const res = await api.get("/api/conversations", { bypassCache: true });
    if (gen !== _conversationsFetchGen) return;
    state.conversations = mergeConversationsPreserveUnread(
      state.conversations,
      res.conversations || [],
    );
    updateConversationUnread(state.conversations);
    updateChatTabUnread(state.conversations);
  } catch (e) { /* keep the last known counts */ }
}

export async function refreshChatMessages() {
  if (!chatPersonaId) return;
  hideTypingIndicator();
  try {
    const res = await api.get(`/api/conversations/${chatPersonaId}/messages?rounds=10`);
    renderMessages(res.messages || []);
  } catch (e) { /* silent */ }
}

/* ---- Register renderers ---- */

registerTabRenderer("chat", renderChatList);
registerPageRenderer("chatWindow", renderChatWindow);
