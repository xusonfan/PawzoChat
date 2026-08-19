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
import { avatarHtml, personaAvatarUrl, esc, CAP_ICONS, ILLEGAL_NAME_RE, voiceOptionsHtml, voiceCatalogFor } from "./utils.js";
import { openImagePreview } from "./image_preview.js";
import { api, downloadFile } from "./api.js";
import { prepareNotificationIcons } from "./notification_feedback.js";
import { state, $, content, sidebar } from "./state.js";
import { toast, confirm, showLoading, hideLoading, showSheet, closeOverlay } from "./ui.js";
import {
  setTopBar, pushPage, goBack, navigateToPage, switchTab,
  registerTabRenderer, registerPageRenderer,
  isDesktop, setSidebarBar, refreshSidebar,
} from "./navigation.js";
import { fetchWorldbookSummary, openWorldbookPicker } from "./worldbook.js";
import {
  CONTACT_INDEX_LETTERS,
  groupPersonasByInitial,
  syncContactIndexAvailability,
} from "./contacts_index.js";

const _CAM_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>`;

let _cropCallback = null;
let _pendingAvatarBlob = null;

// Persona-edit page state for worldbook binding. Populated in renderPersonaEdit,
// mutated by peWorldbookAdd / peWorldbookRemove, read back in savePersona.
let _peBoundWorldbooks = [];
let _peWorldbookSummary = { ok: true, globals: [], selectable: [] };

function _decodeDataValue(value) {
  try {
    return decodeURIComponent(value || "");
  } catch (e) {
    return value || "";
  }
}

function _momentProbability(settings, personaId) {
  const parsed = Number.parseInt(settings?.reply_probabilities?.[personaId], 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 50;
}

function _bindPeWorldbookActions() {
  const host = $("pe-worldbook-bound");
  if (!host) return;
  host.onclick = (e) => {
    const btn = e.target.closest("[data-pe-worldbook-remove]");
    if (!btn || !host.contains(btn)) return;
    peWorldbookRemove(_decodeDataValue(btn.dataset.peWorldbookRemove));
  };
}

/* ---- Contacts List (Tab) ---- */

async function renderContacts() {
  const desktop = isDesktop();
  const target = desktop ? sidebar() : content();
  const actionBtn = `<button class="top-btn" title="导入角色" onclick="PawzoChat.personaImportPick()">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </button>
    <button class="top-btn" title="新建" onclick="PawzoChat.pushPage('personaEdit',{isNew:true})">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>`;

  if (desktop) setSidebarBar("通讯录", actionBtn);
  else setTopBar("通讯录", false, actionBtn);

  target.innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  try {
    const res = await api.get("/api/personas");
    state.personas = res.personas || [];
    void prepareNotificationIcons(state.personas);
  } catch (e) { toast("加载失败", "error"); return; }

  const searchHtml = `<div class="search-bar">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    <input placeholder="搜索" oninput="PawzoChat.filterPersonas(this.value)">
  </div>`;

  const groups = groupPersonasByInitial(state.personas);
  const availableInitials = new Set(groups.map(group => group.initial));
  const sectionsHtml = groups.map(({ initial, personas }) => {
    const sectionId = initial === "#" ? "other" : initial;
    const rows = personas.map(p => {
      const sub = p.signature?.trim() || "这个人很神秘，什么都没写";
      const avUrl = personaAvatarUrl(p);
      return `<div class="card-row persona-row" onclick="PawzoChat.pushPage('personaDetail',{personaId:'${p.id}'})">
        ${avatarHtml(p.name, "", avUrl)}
        <div style="flex:1;min-width:0">
          <div style="font-size:15px;font-weight:500">${esc(p.name)}</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">${esc(sub)}</div>
        </div>
        <span class="row-arrow">›</span>
      </div>`;
    }).join("");
    return `<section class="contacts-section" id="contacts-section-${sectionId}" data-initial="${initial}">
      <div class="contacts-section-title">${initial}</div>
      <div class="card">${rows}</div>
    </section>`;
  }).join("");

  const indexHtml = CONTACT_INDEX_LETTERS.map(initial => `
    <button type="button" class="contacts-index-letter" data-initial="${initial}"
      aria-label="跳转到 ${initial}" ${availableInitials.has(initial) ? "" : "disabled"}
      onclick="PawzoChat.jumpToContactInitial('${initial}')">${initial}</button>
  `).join("");

  target.innerHTML = `<input type="file" id="persona-import-file" accept=".png,.json,.zip" style="display:none" onchange="PawzoChat.personaImportSubmit(this)">
    <div class="page contacts-page" style="position:relative">${searchHtml}
      <div class="contacts-index-slot">
        <nav class="contacts-index" aria-label="通讯录字母索引"
          onpointerdown="PawzoChat.contactsIndexStart(event)"
          onpointermove="PawzoChat.contactsIndexMove(event)"
          onpointerup="PawzoChat.contactsIndexEnd(event)"
          onpointercancel="PawzoChat.contactsIndexEnd(event)">${indexHtml}</nav>
        <div class="contacts-index-bubble" id="contacts-index-bubble" aria-hidden="true"></div>
      </div>
      <div class="contacts-sections" id="persona-list">${sectionsHtml}</div>
      <div class="about-footer" aria-hidden="true" style="position:absolute;right:8px;bottom:4px;font-size:11px;line-height:1;color:var(--text-3);opacity:0.1;white-space:nowrap;pointer-events:none;user-select:none">i'w'y'x'd'x'l</div>
    </div>`;
}

/* ---- Persona Import ---- */

export function personaImportPick() {
  // Make sure the input exists even if user navigates to detail first.
  let input = $("persona-import-file");
  if (!input) {
    input = document.createElement("input");
    input.type = "file";
    input.id = "persona-import-file";
    input.accept = ".png,.json,.zip";
    input.style.display = "none";
    input.onchange = () => personaImportSubmit(input);
    document.body.appendChild(input);
  }
  input.value = "";
  input.click();
}

export async function personaImportSubmit(inputEl) {
  const file = inputEl?.files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);

  showLoading("导入中…");
  try {
    const base = window.PAWZOCHAT_BASE || "";
    const resp = await fetch(`${base}/api/personas/_import`, { method: "POST", body: fd });
    const data = await resp.json();
    if (resp.status >= 400) { toast(data?.error || "导入失败", "error"); return; }

    const warnings = data.warnings || [];
    const createdBooks = data.created_worldbooks || [];
    let msg = `已导入「${data.name}」`;
    if (createdBooks.length) {
      const names = createdBooks.map(b => b.name).join("、");
      msg += `，并创建世界书：${names}`;
    }
    toast(msg, "success");
    if (warnings.length) {
      // Show non-blocking dialog listing what was skipped.
      const items = warnings.map(w => `<li style="margin:4px 0">${esc(w)}</li>`).join("");
      showSheet(`<div style="padding:24px">
        <div class="sheet-title">导入提示</div>
        <ul style="text-align:left;margin:12px 0 20px;padding-left:20px;font-size:14px;color:var(--text-2);line-height:1.6">${items}</ul>
        <button onclick="PawzoChat.closeOverlay()" style="width:100%;padding:10px;border:none;border-radius:var(--radius-btn);background:var(--primary);color:#fff;font-size:15px;cursor:pointer;font-family:var(--font)">知道了</button>
      </div>`);
    }
    renderContacts();
  } catch (e) { toast("导入失败", "error"); }
  finally { hideLoading(); }
}

/* ---- Persona Export ---- */

export function personaExportPick(personaId) {
  const bookLabel = "导出时包含绑定世界书";
  const recommendedBadge = `<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:10px;background:var(--primary);color:#fff;font-size:11px;font-weight:500;vertical-align:1px">推荐</span>`;
  showSheet(`<div style="padding:20px">
    <div class="sheet-title">导出角色</div>
    <div class="form-hint" style="padding:8px 0 4px;text-align:left">选择导出格式：</div>
    <div class="card" style="margin:4px 0">
      <div class="card-row" style="cursor:pointer" onclick="PawzoChat._personaExportGo('${personaId}','bundle')">
        <div style="flex:1;min-width:0">
          <div style="font-size:15px">PawzoChat 原生包 (.zip)${recommendedBadge}</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">保留全部 PawzoChat 字段（记忆/主动消息/绑定书…），适合 PawzoChat 之间迁移</div>
        </div><span class="row-arrow">›</span>
      </div>
      <div class="card-row" style="cursor:pointer" onclick="PawzoChat._personaExportGo('${personaId}','png')">
        <div style="flex:1;min-width:0">
          <div style="font-size:15px">SillyTavern v3 PNG</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">含头像，酒馆/前端主流格式</div>
        </div><span class="row-arrow">›</span>
      </div>
      <div class="card-row" style="cursor:pointer" onclick="PawzoChat._personaExportGo('${personaId}','json_v3')">
        <div style="flex:1;min-width:0">
          <div style="font-size:15px">SillyTavern v3 JSON</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">纯 JSON（无头像）</div>
        </div><span class="row-arrow">›</span>
      </div>
    </div>
    <label class="card-row" style="cursor:pointer;margin:8px 0 12px">
      <input type="checkbox" id="pe-export-books" checked style="margin-right:10px">
      <div style="flex:1;min-width:0"><div style="font-size:14px">${bookLabel}</div>
      <div style="font-size:12px;color:var(--text-3);margin-top:2px">原生包独立打包；SillyTavern 格式合并为 character_book</div></div>
    </label>
    <button onclick="PawzoChat.closeOverlay()" style="width:100%;padding:10px;border:none;border-radius:var(--radius-btn);background:var(--bg);color:var(--text-2);font-size:15px;cursor:pointer;font-family:var(--font)">取消</button>
  </div>`);
}

