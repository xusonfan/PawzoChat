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
import { esc, iconHtml } from "./utils.js";
import { api } from "./api.js";
import { toast, showLoading, hideLoading } from "./ui.js";
import {
  setTopBar, goBack,
  registerPageRenderer,
} from "./navigation.js";

const content = () => document.getElementById("content-area");

let _pluginsCache = [];
let _currentPlugin = null;

const _STATUS_LABELS = {
  active: "运行中",
  disabled: "已停用",
  broken: "异常",
  discovered: "已发现",
};

const _PERMISSION_LABELS = {
  "messaging.send": "主动发送消息",
  "mcp.read": "读取 MCP 工具",
  "mcp.invoke": "调用 MCP 工具",
  "mcp.publish": "向 LLM 暴露新工具",
};

let _iframeMessageHandler = null;

function _statusBadge(status) {
  const label = _STATUS_LABELS[status] || status;
  const cls = `plugin-status-${status === "active" ? "active" : status === "broken" ? "broken" : "disabled"}`;
  return `<span class="plugin-status ${cls}">${esc(label)}</span>`;
}

/* ============ Plugin List Page ============ */

async function renderPluginList() {
  setTopBar("插件管理", true,
    `<button class="top-btn" onclick="PawzoChat.pluginRefresh()" title="刷新插件列表">
      ${iconHtml("ri-refresh-line")}
    </button>`
  );
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;

  try {
    const res = await api.get("/api/plugins");
    _pluginsCache = res.plugins || [];
  } catch (e) {
    toast("加载插件列表失败", "error");
    return;
  }

  _renderPluginListBody();
}

function _renderPluginListBody() {
  const warning = `<div class="plugin-warning">
    ${iconHtml("ri-error-warning-line")}
    <span>安装第三方插件等同于在本机执行不受限的代码，请确认插件来源可信后再启用。PawzoChat 不对第三方插件的安全性负责，使用风险自负。</span>
  </div>`;

  if (_pluginsCache.length === 0) {
    content().innerHTML = `<div class="page">
      ${warning}
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:48px;height:48px;opacity:.4">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9v-2h2v2zm0-4H9V7h2v5zm4 4h-2v-2h2v2zm0-4h-2V7h2v5z"/>
        </svg>
        <div class="empty-text">暂无已安装的插件</div>
        <div style="font-size:13px;color:var(--text-3);margin-top:8px;max-width:280px;text-align:center;line-height:1.5">
          将插件目录放入 <code style="background:var(--bg);padding:1px 4px;border-radius:3px">data/plugins/</code> 后点击右上角刷新
        </div>
      </div>
    </div>`;
    return;
  }

  const cards = _pluginsCache.map(p => {
    const desc = p.description
      ? `<div style="font-size:12px;color:var(--text-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.description)}</div>`
      : "";
    const parts = [];
    if (p.author) parts.push(p.author);
    parts.push(`v${p.version}`);
    const meta = parts.join(" · ");

    return `<div class="card" style="margin:8px 16px">
      <div class="card-row" onclick="PawzoChat.pushPage('pluginDetail','${esc(p.id)}')">
        <div class="row-icon orange">${iconHtml("ri-plug-line")}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:14px;font-weight:500">${esc(p.name)}</span>
            ${_statusBadge(p.status)}
          </div>
          ${desc}
          <div style="font-size:11px;color:var(--text-3);margin-top:2px">${esc(meta)}</div>
        </div>
        <label class="switch-wrap" onclick="event.stopPropagation()">
          <input type="checkbox" ${p.enabled ? "checked" : ""}
            onchange="PawzoChat.pluginToggle('${esc(p.id)}',this.checked)">
          <span class="switch-track"></span>
        </label>
      </div>
    </div>`;
  }).join("");

  content().innerHTML = `<div class="page">${warning}${cards}</div>`;
}

/* ============ Plugin Detail Page ============ */

