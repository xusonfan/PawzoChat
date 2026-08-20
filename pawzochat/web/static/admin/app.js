import { api } from "./api.js";
import {
  state, updateState, setSelection, selectVisible, clearSelection, esc, fieldLabel,
} from "./state.js";
import { BATCH_FIELDS, buildOperation, describeOperation, fieldDefinition } from "./batch-editor.js";
import { renderDiff, summarizePreview } from "./prompt-diff.js";
import { openPersonaCreator } from "./persona-creator.js";

const base = window.PAWZOCHAT_BASE || "";
const byId = id => document.getElementById(id);
let filterTimer = null;
let editingTemplateId = null;

function toast(message, type = "") {
  const element = byId("toast");
  const iconSvg = type === "error"
    ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
    : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
  element.innerHTML = `${iconSvg}<span>${esc(message)}</span>`;
  element.className = `toast ${type}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), 3400);
}

function showModal(html) {
  byId("modal").innerHTML = html;
  byId("modal").classList.remove("hidden");
  byId("modal-backdrop").classList.remove("hidden");
}

function closeModal() {
  byId("modal").classList.add("hidden");
  byId("modal-backdrop").classList.add("hidden");
  byId("modal").innerHTML = "";
}

function showDrawer(html) {
  byId("editor-drawer").innerHTML = html;
  byId("editor-drawer").classList.remove("hidden");
  byId("drawer-backdrop").classList.remove("hidden");
}

function closeDrawer() {
  byId("editor-drawer").classList.add("hidden");
  byId("drawer-backdrop").classList.add("hidden");
  byId("editor-drawer").innerHTML = "";
}

function providerOptions(kind, selected = "") {
  const providers = state.catalogs[kind] || [];
  return `<option value="">未选择</option>${providers.map(provider => `
    <option value="${esc(provider.name)}" ${provider.name === selected ? "selected" : ""}>${esc(provider.name)}</option>
  `).join("")}`;
}

function modelOptions(kind, providerName, selected = "") {
  const provider = (state.catalogs[kind] || []).find(item => item.name === providerName);
  const models = provider?.models || [];
  const hasSelected = models.some(model => model.id === selected);
  return `${selected && !hasSelected ? `<option value="${esc(selected)}" selected>${esc(selected)}（当前）</option>` : ""}<option value="">未选择</option>${models.map(model => `
    <option value="${esc(model.id)}" ${model.id === selected ? "selected" : ""}>${esc(model.name || model.id)}</option>
  `).join("")}`;
}

function capabilityBadges(persona) {
  const capabilities = [
    ["memory_enabled", "记忆", "cap-memory"],
    ["emoji_enabled", "表情", "cap-emoji"],
    ["image_enabled", "生图", "cap-image"],
    ["voice_enabled", "语音", "cap-voice"],
    ["proactive_enabled", "主动", "cap-proactive"],
  ];
  const enabled = capabilities.filter(([key]) => persona[key]);
  return enabled.length
    ? enabled.map(([, label, cls]) => `<span class="badge ${cls}"><span class="badge-dot"></span>${label}</span>`).join("")
    : `<span class="muted">—</span>`;
}

function renderStats() {
  const data = state.dashboard;
  const statDefs = [
    {
      label: "总人物数",
      val: data.total || 0,
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    },
    {
      label: "已启用",
      val: data.enabled || 0,
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`,
    },
    {
      label: "已停用",
      val: data.disabled || 0,
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`,
    },
    {
      label: "记忆已开",
      val: data.memory_enabled || 0,
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a8 8 0 0 0-8 8c0 3.37 2.1 6.25 5.09 7.42V20a2 2 0 0 0 2 2h1.82a2 2 0 0 0 2-2v-2.58C17.9 16.25 20 13.37 20 10a8 8 0 0 0-8-8z"/></svg>`,
    },
    {
      label: "主动消息已开",
      val: data.proactive_enabled || 0,
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
    },
  ];

  byId("stats").innerHTML = statDefs.map(item => `
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">${item.label}</span>
        <span class="stat-card-icon">${item.icon}</span>
      </div>
      <strong class="stat-card-value">${item.val}</strong>
    </div>
  `).join("");

  byId("nav-persona-count").textContent = data.total || 0;
}

function renderFilters() {
  byId("filter-provider").innerHTML = `<option value="">全部服务商</option>${(state.catalogs.llm_providers || []).map(item => `<option value="${esc(item.name)}">${esc(item.name)}</option>`).join("")}`;
  byId("filter-worldbook").innerHTML = `<option value="">全部世界书</option>${(state.catalogs.worldbooks || []).map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join("")}`;
}