export async function _personaExportGo(personaId, format) {
  const includeBooks = $("pe-export-books")?.checked !== false;
  if (format === "png") {
    // Defer so we can open a second sheet asking about cover image.
    closeOverlay();
    setTimeout(() => _personaExportPngPick(personaId, includeBooks), 100);
    return;
  }
  closeOverlay();
  showLoading("导出中…");
  try {
    const q = `?format=${encodeURIComponent(format)}&include_books=${includeBooks ? 1 : 0}`;
    await downloadFile(`/api/personas/${personaId}/_export${q}`, `${personaId}.bin`);
    toast("已开始下载", "success");
  } catch (e) {
    toast(e?.message || "导出失败", "error");
  } finally { hideLoading(); }
}

let _pendingExportCover = null;  // Blob | null
let _pendingExportCoverObjUrl = null;  // blob: URL to revoke
let _pendingExportOriginalAvatarUrl = "";  // snapshot of the dialog's original src

function _personaExportPngPick(personaId, includeBooks) {
  _pendingExportCover = null;
  if (_pendingExportCoverObjUrl) {
    URL.revokeObjectURL(_pendingExportCoverObjUrl);
    _pendingExportCoverObjUrl = null;
  }
  const base = window.PAWZOCHAT_BASE || "";
  const avUrl = `${base}/api/personas/${personaId}/avatar?t=${Date.now()}`;
  _pendingExportOriginalAvatarUrl = avUrl;
  showSheet(`<div style="padding:20px">
    <div class="sheet-title">导出 v3 PNG</div>
    <div class="form-hint" style="padding:8px 0 12px;text-align:left">卡片图像将作为角色数据的容器。你可以使用当前头像，或上传一张其它图片作为这张卡的封面。</div>
    <div style="display:flex;justify-content:center;margin:8px 0 16px">
      <img id="pe-export-cover-preview" src="${avUrl}" onerror="this.style.visibility='hidden'" style="width:120px;height:120px;border-radius:16px;object-fit:cover;border:1px solid var(--border);background:var(--bg)">
    </div>
    <input type="file" id="pe-export-cover-file" accept="image/*" style="display:none" onchange="PawzoChat._personaExportCoverSelected(this)">
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <button onclick="document.getElementById('pe-export-cover-file').click()" style="flex:1;padding:10px;border:1px solid var(--border);border-radius:var(--radius-btn);background:var(--bg);color:var(--text-1);font-size:14px;cursor:pointer;font-family:var(--font)">选择其它图片</button>
      <button onclick="PawzoChat._personaExportCoverReset()" id="pe-export-cover-reset" style="flex:1;padding:10px;border:1px solid var(--border);border-radius:var(--radius-btn);background:var(--bg);color:var(--text-2);font-size:14px;cursor:pointer;font-family:var(--font);display:none">还原当前头像</button>
    </div>
    <div style="display:flex;gap:12px">
      <button onclick="PawzoChat.closeOverlay()" style="flex:1;padding:10px;border:none;border-radius:var(--radius-btn);background:var(--bg);color:var(--text-2);font-size:15px;cursor:pointer;font-family:var(--font)">取消</button>
      <button onclick="PawzoChat._personaExportPngGo('${personaId}', ${includeBooks ? 1 : 0})" style="flex:1;padding:10px;border:none;border-radius:var(--radius-btn);background:var(--primary);color:#fff;font-size:15px;cursor:pointer;font-family:var(--font)">下载</button>
    </div>
  </div>`);
}

export function _personaExportCoverSelected(inputEl) {
  const file = inputEl?.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) { toast("请选择图片文件", "error"); return; }
  _pendingExportCover = file;
  if (_pendingExportCoverObjUrl) {
    URL.revokeObjectURL(_pendingExportCoverObjUrl);
  }
  _pendingExportCoverObjUrl = URL.createObjectURL(file);
  const preview = $("pe-export-cover-preview");
  if (preview) {
    preview.src = _pendingExportCoverObjUrl;
    preview.style.visibility = "";
  }
  const resetBtn = $("pe-export-cover-reset");
  if (resetBtn) resetBtn.style.display = "";
}

export function _personaExportCoverReset() {
  _pendingExportCover = null;
  if (_pendingExportCoverObjUrl) {
    URL.revokeObjectURL(_pendingExportCoverObjUrl);
    _pendingExportCoverObjUrl = null;
  }
  const preview = $("pe-export-cover-preview");
  if (preview && _pendingExportOriginalAvatarUrl) {
    preview.src = _pendingExportOriginalAvatarUrl;
    preview.style.visibility = "";
  }
  const resetBtn = $("pe-export-cover-reset");
  if (resetBtn) resetBtn.style.display = "none";
  const fileInput = $("pe-export-cover-file");
  if (fileInput) fileInput.value = "";
}

export async function _personaExportPngGo(personaId, includeBooksInt) {
  closeOverlay();
  showLoading("导出中…");
  try {
    const url = `/api/personas/${personaId}/_export`;
    const fd = new FormData();
    fd.append("format", "png");
    fd.append("include_books", includeBooksInt ? "1" : "0");
    if (_pendingExportCover) fd.append("avatar", _pendingExportCover, "cover.png");

    await downloadFile(url, `${personaId}.png`, { method: "POST", body: fd });
    toast("已开始下载", "success");
  } catch (e) {
    toast(e?.message || "导出失败", "error");
  } finally {
    _pendingExportCover = null;
    if (_pendingExportCoverObjUrl) {
      URL.revokeObjectURL(_pendingExportCoverObjUrl);
      _pendingExportCoverObjUrl = null;
    }
    _pendingExportOriginalAvatarUrl = "";
    hideLoading();
  }
}

export function filterPersonas(val) {
  const items = document.querySelectorAll(".persona-row");
  const v = val.toLowerCase();
  items.forEach(el => {
    el.style.display = el.textContent.toLowerCase().includes(v) ? "" : "none";
  });
  syncContactIndexAvailability();
}

/* ---- Persona Card / Settings ---- */

async function renderPersonaDetail(data) {
  const moreButton = `<button class="persona-card-more" type="button" title="角色设置" aria-label="打开角色设置"
    onclick="PawzoChat.pushPage('personaSettings',{personaId:'${data.personaId}'})">…</button>`;
  setTopBar("详细资料", true, moreButton);
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  try {
    const p = await api.get(`/api/personas/${data.personaId}`);
    const channelNames = { wechat: "微信", qq: "QQ", web: "网页" };
    const channel = channelNames[p.linked_channel] || p.linked_channel || "未绑定";
    const signature = (p.signature || "").trim() || "这个人很神秘，什么都没写";
    const detailAvUrl = personaAvatarUrl(p);
    const detailAvatar = detailAvUrl
      ? `<button class="persona-card-avatar-preview" type="button" aria-label="查看角色头像大图">
          ${avatarHtml(p.name, "lg", detailAvUrl)}
        </button>`
      : avatarHtml(p.name, "lg", detailAvUrl);

    content().innerHTML = `<div class="page persona-card-page">
      <section class="persona-card-identity" aria-label="角色名片">
        ${detailAvatar}
        <div class="persona-card-name-wrap">
          <div class="persona-card-name">${esc(p.name)}</div>
          <div class="persona-card-subtitle">PawzoChat 角色</div>
        </div>
      </section>

      <section class="persona-card-info">
        <div class="persona-card-field">
          <span class="persona-card-label">个性签名</span>
          <span class="persona-card-value">${esc(signature)}</span>
        </div>
        <div class="persona-card-field">
          <span class="persona-card-label">连接通道</span>
          <span class="persona-card-value">${esc(channel)}</span>
        </div>
      </section>

      <section class="card persona-card-links" aria-label="更多资料">
        <button type="button" class="card-row persona-moments-entry"
          aria-label="查看${esc(p.name)}的朋友圈"
          onclick="PawzoChat.openPersonaMoments('${esc(p.id)}')">
          <span class="row-label">朋友圈</span>
          <span class="persona-moments-entry-previews" id="persona-moments-previews" aria-hidden="true"></span>
          <span class="row-arrow" aria-hidden="true">›</span>
        </button>
      </section>

      <div class="persona-card-actions">
        <button class="btn-primary" onclick="PawzoChat.chatWithPersona('${p.id}')">发消息</button>
      </div>
    </div>`;

    content().querySelector(".persona-card-avatar-preview")?.addEventListener("click", (event) => {
      event.stopPropagation();
      openImagePreview(detailAvUrl);
    });

    // Optional recent-image previews for the 朋友圈 entry (best-effort).
    _fillPersonaMomentsPreviews(p.id);
  } catch (e) { toast("加载失败", "error"); }
}

async function _fillPersonaMomentsPreviews(personaId) {
  const host = $("persona-moments-previews");
  if (!host || !personaId) return;
  try {
    const res = await api.get(
      `/api/moments?author=${encodeURIComponent(personaId)}&limit=8`,
    );
    const thumbs = [];
    for (const m of (res.moments || [])) {
      for (const fn of (m.images || [])) {
        if (!fn) continue;
        thumbs.push(
          `/api/moments/images/${encodeURIComponent(m.id)}/${encodeURIComponent(fn)}`,
        );
        if (thumbs.length >= 3) break;
      }
      if (thumbs.length >= 3) break;
    }
    if (!thumbs.length) {
      host.innerHTML = "";
      return;
    }
    const base = window.PAWZOCHAT_BASE || "";
    host.innerHTML = thumbs.map(u =>
      `<span class="persona-moments-entry-thumb" style="background-image:url('${base}${u}')"></span>`
    ).join("");
  } catch (e) {
    host.innerHTML = "";
  }
}