async function renderPluginDetail(pluginId) {
  setTopBar("插件详情", true, "");
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;

  try {
    _currentPlugin = await api.get(`/api/plugins/${pluginId}`);
    if (_currentPlugin.error) {
      toast("插件未找到", "error");
      goBack();
      return;
    }
  } catch (e) {
    toast("加载插件详情失败", "error");
    goBack();
    return;
  }

  _renderPluginDetailBody();
}

function _renderPluginDetailBody() {
  // Detach any prior iframe handler before re-rendering — re-attached below
  // when the new iframe (if any) loads.
  _detachIframeHandler();

  const p = _currentPlugin;
  if (!p) return;

  const m = p.manifest || {};
  const schema = m.config_schema || {};
  const settings = p.settings || {};
  const configUi = m.config_ui || {};
  const useCustomUi = !!configUi.entry;

  const desc = m.description
    ? `<div style="font-size:13px;color:var(--text-2);margin-top:4px;line-height:1.5">${esc(m.description)}</div>`
    : "";
  const errorBlock = p.last_error
    ? `<div class="plugin-error">${esc(p.last_error)}</div>`
    : "";

  const metaRows = [];
  if (m.author) metaRows.push(_metaRow("作者", esc(m.author)));
  if ((m.hooks || []).length)
    metaRows.push(_metaRow("Hooks", m.hooks.map(h => `<code>${esc(h)}</code>`).join(" ")));
  if ((m.depends_on || []).length)
    metaRows.push(_metaRow("依赖", m.depends_on.map(d => esc(d)).join(", ")));
  const perms = m.permissions || [];
  if (perms.length) {
    const items = perms.map(perm => {
      const label = _PERMISSION_LABELS[perm] || perm;
      return `<code title="${esc(label)}">${esc(perm)}</code>`;
    }).join(" ");
    metaRows.push(_metaRow("权限", items));
  }

  const hasSchemaFields = schema.type === "object" && schema.properties
    && Object.keys(schema.properties).length > 0;

  const providedTools = Array.isArray(p.provided_tools) ? p.provided_tools : [];
  const toolsSection = providedTools.length === 0
    ? ""
    : `<div class="card" style="margin:12px 16px 0">
        <div class="card-header">该插件提供的 LLM 工具</div>
        ${providedTools.map(t => {
          const desc = t.description
            ? `<div style="font-size:12px;color:var(--text-3);margin-top:2px">${esc(t.description)}</div>`
            : "";
          return `<div style="padding:10px 16px;border-top:1px solid var(--border)">
            <div style="font-family:var(--mono-font,monospace);font-size:12px;color:var(--text-2);word-break:break-all">${esc(t.name)}</div>
            ${desc}
          </div>`;
        }).join("")}
      </div>`;

  let configSection = "";
  if (useCustomUi) {
    const base = window.PAWZOCHAT_BASE || "";
    const entry = _encodePluginUiPath(configUi.entry);
    const src = `${base}/api/plugins/${encodeURIComponent(p.id)}/ui/${entry}`;
    const initialHeight = (typeof configUi.height === "number" && configUi.height > 0)
      ? `${configUi.height}px`
      : (configUi.height && configUi.height !== "auto" ? esc(String(configUi.height)) : "320px");
    configSection = `
      <div class="card" style="margin:12px 16px 0">
        <div class="card-header">插件配置</div>
        <iframe id="plugin-config-frame"
          src="${esc(src)}"
          sandbox="allow-scripts"
          style="width:100%;border:0;display:block;height:${initialHeight}"></iframe>
      </div>`;
  } else if (hasSchemaFields) {
    configSection = `
      <div class="card" style="margin:12px 16px 0">
        <div class="card-header">插件配置</div>
        ${_renderSchemaForm(schema, settings)}
        <div style="padding:12px 16px;text-align:right">
          <button class="btn-primary btn-sm" onclick="PawzoChat.pluginSaveConfig('${esc(p.id)}')">保存配置</button>
        </div>
      </div>`;
  }

  content().innerHTML = `<div class="page">
    <div class="card" style="margin:8px 16px">
      <div style="padding:16px">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:16px;font-weight:600">${esc(m.name || p.name)}</span>
          ${_statusBadge(p.status)}
        </div>
        <div style="font-size:12px;color:var(--text-3);margin-top:2px">v${esc(m.version || p.version)} · API v${m.api_version || 1}</div>
        ${desc}
        ${errorBlock}
        ${metaRows.length ? `<div class="plugin-meta">${metaRows.join("")}</div>` : ""}
      </div>
    </div>
    <div class="card" style="margin:0 16px">
      <div class="form-group"><div class="form-row">
        <label>启用插件</label>
        <label class="switch-wrap">
          <input type="checkbox" id="plugin-enabled-toggle" ${p.enabled ? "checked" : ""}
            onchange="PawzoChat.pluginToggle('${esc(p.id)}',this.checked)">
          <span class="switch-track"></span>
        </label>
      </div></div>
      <div class="form-group"><div class="form-row">
        <label>重新加载</label>
        <button class="btn-outline btn-sm" style="margin-left:auto" onclick="PawzoChat.pluginReload('${esc(p.id)}')">重载</button>
      </div></div>
    </div>
    ${toolsSection}
    ${configSection}
  </div>`;

  if (useCustomUi) _attachIframeHandler(p, schema, settings, configUi);
}