function renderRows() {
  const body = byId("persona-rows");
  if (!state.personas.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">没有符合条件的人物</td></tr>`;
  } else {
    body.innerHTML = state.personas.map(persona => {
      const avatar = persona.has_avatar
        ? `<img class="avatar" src="${base}/api/personas/${encodeURIComponent(persona.id)}/avatar" alt="">`
        : `<div class="avatar">${esc(persona.name.slice(0, 1) || "?")}</div>`;
      return `<tr data-persona-id="${esc(persona.id)}">
        <td class="check"><input type="checkbox" data-select-id="${esc(persona.id)}" ${state.selected.has(persona.id) ? "checked" : ""}></td>
        <td>
          <div class="persona-cell">
            ${avatar}
            <div class="persona-cell-info">
              <strong>${esc(persona.name)}</strong>
              <small>${esc(persona.signature || persona.id)}</small>
            </div>
          </div>
        </td>
        <td>
          <span class="badge ${persona.enabled ? "status-on" : "status-off"}">
            <span class="badge-dot"></span>
            ${persona.enabled ? "已启用" : "已停用"}
          </span>
        </td>
        <td>
          <div class="model-cell">
            <span class="model-name">${esc(persona.llm_model || "未配置")}</span>
            <span class="provider-name">${esc(persona.llm_provider || "默认")}</span>
          </div>
        </td>
        <td>${capabilityBadges(persona)}</td>
        <td>${persona.bound_worldbooks.length ? persona.bound_worldbooks.map(name => `<span class="badge worldbook-badge">${esc(name)}</span>`).join("") : `<span class="muted">—</span>`}</td>
        <td style="text-align:right;padding-right:20px">
          <button class="row-action-btn" data-edit-id="${esc(persona.id)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            <span>编辑</span>
          </button>
        </td>
      </tr>`;
    }).join("");
  }
  const pageCount = Math.max(1, Math.ceil(state.total / state.pageSize));
  byId("page-summary").textContent = `第 ${state.page} / ${pageCount} 页，共 ${state.total} 项人物`;
  document.querySelector('[data-action="previous-page"]').disabled = state.page <= 1;
  document.querySelector('[data-action="next-page"]').disabled = state.page >= pageCount;
  const visibleIds = state.personas.map(item => item.id);
  byId("select-page").checked = visibleIds.length > 0 && visibleIds.every(id => state.selected.has(id));
  renderSelectionBar();
}

function renderSelectionBar() {
  const bar = byId("selection-bar");
  const count = state.selected.size;
  bar.classList.toggle("hidden", count === 0);
  byId("selection-count").textContent = `已选择 ${count} 项人物`;
}

