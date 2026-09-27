/*!
 * PawzoChat - Human-like, versatile, extensible AI companion engine
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
import { esc } from "./utils.js";
import { api } from "./api.js";
import { $, content } from "./state.js";
import { toast, confirm, showSheet, closeOverlay, showLoading, hideLoading } from "./ui.js";
import { setTopBar, goBack, registerPageRenderer } from "./navigation.js";

const _IMP_COLORS = ["", "#9E9E9E", "#8BC34A", "#FF9800", "#F44336", "#E91E63"];
const _IMP_LABELS = ["", "1 - 不重要", "2 - 一般", "3 - 普通", "4 - 重要", "5 - 非常重要"];
const _WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

let _currentPersonaId = "";
let _editingMemory = null;
let _editRequest = 0;

function _impBadge(val) {
  const v = Math.max(1, Math.min(5, val || 3));
  return `<span class="mem-imp" style="background:${_IMP_COLORS[v]}20;color:${_IMP_COLORS[v]}">${v}</span>`;
}

function _pad2(n) {
  return String(n).padStart(2, "0");
}

function _nowDatetimeLocal() {
  const now = new Date();
  return [
    now.getFullYear(),
    _pad2(now.getMonth() + 1),
    _pad2(now.getDate()),
  ].join("-") + `T${_pad2(now.getHours())}:${_pad2(now.getMinutes())}`;
}

function _readableToDatetimeLocal(createdAt) {
  const text = String(createdAt || "").trim();
  if (!text) return "";
  let m = text.match(/^(\d{4}-\d{2}-\d{2})(?:\s+\(.+?\))?\s+(\d{2}:\d{2})$/);
  if (m) return `${m[1]}T${m[2]}`;
  m = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (m) return `${m[1]}T${m[2]}`;
  return "";
}

function _datetimeLocalToReadable(value) {
  const m = String(value || "").trim().match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/,
  );
  if (!m) return "";
  const [, year, month, day, hour, minute] = m;
  const weekday = _WEEKDAY_LABELS[
    new Date(Number(year), Number(month) - 1, Number(day)).getDay()
  ];
  return `${year}-${month}-${day} (${weekday}) ${hour}:${minute}`;
}

function _syncMemoryTimePreview() {
  const input = $("mem-edit-time");
  const preview = $("mem-edit-time-preview");
  if (!input || !preview) return;
  const formatted = _datetimeLocalToReadable(input.value);
  const fallback = input.dataset.original || "";
  preview.textContent = formatted || fallback || "未设置";
  preview.classList.toggle("is-empty", !formatted && !fallback);
}

async function renderMemoryManage(data) {
  _currentPersonaId = data.personaId;
  _editingMemory = null;
  const request = ++_editRequest;
  setTopBar("记忆管理", true,
    `<button class="top-btn" onclick="PawzoChat.addMemory()">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>`
  );
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;

  try {
    const res = await api.get(`/api/personas/${data.personaId}/memories`, { bypassCache: true });
    if (request !== _editRequest) return;
    const memories = res.memories || [];

    if (memories.length === 0) {
      content().innerHTML = `<div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 01-2 2h-4a2 2 0 01-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7z"/><line x1="9" y1="21" x2="15" y2="21"/></svg>
        <div class="empty-text">暂无记忆</div>
        <button onclick="PawzoChat.addMemory()">手动添加</button>
      </div>`;
      return;
    }

    const listHtml = memories.map(m =>
      `<div class="mem-card" onclick="PawzoChat.editMemory(${m.index},'${esc(m.fingerprint)}')">
        <div class="mem-header">
          ${_impBadge(m.importance)}
          <span class="mem-time">${esc(m.created_at || "")}</span>
        </div>
        <div class="mem-summary">${esc(m.summary)}</div>
      </div>`
    ).join("");

    content().innerHTML = `<div class="page">
      <div class="mem-count">${memories.length} 条记忆</div>
      ${listHtml}
    </div>`;
  } catch (e) { toast("加载失败", "error"); }
}

export function addMemory() {
  ++_editRequest;
  _showMemorySheet(-1, "", 3, "");
}

export function editMemory(index, fingerprint) {
  return _loadAndShowEdit(index, fingerprint);
}

async function _loadAndShowEdit(index, fingerprint) {
  const personaId = _currentPersonaId;
  const request = ++_editRequest;
  try {
    const res = await api.get(`/api/personas/${personaId}/memories`, { bypassCache: true });
    if (request !== _editRequest || personaId !== _currentPersonaId) return;
    const mem = (res.memories || []).find(m => m.index === index);
    if (!fingerprint || !mem || mem.fingerprint !== fingerprint) {
      toast("记忆已变化，请从刷新后的列表重新打开", "error");
      renderMemoryManage({ personaId });
      return;
    }
    _showMemorySheet(index, mem.summary, mem.importance, mem.created_at, fingerprint);
  } catch (e) { toast("加载失败", "error"); }
}

function _showMemorySheet(index, summary, importance, createdAt, fingerprint = "") {
  _editingMemory = { personaId: _currentPersonaId, index, fingerprint };
  const isNew = index < 0;
  const title = isNew ? "新增记忆" : "编辑记忆";
  const rawCreatedAt = String(createdAt || "");
  const pickerValue = _readableToDatetimeLocal(rawCreatedAt) || (isNew ? _nowDatetimeLocal() : "");
  const hasInvalidTime = !!rawCreatedAt && !pickerValue;
  const impOptions = [1,2,3,4,5].map(v =>
    `<option value="${v}" ${v === importance ? "selected" : ""}>${_IMP_LABELS[v]}</option>`
  ).join("");

  showSheet(`<div style="padding:20px">
    <div class="sheet-title">${title}</div>
    <div class="mem-edit-fields">
      <textarea id="mem-edit-summary" class="mem-edit-textarea" placeholder="记忆内容" rows="4">${esc(summary)}</textarea>
      <div class="mem-edit-row">
        <label>重要度</label>
        <select id="mem-edit-imp" class="mem-edit-input">${impOptions}</select>
      </div>
      <div class="mem-edit-row">
        <label>时间</label>
        <div class="mem-time-wrap">
          <input
            id="mem-edit-time"
            class="mem-edit-input"
            type="datetime-local"
            step="60"
            value="${esc(pickerValue)}"
            data-original="${esc(rawCreatedAt)}"
          >
          <div class="mem-time-note">${hasInvalidTime ? `当前旧值无法直接解析：${esc(rawCreatedAt)}。重新选择后会按标准格式保存。` : "选择后会自动转换为 YYYY-MM-DD (Weekday) HH:MM"}</div>
          <div id="mem-edit-time-preview" class="mem-time-preview"></div>
        </div>
      </div>
    </div>
    <div style="display:flex;gap:12px">
      ${!isNew ? `<button onclick="PawzoChat.deleteMemoryConfirm(${index})" style="padding:10px 16px;border:none;border-radius:var(--radius-btn);background:var(--bg);color:var(--error);font-size:15px;cursor:pointer;font-family:var(--font)">删除</button>` : ""}
      <button onclick="PawzoChat.closeOverlay()" style="flex:1;padding:10px;border:none;border-radius:var(--radius-btn);background:var(--bg);color:var(--text-2);font-size:15px;cursor:pointer;font-family:var(--font)">取消</button>
      <button onclick="PawzoChat.saveMemory(${index})" style="flex:1;padding:10px;border:none;border-radius:var(--radius-btn);background:var(--primary);color:#fff;font-size:15px;cursor:pointer;font-family:var(--font)">保存</button>
    </div>
  </div>`);

  const timeInput = $("mem-edit-time");
  timeInput?.addEventListener("input", _syncMemoryTimePreview);
  timeInput?.addEventListener("change", _syncMemoryTimePreview);
  _syncMemoryTimePreview();
}

export async function saveMemory(index) {
  const editing = _editingMemory;
  if (!editing || editing.index !== index || editing.personaId !== _currentPersonaId) return;
  const summary = $("mem-edit-summary")?.value?.trim();
  if (!summary) { toast("记忆内容不能为空", "error"); return; }
  const importance = parseInt($("mem-edit-imp")?.value) || 3;
  const timeInput = $("mem-edit-time");
  const createdAt = _datetimeLocalToReadable(timeInput?.value?.trim())
    || timeInput?.dataset?.original
    || "";
  const isNew = index < 0;

  showLoading("保存中…");
  try {
    let res;
    if (isNew) {
      res = await api.post(`/api/personas/${editing.personaId}/memories`, {
        summary, importance, created_at: createdAt,
      });
    } else {
      res = await api.put(`/api/personas/${editing.personaId}/memories/${index}`, {
        summary, importance, created_at: createdAt, fingerprint: editing.fingerprint,
      });
    }
    if (_editingMemory !== editing) return;
    if (res.status >= 400) { toast(res.data?.error || "保存失败", "error"); return; }
    closeOverlay();
    toast("已保存", "success");
    renderMemoryManage({ personaId: _currentPersonaId });
  } catch (e) { toast("保存失败", "error"); }
  finally { hideLoading(); }
}

export async function deleteMemoryConfirm(index) {
  const editing = _editingMemory;
  if (!editing || editing.index !== index || editing.personaId !== _currentPersonaId) return;
  closeOverlay();
  const ok = await confirm("删除记忆", "确认删除这条记忆？", true);
  if (!ok) return;
  showLoading("删除中…");
  try {
    const res = await api.del(`/api/personas/${editing.personaId}/memories/${index}?fingerprint=${encodeURIComponent(editing.fingerprint)}`);
    if (_editingMemory !== editing) return;
    if (res.status >= 400) {
      toast(res.data?.error || "删除失败", "error");
      if (res.status === 409 || res.status === 400) renderMemoryManage({ personaId: editing.personaId });
      return;
    }
    toast("已删除", "success");
    renderMemoryManage({ personaId: _currentPersonaId });
  } catch (e) { toast("删除失败", "error"); }
  finally { hideLoading(); }
}

registerPageRenderer("memoryManage", renderMemoryManage);