async function renderPersonaSettings(data) {
  const topBtns = `<button class="btn-text" onclick="PawzoChat.personaExportPick('${data.personaId}')" style="font-size:15px;font-weight:500;padding:8px 8px">导出</button>
    <button class="btn-text" onclick="PawzoChat.pushPage('personaEdit',{personaId:'${data.personaId}'})" style="font-size:15px;font-weight:500;padding:8px 8px">编辑</button>`;
  setTopBar("角色设置", true, topBtns);
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  try {
    const [p, momentsSettings] = await Promise.all([
      api.get(`/api/personas/${data.personaId}`),
      api.get("/api/moments/settings").catch(() => ({})),
    ]);
    const prov = p.llm_provider || "未配置";
    const model = p.llm_model || "未选择";

    const pro = p.proactive || {};
    const proEnabled = !!pro.enabled;
    const proIntervalText = `${pro.min_idle_hours ?? 1.0}–${pro.max_idle_hours ?? 3.0} 小时`;
    const proConsecutiveText = `${pro.max_consecutive ?? 3} 条`;
    const qh = pro.quiet_hours || {};
    const proQuietText = qh.enabled !== false
      ? `${esc(qh.start || "22:00")} – ${esc(qh.end || "08:00")}`
      : "已关闭";

    const momentCanPublish = (momentsSettings.publishers || []).includes(p.id);
    const momentCanReply = (momentsSettings.repliers || []).includes(p.id);
    const momentMemoryEnabled = momentsSettings.memory_enabled?.[p.id] !== false;
    const momentProbability = _momentProbability(momentsSettings, p.id);

    const ig = p.image_generation || {};
    const igEnabled = !!ig.enabled;
    const refModeMap = { avatar: "使用角色头像", custom: "使用自定义形象图", none: "不使用参考图" };
    const refModeText = refModeMap[ig.ref_mode] || refModeMap.avatar;
    const refImgRow = ig.ref_mode === "custom"
      ? `<div class="card-row"><span class="row-label">自定义参考图</span><span class="row-value" style="${p.has_image_ref ? '' : 'font-style:italic;color:var(--text-3)'}">${p.has_image_ref ? '已上传' : '未上传'}</span></div>`
      : "";
    const trunc = (s, n) => {
      const t = (s || "").trim();
      return t.length > n ? esc(t.slice(0, n)) + "…" : esc(t || "未填写");
    };
    const truncStyle = (s, n) => (s || "").trim() ? '' : 'font-style:italic;color:var(--text-3)';

    const detailAvUrl = personaAvatarUrl(p);
    content().innerHTML = `<div class="page">
      <div class="persona-header">
        ${avatarHtml(p.name, "lg", detailAvUrl)}
        <div class="name">${esc(p.name)}</div>
      </div>
      <div class="card">
        <div class="card-row"><span class="row-label">服务商</span><span class="row-value">${esc(prov)}</span></div>
        <div class="card-row"><span class="row-label">模型</span><span class="row-value" style="${p.llm_model ? '' : 'font-style:italic;color:var(--text-3)'}">${esc(model)}</span></div>
        <div class="card-row"><span class="row-label">温度</span><span class="row-value">${p.temperature}</span></div>
        <div class="card-row"><span class="row-label">最大 Token</span><span class="row-value">${p.max_tokens}</span></div>
      </div>
      <div class="card">
        <div class="card-header">表情包</div>
        <div class="card-row"><span class="row-label">启用</span><span class="row-value">${p.emoji_enabled ? '已开启' : '已关闭'}</span></div>
        <div class="card-row"><span class="row-label">分组</span><span class="row-value" style="${p.emoji_group ? '' : 'font-style:italic;color:var(--text-3)'}">${esc(p.emoji_group || '未选择')}</span></div>
        <div class="card-row"><span class="row-label">发送概率</span><span class="row-value">${p.emoji_send_probability}%</span></div>
      </div>
      <div class="card">
        <div class="card-header">记忆</div>
        <div class="card-row"><span class="row-label">状态</span><span class="row-value">${p.memory?.enabled !== false ? '已开启' : '已关闭'}</span></div>
        <div class="card-row"><span class="row-label">记忆条数</span><span class="row-value">${p.memory_count || 0} 条</span></div>
        <div class="card-row" style="cursor:pointer" onclick="PawzoChat.pushPage('memoryManage',{personaId:'${p.id}'})">
          <span class="row-label">管理记忆</span><span class="row-arrow">›</span>
        </div>
      </div>
      <div class="card">
        <div class="card-header">朋友圈</div>
        <div class="card-row"><span class="row-label">允许发布</span><span class="row-value">${momentCanPublish ? '已开启' : '已关闭'}</span></div>
        <div class="card-row"><span class="row-label">允许回复</span><span class="row-value">${momentCanReply ? '已开启' : '已关闭'}</span></div>
        <div class="card-row"><span class="row-label">写入记忆</span><span class="row-value">${momentMemoryEnabled ? '已开启' : '已关闭'}</span></div>
        <div class="card-row"><span class="row-label">触发回复概率</span><span class="row-value">${momentProbability}%</span></div>
      </div>
      <div class="card">
        <div class="card-header">主动消息</div>
        <div class="card-row"><span class="row-label">状态</span><span class="row-value">${proEnabled ? '已开启' : '已关闭'}</span></div>
        <div class="card-row"><span class="row-label">触发间隔</span><span class="row-value">${proIntervalText}</span></div>
        <div class="card-row"><span class="row-label">连续上限</span><span class="row-value">${proConsecutiveText}</span></div>
        <div class="card-row"><span class="row-label">静默时段</span><span class="row-value">${proQuietText}</span></div>
      </div>
      <div class="card">
        <div class="card-header">生图选项</div>
        <div class="card-row"><span class="row-label">状态</span><span class="row-value">${igEnabled ? '已开启' : '已关闭'}</span></div>
        <div class="card-row"><span class="row-label">服务商</span><span class="row-value" style="${truncStyle(ig.provider, 0)}">${esc(ig.provider || "未配置")}</span></div>
        <div class="card-row"><span class="row-label">模型</span><span class="row-value" style="${truncStyle(ig.model, 0)}">${esc(ig.model || "未选择")}</span></div>
        <div class="card-row card-row-multiline"><span class="row-label">画面风格</span><span class="row-value" style="${truncStyle(ig.art_style, 0)}">${trunc(ig.art_style, 40)}</span></div>
        <div class="card-row"><span class="row-label">负面提示词</span><span class="row-value">${ig.negative_enabled !== false ? '已开启' : '已关闭'}</span></div>
        <div class="card-row"><span class="row-label">参考图模式</span><span class="row-value">${esc(refModeText)}</span></div>
        ${refImgRow}
      </div>
      ${(() => {
        const vg = p.voice_generation || {};
        return `<div class="card">
        <div class="card-header">语音选项</div>
        <div class="card-row"><span class="row-label">状态</span><span class="row-value">${vg.enabled ? '已开启' : '已关闭'}</span></div>
        <div class="card-row"><span class="row-label">服务商</span><span class="row-value" style="${truncStyle(vg.provider, 0)}">${esc(vg.provider || "未配置")}</span></div>
        <div class="card-row"><span class="row-label">模型</span><span class="row-value" style="${truncStyle(vg.model, 0)}">${esc(vg.model || "未选择")}</span></div>
        <div class="card-row"><span class="row-label">语速</span><span class="row-value">${vg.speed ?? 1.0}x</span></div>
        <div class="card-row"><span class="row-label">音色</span><span class="row-value" style="${truncStyle(vg.voice, 0)}">${esc(vg.voice || "模型默认")}</span></div>
      </div>`;
      })()}
      <div class="persona-actions">
        <button class="btn-text danger mt-8" onclick="PawzoChat.deletePersona('${p.id}')">删除</button>
      </div>
    </div>`;
  } catch (e) { toast("加载失败", "error"); }
}

export async function chatWithPersona(personaId) {
  const restored = await api.put(
    `/api/conversations/${encodeURIComponent(personaId)}/visibility`,
    { hidden: false },
  );
  if (restored.status === 404) {
    const created = await api.post("/api/conversations", { persona_id: personaId });
    if (created.status >= 400 && created.status !== 409) {
      toast(created.data?.error || "创建失败", "error");
      return;
    }
  } else if (restored.status >= 400) {
    toast(restored.data?.error || "打开对话失败", "error");
    return;
  }

  navigateToPage("chat", "chatWindow", { personaId }, { collapsePreviousTarget: true });
}

export async function deletePersona(personaId) {
  const ok = await confirm("删除角色", "确认删除该角色？相关对话也会被删除。", true);
  if (!ok) return;
  showLoading("删除中…");
  try {
    await api.del(`/api/personas/${personaId}?delete_conversation=true`);
    toast("已删除", "success");
    goBack();
    refreshSidebar();
  } catch (e) { toast("操作失败", "error"); }
  finally { hideLoading(); }
}

/* ---- Persona Edit ---- */