function _metaRow(label, value) {
  return `<div class="plugin-meta-row">
    <span class="plugin-meta-label">${esc(label)}</span>
    <span>${value}</span>
  </div>`;
}

function _encodePluginUiPath(path) {
  return String(path || "")
    .split("/")
    .filter(Boolean)
    .map(part => encodeURIComponent(part))
    .join("/");
}

/* ============ Schema Form Renderer ============ */

function _renderSchemaForm(schema, values) {
  if (!schema || schema.type !== "object" || !schema.properties) return "";
  const entries = Object.entries(schema.properties);
  entries.sort((a, b) => ((a[1].order ?? 999) - (b[1].order ?? 999)));
  return entries.map(([key, prop]) => _renderField(key, prop, values[key])).join("");
}

function _renderField(key, prop, value) {
  const type = prop.type || "string";
  const title = prop.title || key;
  const hint = prop.description
    ? `<div class="form-hint">${esc(prop.description)}</div>`
    : "";
  const ph = prop.placeholder ? ` placeholder="${esc(prop.placeholder)}"` : "";
  const da = `data-cfg-key="${esc(key)}" data-cfg-type="${esc(type)}"`;

  if (type === "boolean") {
    return `<div class="form-group"><div class="form-row">
      <label>${esc(title)}</label>
      <label class="switch-wrap">
        <input type="checkbox" ${da} ${value ? "checked" : ""}>
        <span class="switch-track"></span>
      </label>
    </div>${hint}</div>`;
  }

  if (type === "string" && prop.enum) {
    const labels = prop.enum_labels || {};
    const opts = prop.enum.map(v => {
      const sel = v === value ? " selected" : "";
      return `<option value="${esc(v)}"${sel}>${esc(labels[v] || v)}</option>`;
    }).join("");
    return `<div class="form-group"><div class="form-row">
      <label>${esc(title)}</label>
      <select ${da}>${opts}</select>
    </div>${hint}</div>`;
  }

  if (type === "string" && prop.secret) {
    return `<div class="form-group"><div class="form-row">
      <label>${esc(title)}</label>
      <input type="password" ${da} value="${esc(value || "")}"${ph}>
    </div>${hint}</div>`;
  }

  if (type === "string" && prop.multiline) {
    return `<div class="form-group"><div class="form-row" style="flex-direction:column;align-items:stretch;gap:4px">
      <label>${esc(title)}</label>
      <textarea ${da} rows="4"${ph} style="width:100%;resize:vertical;box-sizing:border-box">${esc(value || "")}</textarea>
    </div>${hint}</div>`;
  }

  if (type === "string") {
    return `<div class="form-group"><div class="form-row">
      <label>${esc(title)}</label>
      <input type="text" ${da} value="${esc(value || "")}"${ph}>
    </div>${hint}</div>`;
  }

  if (type === "integer" || type === "number") {
    const min = prop.minimum != null ? ` min="${prop.minimum}"` : "";
    const max = prop.maximum != null ? ` max="${prop.maximum}"` : "";
    const step = type === "integer" ? ' step="1"' : ' step="any"';
    return `<div class="form-group"><div class="form-row">
      <label>${esc(title)}</label>
      <input type="number" ${da} value="${value != null ? value : ""}"${min}${max}${step}${ph}>
    </div>${hint}</div>`;
  }

  if (type === "array" && prop.items && prop.items.type === "string") {
    const lines = Array.isArray(value) ? value.join("\n") : "";
    const arrPh = ph || ` placeholder="每行一项"`;
    return `<div class="form-group"><div class="form-row" style="flex-direction:column;align-items:stretch;gap:4px">
      <label>${esc(title)}</label>
      <textarea ${da} data-cfg-array="lines" rows="4"${arrPh} style="width:100%;resize:vertical;box-sizing:border-box">${esc(lines)}</textarea>
    </div>${hint}</div>`;
  }

  return `<div class="form-group"><div class="form-row">
    <label>${esc(title)}</label>
    <span class="readonly" style="font-size:13px;color:var(--text-3)">不支持的配置类型: ${esc(type)}</span>
  </div></div>`;
}

