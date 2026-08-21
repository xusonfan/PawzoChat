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
import { imageLayoutAttributes } from "./image_layout_cache.js";
import {
  conversationLatestMessageSequence, isConversationReadContext, markConversationReadLocal,
  mergeConversationsPreserveUnread, setConversationUnreadCount,
  unreadBadgeHtml, updateChatTabUnread, updateConversationUnread,
} from "./unread.js";
import { api } from "./api.js";
import { prepareNotificationIcons } from "./notification_feedback.js";
import { state, $, content, sidebar } from "./state.js";
import {
  attachConversationMenu, closeConversationMenu,
} from "./conversation_menu.js";
import { ownsConversationListTarget } from "./conversation_list_ownership.js";
import { toast, confirm, showSheet, closeOverlay, showLoading, hideLoading } from "./ui.js";
import { showErrorBanner } from "./error_banner.js";
import {
  createChatBottomAnchor,
} from "./chat_scroll.js";
import {
  addPendingUserMessage, confirmPendingUserMessage,
  mergePendingUserMessages, projectPendingConversationSummaries,
  removePendingUserMessage,
} from "./chat_pending.js";
import { shouldShowMessageTime } from "./chat_message_time.js";
import { hasRenderedMessage, mergeMessagesBySequence, messageSequence } from "./chat_message_identity.js";
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

function _newReadAuditId() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const _readPageId = _newReadAuditId();
let _readClientId = _readPageId;
try {
  _readClientId = localStorage.getItem("pawzoReadClientId") || _newReadAuditId();
  localStorage.setItem("pawzoReadClientId", _readClientId);
} catch (e) { /* storage may be unavailable in private/embedded contexts */ }

let _mobileViewportReady = false;
let _viewportSyncFrame = 0;
let _pinBottomForKeyboard = false;
let _keyboardBlurTimer = 0;
let _chatInputComposing = false;

const _chatBottomAnchor = createChatBottomAnchor();
const _CHAT_PAGE_ROUNDS = 10;
const _CHAT_HISTORY_TOP_THRESHOLD = 48;
let _chatHistory = {
  personaId: null,
  messages: [],
  hasMore: false,
  loadingOlder: false,
  generation: 0,
};
const _failedReplies = new Set();
const _assistantMessageUpdateTokens = new Map();

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
  regenerateSeq: null,
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
let _cameraStream = null;

const _voiceInput = {
  mode: false,
  recorder: null,
  stream: null,
  chunks: [],
  startedAt: 0,
  pointerId: null,
  stopTimer: null,
  busy: false,
  pressing: false,
  canceled: false,
  cancelOnRelease: false,
  personaId: null,
  mimeType: "",
  generation: 0,
};

const _VOICE_MIN_DURATION_MS = 500;
const _VOICE_MAX_DURATION_MS = 60_000;

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

function _mergeConversationState(incoming) {
  return projectPendingConversationSummaries(
    mergeConversationsPreserveUnread(state.conversations, incoming || []),
  );
}