async function renderPersonaEdit(data = {}) {
  _pendingAvatarBlob = null;
  const isNew = data.isNew;
  const openDetailAfterSave = data.openDetailAfterSave === true;
  setTopBar(isNew ? "新建角色" : "编辑角色", true,
    `<button class="btn-text" onclick="PawzoChat.savePersona(${isNew},${openDetailAfterSave})" style="font-size:15px;font-weight:500">保存</button>`
  );

  let providers = [];
  let emojiGroups = [];
  let imageProviders = [];
  let voiceProviders = [];
  let voicePresetVoices = {};
  let momentsSettings = {};
  try {
    const [provRes, emojiRes, imgRes, voiceRes, momentsRes] = await Promise.all([
      api.get("/api/providers"),
      api.get("/api/emoji/groups"),
      api.get("/api/image-providers"),
      api.get("/api/voice-providers"),
      api.get("/api/moments/settings").catch(() => ({})),
    ]);
    providers = provRes.providers || [];
    emojiGroups = emojiRes.groups || [];
    imageProviders = (imgRes.providers || []).filter(pr => pr.api_key_set && (pr.models || []).length > 0);
    voiceProviders = (voiceRes.providers || []).filter(pr => pr.api_key_set && (pr.models || []).length > 0);
    voicePresetVoices = voiceRes.preset_voices || {};
    momentsSettings = momentsRes || {};
  } catch (e) { /* silent */ }

  // Defaults for a brand-new persona. Keep proactive defaults in sync with
  // pawzochat/transport/models.py:PROACTIVE_DEFAULTS (the Python side is the
  // source of truth; duplicated here only so the new-persona form can render
  // before any API call).
  let p = { id: "", name: "", signature: "", llm_provider: "", llm_model: "", temperature: 1.0, max_tokens: 2000,
            character_prompt: "", output_examples: "", system_instructions: "",
            emoji_enabled: false, emoji_send_probability: 25, emoji_group: "", has_avatar: false,
            memory: { enabled: true, max_memories: 50, include_in_prompt: true, trigger_rounds: 10 }, memory_count: 0,
            proactive: {
              enabled: false, min_idle_hours: 1.0, max_idle_hours: 3.0, max_consecutive: 3,
              prompt: "用户已经一段时间没有回复了。请根据角色设定与近期对话，主动发起一条贴合角色的简短消息。",
              quiet_hours: { enabled: true, start: "22:00", end: "08:00" },
            },
            image_generation: { enabled: false, provider: "", model: "", style_prefix: "",
              art_style: "anime style, masterpiece, best quality",
              negative_prompt: "low quality, blurry, watermark, text, signature, lowres, bad anatomy, extra fingers, jpeg artifacts",
              negative_enabled: true,
              ref_mode: "avatar", custom_ref_filename: "" },
            has_image_ref: false,
            voice_generation: { enabled: false, provider: "", model: "", voice: "", speed: 1.0 },
            bound_worldbooks: [],
            wechat_chat_type: "" };
  if (!isNew && data.personaId) {
    try {
      p = await api.get(`/api/personas/${data.personaId}`);
    } catch (e) { /* silent */ }
  }

  const momentPublishers = new Set(momentsSettings.publishers || []);
  const momentRepliers = new Set(momentsSettings.repliers || []);
  const momentProbability = _momentProbability(momentsSettings, p.id);
  const momentMemoryEnabled = momentsSettings.memory_enabled?.[p.id] !== false;

  _peBoundWorldbooks = Array.isArray(p.bound_worldbooks) ? [...p.bound_worldbooks] : [];
  _peWorldbookSummary = await fetchWorldbookSummary();
  const worldbookReady = _peWorldbookSummary.ok !== false;

  const provOptions = providers.map(pr => `<option value="${esc(pr.name)}" ${pr.name === p.llm_provider ? "selected" : ""}>${esc(pr.name)}</option>`).join("");
  const groupOptions = emojiGroups.map(g => `<option value="${esc(g.name)}" ${g.name === p.emoji_group ? "selected" : ""}>${esc(g.name)} (${g.total_images})</option>`).join("");

  function buildModelOptions(provName) {
    const prov = providers.find(pr => pr.name === provName);
    const models = prov?.models || [];
    const hasSelection = models.some(m => m.id === p.llm_model);
    let opts = `<option value="" disabled ${hasSelection ? "" : "selected"}>选择模型</option>`;
    for (const m of models) {
      const caps = (m.capabilities || []).map(c => CAP_ICONS[c] || "").join("");
      const sel = m.id === p.llm_model ? "selected" : "";
      opts += `<option value="${esc(m.id)}" ${sel}>${esc(m.name || m.id)} ${caps}</option>`;
    }
    return opts;
  }

  window._peProviders = providers;
  window._peBuildModelOptions = buildModelOptions;
  window._peCapIcons = CAP_ICONS;

  function buildImgProviderOptions(selectedName) {
    let opts = `<option value="">选择服务商</option>`;
    const selectedExists = imageProviders.some(ip => ip.name === selectedName);
    if (selectedName && !selectedExists) {
      opts += `<option value="${esc(selectedName)}" selected disabled>${esc(selectedName)}（不可用）</option>`;
    }
    for (const ip of imageProviders) {
      const sel = ip.name === selectedName ? "selected" : "";
      opts += `<option value="${esc(ip.name)}" ${sel}>${esc(ip.name)}</option>`;
    }
    return opts;
  }
  function buildImgModelOptions(provName, selectedId) {
    const prov = imageProviders.find(ip => ip.name === provName);
    const models = prov?.models || [];
    if (!models.length && selectedId) {
      return `<option value="${esc(selectedId)}" selected disabled>${esc(selectedId)}（不可用）</option>`;
    }
    if (!models.length) return `<option value="" disabled selected>该服务商下没有模型</option>`;
    let opts = `<option value="">选择模型</option>`;
    const selectedExists = models.some(m => m.id === selectedId);
    if (selectedId && !selectedExists) {
      opts += `<option value="${esc(selectedId)}" selected disabled>${esc(selectedId)}（不可用）</option>`;
    }
    for (const m of models) {
      const sel = m.id === selectedId ? "selected" : "";
      opts += `<option value="${esc(m.id)}" ${sel}>${esc(m.name || m.id)}</option>`;
    }
    return opts;
  }
  window._peBuildImgModelOptions = buildImgModelOptions;

  function buildVoiceProviderOptions(selectedName) {
    let opts = `<option value="">选择服务商</option>`;
    const selectedExists = voiceProviders.some(vp => vp.name === selectedName);
    if (selectedName && !selectedExists) {
      opts += `<option value="${esc(selectedName)}" selected disabled>${esc(selectedName)}（不可用）</option>`;
    }
    for (const vp of voiceProviders) {
      const sel = vp.name === selectedName ? "selected" : "";
      opts += `<option value="${esc(vp.name)}" ${sel}>${esc(vp.name)}</option>`;
    }
    return opts;
  }
  function buildVoiceModelOptions(provName, selectedId) {
    const prov = voiceProviders.find(vp => vp.name === provName);
    const models = prov?.models || [];
    if (!models.length && selectedId) {
      return `<option value="${esc(selectedId)}" selected disabled>${esc(selectedId)}（不可用）</option>`;
    }
    if (!models.length) return `<option value="" disabled selected>该服务商下没有模型</option>`;
    let opts = `<option value="">选择模型</option>`;
    const selectedExists = models.some(m => m.id === selectedId);
    if (selectedId && !selectedExists) {
      opts += `<option value="${esc(selectedId)}" selected disabled>${esc(selectedId)}（不可用）</option>`;
    }
    for (const m of models) {
      const sel = m.id === selectedId ? "selected" : "";
      opts += `<option value="${esc(m.id)}" ${sel}>${esc(m.name || m.id)}</option>`;
    }
    return opts;
  }
  window._peVoiceProviders = voiceProviders;
  window._peVoicePresetVoices = voicePresetVoices;
  window._peBuildVoiceModelOptions = buildVoiceModelOptions;

  const initialModelOpts = p.llm_provider ? buildModelOptions(p.llm_provider) : `<option value="" disabled selected>先选择服务商</option>`;

  const editAvUrl = personaAvatarUrl(p);

  content().innerHTML = `<div class="page">
    <input type="hidden" id="pe-id" value="${esc(p.id)}">
    <input type="file" id="pe-avatar-input" accept="image/*" style="display:none" onchange="PawzoChat.onAvatarFileSelected(this)">
    <div class="card">
      <div class="card-header">基础信息</div>
      <div class="form-group" style="display:flex;justify-content:center;padding:12px 0 4px">
        <div class="avatar-upload-wrap" onclick="document.getElementById('pe-avatar-input').click()">
          ${avatarHtml(p.name, "lg", editAvUrl)}
          <div class="avatar-cam">${_CAM_SVG}</div>
        </div>
      </div>
      <div class="form-group"><div class="form-row"><label>角色名称</label><input id="pe-name" value="${esc(p.name)}" placeholder="输入角色名称"></div></div>
      <div class="form-group"><div class="form-row"><label>人物签名</label><input id="pe-signature" value="${esc(p.signature || "")}" maxlength="100" placeholder="展示在通讯录中的一句话"></div></div>
    </div>
    <div class="sub-tabs" role="tablist">
      <button type="button" class="sub-tab active" data-petab="detail" onclick="PawzoChat.switchPersonaEditTab('detail')">角色详情</button>
      <button type="button" class="sub-tab" data-petab="persona" onclick="PawzoChat.switchPersonaEditTab('persona')">角色人设</button>
      <button type="button" class="sub-tab" data-petab="image" onclick="PawzoChat.switchPersonaEditTab('image')">生图选项</button>
      <button type="button" class="sub-tab" data-petab="voice" onclick="PawzoChat.switchPersonaEditTab('voice')">语音选项</button>
    </div>
    <div id="pe-panel-detail">
    <div class="card">
      <div class="card-header">模型配置</div>
      <div class="form-group"><div class="form-row"><label>服务商</label><select id="pe-provider" onchange="PawzoChat.onPersonaProviderChange()"><option value="">选择服务商</option>${provOptions}</select></div></div>
      <div class="form-group"><div class="form-row"><label>模型</label><select id="pe-model">${initialModelOpts}</select></div></div>
      <div class="form-group">
        <div class="form-row"><label>温度</label>
          <div class="slider-wrap"><input type="range" id="pe-temp" min="0" max="2" step="0.1" value="${p.temperature}" oninput="this.nextElementSibling.textContent=this.value"><span class="slider-val">${p.temperature}</span></div>
        </div>
      </div>
      <div class="form-group"><div class="form-row"><label>最大 Token</label><input type="number" id="pe-tokens" value="${p.max_tokens}" min="100" max="100000"></div></div>
    </div>
    <div class="card">
      <div class="card-header">表情包</div>
      <div class="form-group"><div class="form-row"><label>启用表情包</label>
        <label class="switch-wrap"><input type="checkbox" id="pe-emoji-en" ${p.emoji_enabled ? "checked" : ""}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-group"><div class="form-row"><label>表情包分组</label><select id="pe-emoji-group"><option value="">未选择</option>${groupOptions}</select></div></div>
      <div class="form-group"><div class="form-row"><label>发送概率</label>
        <div class="slider-wrap"><input type="range" id="pe-emoji-prob" min="0" max="100" step="1" value="${p.emoji_send_probability}" oninput="this.nextElementSibling.textContent=this.value+'%'"><span class="slider-val">${p.emoji_send_probability}%</span></div>
      </div></div>
      <div class="form-hint">每次回复后按概率自动发送该分组中匹配情绪的表情包</div>
    </div>
    <div class="card">
      <div class="card-header">记忆设置</div>
      <div class="form-group"><div class="form-row"><label>启用记忆</label>
        <label class="switch-wrap"><input type="checkbox" id="pe-mem-en" ${p.memory?.enabled !== false ? "checked" : ""}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-hint">开启后 AI 会在对话中自主记录和更新记忆（需模型支持工具调用），也可在下方手动管理</div>
      <div class="form-group"><div class="form-row"><label>最大记忆条数</label>
        <div class="stepper"><button onclick="PawzoChat.step('pe-mem-max',-1)">−</button><span class="stepper-val" id="pe-mem-max">${p.memory?.max_memories || 50}</span><button onclick="PawzoChat.step('pe-mem-max',1)">+</button></div>
      </div></div>
      <div class="form-group"><div class="form-row"><label>包含在提示词</label>
        <label class="switch-wrap"><input type="checkbox" id="pe-mem-inc" ${p.memory?.include_in_prompt !== false ? "checked" : ""}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-hint">开启后将所有记忆注入 LLM 上下文；关闭后 AI 看不到已有记忆，也无法更新它们</div>
      <div class="form-group"><div class="form-row"><label>触发方式</label>
        <select id="pe-mem-trigger-mode" onchange="PawzoChat.onPeMemTriggerModeChange()">
          <option value="remind" ${(p.memory?.trigger_mode || "remind") !== "summarize" ? "selected" : ""}>提醒 AI 记录（默认）</option>
          <option value="summarize" ${p.memory?.trigger_mode === "summarize" ? "selected" : ""}>自动总结对话</option>
        </select>
      </div></div>
      <div class="form-group"><div class="form-row"><label>触发轮数</label>
        <div class="stepper"><button onclick="PawzoChat.step('pe-mem-trigger',-1,0)">−</button><span class="stepper-val" id="pe-mem-trigger">${p.memory?.trigger_rounds || 0}</span><button onclick="PawzoChat.step('pe-mem-trigger',1,0)">+</button></div>
      </div></div>
      <div class="form-hint" id="pe-mem-trigger-hint">${(p.memory?.trigger_mode || "remind") === "summarize"
        ? "每积累 N 轮未总结的对话，自动调用一次 LLM 将其总结为一条记忆；设为 0 禁用自动总结（AI 仍可通过工具主动记录，主动记录后计数顺延）"
        : "设置 N > 0 时，AI 每 N 轮对话未记录记忆则收到一次提醒；设为 0 禁用提醒"}</div>
      ${!isNew && p.id ? `<div style="padding:8px 16px 12px">
        <button class="btn-outline" onclick="PawzoChat.pushPage('memoryManage',{personaId:'${p.id}'})" style="width:100%">管理记忆 (${p.memory_count || 0} 条)</button>
      </div>` : ''}
    </div>
    <div class="card">
      <div class="card-header">朋友圈</div>
      <div class="form-group"><div class="form-row"><label>允许发布朋友圈</label>
        <label class="switch-wrap"><input type="checkbox" id="pe-moments-publish" ${momentPublishers.has(p.id) ? "checked" : ""}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-group"><div class="form-row"><label>允许回复朋友圈</label>
        <label class="switch-wrap"><input type="checkbox" id="pe-moments-reply" ${momentRepliers.has(p.id) ? "checked" : ""}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-group"><div class="form-row"><label>朋友圈写入记忆</label>
        <label class="switch-wrap"><input type="checkbox" id="pe-moments-memory" ${momentMemoryEnabled ? "checked" : ""}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-group"><div class="form-row"><label>触发回复概率</label>
        <div class="slider-wrap"><input type="range" id="pe-moments-prob" min="0" max="100" step="1" value="${momentProbability}" oninput="this.nextElementSibling.textContent=this.value+'%'"><span class="slider-val">${momentProbability}%</span></div>
      </div></div>
      <div class="form-hint">发布用于刷新时生成朋友圈；回复概率仅在允许回复时生效</div>
    </div>
    ${(() => {
      const pro = p.proactive || {};
      const qh = pro.quiet_hours || {};
      const ch = p.linked_channel || "";
      const isGroup = p.wechat_chat_type === "group";
      // QQ is passive-reply only — proactive sends are never delivered, so the
      // card is disabled the same way the WeChat-group case is.
      const proDisabled = isGroup || ch === "qq";
      const dis = proDisabled ? "disabled" : "";
      const cardStyle = proDisabled ? 'style="opacity:0.55"' : '';
      const disabledHint = isGroup
        ? '<div class="form-hint" style="color:var(--danger,#d33)">openclaw 不支持群聊主动消息，已禁用</div>'
        : (ch === "qq"
          ? '<div class="form-hint" style="color:var(--danger,#d33)">QQ 通道仅支持被动回复，主动消息不可用</div>'
          : '');
      const limitNote = ch === "wechat" ? `<div class="form-hint" style="background:var(--primary-light);color:var(--text-2);padding:10px 12px;margin:0 16px 4px;border-radius:8px;line-height:1.6">
        <div style="color:var(--primary);font-weight:500;margin-bottom:2px">微信通道限制</div>
        · 只能在用户最近一次消息 <b>24 小时内</b> 回复，超时后该角色的主动消息会被跳过<br>
        · 用户每次发消息后，微信最多接受机器人 <b>10 条</b> 连续回复；配额用完后主动消息会自动跳过，等用户再次发言后恢复
      </div>` : '';
      return `<div class="card" ${cardStyle}>
      <div class="card-header">主动消息</div>
      ${disabledHint}
      ${limitNote}
      <div class="form-group"><div class="form-row"><label>启用</label>
        <label class="switch-wrap"><input type="checkbox" id="pe-pro-en" ${pro.enabled ? "checked" : ""} ${dis}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-group"><div class="form-row"><label>最小间隔（小时）</label>
        <input type="number" id="pe-pro-min" value="${pro.min_idle_hours ?? 1.0}" min="0" step="0.1" ${dis}>
      </div></div>
      <div class="form-group"><div class="form-row"><label>最大间隔（小时）</label>
        <input type="number" id="pe-pro-max" value="${pro.max_idle_hours ?? 3.0}" min="0" step="0.1" ${dis}>
      </div></div>
      <div class="form-hint">用户最近一次回复后，等待 [最小,最大] 区间内的随机时长再触发</div>
      <div class="form-group"><div class="form-row"><label>连续上限</label>
        <div class="stepper"><button onclick="PawzoChat.step('pe-pro-max-consec',-1)" ${dis}>−</button><span class="stepper-val" id="pe-pro-max-consec">${pro.max_consecutive ?? 3}</span><button onclick="PawzoChat.step('pe-pro-max-consec',1)" ${dis}>+</button></div>
      </div></div>
      <div class="form-hint">用户回消息前最多连续触发的主动消息条数</div>
      <div class="form-group"><div class="form-row"><label>静默时段</label>
        <label class="switch-wrap"><input type="checkbox" id="pe-pro-qh-en" ${qh.enabled !== false ? "checked" : ""} ${dis}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-group"><div class="form-row"><label>开始时间</label>
        <input type="time" id="pe-pro-qh-start" value="${esc(qh.start || "22:00")}" ${dis}>
      </div></div>
      <div class="form-group"><div class="form-row"><label>结束时间</label>
        <input type="time" id="pe-pro-qh-end" value="${esc(qh.end || "08:00")}" ${dis}>
      </div></div>
      <div class="form-hint">静默时段内不会触发主动消息（支持跨午夜）</div>
      <div class="form-group" style="padding:0 16px"><label style="display:block;font-size:13px;color:var(--text-2);margin:8px 0 4px">自定义提示词</label>
        <textarea class="form-textarea" id="pe-pro-prompt" rows="3" placeholder="留空使用默认" ${dis}>${esc(pro.prompt || "")}</textarea>
      </div>
    </div>`;
    })()}
    </div>
    <div id="pe-panel-image" hidden>
    ${(() => {
      const ig = p.image_generation || {};
      const noProviders = imageProviders.length === 0;
      const canDisableUnavailable = noProviders && ig.enabled;
      const fieldDisabled = noProviders ? "disabled" : "";
      const checkboxDisabled = noProviders && !canDisableUnavailable ? "disabled" : "";
      const provOpts = buildImgProviderOptions(ig.provider || "");
      const modelOpts = ig.provider ? buildImgModelOptions(ig.provider, ig.model || "") : `<option value="" disabled selected>先选择服务商</option>`;
      const refMode = ig.ref_mode || "avatar";
      const refUrl = (!isNew && p.id && p.has_image_ref)
        ? `${window.PAWZOCHAT_BASE || ""}/api/personas/${p.id}/image_ref?t=${Date.now()}`
        : "";
      const customDisp = refMode === "custom" ? "" : "display:none";
      const newDisabled = isNew ? "disabled" : "";
      return `
    <div class="form-hint" style="background:var(--primary-light);color:var(--text-2);padding:10px 12px;margin:8px 16px 12px;border-radius:8px;line-height:1.6">
      开启后该角色可以在合适的对话场景下（如"拍个照"、"看看你在干嘛"）自主调用 AI 生图，并以图片消息回复。
    </div>
    ${noProviders ? '<div class="form-hint" style="color:var(--danger,#d33);padding:0 16px 8px">尚未配置可用的生图服务商。请先到「设置 → 生图服务商」中添加；已启用的角色仍可在这里关闭生图。</div>' : ''}

    <div class="card">
      <div class="card-header">服务商配置</div>
      <div class="form-group"><div class="form-row"><label>启用 AI 生图</label>
        <label class="switch-wrap"><input type="checkbox" id="pe-img-en" ${ig.enabled ? "checked" : ""} ${checkboxDisabled}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-group"><div class="form-row"><label>服务商</label>
        <select id="pe-img-provider" onchange="PawzoChat.onPersonaImageProviderChange()" ${fieldDisabled}>${provOpts}</select>
      </div></div>
      <div class="form-group"><div class="form-row"><label>模型</label>
        <select id="pe-img-model" ${fieldDisabled}>${modelOpts}</select>
      </div></div>
      <div class="form-group"><div class="form-row"><label>参考图模式</label>
        <select id="pe-img-ref-mode" onchange="PawzoChat.onPeImgRefModeChange()" ${fieldDisabled}>
          <option value="avatar" ${refMode === "avatar" ? "selected" : ""}>使用角色头像（默认）</option>
          <option value="custom" ${refMode === "custom" ? "selected" : ""}>使用自定义形象图</option>
          <option value="none" ${refMode === "none" ? "selected" : ""}>不使用参考图</option>
        </select>
      </div></div>
      <div class="form-hint">参考图会传给支持的图模型（NanoBanana、NovelAI 等），帮助保持人物外观一致；OpenAI /images/generations 不支持，会自动忽略。</div>
    </div>

    <div class="card" id="pe-img-ref-custom-block" style="${customDisp}">
      <div class="card-header">自定义参考图</div>
      <input type="file" id="pe-img-ref-input" accept="image/*" style="display:none" onchange="PawzoChat.onPeImgRefFileSelected(this)">
      <div class="form-group" style="display:flex;justify-content:center;padding:8px 0">
        <img id="pe-img-ref-preview" src="${refUrl}" alt=""
             style="max-width:160px;max-height:160px;border-radius:8px;background:var(--primary-light);${refUrl ? "" : "display:none"}">
        <div id="pe-img-ref-empty" style="${refUrl ? "display:none" : ""};padding:16px 24px;color:var(--text-3);background:var(--primary-light);border-radius:8px;font-size:13px">尚未上传</div>
      </div>
      <div class="form-group" style="display:flex;gap:8px;padding:0 16px 12px;border-top:none">
        <button class="btn-outline" style="flex:1" ${newDisabled} onclick="document.getElementById('pe-img-ref-input').click()">上传 / 替换</button>
        <button class="btn-outline" style="flex:1" ${newDisabled} onclick="PawzoChat.deletePersonaRefImage()">删除</button>
      </div>
      ${isNew ? '<div class="form-hint" style="color:var(--danger,#d33)">请先保存角色后再上传自定义参考图</div>' : ''}
    </div>

    <div class="card">
      <div class="card-header">画面风格</div>
      <div class="form-group" style="padding:0 16px 4px">
        <textarea class="form-textarea" id="pe-img-art-style" rows="2" placeholder="例：anime style, masterpiece, best quality" ${fieldDisabled}>${esc(ig.art_style ?? "")}</textarea>
      </div>
      <div class="form-hint">描述画风（动漫/写实/油画…），会拼到每次生图 prompt 最前。</div>
    </div>

    <div class="card">
      <div class="card-header">角色形象提示</div>
      <div class="form-group" style="padding:0 16px 4px">
        <textarea class="form-textarea" id="pe-img-style" rows="3" placeholder="例：1girl, silver hair, blue eyes, school uniform" ${fieldDisabled}>${esc(ig.style_prefix || "")}</textarea>
      </div>
      <div class="form-hint">描述角色固定形象（发色/服饰/外貌特征），跟在画面风格之后，用于保持角色一致。</div>
    </div>

    <div class="card">
      <div class="card-header-row">
        <span class="card-header" style="flex:1;padding:0">负面提示词</span>
        <label class="switch-wrap"><input type="checkbox" id="pe-img-neg-en" ${ig.negative_enabled !== false ? "checked" : ""} ${fieldDisabled}><span class="switch-track"></span></label>
      </div>
      <div class="form-group" style="padding:8px 16px 4px;border-top:none">
        <textarea class="form-textarea" id="pe-img-neg" rows="3" placeholder="不希望出现的内容" ${fieldDisabled}>${esc(ig.negative_prompt ?? "")}</textarea>
      </div>
      <div class="form-hint">关闭开关后将不发送负面提示词，避免不支持的服务商被干扰。</div>
    </div>`;
    })()}
    </div>
    <div id="pe-panel-voice" hidden>
    ${(() => {
      const vg = p.voice_generation || {};
      const noProviders = voiceProviders.length === 0;
      const canDisableUnavailable = noProviders && vg.enabled;
      const fieldDisabled = noProviders ? "disabled" : "";
      const checkboxDisabled = noProviders && !canDisableUnavailable ? "disabled" : "";
      const provOpts = buildVoiceProviderOptions(vg.provider || "");
      const modelOpts = vg.provider ? buildVoiceModelOptions(vg.provider, vg.model || "") : `<option value="" disabled selected>先选择服务商</option>`;
      const currentProv = voiceProviders.find(vp => vp.name === vg.provider);
      const currentModel = (currentProv?.models || []).find(m => m.id === vg.model);
      const voiceOpts = voiceOptionsHtml(
        voiceCatalogFor(voicePresetVoices, currentModel, currentProv?.models),
      );
      const speed = vg.speed ?? 1.0;
      return `
    <div class="form-hint" style="background:var(--primary-light);color:var(--text-2);padding:10px 12px;margin:8px 16px 12px;border-radius:8px;line-height:1.6">
      开启后该角色可以在合适的对话场景下（如"发个语音听听"、道晚安）在回复中用 [语音] 标记把想说的话合成为语音条发送。
    </div>
    ${noProviders ? '<div class="form-hint" style="color:var(--danger,#d33);padding:0 16px 8px">尚未配置可用的语音服务商。请先到「设置 → 语音服务商」中添加；已启用的角色仍可在这里关闭语音。</div>' : ''}

    <div class="card">
      <div class="card-header">服务商配置</div>
      <div class="form-group"><div class="form-row"><label>启用语音消息</label>
        <label class="switch-wrap"><input type="checkbox" id="pe-voice-en" ${vg.enabled ? "checked" : ""} ${checkboxDisabled}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-group"><div class="form-row"><label>服务商</label>
        <select id="pe-voice-provider" onchange="PawzoChat.onPersonaVoiceProviderChange()" ${fieldDisabled}>${provOpts}</select>
      </div></div>
      <div class="form-group"><div class="form-row"><label>模型</label>
        <select id="pe-voice-model" onchange="PawzoChat.onPersonaVoiceModelChange()" ${fieldDisabled}>${modelOpts}</select>
      </div></div>
      <div class="form-group"><div class="form-row"><label>语速</label>
        <div class="slider-wrap"><input type="range" id="pe-voice-speed" min="0.5" max="2" step="0.1" value="${speed}" ${fieldDisabled} oninput="this.nextElementSibling.textContent=this.value+'x'"><span class="slider-val">${speed}x</span></div>
      </div></div>
      <div class="form-group"><div class="form-row"><label style="padding-right:12px">音色 (voice ID)</label>
        <input id="pe-voice-voice" list="pe-voice-list" value="${esc(vg.voice || "")}" placeholder="留空则使用模型默认音色" spellcheck="false" autocomplete="off" ${fieldDisabled} style="flex:1;border:1px solid var(--divider);border-radius:8px;padding:10px 12px;font-size:14px;font-family:var(--font);outline:none;background:var(--bg);color:var(--text-1);text-align:right">
      </div></div>
      <datalist id="pe-voice-list">${voiceOpts}</datalist>
      <div class="form-hint">音色 ID 可自由输入；预设列表随所选模型的音色体系（MiniMax / OpenAI）变化。可先到「设置 → 语音服务商 → 语音测试」试听。</div>
    </div>`;
    })()}
    </div>
    <div id="pe-panel-persona" hidden>
    <div class="card">
      <div class="card-header-row"><span class="card-header" style="flex:1">世界书</span><button class="btn-text btn-sm" onclick="PawzoChat.peWorldbookAdd()" ${worldbookReady ? "" : 'disabled style="opacity:.5;cursor:not-allowed" title="世界书列表加载失败"'}>+ 绑定世界书</button></div>
      ${worldbookReady ? "" : `<div class="form-hint" style="padding:0 16px 8px;color:var(--danger,#d33)">世界书列表加载失败，当前仅保留已有绑定；保存角色时不会清空它们。</div>`}
      <div id="pe-worldbook-bound"></div>
      <div class="card-header" style="margin-top:8px;font-size:13px;color:var(--text-3)">全局生效（所有角色）</div>
      <div id="pe-worldbook-globals"></div>
    </div>
    <div class="card">
      <div class="card-header">人设设定</div>
      <textarea class="form-textarea prompt-part" id="pe-character" placeholder="描述角色的背景、性格、经历…">${esc(p.character_prompt)}</textarea>
    </div>
    <div class="card">
      <div class="card-header">输出示例</div>
      <textarea class="form-textarea prompt-part" id="pe-examples" placeholder="输入角色的经典台词作为风格参考…">${esc(p.output_examples)}</textarea>
      <div class="form-hint">用于风格参考和输出格式对齐 建议填写以\\分割的多个示例 如：你好\\我是小明\\很高兴认识你</div>
    </div>
    <div class="card">
      <div class="card-header-row"><span class="card-header" style="flex:1">系统提示词</span><button class="btn-text btn-sm" onclick="PawzoChat.resetSystemInstructions()">恢复默认</button></div>
      <textarea class="form-textarea prompt-part" id="pe-system" placeholder="输入系统级指令…">${esc(p.system_instructions)}</textarea>
    </div>
    </div>
  </div>`;

  _renderPeWorldbook();

  if (isNew) {
    api.get("/api/personas/default-system-instructions").then(res => {
      const ta = $("pe-system");
      if (ta && !ta.value) ta.value = res.text || "";
    }).catch(() => {});
  }
}