function _collectSettings() {
  const result = {};
  content().querySelectorAll("[data-cfg-key]").forEach(el => {
    const key = el.dataset.cfgKey;
    const type = el.dataset.cfgType;

    if (type === "boolean") {
      result[key] = el.checked;
    } else if (type === "integer") {
      result[key] = el.value === "" ? 0 : parseInt(el.value, 10);
    } else if (type === "number") {
      result[key] = el.value === "" ? 0 : parseFloat(el.value);
    } else if (type === "array" && el.dataset.cfgArray === "lines") {
      result[key] = el.value.split("\n").map(s => s.trim()).filter(Boolean);
    } else {
      result[key] = el.value;
    }
  });
  return result;
}

/* ============ Exported actions ============ */

export async function pluginToggle(pluginId, enabled) {
  const endpoint = enabled ? "enable" : "disable";
  showLoading("操作中…");
  try {
    const res = await api.post(`/api/plugins/${pluginId}/${endpoint}`, {});
    if (res.status >= 400) {
      toast(res.data.error || "操作失败", "error");
      _revertToggle();
      return;
    }
    toast(enabled ? "已启用" : "已停用", "success");

    if (_currentPlugin && _currentPlugin.id === pluginId) {
      _currentPlugin = res.data.plugin;
      _renderPluginDetailBody();
    } else {
      try {
        const listRes = await api.get("/api/plugins");
        _pluginsCache = listRes.plugins || [];
        _renderPluginListBody();
      } catch (_) { /* silent */ }
    }
  } catch (e) {
    toast("操作失败", "error");
    _revertToggle();
  }
  finally { hideLoading(); }
}

function _revertToggle() {
  const el = document.getElementById("plugin-enabled-toggle");
  if (el) el.checked = !el.checked;
}

export async function pluginSaveConfig(pluginId) {
  const settings = _collectSettings();
  showLoading("保存中…");
  try {
    const res = await api.patch(`/api/plugins/${pluginId}/config`, { settings });
    if (res.status >= 400) {
      toast(res.data.error || "保存失败", "error");
      return;
    }
    toast("配置已保存", "success");
    _currentPlugin = res.data.plugin;
    _renderPluginDetailBody();
  } catch (e) {
    toast("保存失败", "error");
  }
  finally { hideLoading(); }
}