function _paintChatList(target, desktop) {
  closeConversationMenu();
  if (state.conversations.length === 0) {
    target.innerHTML = `
      <div class="empty-state" style="position:relative">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
        <div class="empty-text">还没有对话</div>
        <button onclick="PawzoChat.newConversation()">发起新对话</button>
        <div class="about-footer" aria-hidden="true" style="position:absolute;right:8px;bottom:4px;font-size:11px;line-height:1;color:var(--text-3);opacity:0.1;white-space:nowrap;pointer-events:none;user-select:none"></div>
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
    const active = (desktop && chatPersonaId === c.persona_id) ? " active" : "";
    const unreadBadge = unreadBadgeHtml(c.unread_count, "conv-unread-badge");
    const pinnedBadge = c.pinned
      ? `<span class="conv-pinned" aria-label="已置顶">${iconHtml("ri-pushpin-fill")}</span>` : "";
    return `<div class="conv-item${active}" data-persona-id="${escAttr(c.persona_id)}" tabindex="0" role="button" aria-haspopup="menu" aria-label="打开与${escAttr(pname)}的对话">
      <div class="conv-avatar-wrap">${avatarHtml(pname, "", avUrl)}${unreadBadge}</div>
      <div class="conv-info">
        <div class="conv-name">${esc(pname)}</div>
        <div class="conv-preview">${esc(preview)}</div>
      </div>
      <div class="conv-meta"><div class="conv-time">${time}</div>${pinnedBadge}</div>
    </div>`;
  }).join("");

  // Single write: session rows + unread badges from the same state snapshot.
  target.innerHTML = `<div class="page" id="conv-list-page" style="position:relative">${searchHtml}<div class="card" id="conv-list-items">${listHtml}</div>
    <div class="about-footer" aria-hidden="true" style="position:absolute;right:8px;bottom:4px;font-size:11px;line-height:1;color:var(--text-3);opacity:0.1;white-space:nowrap;pointer-events:none;user-select:none"></div>
  </div>`;
  attachConversationMenu(target.querySelector("#conv-list-items"), state.conversations, {
    onOpen: openChat,
    onPin: setConversationPinned,
    onHide: hideConversation,
  });
  updateChatTabUnread(state.conversations);
}

function _ownsConversationListTarget(target, desktop) {
  return ownsConversationListTarget({
    target,
    desktop,
    currentDesktop: isDesktop(),
    currentTab: state.currentTab,
    pageDepth: state.pageStack.length,
    contentTarget: content(),
    sidebarTarget: sidebar(),
  });
}

function _paintConversationListIfOwned(target, desktop) {
  if (!_ownsConversationListTarget(target, desktop)) return false;
  _paintChatList(target, desktop);
  return true;
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
    state.conversations = _mergeConversationState(res.conversations);
    if (isViewingChat()) markConversationReadLocal(state.conversations, chatPersonaId);
    state.personas = pres.personas || [];
    void prepareNotificationIcons(state.personas);
  } catch (e) {
    if (gen !== _conversationsFetchGen) return;
    if (!hasListDom) toast("加载失败", "error");
    return;
  }

  if (gen !== _conversationsFetchGen) return;
  _paintConversationListIfOwned(target, desktop);
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

async function _reloadConversationList() {
  const desktop = isDesktop();
  const target = desktop ? sidebar() : content();
  const res = await api.get("/api/conversations", { bypassCache: true });
  state.conversations = _mergeConversationState(res.conversations);
  _paintConversationListIfOwned(target, desktop);
}

export async function setConversationPinned(conversation, pinned) {
  try {
    const res = await api.put(
      `/api/conversations/${encodeURIComponent(conversation.persona_id)}/pinned`,
      { pinned },
    );
    if (res.status >= 400) throw new Error(res.data?.error || "操作失败");
    await _reloadConversationList();
  } catch (e) {
    toast(e.message || "操作失败", "error");
  }
}

export async function hideConversation(conversation) {
  try {
    const res = await api.put(
      `/api/conversations/${encodeURIComponent(conversation.persona_id)}/visibility`,
      { hidden: true },
    );
    if (res.status >= 400) throw new Error(res.data?.error || "操作失败");
    state.conversations = state.conversations.filter(
      item => item.persona_id !== conversation.persona_id,
    );
    _paintChatList(isDesktop() ? sidebar() : content(), isDesktop());
  } catch (e) {
    toast(e.message || "操作失败", "error");
  }
}

async function _restoreOrCreateConversation(personaId) {
  const restored = await api.put(
    `/api/conversations/${encodeURIComponent(personaId)}/visibility`,
    { hidden: false },
  );
  if (restored.status < 400) return true;
  if (restored.status !== 404) {
    toast(restored.data?.error || "打开对话失败", "error");
    return false;
  }
  const created = await api.post("/api/conversations", { persona_id: personaId });
  if (created.status >= 400 && created.status !== 409) {
    toast(created.data?.error || "创建失败", "error");
    return false;
  }
  return true;
}

export async function newConversation() {
  try {
    const pres = await api.get("/api/personas");
    state.personas = pres.personas || [];
    void prepareNotificationIcons(state.personas);
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
  if (!hasConv) showLoading("打开中…");
  try {
    if (!await _restoreOrCreateConversation(personaId)) return;
  } catch (e) {
    toast("打开对话失败", "error");
    return;
  } finally {
    if (!hasConv) hideLoading();
  }
  openChat(personaId, { restored: true });
}

export function isViewingChat(personaId = chatPersonaId) {
  const activePage = state.pageStack[state.pageStack.length - 1];
  return isConversationReadContext({
    personaId,
    activePersonaId: chatPersonaId,
    currentTab: state.currentTab,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    activePage,
  }) && !!$("chat-msgs");
}

export async function markConversationRead(personaId = chatPersonaId, throughSeq = null) {
  if (!isViewingChat(personaId)) return;
  markConversationReadLocal(state.conversations, personaId);
  updateConversationUnread(state.conversations);
  updateChatTabUnread(state.conversations);
  if (!Number.isInteger(throughSeq) || throughSeq < 0) return;
  try {
    await api.post(`/api/conversations/${encodeURIComponent(personaId)}/read`, {
      through_seq: throughSeq,
      client_id: _readClientId,
      page_id: _readPageId,
    });
  } catch (e) { /* the next list refresh restores server truth */ }
}

export function applyAssistantUnread(personaId, unreadCount) {
  const count = isViewingChat(personaId) ? 0 : unreadCount;
  if (!setConversationUnreadCount(state.conversations, personaId, count)) {
    void refreshUnreadCounts();
    return;
  }
  updateConversationUnread(state.conversations);
  updateChatTabUnread(state.conversations);
}

export async function openChat(personaId, { restored = false } = {}) {
  closeConversationMenu();
  if (!restored) {
    try {
      if (!await _restoreOrCreateConversation(personaId)) return;
    } catch (e) {
      toast("打开对话失败", "error");
      return;
    }
  }
  _expandedVoiceTranscripts.clear();

  // Clear the still-mounted list before pushPage caches its DOM. Persist using
  // the list snapshot as well, so a quick back action cannot outrun message loading.
  const throughSeq = conversationLatestMessageSequence(state.conversations, personaId);
  markConversationReadLocal(state.conversations, personaId);
  updateConversationUnread(state.conversations);
  updateChatTabUnread(state.conversations);

  state.pageStack = [];
  pushPage("chatWindow", { personaId });
  void markConversationRead(personaId, throughSeq);

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
      .map(b => {
        const src = base + b.url;
        const layout = imageLayoutAttributes(src, { maxWidth: 160, maxHeight: 160 });
        return `<div class="msg-emoji"><img src="${escAttr(src)}" alt="emoji" draggable="false" data-message-media${layout} onload="PawzoChat.rememberImageLayout(this)"></div>`;
      })
      .join("");
  }
  const base = window.PAWZOCHAT_BASE || "";
  let parts = "";
  for (const b of blocks) {
    if (b.type === "image") {
      if (b.status === "pending") {
        parts += `<div class="msg-image-placeholder" role="status" aria-live="polite">
          <span class="msg-image-placeholder-spinner" aria-hidden="true"></span>
          <span>图片加载中…</span>
        </div>`;
        continue;
      }
      if (b.status === "failed") {
        const retryButton = b.retryable === true && /^[0-9a-f]{16}$/.test(b.task_id || "")
          ? `<button type="button" class="msg-image-retry" data-task-id="${escAttr(b.task_id)}"
              onclick="event.stopPropagation();PawzoChat.retryGeneratedImage(this)">重试</button>`
          : "";
        parts += `<div class="msg-image-placeholder failed" title="${escAttr(b.error || "图片加载失败")}">
          ${iconHtml("ri-image-off-line")}
          <span>图片加载失败</span>
          ${retryButton}
        </div>`;
        continue;
      }
      let src = "";
      if (b.url) {
        src = /^(?:https?:\/\/|blob:|data:)/i.test(b.url) ? b.url : base + b.url;
      } else if (b.path) {
        const filename = b.path.split(/[\\/]/).pop();
        src = base + "/api/images/" + chatPersonaId + "/" + filename;
      }
      if (src) {
        const safeSrc = escAttr(src);
        const layout = imageLayoutAttributes(src);
        parts += `<div class="msg-image linked-image">
          <img src="${safeSrc}" alt="image" loading="lazy" data-message-media${layout}
            onload="PawzoChat.rememberImageLayout(this)"
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
          <div class="msg-voice-line">
            <div class="msg-voice" style="width:${width}px" data-src="${escAttr(src)}" data-transcript="${escAttr(transcript)}" onclick="PawzoChat.playVoiceMessage(this)">
              <svg class="msg-voice-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path class="v1" d="M8.5 9.5a4 4 0 010 5"/><path class="v2" d="M11.5 7a8 8 0 010 10"/><path class="v3" d="M14.5 4.5a12.5 12.5 0 010 15"/></svg>
              <span class="msg-voice-dur">${secs}″</span>
            </div>
            <button type="button" class="msg-voice-transcript-btn"${expanded ? " hidden" : ""} onclick="event.stopPropagation();PawzoChat.toggleVoiceTranscript(this)">转文字</button>
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

export async function retryGeneratedImage(button) {
  const taskId = button?.dataset?.taskId || "";
  const personaId = chatPersonaId;
  const placeholder = button?.closest?.(".msg-image-placeholder");
  if (!personaId || !placeholder || !/^[0-9a-f]{16}$/.test(taskId)) return;

  placeholder.classList.remove("failed");
  placeholder.removeAttribute("title");
  placeholder.innerHTML = `
    <span class="msg-image-placeholder-spinner" aria-hidden="true"></span>
    <span>图片加载中…</span>
  `;
  placeholder.setAttribute("role", "status");
  placeholder.setAttribute("aria-live", "polite");

  try {
    const res = await api.post(
      `/api/conversations/${encodeURIComponent(personaId)}/images/${taskId}/retry`,
      {},
    );
    if (res.status >= 400) throw new Error(res.data?.error || "图片重试失败");
  } catch (e) {
    showErrorBanner(e.message || "图片重试失败", "图片重试失败");
    if (chatPersonaId === personaId) await refreshChatMessages();
  }
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

function _latestMessageSequence(messages) {
  return (messages || []).reduce(
    (latest, message) => Math.max(latest, Number(messageSequence(message)) || 0),
    0,
  );
}

function _mergeLatestHistory(current, latest) {
  if (!latest.length) return [];
  const firstLatestSequence = Number(messageSequence(latest[0]));
  const older = firstLatestSequence > 0
    ? (current || []).filter(message => {
      const sequence = Number(messageSequence(message));
      return sequence > 0 && sequence < firstLatestSequence;
    })
    : [];
  return mergeMessagesBySequence(older, latest);
}

function _setNewMessageButtonVisible(visible) {
  const button = $("chat-new-message-btn");
  if (button) button.hidden = !visible;
}

export function scrollToLatestMessage() {
  const messagesEl = $("chat-msgs");
  if (!messagesEl) return;
  _chatBottomAnchor.scrollToBottom(messagesEl);
  _chatBottomAnchor.scheduleBottom(messagesEl);
  _setNewMessageButtonVisible(false);
}

function _bindChatScroll(el) {
  _chatBottomAnchor.bind(el, { initial: true, lifecycleRoot: content() });
  el.addEventListener("scroll", () => {
    if (_chatBottomAnchor.isNearBottom(el)) _setNewMessageButtonVisible(false);
    if (el.scrollTop <= _CHAT_HISTORY_TOP_THRESHOLD) void _loadOlderMessages(el);
  }, { passive: true });
}

async function _loadOlderMessages(el) {
  const history = _chatHistory;
  const firstSequence = Number(messageSequence(history.messages[0]));
  if (
    history.personaId !== chatPersonaId
    || !history.hasMore
    || history.loadingOlder
    || !firstSequence
    || el !== $("chat-msgs")
  ) return;

  history.loadingOlder = true;
  const generation = history.generation;
  try {
    const res = await api.get(
      `/api/conversations/${encodeURIComponent(history.personaId)}/messages?rounds=${_CHAT_PAGE_ROUNDS}&before_seq=${firstSequence}`,
      { bypassCache: true },
    );
    if (
      generation !== history.generation
      || history.personaId !== chatPersonaId
      || el !== $("chat-msgs")
    ) return;
    history.messages = mergeMessagesBySequence(res.messages || [], history.messages);
    history.hasMore = res.has_more === true;
    renderMessages(history.messages, { preservePrepend: true });
  } catch (e) {
    if (generation === history.generation) toast("加载更早消息失败", "error");
  } finally {
    if (generation === history.generation) history.loadingOlder = false;
  }
}

function _scrollAfterInsert(el, insertedRoot = el.lastElementChild) {
  _chatBottomAnchor.scrollAfterInsert(el, insertedRoot);
  if (_chatBottomAnchor.isNearBottom(el)) _setNewMessageButtonVisible(false);
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
  _quotePop.regenerateSeq = null;
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
  const rawRegenerateSeq = Number(row.dataset.messageSeq);
  const regenerateSeq = isUser
    && row.dataset.latestUser === "true"
    && Number.isInteger(rawRegenerateSeq)
    && rawRegenerateSeq > 0
    ? rawRegenerateSeq
    : null;
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
    if (transcriptEl?.hidden) {
      buttons += `<button class="map-btn" onclick="PawzoChat.toggleVoiceTranscript()">${iconHtml("ri-file-text-line")}<span>转文字</span></button>`;
    }
  }
  if (regenerateSeq !== null) {
    if (buttons) buttons += `<span class="map-divider" aria-hidden="true"></span>`;
    buttons += `<button class="map-btn" onclick="PawzoChat.regenerateChatReply()">${iconHtml("ri-refresh-line")}<span>重新生成</span></button>`;
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
  _quotePop.regenerateSeq = regenerateSeq;
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
    pushPage("profileDetail");
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

export async function regenerateChatReply() {
  const personaId = chatPersonaId;
  const messageSeq = _quotePop.regenerateSeq;
  _closeQuotePop();
  if (!personaId || !Number.isInteger(messageSeq) || messageSeq <= 0) return;

  try {
    const res = await api.post(
      `/api/conversations/${encodeURIComponent(personaId)}/messages/${messageSeq}/regenerate`,
      {},
    );
    if (res.status >= 400) throw new Error(res.data?.error || "重新生成失败");
    if (!_isActiveChatWindow(personaId)) return;

    _failedReplies.delete(_failedReplyKey(personaId, messageSeq));
    _chatHistory.messages = _chatHistory.messages.filter(message => {
      const sequence = Number(messageSequence(message));
      return !Number.isInteger(sequence) || sequence <= messageSeq;
    });
    renderMessages(_chatHistory.messages);
    state.processingPersonas.add(personaId);
    showTypingIndicator();
    toast("正在重新生成…", "success");
  } catch (e) {
    toast(e.message || "重新生成失败", "error");
    void refreshChatMessages(personaId);
  }
}

export function toggleVoiceTranscript(trigger = null) {
  const wrap = trigger?.closest?.(".msg-voice-wrap")
    || _quotePop.voiceEl?.closest(".msg-voice-wrap");
  const transcriptEl = wrap?.querySelector(".msg-voice-transcript");
  if (!wrap || !transcriptEl || !transcriptEl.hidden) {
    _closeQuotePop();
    return;
  }
  transcriptEl.hidden = false;
  const key = wrap.dataset.voiceKey || "";
  if (key) _expandedVoiceTranscripts.add(key);
  const directButton = wrap.querySelector(".msg-voice-transcript-btn");
  if (directButton) directButton.hidden = true;
  _closeQuotePop();
  requestAnimationFrame(() => {
    transcriptEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  });
}

export function clearPendingQuote() {
  _pendingQuote = "";
  _renderQuotePreview();
}

/* ---- Chat Window ---- */

async function renderChatWindow(data) {
  chatPersonaId = data.personaId;
  const renderedPersonaId = chatPersonaId;
  const historyGeneration = _chatHistory.generation + 1;
  _chatHistory = {
    personaId: renderedPersonaId,
    messages: [],
    hasMore: false,
    loadingOlder: false,
    generation: historyGeneration,
  };
  const messagesUrl = `/api/conversations/${encodeURIComponent(renderedPersonaId)}/messages?rounds=${_CHAT_PAGE_ROUNDS}`;
  const cachedMessages = api.peek(messagesUrl);
  const pname = state.personas.find(p => p.id === chatPersonaId)?.name || chatPersonaId;
  const asrEnabled = state.settings?.asr?.enabled !== false;

  setTopBar(pname, true,
    `<button class="top-btn" onclick="PawzoChat.chatMore()">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
    </button>`
  );

  _disposeVoiceRecorder();
  _voiceInput.mode = false;
  _pendingImages = [];
  _pendingFiles = [];
  _pendingQuote = "";
  _closeQuotePop(); // never let a popup (in document.body) outlive the chat that spawned it
  content().innerHTML = `<div class="chat-container">
    <div class="chat-messages" id="chat-msgs">${cachedMessages ? "" : `<div class="loading-center"><div class="spinner"></div></div>`}</div>
    <div class="chat-new-message-anchor">
      <button type="button" class="chat-new-message-btn" id="chat-new-message-btn" hidden onclick="PawzoChat.scrollToLatestMessage()" aria-label="查看新消息">
        <span>查看新消息</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </button>
    </div>
    <div id="img-preview-bar" class="img-preview-bar" style="display:none"></div>
    <div id="file-preview-bar" class="file-preview-bar" style="display:none"></div>
    <div id="quote-preview-bar" class="quote-preview-bar" style="display:none"></div>
    <div id="emoji-picker-panel" class="emoji-picker-panel" style="display:none"></div>
    <div id="plus-menu-panel" class="plus-menu-panel" style="display:none"></div>
    <div class="chat-input-bar">
      ${asrEnabled ? `<button class="img-upload-btn voice-mode-toggle" id="voice-mode-btn" onclick="PawzoChat.toggleVoiceInputMode()" title="切换到按住说话" aria-label="切换到按住说话">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0014 0M12 17v5M8 22h8"/></svg>
      </button>` : ""}
      <textarea class="chat-input" id="chat-input" rows="1" placeholder="输入消息…" aria-label="消息输入框" enterkeyhint="send" oninput="PawzoChat.onChatInput()" onkeydown="PawzoChat.onChatKey(event)" oncompositionstart="PawzoChat.onChatCompositionStart()" oncompositionend="PawzoChat.onChatCompositionEnd()"></textarea>
      <button class="voice-hold-btn" id="voice-hold-btn" type="button" aria-label="按住说话" hidden
        onpointerdown="PawzoChat.startVoiceRecording(event)" onpointermove="PawzoChat.moveVoiceRecording(event)" onpointerup="PawzoChat.finishVoiceRecording(event)" onpointercancel="PawzoChat.cancelVoiceRecording(event)" oncontextmenu="return false">按住 说话</button>
      <button class="img-upload-btn" id="emoji-picker-btn" onclick="PawzoChat.toggleEmojiPicker()" title="表情" aria-label="打开表情面板">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
      </button>
      <button class="img-upload-btn" id="plus-menu-btn" onclick="PawzoChat.togglePlusMenu()" title="更多" aria-label="打开附件面板">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="7" x2="12" y2="17"/><line x1="7" y1="12" x2="17" y2="12"/></svg>
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
  _chatInputComposing = false;

  if (cachedMessages) {
    const cached = cachedMessages.messages || [];
    _chatHistory.messages = cached;
    _chatHistory.hasMore = cachedMessages.has_more === true;
    renderMessages(cached);
    markRenderedMessagesRead(renderedPersonaId, cached);
  }

  try {
    const res = await api.get(messagesUrl, { bypassCache: true });
    if (
      _isActiveChatWindow(renderedPersonaId)
      && _chatHistory.generation === historyGeneration
    ) {
      const messages = res.messages || [];
      const currentFirst = Number(messageSequence(_chatHistory.messages[0]));
      const freshFirst = Number(messageSequence(messages[0]));
      const alreadyLoadedOlder = currentFirst > 0 && freshFirst > 0 && currentFirst < freshFirst;
      _chatHistory.messages = _mergeLatestHistory(_chatHistory.messages, messages);
      if (!alreadyLoadedOlder) _chatHistory.hasMore = res.has_more === true;
      renderMessages(_chatHistory.messages);
      markRenderedMessagesRead(renderedPersonaId, messages);
    }
  } catch (e) {
    if (!cachedMessages) toast("加载消息失败", "error");
  }

  if (_isActiveChatWindow(renderedPersonaId) && state.processingPersonas.has(renderedPersonaId)) {
    showTypingIndicator();
  }
}

function _messageTimeHtml(timestamp, previousTimestamp = null, attributes = "") {
  if (!shouldShowMessageTime(timestamp, previousTimestamp)) return "";
  return `<div class="msg-time"${attributes}>${formatMsgTime(timestamp)}</div>`;
}

function _lastRenderedMessageTimestamp(messagesEl) {
  const rows = messagesEl.querySelectorAll(".msg-row[data-message-timestamp]");
  return rows.length ? rows[rows.length - 1].dataset.messageTimestamp : null;
}

function _failedReplyKey(personaId, messageSeq) {
  return `${personaId}:${messageSeq}`;
}

function _retryStatusHtml(personaId, messageSeq) {
  if (!_failedReplies.has(_failedReplyKey(personaId, messageSeq))) return "";
  return `
    <div class="msg-retry-status">
      <button type="button" data-message-seq="${messageSeq}" onclick="PawzoChat.retryChatReply(this)" title="重试回复" aria-label="重试回复">
        ${iconHtml("ri-refresh-line")}
      </button>
    </div>
  `;
}

function renderMessages(messages, { preservePrepend = false } = {}) {
  const el = $("chat-msgs");
  if (!el) return;
  messages = mergePendingUserMessages(chatPersonaId, messages);
  _closeQuotePop();  // a full in-place re-render (e.g. SSE refresh) detaches the popup anchor

  const previousScrollHeight = el.scrollHeight;
  const previousScrollTop = el.scrollTop;
  const renderState = _chatBottomAnchor.beginRender(el);
  const finishRender = () => {
    _chatBottomAnchor.finishRender(renderState, el);
    if (preservePrepend) {
      el.scrollTop = previousScrollTop + Math.max(0, el.scrollHeight - previousScrollHeight);
    }
  };

  if (messages.length === 0) {
    el.innerHTML = `<div class="empty-state" style="padding:40px"><div class="empty-text">开始对话吧</div></div>`;
    requestAnimationFrame(finishRender);
    return;
  }

  const _persona = state.personas.find(p => p.id === chatPersonaId);
  const _pname = _persona?.name || chatPersonaId;
  const _avUrl = personaAvatarUrl(_persona);

  const _userName = state.profile?.name || "我";
  const _userAvUrl = profileAvatarUrl(state.profile);

  let latestUserSequence = "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    latestUserSequence = messageSequence(messages[index]);
    break;
  }

  let html = "";
  let lastTimestamp = null;
  for (const m of messages) {
    html += _messageTimeHtml(m.timestamp, lastTimestamp);
    lastTimestamp = m.timestamp;

    const role = m.role;
    const av = role === "assistant"
      ? avatarHtml(_pname, "sm", _avUrl)
      : avatarHtml(_userName, "sm", _userAvUrl);
    const source = sourceBadge(m.source);
    const bubbleHtml = renderContentBlocks(m.content, role === "assistant");
    const sequence = messageSequence(m);
    const sequenceAttr = sequence
      ? ` data-message-seq="${escAttr(sequence)}"`
      : "";
    const latestUserAttr = role === "user" && sequence === latestUserSequence
      ? ` data-latest-user="true"`
      : "";
    const retryStatus = role === "user" && sequence
      ? _retryStatusHtml(chatPersonaId, sequence)
      : "";

    html += `<div class="msg-row ${role}"${sequenceAttr}${latestUserAttr} data-message-timestamp="${escAttr(m.timestamp || "")}">
      ${av}
      <div>
        ${bubbleHtml}
        ${renderQuoteBox(m.quote)}
        ${source}
        ${retryStatus}
      </div>
    </div>`;
  }
  el.innerHTML = html;
  requestAnimationFrame(finishRender);
}

function markRenderedMessagesRead(personaId, messages) {
  if (!isViewingChat(personaId)) return;
  const latestSequence = (messages || []).reduce(
    (latest, message) => Number.isInteger(message?._seq)
      ? Math.max(latest, message._seq)
      : latest,
    0,
  );
  if (latestSequence > 0) void markConversationRead(personaId, latestSequence);
}

export function onChatInput() {
  const inp = $("chat-input");
  inp.style.height = "auto";
  inp.style.height = Math.min(inp.scrollHeight, 100) + "px";
  if (_pinBottomForKeyboard && document.activeElement === inp) {
    const msgsEl = $("chat-msgs");
    if (msgsEl) requestAnimationFrame(() => _scrollAfterInsert(msgsEl));
  }
}

export function onChatCompositionStart() {
  _chatInputComposing = true;
}

export function onChatCompositionEnd() {
  _chatInputComposing = false;
}

export function onChatKey(e) {
  if (e.key !== "Enter" || e.shiftKey) return;
  if (_chatInputComposing || e.isComposing || e.keyCode === 229) return;

  e.preventDefault();
  const inp = $("chat-input");
  const hasContent = inp?.value.trim().length > 0
    || _pendingImages.length > 0
    || _pendingFiles.length > 0;
  if (hasContent) sendChat();
}

function _setVoiceButtonState(label, stateName = "") {
  const button = $("voice-hold-btn");
  if (!button) return;
  button.textContent = label;
  button.classList.toggle("recording", stateName === "recording");
  button.classList.toggle("canceling", stateName === "canceling");
  button.classList.toggle("transcribing", stateName === "transcribing");
  button.disabled = stateName === "transcribing";
}

function _stopVoiceStream() {
  if (_voiceInput.stream) {
    _voiceInput.stream.getTracks().forEach(track => track.stop());
    _voiceInput.stream = null;
  }
}

function _disposeVoiceRecorder() {
  if (_voiceInput.stopTimer) clearTimeout(_voiceInput.stopTimer);
  _voiceInput.stopTimer = null;
  _voiceInput.generation += 1;
  _voiceInput.pressing = false;
  _voiceInput.canceled = true;
  const recorder = _voiceInput.recorder;
  _voiceInput.recorder = null;
  if (recorder?.state === "recording") recorder.stop();
  _stopVoiceStream();
  _voiceInput.chunks = [];
  _voiceInput.pointerId = null;
}

function _preferredAudioMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
  return candidates.find(type => MediaRecorder.isTypeSupported?.(type)) || "";
}

function _audioFilename(mimeType) {
  if (mimeType.includes("mp4")) return "recording.m4a";
  if (mimeType.includes("ogg")) return "recording.ogg";
  return "recording.webm";
}

async function _transcribeVoice(blob, personaId) {
  if (!blob.size) {
    toast("没有录到声音，请重试", "error");
    return;
  }

  _voiceInput.busy = true;
  _setVoiceButtonState("正在识别…", "transcribing");
  try {
    const form = new FormData();
    form.append("file", blob, _audioFilename(blob.type));
    const base = window.PAWZOCHAT_BASE || "";
    const response = await fetch(`${base}/api/asr/transcriptions`, {
      method: "POST",
      body: form,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "语音识别失败");

    const text = String(result.text || "").trim();
    if (!text) {
      toast("没有识别到文字", "error");
      return;
    }
    if (!_isActiveChatWindow(personaId)) return;

    const input = $("chat-input");
    if (!input) return;
    input.value = text;
    onChatInput();
    await sendChat();
  } catch (e) {
    toast(e?.message || "语音识别失败", "error");
  } finally {
    _voiceInput.busy = false;
    if (_isActiveChatWindow(personaId)) _setVoiceButtonState("按住 说话");
  }
}

function _stopVoiceRecording({ send }) {
  const recorder = _voiceInput.recorder;
  if (!recorder || recorder.state !== "recording") return;
  _voiceInput.canceled = !send;
  if (_voiceInput.stopTimer) clearTimeout(_voiceInput.stopTimer);
  _voiceInput.stopTimer = null;
  recorder.stop();
}

export function toggleVoiceInputMode() {
  if (_voiceInput.busy || _voiceInput.recorder?.state === "recording") return;
  _voiceInput.mode = !_voiceInput.mode;
  const input = $("chat-input");
  const holdButton = $("voice-hold-btn");
  const modeButton = $("voice-mode-btn");
  const emojiButton = $("emoji-picker-btn");
  const plusButton = $("plus-menu-btn");
  if (!input || !holdButton || !modeButton) return;

  input.hidden = _voiceInput.mode;
  holdButton.hidden = !_voiceInput.mode;
  emojiButton?.toggleAttribute("hidden", _voiceInput.mode);
  plusButton?.toggleAttribute("hidden", _voiceInput.mode);
  modeButton.classList.toggle("active", _voiceInput.mode);
  modeButton.title = _voiceInput.mode ? "切换到文字输入" : "切换到按住说话";
  modeButton.setAttribute("aria-label", modeButton.title);
  if (!_voiceInput.mode) input.focus();
}

export async function startVoiceRecording(event) {
  if (!_voiceInput.mode || _voiceInput.busy || _voiceInput.pressing || _voiceInput.recorder) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    toast("当前浏览器不支持录音，请使用 HTTPS 访问", "error");
    return;
  }

  event.preventDefault();
  const button = event.currentTarget;
  button?.setPointerCapture?.(event.pointerId);
  _voiceInput.pressing = true;
  _voiceInput.canceled = false;
  _voiceInput.cancelOnRelease = false;
  _voiceInput.pointerId = event.pointerId;
  _voiceInput.personaId = chatPersonaId;
  const generation = ++_voiceInput.generation;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (generation !== _voiceInput.generation || !_voiceInput.pressing || !_isActiveChatWindow(_voiceInput.personaId)) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }

    const mimeType = _preferredAudioMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    _voiceInput.stream = stream;
    _voiceInput.recorder = recorder;
    _voiceInput.chunks = [];
    _voiceInput.startedAt = Date.now();
    _voiceInput.mimeType = recorder.mimeType || mimeType;

    recorder.addEventListener("dataavailable", e => {
      if (e.data?.size) _voiceInput.chunks.push(e.data);
    });
    recorder.addEventListener("stop", () => {
      const duration = Date.now() - _voiceInput.startedAt;
      const canceled = _voiceInput.canceled;
      const personaId = _voiceInput.personaId;
      const blob = new Blob(_voiceInput.chunks, { type: _voiceInput.mimeType });
      _voiceInput.recorder = null;
      _voiceInput.chunks = [];
      _voiceInput.pointerId = null;
      _stopVoiceStream();
      _setVoiceButtonState("按住 说话");
      if (canceled) return;
      if (duration < _VOICE_MIN_DURATION_MS) {
        toast("说话时间太短", "error");
        return;
      }
      void _transcribeVoice(blob, personaId);
    }, { once: true });

    recorder.start(250);
    _setVoiceButtonState("松开 发送", "recording");
    _voiceInput.stopTimer = setTimeout(() => {
      _voiceInput.pressing = false;
      _stopVoiceRecording({ send: true });
      toast("录音已达到 60 秒，正在识别", "success");
    }, _VOICE_MAX_DURATION_MS);
  } catch (e) {
    if (generation !== _voiceInput.generation) return;
    _voiceInput.pressing = false;
    _voiceInput.pointerId = null;
    _stopVoiceStream();
    const message = e?.name === "NotAllowedError"
      ? "麦克风权限被拒绝，请在浏览器设置中允许访问"
      : "无法启动录音，请检查麦克风";
    toast(message, "error");
  }
}

export function moveVoiceRecording(event) {
  if (!_voiceInput.pressing || _voiceInput.pointerId !== event.pointerId) return;
  const button = event.currentTarget;
  const cancel = event.clientY < button.getBoundingClientRect().top - 48;
  if (cancel === _voiceInput.cancelOnRelease) return;
  _voiceInput.cancelOnRelease = cancel;
  _setVoiceButtonState(cancel ? "松开 取消" : "松开 发送", cancel ? "canceling" : "recording");
}

export function finishVoiceRecording(event) {
  if (_voiceInput.pointerId != null && event.pointerId !== _voiceInput.pointerId) return;
  event.preventDefault();
  const send = !_voiceInput.cancelOnRelease;
  _voiceInput.pressing = false;
  _voiceInput.cancelOnRelease = false;
  if (!_voiceInput.recorder) {
    _voiceInput.generation += 1;
    _voiceInput.pointerId = null;
  }
  _stopVoiceRecording({ send });
}

export function cancelVoiceRecording(event) {
  if (_voiceInput.pointerId != null && event.pointerId !== _voiceInput.pointerId) return;
  event.preventDefault();
  _voiceInput.pressing = false;
  _voiceInput.cancelOnRelease = false;
  if (!_voiceInput.recorder) {
    _voiceInput.generation += 1;
    _voiceInput.pointerId = null;
  }
  _stopVoiceRecording({ send: false });
}

function _stopCameraStream() {
  if (!_cameraStream) return;
  _cameraStream.getTracks().forEach(track => track.stop());
  _cameraStream = null;
}

export async function takePhoto() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("当前浏览器不支持直接调用摄像头，请使用 HTTPS 访问", "error");
    return;
  }

  try {
    _stopCameraStream();
    _cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    showSheet(`
      <div class="camera-sheet">
        <div class="camera-sheet-title">拍照</div>
        <video id="camera-preview" class="camera-preview" autoplay muted playsinline></video>
        <div class="camera-sheet-actions">
          <button class="camera-cancel-btn" onclick="PawzoChat.closeOverlay()">取消</button>
          <button class="camera-capture-btn" onclick="PawzoChat.capturePhoto()" aria-label="拍摄照片"></button>
        </div>
      </div>`, _stopCameraStream);
    const video = $("camera-preview");
    if (video) video.srcObject = _cameraStream;
  } catch (e) {
    _stopCameraStream();
    const message = e?.name === "NotAllowedError"
      ? "摄像头权限被拒绝，请在浏览器设置中允许访问"
      : "无法启动摄像头，请检查设备和浏览器权限";
    toast(message, "error");
  }
}

export function capturePhoto() {
  const video = $("camera-preview");
  if (!video?.videoWidth || !video.videoHeight) {
    toast("摄像头正在准备，请稍后再拍", "error");
    return;
  }

  const maxSide = 1920;
  const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  closeOverlay();
  canvas.toBlob(blob => {
    if (!blob) {
      toast("照片生成失败，请重试", "error");
      return;
    }
    _addPendingImage(new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" }));
  }, "image/jpeg", 0.9);
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

  const personaId = chatPersonaId;
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
    userBubble += `<div class="msg-image"><img src="${img.url}" alt="image" data-message-media></div>`;
  }
  for (const f of _pendingFiles) {
    userBubble += `<div class="msg-file-inline">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span>${esc(f.name)}</span>
    </div>`;
  }
  const quoteToSend = _pendingQuote;
  const optimisticContent = [];
  if (text) optimisticContent.push({ type: "text", text });
  for (const img of _pendingImages) {
    optimisticContent.push({ type: "image", url: img.url });
  }
  for (const file of _pendingFiles) {
    optimisticContent.push({ type: "file", name: file.name });
  }
  const optimisticMessage = {
    role: "user",
    content: optimisticContent,
    source: "web",
    timestamp: new Date().toISOString(),
    ...(quoteToSend ? { quote: quoteToSend } : {}),
  };
  const pendingId = addPendingUserMessage(personaId, optimisticMessage);
  const previousTimestamp = _lastRenderedMessageTimestamp(msgsEl);
  const timeHtml = _messageTimeHtml(
    optimisticMessage.timestamp,
    previousTimestamp,
    ` data-pending-time-id="${pendingId}"`,
  );
  msgsEl.insertAdjacentHTML("beforeend", `${timeHtml}<div class="msg-row user" data-pending-id="${pendingId}" data-message-timestamp="${escAttr(optimisticMessage.timestamp)}">${avatarHtml(_uName, "sm", _uAvUrl)}<div>${userBubble}${renderQuoteBox(quoteToSend)}</div></div>`);
  _scrollAfterInsert(msgsEl);

  const imagesToSend = [..._pendingImages];
  const filesToSend = [..._pendingFiles];
  _pendingImages = [];
  _pendingFiles = [];
  _pendingQuote = "";
  _renderImagePreviews();
  _renderFilePreviews();
  _renderQuotePreview();

  let acceptedMessage = null;
  let sendFailed = false;
  try {
    if (imagesToSend.length > 0 || filesToSend.length > 0) {
      const fd = new FormData();
      fd.append("text", text);
      if (quoteToSend) fd.append("quote", quoteToSend);
      for (const img of imagesToSend) fd.append("images", img.file);
      for (const f of filesToSend) fd.append("files", f.file);
      const base = window.PAWZOCHAT_BASE || "";
      const resp = await fetch(`${base}/api/conversations/${personaId}/messages`, {
        method: "POST",
        body: fd,
      });
      const res = await resp.json();
      if (resp.status >= 400) {
        sendFailed = true;
        toast(res.error || "发送失败", "error");
      } else if (res.message) {
        acceptedMessage = res.message;
      } else {
        sendFailed = true;
      }
    } else {
      const body = quoteToSend ? { text, quote: quoteToSend } : { text };
      const res = await api.post(
        `/api/conversations/${personaId}/messages`,
        body,
        { keepalive: true },
      );
      if (res.status >= 400) {
        sendFailed = true;
        toast(res.data.error || "发送失败", "error");
      } else if (res.data.message) {
        acceptedMessage = res.data.message;
      } else {
        sendFailed = true;
      }
    }
  } catch (e) {
    sendFailed = true;
    toast("网络错误", "error");
  }

  if (sendFailed) {
    removePendingUserMessage(personaId, pendingId);
    document.querySelector(`.msg-row[data-pending-id="${pendingId}"]`)?.remove();
    document.querySelector(`.msg-time[data-pending-time-id="${pendingId}"]`)?.remove();
  } else {
    confirmPendingUserMessage(personaId, pendingId, acceptedMessage);
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

export function handleChatOperationError(event) {
  const personaId = event?.persona_id;
  const messageSeq = Number(event?.retry_message_seq);
  if (!personaId || personaId !== chatPersonaId) return;

  hideTypingIndicator();
  toast(event.message || "消息回复失败", "error");
  if (!Number.isInteger(messageSeq) || messageSeq <= 0) return;
  _failedReplies.add(_failedReplyKey(personaId, messageSeq));

  const row = $("chat-msgs")?.querySelector(
    `.msg-row.user[data-message-seq="${messageSeq}"]`,
  );
  const body = row?.querySelector(":scope > div:not(.avatar)");
  if (!body) return;

  body.querySelector(".msg-retry-status")?.remove();
  body.insertAdjacentHTML("beforeend", _retryStatusHtml(personaId, messageSeq));
}

export async function retryChatReply(button) {
  const personaId = chatPersonaId;
  const messageSeq = Number(button?.dataset?.messageSeq);
  const status = button?.closest?.(".msg-retry-status");
  if (!personaId || !Number.isInteger(messageSeq) || messageSeq <= 0 || !status) return;

  button.disabled = true;
  status.classList.add("retrying");
  toast("正在重试…");
  try {
    const res = await api.post(
      `/api/conversations/${encodeURIComponent(personaId)}/messages/${messageSeq}/retry`,
      {},
    );
    if (res.status >= 400) throw new Error(res.data?.error || "重试失败");
    _failedReplies.delete(_failedReplyKey(personaId, messageSeq));
    status.remove();
    state.processingPersonas.add(personaId);
    showTypingIndicator();
    toast("已重新发起回复", "success");
  } catch (e) {
    status.classList.remove("retrying");
    button.disabled = false;
    toast(e.message || "重试失败", "error");
  }
}

export function appendAssistantMessage(message, isLast) {
  const msgsEl = $("chat-msgs");
  if (!msgsEl) return;

  if (_chatHistory.personaId === chatPersonaId) {
    _chatHistory.messages = mergeMessagesBySequence(_chatHistory.messages, [message]);
  }

  if (hasRenderedMessage(msgsEl, message)) {
    if (isLast) hideTypingIndicator();
    return;
  }

  const wasAtBottom = _chatBottomAnchor.followsBottom(msgsEl);

  const persona = state.personas.find(p => p.id === chatPersonaId);
  const pname = persona?.name || chatPersonaId;
  const avUrl = personaAvatarUrl(persona);
  const source = sourceBadge(message.source);
  const bubbleHtml = renderContentBlocks(message.content, true);
  const previousTimestamp = _lastRenderedMessageTimestamp(msgsEl);
  const timeHtml = _messageTimeHtml(message.timestamp, previousTimestamp);
  const sequence = messageSequence(message);
  const sequenceAttr = sequence
    ? ` data-message-seq="${escAttr(sequence)}"`
    : "";

  msgsEl.insertAdjacentHTML("beforeend", `${timeHtml}<div class="msg-row assistant"${sequenceAttr} data-message-timestamp="${escAttr(message.timestamp || "")}">
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

  if (wasAtBottom) {
    _scrollAfterInsert(msgsEl);
  } else {
    _setNewMessageButtonVisible(true);
  }
}

function _preloadMessageImages(root) {
  const sources = Array.from(root.querySelectorAll("img[src]"), image => image.src);
  return Promise.all(sources.map(source => new Promise(resolve => {
    const image = new Image();
    let timeout = 0;
    const done = () => {
      image.onload = null;
      image.onerror = null;
      if (timeout) clearTimeout(timeout);
      resolve();
    };
    image.onload = done;
    image.onerror = done;
    timeout = window.setTimeout(done, 10_000);
    image.src = source;
    if (image.complete) done();
  })));
}

export async function updateAssistantMessage(message) {
  const sequence = messageSequence(message);
  const personaId = chatPersonaId;
  const msgsEl = $("chat-msgs");
  if (!sequence || !personaId || !msgsEl) {
    await refreshChatMessages(personaId);
    return;
  }

  if (_chatHistory.personaId === personaId) {
    _chatHistory.messages = mergeMessagesBySequence(_chatHistory.messages, [message]);
  }

  const currentRow = msgsEl.querySelector(
    `.msg-row.assistant[data-message-seq="${sequence}"]`,
  );
  if (!currentRow) {
    await refreshChatMessages(personaId);
    return;
  }

  const token = Symbol(sequence);
  const updateKey = `${personaId}:${sequence}`;
  _assistantMessageUpdateTokens.set(updateKey, token);

  const replacementBody = document.createElement("div");
  replacementBody.innerHTML = `${renderContentBlocks(message.content, true)}
    ${renderQuoteBox(message.quote)}
    ${sourceBadge(message.source)}`;
  await _preloadMessageImages(replacementBody);

  if (_assistantMessageUpdateTokens.get(updateKey) !== token) return;
  _assistantMessageUpdateTokens.delete(updateKey);
  if (!_isActiveChatWindow(personaId)) return;

  const latestRow = $("chat-msgs")?.querySelector(
    `.msg-row.assistant[data-message-seq="${sequence}"]`,
  );
  const currentBody = latestRow?.querySelector(":scope > div:not(.avatar)");
  if (!currentBody) return;
  currentBody.replaceWith(replacementBody);
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

/* ---- Plus Menu (拍照 / 图片 / 文件) ---- */

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
    <button class="plus-menu-item" onclick="PawzoChat.takePhoto();PawzoChat.togglePlusMenu()">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 4l1.5 2H20a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2h4l1.5-2h5z"/><circle cx="12" cy="13" r="3"/></svg>
      <span>拍照</span>
    </button>
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
    `<div class="msg-row user">${avatarHtml(_uName, "sm", _uAvUrl)}<div><div class="msg-image"><img src="${esc(imgSrc)}" alt="sticker" data-message-media onclick="PawzoChat.openImagePreview(this.src)"></div></div></div>`
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
    state.conversations = _mergeConversationState(convRes.conversations);
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
    state.conversations = _mergeConversationState(convRes.conversations);
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
    state.conversations = _mergeConversationState(res.conversations);
    if (isViewingChat()) markConversationReadLocal(state.conversations, chatPersonaId);
    updateConversationUnread(state.conversations);
    updateChatTabUnread(state.conversations);
  } catch (e) { /* keep the last known counts */ }
}

export async function refreshChatMessages(personaId = chatPersonaId) {
  if (!personaId || !isViewingChat(personaId)) return;
  hideTypingIndicator();
  const previousLatestSequence = _latestMessageSequence(_chatHistory.messages);
  try {
    const res = await api.get(
      `/api/conversations/${encodeURIComponent(personaId)}/messages?rounds=${_CHAT_PAGE_ROUNDS}`,
      { bypassCache: true },
    );
    if (!isViewingChat(personaId) || _chatHistory.personaId !== personaId) return;
    const messages = res.messages || [];
    const hasNewMessages = _latestMessageSequence(messages) > previousLatestSequence;
    const wasAtBottom = _chatBottomAnchor.followsBottom($("chat-msgs"));
    _chatHistory.messages = _mergeLatestHistory(_chatHistory.messages, messages);
    _chatHistory.hasMore = _chatHistory.messages.length > messages.length
      ? _chatHistory.hasMore
      : res.has_more === true;
    renderMessages(_chatHistory.messages);
    if (hasNewMessages && !wasAtBottom) _setNewMessageButtonVisible(true);
    markRenderedMessagesRead(personaId, messages);
  } catch (e) { /* silent */ }
}

/* ---- Register renderers ---- */

registerTabRenderer("chat", renderChatList);
registerPageRenderer("chatWindow", renderChatWindow);