function _renderPeWorldbook() {
  const boundHost = $("pe-worldbook-bound");
  const globalsHost = $("pe-worldbook-globals");
  if (!boundHost || !globalsHost) return;
  const summaryOk = _peWorldbookSummary.ok !== false;

  const selectableByName = new Map(
    (_peWorldbookSummary.selectable || []).map(b => [b.name, b])
  );

  // Drop bound names whose book has been deleted (lazy orphan cleanup in UI).
  if (summaryOk) {
    _peBoundWorldbooks = _peBoundWorldbooks.filter(n => selectableByName.has(n));
  }

  if (_peBoundWorldbooks.length === 0) {
    boundHost.innerHTML = `<div class="form-hint" style="padding:8px 16px">尚未绑定任何世界书</div>`;
  } else {
    boundHost.innerHTML = _peBoundWorldbooks.map(name => {
      const b = selectableByName.get(name);
      const sub = b
        ? `${b.section_count || 0} 节${b.scope?.keyword_filter ? " · 关键词过滤" : ""}`
        : (summaryOk ? "已删除或暂不可用" : "列表加载失败，保留原绑定");
      return `<div class="card-row">
        <div style="flex:1;min-width:0">
          <div style="font-size:15px">${esc(name)}</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">${esc(sub)}</div>
        </div>
        <button class="btn-text btn-sm danger" data-pe-worldbook-remove="${encodeURIComponent(name)}">移除</button>
      </div>`;
    }).join("");
    _bindPeWorldbookActions();
  }

  const globals = _peWorldbookSummary.globals || [];
  if (!summaryOk) {
    globalsHost.innerHTML = `<div class="form-hint" style="padding:8px 16px">世界书列表加载失败</div>`;
  } else if (globals.length === 0) {
    globalsHost.innerHTML = `<div class="form-hint" style="padding:8px 16px">暂无全局世界书</div>`;
  } else {
    globalsHost.innerHTML = globals.map(b => {
      const sub = `${b.section_count || 0} 节${b.scope?.keyword_filter ? " · 关键词过滤" : ""}`;
      return `<div class="card-row">
        <div style="flex:1;min-width:0">
          <div style="font-size:14px">${esc(b.name)}</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">${esc(sub)}</div>
        </div>
      </div>`;
    }).join("");
  }
}