export async function pluginReload(pluginId) {
  showLoading("重载中…");
  try {
    const res = await api.post(`/api/plugins/${pluginId}/reload`, {});
    if (res.status >= 400) {
      toast(res.data.error || "重载失败", "error");
      return;
    }
    toast("已重载", "success");
    _currentPlugin = res.data.plugin;
    _renderPluginDetailBody();
  } catch (e) {
    toast("重载失败", "error");
  }
  finally { hideLoading(); }
}

export async function pluginRefresh() {
  showLoading("刷新中…");
  try {
    const res = await api.post("/api/plugins/refresh", {});
    if (res.status >= 400) {
      toast(res.data.error || "刷新失败", "error");
      return;
    }
    _pluginsCache = res.data.plugins || [];
    _renderPluginListBody();
    toast("已刷新", "success");
  } catch (e) {
    toast("刷新失败", "error");
  }
  finally { hideLoading(); }
}

/* ============ Custom config UI (sandboxed iframe) ============ */

function _detachIframeHandler() {
  if (_iframeMessageHandler) {
    window.removeEventListener("message", _iframeMessageHandler);
    _iframeMessageHandler = null;
  }
}

function _attachIframeHandler(plugin, schema, settings, configUi) {
  const iframe = document.getElementById("plugin-config-frame");
  if (!iframe) return;

  const handler = async (event) => {
    // event.origin is "null" for sandboxed iframes (no allow-same-origin),
    // so we identify the sender by its window object instead.
    if (event.source !== iframe.contentWindow) return;
    const data = event.data || {};
    const type = data.type;
    if (!type) return;

    if (type === "ready") {
      iframe.contentWindow.postMessage({
        type: "init",
        plugin: {
          id: plugin.id,
          name: (plugin.manifest && plugin.manifest.name) || plugin.name,
          version: (plugin.manifest && plugin.manifest.version) || plugin.version,
        },
        schema,
        settings,
        locale: (navigator.language || "zh-CN"),
      }, "*");
      return;
    }

    if (type === "resize") {
      const heightAuto = configUi && (configUi.height === "auto" || configUi.height == null);
      if (!heightAuto) return;
      const h = Math.max(0, Math.floor(Number(data.height) || 0));
      if (h > 0) iframe.style.height = `${h}px`;
      return;
    }

    if (type === "toast") {
      const level = ["success", "error", "info"].includes(data.level) ? data.level : "info";
      const msg = String(data.message || "");
      if (msg) toast(msg, level);
      return;
    }

    if (type === "save") {
      const correlationId = data.id;
      try {
        const res = await api.patch(
          `/api/plugins/${plugin.id}/config`,
          { settings: data.settings || {} },
        );
        if (res.status >= 400) {
          const errMsg = (res.data && res.data.error) || "保存失败";
          iframe.contentWindow.postMessage({
            type: "save-result",
            id: correlationId,
            ok: false,
            error: errMsg,
          }, "*");
          toast(errMsg, "error");
          return;
        }
        // Refresh local copy so future "ready" handshakes (e.g. after a
        // plugin reload) see the latest settings.
        _currentPlugin = res.data.plugin;
        iframe.contentWindow.postMessage({
          type: "save-result",
          id: correlationId,
          ok: true,
          settings: res.data.settings || {},
        }, "*");
        toast("配置已保存", "success");
      } catch (e) {
        iframe.contentWindow.postMessage({
          type: "save-result",
          id: correlationId,
          ok: false,
          error: String(e && e.message || e),
        }, "*");
        toast("保存失败", "error");
      }
      return;
    }
  };

  _iframeMessageHandler = handler;
  window.addEventListener("message", handler);
}

/* ============ Register pages ============ */

registerPageRenderer("pluginList", renderPluginList);
registerPageRenderer("pluginDetail", renderPluginDetail);