async function loadList() {
  const params = new URLSearchParams({ page: state.page, page_size: state.pageSize, ...state.filters });
  try {
    const data = await api.get(`/api/admin/personas?${params}`);
    updateState({ personas: data.items || [], total: data.total || 0, version: data.version || "" });
    renderRows();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function refreshAll() {
  try {
    const [dashboard, catalogs, templates] = await Promise.all([
      api.get("/api/admin/dashboard"), api.get("/api/admin/catalogs"), api.get("/api/admin/prompt-templates"),
    ]);
    updateState({ dashboard, catalogs, templates: templates.templates || [] });
    renderStats();
    renderFilters();
    await loadList();
  } catch (error) {
    toast(error.message, "error");
  }
}

function checked(value) { return value ? "checked" : ""; }

function worldbookChecks(selected) {
  const selectedSet = new Set(selected || []);
  if (!state.catalogs.worldbooks.length) return `<span class="muted">暂无世界书</span>`;
  return state.catalogs.worldbooks.map(name => `<label class="checkbox-field"><input type="checkbox" name="bound_worldbooks" value="${esc(name)}" ${checked(selectedSet.has(name))}>${esc(name)}</label>`).join("");
}

async function openEditor(personaId) {
  showDrawer(`<div class="empty">正在加载人物数据…</div>`);
  try {
    const { persona: p } = await api.get(`/api/admin/personas/${encodeURIComponent(personaId)}`);
    showDrawer(`<form id="persona-form" data-persona-id="${esc(p.id)}">
      <header class="drawer-header">
        <div>
          <h2>${esc(p.name)}</h2>
          <div class="muted code" style="font-size:12px;margin-top:2px">${esc(p.id)}</div>
        </div>
        <button type="button" class="icon-btn" data-action="close-drawer" aria-label="关闭">×</button>
      </header>
      <section class="form-section">
        <div class="form-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <span>基础设定</span>
        </div>
        <div class="form-grid">
          <label class="checkbox-field"><input name="enabled" type="checkbox" ${checked(p.enabled)}>启用该人物</label>
          <label class="form-field"><span>名称</span><input name="name" maxlength="100" value="${esc(p.name)}" required></label>
          <label class="form-field wide"><span>签名 / 简介</span><input name="signature" maxlength="100" value="${esc(p.signature)}"></label>
        </div>
      </section>
      <section class="form-section">
        <div class="form-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          <span>模型与工具策略</span>
        </div>
        <div class="form-grid">
          <label class="form-field"><span>LLM 服务商</span><select name="llm_provider" data-provider-for="llm_model">${providerOptions("llm_providers", p.llm_provider)}</select></label>
          <label class="form-field"><span>LLM 模型</span><select name="llm_model">${modelOptions("llm_providers", p.llm_provider, p.llm_model)}</select></label>
          <label class="form-field"><span>温度 (Temperature)</span><input name="temperature" type="number" min="0" max="2" step="0.1" value="${p.temperature}"></label>
          <label class="form-field"><span>最大令牌 (Max Tokens)</span><input name="max_tokens" type="number" min="1" value="${p.max_tokens}"></label>
          <label class="form-field"><span>工具策略</span><select name="tool_policy.mode"><option value="all">全部工具</option><option value="none">禁用工具</option><option value="whitelist">仅白名单</option><option value="blacklist">排除黑名单</option></select></label>
          <label class="form-field"><span>工具列表（逗号分隔）</span><input name="tool_policy.list" value="${esc((p.tool_policy.list || []).join(", "))}"></label>
          <label class="form-field"><span>最大工具迭代</span><input name="tool_policy.max_iterations" type="number" min="1" value="${p.tool_policy.max_iterations}"></label>
          <label class="form-field"><span>工具超时（秒）</span><input name="tool_policy.timeout_seconds" type="number" min="1" value="${p.tool_policy.timeout_seconds}"></label>
        </div>
      </section>
      <section class="form-section">
        <div class="form-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span>提示词架构</span>
        </div>
        <div class="form-grid">
          <label class="form-field wide"><span>人设设定 (Character Prompt)</span><textarea name="character_prompt">${esc(p.character_prompt)}</textarea></label>
          <label class="form-field wide"><span>输出示例 (Output Examples)</span><textarea name="output_examples">${esc(p.output_examples)}</textarea></label>
          <label class="form-field wide"><span>系统指令 (System Instructions)</span><textarea name="system_instructions">${esc(p.system_instructions)}</textarea></label>
        </div>
      </section>
      <section class="form-section">
        <div class="form-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a8 8 0 0 0-8 8c0 3.37 2.1 6.25 5.09 7.42V20a2 2 0 0 0 2 2h1.82a2 2 0 0 0 2-2v-2.58C17.9 16.25 20 13.37 20 10a8 8 0 0 0-8-8z"/></svg>
          <span>记忆与表情包</span>
        </div>
        <div class="form-grid">
          <label class="checkbox-field"><input name="memory.enabled" type="checkbox" ${checked(p.memory.enabled)}>启用记忆</label>
          <label class="checkbox-field"><input name="memory.include_in_prompt" type="checkbox" ${checked(p.memory.include_in_prompt)}>注入提示词</label>
          <label class="form-field"><span>最大记忆数</span><input name="memory.max_memories" type="number" min="1" value="${p.memory.max_memories}"></label>
          <label class="form-field"><span>触发轮数</span><input name="memory.trigger_rounds" type="number" min="0" value="${p.memory.trigger_rounds}"></label>
          <label class="form-field"><span>触发模式</span><select name="memory.trigger_mode"><option value="remind">提醒模型</option><option value="summarize">自动总结</option></select></label>
          <label class="checkbox-field"><input name="emoji_enabled" type="checkbox" ${checked(p.emoji_enabled)}>启用表情</label>
          <label class="form-field"><span>表情概率 (%)</span><input name="emoji_send_probability" type="number" min="0" max="100" value="${p.emoji_send_probability}"></label>
          <label class="form-field"><span>表情分组</span><input name="emoji_group" value="${esc(p.emoji_group)}"></label>
        </div>
      </section>
      <section class="form-section">
        <div class="form-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          <span>生图与语音合成</span>
        </div>
        <div class="form-grid">
          <label class="checkbox-field"><input name="image_generation.enabled" type="checkbox" ${checked(p.image_generation.enabled)}>启用生图</label>
          <span></span>
          <label class="form-field"><span>生图服务商</span><select name="image_generation.provider" data-provider-for="image_generation.model">${providerOptions("image_providers", p.image_generation.provider)}</select></label>
          <label class="form-field"><span>生图模型</span><select name="image_generation.model">${modelOptions("image_providers", p.image_generation.provider, p.image_generation.model)}</select></label>
          <label class="form-field wide"><span>外貌提示词 (Style Prefix)</span><textarea name="image_generation.style_prefix">${esc(p.image_generation.style_prefix)}</textarea></label>
          <label class="form-field wide"><span>画风设定 (Art Style)</span><textarea name="image_generation.art_style">${esc(p.image_generation.art_style)}</textarea></label>
          <label class="form-field wide"><span>负面提示词</span><textarea name="image_generation.negative_prompt">${esc(p.image_generation.negative_prompt)}</textarea></label>
          <label class="checkbox-field"><input name="image_generation.negative_enabled" type="checkbox" ${checked(p.image_generation.negative_enabled)}>启用负面提示词</label>
          <label class="form-field"><span>参考图模式</span><select name="image_generation.ref_mode"><option value="avatar">人物头像</option><option value="custom">自定义参考图</option><option value="none">不使用参考图</option></select></label>
          <label class="checkbox-field"><input name="voice_generation.enabled" type="checkbox" ${checked(p.voice_generation.enabled)}>启用语音</label>
          <span></span>
          <label class="form-field"><span>语音服务商</span><select name="voice_generation.provider" data-provider-for="voice_generation.model">${providerOptions("voice_providers", p.voice_generation.provider)}</select></label>
          <label class="form-field"><span>语音模型</span><select name="voice_generation.model">${modelOptions("voice_providers", p.voice_generation.provider, p.voice_generation.model)}</select></label>
          <label class="form-field"><span>音色 ID</span><input name="voice_generation.voice" value="${esc(p.voice_generation.voice)}"></label>
          <label class="form-field"><span>语速</span><input name="voice_generation.speed" type="number" min="0.25" max="4" step="0.05" value="${p.voice_generation.speed}"></label>
        </div>
      </section>
      <section class="form-section">
        <div class="form-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          <span>主动消息与朋友圈</span>
        </div>
        <div class="form-grid">
          <label class="checkbox-field"><input name="proactive.enabled" type="checkbox" ${checked(p.proactive.enabled)}>启用主动消息</label>
          <span></span>
          <label class="form-field"><span>最短空闲小时</span><input name="proactive.min_idle_hours" type="number" min="0" step="0.1" value="${p.proactive.min_idle_hours}"></label>
          <label class="form-field"><span>最长空闲小时</span><input name="proactive.max_idle_hours" type="number" min="0" step="0.1" value="${p.proactive.max_idle_hours}"></label>
          <label class="form-field"><span>最大连续次数</span><input name="proactive.max_consecutive" type="number" min="1" value="${p.proactive.max_consecutive}"></label>
          <label class="form-field wide"><span>主动消息提示词</span><textarea name="proactive.prompt">${esc(p.proactive.prompt)}</textarea></label>
          <label class="checkbox-field"><input name="proactive.quiet_hours.enabled" type="checkbox" ${checked(p.proactive.quiet_hours?.enabled)}>启用免打扰</label>
          <span></span>
          <label class="form-field"><span>免打扰开始</span><input name="proactive.quiet_hours.start" type="time" value="${esc(p.proactive.quiet_hours?.start || "22:00")}"></label>
          <label class="form-field"><span>免打扰结束</span><input name="proactive.quiet_hours.end" type="time" value="${esc(p.proactive.quiet_hours?.end || "08:00")}"></label>
          <label class="checkbox-field"><input name="moments.publisher" type="checkbox" ${checked(p.moments.publisher)}>参与发布朋友圈</label>
          <label class="checkbox-field"><input name="moments.replier" type="checkbox" ${checked(p.moments.replier)}>参与回复朋友圈</label>
          <label class="form-field"><span>回复概率 (%)</span><input name="moments.reply_probability" type="number" min="0" max="100" value="${p.moments.reply_probability}"></label>
          <label class="checkbox-field"><input name="moments.memory_enabled" type="checkbox" ${checked(p.moments.memory_enabled)}>朋友圈写入记忆</label>
        </div>
      </section>
      <section class="form-section">
        <div class="form-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          <span>绑定世界书</span>
        </div>
        <div class="form-grid">${worldbookChecks(p.bound_worldbooks)}</div>
      </section>
      <div class="drawer-actions">
        <button type="button" class="btn ghost" data-action="close-drawer">取消</button>
        <button class="btn primary" type="submit">保存人物配置</button>
      </div>
    </form>`);
    const form = byId("persona-form");
    form.elements["tool_policy.mode"].value = p.tool_policy.mode;
    form.elements["memory.trigger_mode"].value = p.memory.trigger_mode;
    form.elements["image_generation.ref_mode"].value = p.image_generation.ref_mode || "avatar";
  } catch (error) {
    closeDrawer();
    toast(error.message, "error");
  }
}

function nestedPayload(form, prefix, fields) {
  const result = {};
  for (const field of fields) {
    const control = form.elements[`${prefix}.${field}`];
    if (!control) continue;
    if (field.includes(".")) {
      const [parent, child] = field.split(".");
      result[parent] ||= {};
      result[parent][child] = control.type === "checkbox" ? control.checked : control.value;
    } else if (control.type === "checkbox") result[field] = control.checked;
    else if (control.type === "number") result[field] = Number(control.value);
    else if (field === "list") result[field] = control.value.split(",").map(value => value.trim()).filter(Boolean);
    else result[field] = control.value;
  }
  return result;
}

async function saveEditor(form) {
  const personaId = form.dataset.personaId;
  const value = name => form.elements[name]?.value ?? "";
  const payload = {
    enabled: form.elements.enabled.checked,
    name: value("name"), signature: value("signature"),
    llm_provider: value("llm_provider"), llm_model: value("llm_model"),
    temperature: Number(value("temperature")), max_tokens: Number(value("max_tokens")),
    character_prompt: value("character_prompt"), output_examples: value("output_examples"), system_instructions: value("system_instructions"),
    emoji_enabled: form.elements.emoji_enabled.checked,
    emoji_send_probability: Number(value("emoji_send_probability")), emoji_group: value("emoji_group"),
    tool_policy: nestedPayload(form, "tool_policy", ["mode", "list", "max_iterations", "timeout_seconds"]),
    memory: nestedPayload(form, "memory", ["enabled", "include_in_prompt", "max_memories", "trigger_rounds", "trigger_mode"]),
    proactive: nestedPayload(form, "proactive", ["enabled", "min_idle_hours", "max_idle_hours", "max_consecutive", "prompt", "quiet_hours.enabled", "quiet_hours.start", "quiet_hours.end"]),
    image_generation: nestedPayload(form, "image_generation", ["enabled", "provider", "model", "style_prefix", "art_style", "negative_prompt", "negative_enabled", "ref_mode"]),
    voice_generation: nestedPayload(form, "voice_generation", ["enabled", "provider", "model", "voice", "speed"]),
    bound_worldbooks: [...form.querySelectorAll('[name="bound_worldbooks"]:checked')].map(input => input.value),
    moments: nestedPayload(form, "moments", ["publisher", "replier", "reply_probability", "memory_enabled"]),
  };
  try {
    await api.put(`/api/admin/personas/${encodeURIComponent(personaId)}`, payload);
    closeDrawer();
    toast("人物配置已保存", "success");
    await refreshAll();
  } catch (error) { toast(error.message, "error"); }
}

function renderBatchValue(definition) {
  if (!definition) return `<div class="muted">请选择要修改的字段</div>`;
  if (definition.type === "boolean") return `<label class="form-field"><span>目标状态</span><select id="batch-value"><option value="true">开启</option><option value="false">关闭</option></select></label>`;
  if (definition.type === "choice") return `<label class="form-field"><span>目标值</span><select id="batch-value">${definition.options.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join("")}</select></label>`;
  if (definition.type === "affix") return `<label class="form-field"><span>名称前缀</span><input id="batch-prefix" placeholder="例如：[NPC] "></label><label class="form-field"><span>名称后缀</span><input id="batch-suffix" placeholder="例如： (v2)"></label>`;
  if (definition.type === "worldbooks") return `<label class="form-field"><span>操作方式</span><select id="batch-mode"><option value="replace">替换为所选</option><option value="append">追加所选</option><option value="remove">移除所选</option></select></label><div class="form-field"><span>世界书</span>${worldbookChecks([]).replaceAll('name="bound_worldbooks"', 'name="batch-worldbooks"')}</div>`;
  if (definition.type === "prompt") {
    return `<label class="form-field"><span>操作方式</span><select id="batch-mode"><option value="overwrite">直接覆盖</option><option value="prepend">前置内容</option><option value="append">追加内容</option><option value="replace">查找替换</option><option value="template">套用模板</option></select></label>
      <label class="form-field"><span>模板（可选）</span><select id="batch-template"><option value="">不使用模板</option>${state.templates.filter(item => item.field === definition.value).map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("")}</select></label>
      <label class="form-field wide hidden" id="batch-find-wrap"><span>查找内容</span><input id="batch-find" placeholder="输入要替换的旧文本"></label>
      <label class="form-field wide"><span>提示词内容</span><textarea id="batch-value" placeholder="支持变量：{{name}}、{{signature}}、{{id}}"></textarea></label>`;
  }
  if (["llm-provider", "image-provider", "voice-provider"].includes(definition.type)) {
    const kind = definition.type === "llm-provider" ? "llm_providers" : definition.type === "image-provider" ? "image_providers" : "voice_providers";
    return `<label class="form-field"><span>目标服务商</span><select id="batch-value">${providerOptions(kind)}</select></label>`;
  }
  const tag = definition.type === "textarea" ? "textarea" : "input";
  const attrs = definition.type === "number" ? `type="number" min="${definition.min ?? ""}" max="${definition.max ?? ""}" step="${definition.step ?? 1}"` : "";
  return `<label class="form-field wide"><span>目标值</span><${tag} id="batch-value" ${attrs}></${tag}></label>`;
}

function renderBatchModal() {
  const options = BATCH_FIELDS.map(field => `<option value="${esc(field.value)}">${esc(field.label)}</option>`).join("");
  showModal(`<header class="modal-header">
    <div>
      <h2>批量编辑人物</h2>
      <div class="muted" style="margin-top:2px">已选定 ${state.selected.size} 个人物；提交前可清晰预览每次修改</div>
    </div>
    <button class="icon-btn" data-action="close-modal">×</button>
  </header>
  <div class="operation-builder">
    <label class="form-field">
      <span>选择修改字段</span>
      <select id="batch-field"><option value="">请选择字段…</option>${options}</select>
    </label>
    <div id="batch-value-host" class="operation-builder"><div class="muted" style="padding-top:24px">请选择要修改的字段</div></div>
  </div>
  <div class="modal-actions" style="margin-top:16px">
    <button class="btn secondary" data-action="add-operation">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      <span>加入操作列表</span>
    </button>
    <button class="btn ghost" data-action="templates">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span>管理提示词模板</span>
    </button>
  </div>
  <div id="operation-list" class="operation-list">${renderOperationList()}</div>
  <div class="modal-actions" style="justify-content:flex-end;margin-top:20px">
    <button class="btn ghost" data-action="close-modal">取消</button>
    <button class="btn primary" data-action="preview-batch" ${state.operations.length ? "" : "disabled"}>预览变更</button>
  </div>`);
}

function renderOperationList() {
  if (!state.operations.length) return `<div class="empty" style="padding:24px">尚未添加任何批量操作</div>`;
  return state.operations.map((operation, index) => `<div class="operation-item">
    <span>${esc(describeOperation(operation, fieldLabel))}</span>
    <button class="icon-btn" data-remove-operation="${index}" title="移除此操作">×</button>
  </div>`).join("");
}

function collectOperation() {
  const field = byId("batch-field")?.value || "";
  const definition = fieldDefinition(field);
  const input = { value: byId("batch-value")?.value || "", mode: byId("batch-mode")?.value || "" };
  if (definition?.type === "prompt") {
    input.find = byId("batch-find")?.value || "";
  } else if (definition?.type === "worldbooks") {
    input.values = [...document.querySelectorAll('[name="batch-worldbooks"]:checked')].map(element => element.value);
  } else if (definition?.type === "affix") {
    input.prefix = byId("batch-prefix")?.value || "";
    input.suffix = byId("batch-suffix")?.value || "";
  }
  return buildOperation(field, input);
}

async function previewBatch() {
  try {
    const preview = await api.post("/api/admin/batch/preview", {
      ids: [...state.selected], operations: state.operations,
    });
    showModal(`<header class="modal-header">
      <div>
        <h2>确认批量变更</h2>
        <div class="muted" style="margin-top:2px">${esc(summarizePreview(preview))}</div>
      </div>
      <button class="icon-btn" data-action="close-modal">×</button>
    </header>
    <div>${renderDiff(preview)}</div>
    <div class="modal-actions" style="justify-content:flex-end;margin-top:20px">
      <button class="btn ghost" data-action="batch">返回编辑</button>
      <button class="btn primary" data-action="apply-batch" data-version="${esc(preview.version)}" ${preview.changed_count ? "" : "disabled"}>确认应用</button>
    </div>`);
  } catch (error) { toast(error.message, "error"); }
}

async function applyBatch(version) {
  try {
    const result = await api.post("/api/admin/batch/apply", {
      ids: [...state.selected], operations: state.operations, version,
    });
    closeModal();
    state.operations = [];
    clearSelection();
    toast(`已成功更新 ${result.updated_count} 个人物`, "success");
    await refreshAll();
  } catch (error) { toast(error.message, "error"); }
}

function renderTemplates() {
  const selected = state.templates.find(item => item.id === editingTemplateId) || null;
  showModal(`<header class="modal-header">
    <div>
      <h2>提示词模板管理</h2>
      <div class="muted" style="margin-top:2px">支持动态变量：<code>{{name}}</code>、<code>{{signature}}</code>、<code>{{id}}</code></div>
    </div>
    <button class="icon-btn" data-action="close-modal">×</button>
  </header>
  <div class="template-grid">
    <div class="template-list">
      <button class="btn secondary" data-action="new-template">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        <span>新建模板</span>
      </button>
      ${state.templates.map(item => `
        <button class="template-item ${item.id === editingTemplateId ? "active" : ""}" data-template-id="${esc(item.id)}">
          <strong>${esc(item.name)}</strong>
          <div class="muted" style="font-size:11px;margin-top:3px">${esc(fieldLabel(item.field))}</div>
        </button>
      `).join("") || `<div class="muted" style="padding:16px 0;text-align:center">暂无保存的模板</div>`}
    </div>
    <form id="template-form">
      <label class="form-field"><span>模板名称</span><input name="name" value="${esc(selected?.name || "")}" placeholder="例如：赛博朋克世界观设定" required></label>
      <label class="form-field" style="margin-top:12px">
        <span>适用字段</span>
        <select name="field">
          <option value="character_prompt">人设设定 (Character Prompt)</option>
          <option value="output_examples">输出示例 (Output Examples)</option>
          <option value="system_instructions">系统指令 (System Instructions)</option>
        </select>
      </label>
      <label class="form-field" style="margin-top:12px">
        <span>模板内容</span>
        <textarea name="content" style="min-height:240px" placeholder="在此编写模板文本，可包含 {{name}}、{{signature}} 等变量…">${esc(selected?.content || "")}</textarea>
      </label>
      <div class="modal-actions" style="margin-top:16px;justify-content:flex-end">
        ${selected ? `<button type="button" class="btn danger" data-action="delete-template">删除此模板</button>` : ""}
        <button class="btn primary" type="submit">${selected ? "保存模板" : "创建模板"}</button>
      </div>
    </form>
  </div>`);
  byId("template-form").elements.field.value = selected?.field || "character_prompt";
}

async function saveTemplate(form) {
  const payload = { name: form.elements.name.value, field: form.elements.field.value, content: form.elements.content.value };
  try {
    if (editingTemplateId) await api.put(`/api/admin/prompt-templates/${encodeURIComponent(editingTemplateId)}`, payload);
    else await api.post("/api/admin/prompt-templates", payload);
    const data = await api.get("/api/admin/prompt-templates");
    state.templates = data.templates || [];
    editingTemplateId = null;
    renderTemplates();
    toast("模板已保存", "success");
  } catch (error) { toast(error.message, "error"); }
}

async function deleteTemplate() {
  if (!editingTemplateId || !window.confirm("确认删除这个提示词模板？")) return;
  try {
    await api.del(`/api/admin/prompt-templates/${encodeURIComponent(editingTemplateId)}`);
    state.templates = state.templates.filter(item => item.id !== editingTemplateId);
    editingTemplateId = null;
    renderTemplates();
    toast("模板已删除", "success");
  } catch (error) { toast(error.message, "error"); }
}

async function importFiles(files) {
  if (!files.length) return;
  const data = new FormData();
  for (const file of files) data.append("files", file);
  data.append("include_worldbooks", "true");
  try {
    const result = await api.post("/api/admin/personas/import", data);
    const failed = result.errors?.length || 0;
    toast(`已导入 ${result.imported.length} 个人物${failed ? `，失败 ${failed} 个` : ""}`, failed ? "error" : "success");
    await refreshAll();
  } catch (error) { toast(error.message, "error"); }
  byId("import-files").value = "";
}

async function exportSelected() {
  try {
    await api.download("/api/admin/personas/export", { ids: [...state.selected], include_worldbooks: true }, "pawzochat-personas.zip");
    toast("导出已开始", "success");
  } catch (error) { toast(error.message, "error"); }
}

async function cloneSelected() {
  if (!window.confirm(`复制所选 ${state.selected.size} 个人物？副本默认处于停用状态。`)) return;
  try {
    const result = await api.post("/api/admin/personas/clone", { ids: [...state.selected] });
    clearSelection();
    toast(`已成功复制 ${result.created.length} 个人物`, "success");
    await refreshAll();
  } catch (error) { toast(error.message, "error"); }
}

async function deleteSelected() {
  const confirmation = window.prompt(`将永久删除所选 ${state.selected.size} 个人物。\n请输入 DELETE 确认：`);
  if (confirmation !== "DELETE") return;
  const deleteConversations = window.confirm("是否同时永久删除这些人物的聊天记录？\n选择“取消”将保留对话历史。");
  try {
    const result = await api.post("/api/admin/personas/delete", { ids: [...state.selected], confirmation, delete_conversations: deleteConversations });
    clearSelection();
    toast(`已删除 ${result.deleted_count} 个人物`, "success");
    await refreshAll();
  } catch (error) { toast(error.message, "error"); }
}

function updateProviderModels(select) {
  const form = select.closest("form");
  const modelName = select.dataset.providerFor;
  const modelSelect = form?.elements[modelName];
  if (!modelSelect) return;
  const kind = modelName === "llm_model" ? "llm_providers" : modelName.startsWith("image_") ? "image_providers" : "voice_providers";
  modelSelect.innerHTML = modelOptions(kind, select.value, "");
}

function bindEvents() {
  document.addEventListener("click", event => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    const editId = event.target.closest("[data-edit-id]")?.dataset.editId;
    const templateId = event.target.closest("[data-template-id]")?.dataset.templateId;
    const removeIndex = event.target.closest("[data-remove-operation]")?.dataset.removeOperation;
    if (editId) return void openEditor(editId);
    if (templateId) { editingTemplateId = templateId; renderTemplates(); return; }
    if (removeIndex !== undefined) { state.operations.splice(Number(removeIndex), 1); renderBatchModal(); return; }
    if (!action) return;
    const actions = {
      "close-modal": closeModal,
      "close-drawer": closeDrawer,
      "reset-filters": () => {
        state.filters = { q: "", status: "all", provider: "", capability: "", worldbook: "" };
        state.page = 1;
        for (const id of ["filter-query", "filter-provider", "filter-capability", "filter-worldbook"]) byId(id).value = "";
        byId("filter-status").value = "all";
        void loadList();
      },
      "previous-page": () => { if (state.page > 1) { state.page -= 1; void loadList(); } },
      "next-page": () => { state.page += 1; void loadList(); },
      "clear-selection": () => { clearSelection(); renderRows(); },
      import: () => byId("import-files").click(),
      create: () => openPersonaCreator({ showModal, closeModal, toast, onCreated: refreshAll }),
      export: () => void exportSelected(),
      clone: () => void cloneSelected(),
      delete: () => void deleteSelected(),
      batch: () => state.selected.size ? renderBatchModal() : toast("请先选择要编辑的人物", "error"),
      templates: () => { editingTemplateId = null; renderTemplates(); },
      "new-template": () => { editingTemplateId = null; renderTemplates(); },
      "delete-template": () => void deleteTemplate(),
      "add-operation": () => {
        try { state.operations.push(collectOperation()); renderBatchModal(); }
        catch (error) { toast(error.message, "error"); }
      },
      "preview-batch": () => void previewBatch(),
      "apply-batch": () => void applyBatch(event.target.closest("[data-version]")?.dataset.version || ""),
    };
    actions[action]?.();
  });

  document.addEventListener("change", event => {
    if (event.target.matches("[data-select-id]")) {
      setSelection(event.target.dataset.selectId, event.target.checked);
      renderRows();
    } else if (event.target.id === "select-page") {
      selectVisible(event.target.checked);
      renderRows();
    } else if (event.target.matches("[data-provider-for]")) {
      updateProviderModels(event.target);
    } else if (event.target.id === "batch-field") {
      byId("batch-value-host").innerHTML = renderBatchValue(fieldDefinition(event.target.value));
    } else if (event.target.id === "batch-mode") {
      byId("batch-find-wrap")?.classList.toggle("hidden", event.target.value !== "replace");
    } else if (event.target.id === "batch-template") {
      const template = state.templates.find(item => item.id === event.target.value);
      if (template) {
        byId("batch-mode").value = "template";
        byId("batch-value").value = template.content;
      }
    } else if (event.target.id === "import-files") {
      void importFiles([...event.target.files]);
    }
  });

  document.addEventListener("submit", event => {
    event.preventDefault();
    if (event.target.id === "persona-form") void saveEditor(event.target);
    if (event.target.id === "template-form") void saveTemplate(event.target);
  });

  for (const [id, key] of [["filter-query", "q"], ["filter-status", "status"], ["filter-provider", "provider"], ["filter-capability", "capability"], ["filter-worldbook", "worldbook"]]) {
    const eventName = id === "filter-query" ? "input" : "change";
    byId(id).addEventListener(eventName, event => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        state.filters[key] = event.target.value;
        state.page = 1;
        void loadList();
      }, eventName === "input" ? 250 : 0);
    });
  }
  byId("modal-backdrop").addEventListener("click", closeModal);
  byId("drawer-backdrop").addEventListener("click", closeDrawer);
}

bindEvents();
void refreshAll();