export function peWorldbookAdd() {
  if (_peWorldbookSummary.ok === false) {
    toast("世界书列表加载失败，请稍后重试", "error");
    return;
  }
  openWorldbookPicker(_peBoundWorldbooks, (picked) => {
    _peBoundWorldbooks = Array.isArray(picked) ? [...picked] : [];
    _renderPeWorldbook();
  });
}

function peWorldbookRemove(name) {
  _peBoundWorldbooks = _peBoundWorldbooks.filter(n => n !== name);
  _renderPeWorldbook();
}

export function onPersonaProviderChange() {
  const provName = $("pe-provider")?.value || "";
  const modelSel = $("pe-model");
  if (!modelSel) return;
  if (!provName) {
    modelSel.innerHTML = `<option value="" disabled selected>先选择服务商</option>`;
    return;
  }
  modelSel.innerHTML = window._peBuildModelOptions(provName);
}

export function onPersonaImageProviderChange() {
  const provName = $("pe-img-provider")?.value || "";
  const modelSel = $("pe-img-model");
  if (!modelSel) return;
  if (!provName) {
    modelSel.innerHTML = `<option value="" disabled selected>先选择服务商</option>`;
    return;
  }
  modelSel.innerHTML = window._peBuildImgModelOptions(provName, "");
}

function _refreshPeVoiceDatalist() {
  const provName = $("pe-voice-provider")?.value || "";
  const modelId = $("pe-voice-model")?.value || "";
  const prov = (window._peVoiceProviders || []).find(vp => vp.name === provName);
  const model = (prov?.models || []).find(m => m.id === modelId);
  const voices = voiceCatalogFor(window._peVoicePresetVoices, model, prov?.models);
  const list = $("pe-voice-list");
  if (list) {
    list.innerHTML = voiceOptionsHtml(voices);
  }
}

export function onPersonaVoiceProviderChange() {
  const provName = $("pe-voice-provider")?.value || "";
  const modelSel = $("pe-voice-model");
  if (!modelSel) return;
  if (!provName) {
    modelSel.innerHTML = `<option value="" disabled selected>先选择服务商</option>`;
  } else {
    modelSel.innerHTML = window._peBuildVoiceModelOptions(provName, "");
  }
  _refreshPeVoiceDatalist();
}

export function onPersonaVoiceModelChange() {
  _refreshPeVoiceDatalist();
}

export function switchPersonaEditTab(name) {
  document.querySelectorAll(".sub-tab").forEach(el =>
    el.classList.toggle("active", el.dataset.petab === name)
  );
  const panels = {
    detail: document.getElementById("pe-panel-detail"),
    persona: document.getElementById("pe-panel-persona"),
    image: document.getElementById("pe-panel-image"),
    voice: document.getElementById("pe-panel-voice"),
  };
  for (const [key, el] of Object.entries(panels)) {
    if (el) el.hidden = key !== name;
  }
  if (name === "persona") {
    const area = content();
    const ta = $("pe-character");
    if (area && ta && !ta.style.minHeight) {
      ta.style.minHeight = Math.round(area.clientHeight * 0.7) + "px";
    }
  }
}

export async function savePersona(isNew, openDetailAfterSave = false) {
  const name = $("pe-name").value.trim();
  if (!name) { toast("角色名称不能为空", "error"); return; }
  if (name.length > 100) { toast("角色名称过长（最多 100 个字符）", "error"); return; }
  const bad = name.match(ILLEGAL_NAME_RE);
  if (bad) { toast(`名称包含非法字符「${bad[0]}」，不可使用 \\ / : * ? " < > |`, "error"); return; }
  if (/[. ]$/.test(name)) { toast("名称不能以空格或句点结尾", "error"); return; }

  const body = {
    name,
    signature: $("pe-signature").value.trim(),
    llm_provider: $("pe-provider").value,
    llm_model: $("pe-model").value,
    temperature: parseFloat($("pe-temp").value),
    max_tokens: parseInt($("pe-tokens").value) || 2000,
    character_prompt: $("pe-character").value,
    output_examples: $("pe-examples").value,
    system_instructions: $("pe-system").value,
    emoji_enabled: $("pe-emoji-en").checked,
    emoji_send_probability: parseInt($("pe-emoji-prob").value),
    emoji_group: $("pe-emoji-group").value,
    memory: {
      enabled: $("pe-mem-en").checked,
      max_memories: parseInt($("pe-mem-max").textContent) || 50,
      include_in_prompt: $("pe-mem-inc").checked,
      trigger_rounds: parseInt($("pe-mem-trigger").textContent) || 0,
      trigger_mode: $("pe-mem-trigger-mode")?.value || "remind",
    },
    bound_worldbooks: [..._peBoundWorldbooks],
  };

  if ($("pe-pro-en")) {
    body.proactive = {
      enabled: $("pe-pro-en").checked,
      min_idle_hours: parseFloat($("pe-pro-min").value) || 0,
      max_idle_hours: parseFloat($("pe-pro-max").value) || 0,
      max_consecutive: parseInt($("pe-pro-max-consec").textContent) || 3,
      prompt: $("pe-pro-prompt").value,
      quiet_hours: {
        enabled: $("pe-pro-qh-en").checked,
        start: $("pe-pro-qh-start").value || "22:00",
        end: $("pe-pro-qh-end").value || "08:00",
      },
    };
  }

  if ($("pe-img-en")) {
    body.image_generation = {
      enabled: $("pe-img-en").checked,
      provider: $("pe-img-provider")?.value || "",
      model: $("pe-img-model")?.value || "",
      style_prefix: $("pe-img-style")?.value || "",
      art_style: $("pe-img-art-style")?.value ?? "",
      negative_prompt: $("pe-img-neg")?.value ?? "",
      negative_enabled: $("pe-img-neg-en")?.checked ?? true,
      ref_mode: $("pe-img-ref-mode")?.value || "avatar",
    };
  }

  if ($("pe-voice-en")) {
    body.voice_generation = {
      enabled: $("pe-voice-en").checked,
      provider: $("pe-voice-provider")?.value || "",
      model: $("pe-voice-model")?.value || "",
      voice: $("pe-voice-voice")?.value.trim() || "",
      speed: parseFloat($("pe-voice-speed")?.value) || 1.0,
    };
  }

  const momentsBody = {
    can_publish: $("pe-moments-publish").checked,
    can_reply: $("pe-moments-reply").checked,
    memory_enabled: $("pe-moments-memory").checked,
    reply_probability: parseInt($("pe-moments-prob").value, 10) || 0,
  };

  showLoading("保存中…");
  try {
    let res;
    let savedPersonaId;
    if (isNew) {
      res = await api.post("/api/personas", body);
      if (res.status >= 400) { toast(res.data.error, "error"); return; }
      savedPersonaId = res.data.id;
      if (_pendingAvatarBlob && res.data.id) {
        const fd = new FormData();
        fd.append("avatar", _pendingAvatarBlob, "avatar.png");
        const base = window.PAWZOCHAT_BASE || "";
        await fetch(`${base}/api/personas/${res.data.id}/avatar`, { method: "POST", body: fd });
        _pendingAvatarBlob = null;
      }
    } else {
      const pid = $("pe-id").value.trim();
      res = await api.put(`/api/personas/${pid}`, body);
      if (res.status >= 400) { toast(res.data.error, "error"); return; }
      savedPersonaId = pid;
    }
    const momentsRes = await api.patch(
      `/api/moments/settings/personas/${encodeURIComponent(savedPersonaId)}`,
      momentsBody,
    );
    if (momentsRes.status >= 400) {
      toast(momentsRes.data?.error || "朋友圈设置保存失败", "error");
      return;
    }
    toast("已保存", "success");
    if (openDetailAfterSave) {
      switchTab("contacts");
      pushPage("personaDetail", { personaId: savedPersonaId });
    } else {
      goBack();
    }
    refreshSidebar();
  } catch (e) { toast("保存失败", "error"); }
  finally { hideLoading(); }
}

export async function resetSystemInstructions() {
  try {
    const res = await api.get("/api/personas/default-system-instructions");
    const ta = $("pe-system");
    if (ta) ta.value = res.text || "";
    toast("已恢复默认", "success");
  } catch (e) { toast("获取默认值失败", "error"); }
}

/* ---- Avatar Crop Modal (generic, callback-based) ---- */

export function openCropModal(imgUrl, onCropped) {
  _cropCallback = onCropped;

  const modal = document.createElement("div");
  modal.className = "crop-modal";
  modal.id = "crop-modal";
  modal.innerHTML = `
    <div class="crop-viewport" id="crop-vp">
      <img id="crop-img" src="${imgUrl}">
      <div class="crop-frame"></div>
    </div>
    <div class="crop-bar">
      <button class="crop-cancel" onclick="PawzoChat.closeCropModal()">取消</button>
      <button class="crop-ok" onclick="PawzoChat.confirmCrop()">确定</button>
    </div>`;
  document.body.appendChild(modal);

  const img = document.getElementById("crop-img");
  const vp = document.getElementById("crop-vp");
  let scale = 1, imgX = 0, imgY = 0, dragging = false, lastX = 0, lastY = 0;

  img.onload = () => {
    const vpSize = vp.clientWidth;
    const minDim = Math.min(img.naturalWidth, img.naturalHeight);
    scale = vpSize / minDim;
    imgX = (vpSize - img.naturalWidth * scale) / 2;
    imgY = (vpSize - img.naturalHeight * scale) / 2;
    _applyCropTransform(img, imgX, imgY, scale);
    URL.revokeObjectURL(imgUrl);
  };

  const onDown = (e) => {
    dragging = true;
    const pt = e.touches ? e.touches[0] : e;
    lastX = pt.clientX; lastY = pt.clientY;
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    const pt = e.touches ? e.touches[0] : e;
    imgX += pt.clientX - lastX;
    imgY += pt.clientY - lastY;
    lastX = pt.clientX; lastY = pt.clientY;
    _applyCropTransform(img, imgX, imgY, scale);
  };
  const onUp = () => { dragging = false; };
  const onWheel = (e) => {
    e.preventDefault();
    const vpRect = vp.getBoundingClientRect();
    const cx = e.clientX - vpRect.left;
    const cy = e.clientY - vpRect.top;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.1, Math.min(10, scale * delta));
    imgX = cx - (cx - imgX) * (newScale / scale);
    imgY = cy - (cy - imgY) * (newScale / scale);
    scale = newScale;
    _applyCropTransform(img, imgX, imgY, scale);
  };

  vp.addEventListener("mousedown", onDown);
  vp.addEventListener("touchstart", onDown, { passive: false });
  window.addEventListener("mousemove", onMove);
  window.addEventListener("touchmove", onMove, { passive: false });
  window.addEventListener("mouseup", onUp);
  window.addEventListener("touchend", onUp);
  vp.addEventListener("wheel", onWheel, { passive: false });

  modal._cleanup = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("touchmove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("touchend", onUp);
  };
  modal._cropState = () => ({ img, scale, imgX, imgY, vpSize: vp.clientWidth });
}

function _applyCropTransform(img, x, y, s) {
  img.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  img.style.transformOrigin = "0 0";
}

export function closeCropModal() {
  _cropCallback = null;
  const modal = document.getElementById("crop-modal");
  if (!modal) return;
  if (modal._cleanup) modal._cleanup();
  modal.remove();
}

export function confirmCrop() {
  const modal = document.getElementById("crop-modal");
  if (!modal || !modal._cropState) return;
  const { img, scale, imgX, imgY, vpSize } = modal._cropState();

  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");

  const sx = -imgX / scale;
  const sy = -imgY / scale;
  const sSize = vpSize / scale;
  ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, 256, 256);

  const cb = _cropCallback;
  canvas.toBlob((blob) => {
    if (!blob) { toast("裁剪失败", "error"); return; }
    closeCropModal();
    if (cb) cb(blob);
  }, "image/png");
}

export function onAvatarFileSelected(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  if (!file.type.startsWith("image/")) { toast("请选择图片文件", "error"); return; }
  input.value = "";

  const pid = $("pe-id")?.value?.trim() || "";
  const url = URL.createObjectURL(file);
  openCropModal(url, async (blob) => {
    if (!pid) {
      _pendingAvatarBlob = blob;
      const avDiv = content().querySelector(".avatar-upload-wrap .avatar");
      if (avDiv) {
        avDiv.style.background = "";
        avDiv.innerHTML = `<img src="${URL.createObjectURL(blob)}" alt="avatar">`;
      }
      return;
    }
    const fd = new FormData();
    fd.append("avatar", blob, "avatar.png");
    const base = window.PAWZOCHAT_BASE || "";
    try {
      const resp = await fetch(`${base}/api/personas/${pid}/avatar`, { method: "POST", body: fd });
      const res = await resp.json();
      if (resp.status >= 400) { toast(res.error || "上传失败", "error"); return; }
      const persona = state.personas.find(p => p.id === pid);
      if (persona) {
        persona.has_avatar = true;
        persona.avatar_version = res.avatar_version || String(Date.now());
      }
      toast("头像已更新", "success");
      const avDiv = content().querySelector(".avatar-upload-wrap .avatar");
      if (avDiv) {
        let img = avDiv.querySelector("img");
        if (!img) {
          img = document.createElement("img");
          img.alt = persona?.name || pid;
          avDiv.appendChild(img);
        }
        img.src = personaAvatarUrl(persona || {
          id: pid,
          has_avatar: true,
          avatar_version: res.avatar_version || String(Date.now()),
        });
      }
    } catch (e) { toast("上传失败", "error"); }
  });
}

/* ---- Memory trigger-mode controls ---- */

export function onPeMemTriggerModeChange() {
  const sel = $("pe-mem-trigger-mode");
  const hint = $("pe-mem-trigger-hint");
  if (!sel || !hint) return;
  hint.textContent = sel.value === "summarize"
    ? "每积累 N 轮未总结的对话，自动调用一次 LLM 将其总结为一条记忆；设为 0 禁用自动总结（AI 仍可通过工具主动记录，主动记录后计数顺延）"
    : "设置 N > 0 时，AI 每 N 轮对话未记录记忆则收到一次提醒；设为 0 禁用提醒";
}

/* ---- Image-generation reference-image controls ---- */

export function onPeImgRefModeChange() {
  const sel = $("pe-img-ref-mode");
  const block = $("pe-img-ref-custom-block");
  if (!sel || !block) return;
  block.style.display = sel.value === "custom" ? "" : "none";
}

export async function onPeImgRefFileSelected(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  if (!file.type.startsWith("image/")) { toast("请选择图片文件", "error"); return; }
  input.value = "";

  const pid = $("pe-id")?.value?.trim() || "";
  if (!pid) { toast("请先保存角色后再上传参考图", "error"); return; }

  const fd = new FormData();
  fd.append("image", file, file.name || "ref.png");
  const base = window.PAWZOCHAT_BASE || "";
  showLoading("上传中…");
  try {
    const resp = await fetch(`${base}/api/personas/${pid}/image_ref`, { method: "POST", body: fd });
    const res = await resp.json();
    if (resp.status >= 400) { toast(res.error || "上传失败", "error"); return; }
    toast("参考图已更新", "success");
    const img = $("pe-img-ref-preview");
    const empty = $("pe-img-ref-empty");
    if (img) {
      img.src = `${base}/api/personas/${pid}/image_ref?t=${Date.now()}`;
      img.style.display = "";
    }
    if (empty) empty.style.display = "none";
  } catch (e) { toast("上传失败", "error"); }
  finally { hideLoading(); }
}

export async function deletePersonaRefImage() {
  const pid = $("pe-id")?.value?.trim() || "";
  if (!pid) return;
  const ok = await confirm("删除参考图", "确认删除该角色的自定义参考图？", true);
  if (!ok) return;
  const base = window.PAWZOCHAT_BASE || "";
  try {
    const resp = await fetch(`${base}/api/personas/${pid}/image_ref`, { method: "DELETE" });
    const res = await resp.json();
    if (resp.status >= 400) { toast(res.error || "删除失败", "error"); return; }
    toast("已删除", "success");
    const img = $("pe-img-ref-preview");
    const empty = $("pe-img-ref-empty");
    if (img) { img.src = ""; img.style.display = "none"; }
    if (empty) empty.style.display = "";
  } catch (e) { toast("删除失败", "error"); }
}

/* ---- Register renderers ---- */

registerTabRenderer("contacts", renderContacts);
registerPageRenderer("personaDetail", renderPersonaDetail);
registerPageRenderer("personaSettings", renderPersonaSettings);
registerPageRenderer("personaEdit", renderPersonaEdit);
