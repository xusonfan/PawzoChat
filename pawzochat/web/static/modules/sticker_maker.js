/*!
 * PawzoChat - Multi-platform LLM-powered chatbot
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { api } from "./api.js";
import { content, $ } from "./state.js";
import { setTopBar, registerPageRenderer } from "./navigation.js";
import { toast, showLoading, hideLoading } from "./ui.js";
import { esc, escAttr, iconHtml, jsArg } from "./utils.js";
import {
  availableStickerProviders,
  modelSupportsReferenceImages,
} from "./sticker_maker_capabilities.js";

const BASE = () => window.PAWZOCHAT_BASE || "";

const _maker = {
  providers: [],
  personas: [],
  referenceFile: null,
  referenceDataUrl: "",
  result: null,
  generating: false,
};

function _providerOptions(selected = "") {
  return _maker.providers.map(provider => (
    `<option value="${escAttr(provider.name)}" ${provider.name === selected ? "selected" : ""}>${esc(provider.name)}</option>`
  )).join("");
}

function _modelsFor(providerName) {
  return _maker.providers.find(provider => provider.name === providerName)?.models || [];
}

function _modelOptions(providerName, selected = "") {
  return _modelsFor(providerName).map(model => (
    `<option value="${escAttr(model.id)}" ${model.id === selected ? "selected" : ""}>${esc(model.name || model.id)}</option>`
  )).join("");
}

function _selectedModelSupportsReference() {
  return modelSupportsReferenceImages(
    _maker.providers,
    $("sticker-provider")?.value || "",
    $("sticker-model")?.value || "",
  );
}

function _personaHasReference(persona) {
  const mode = persona.image_generation?.ref_mode || "avatar";
  if (mode === "custom") return !!persona.has_image_ref;
  if (mode === "avatar") return !!persona.has_avatar;
  return false;
}

function _personaOptions() {
  const options = _maker.personas.map(persona => {
    const usable = _personaHasReference(persona);
    const suffix = usable ? "" : "（无参考图）";
    return `<option value="${escAttr(persona.id)}" ${usable ? "" : "disabled"}>${esc(persona.name)}${suffix}</option>`;
  }).join("");
  return `<option value="">不使用角色，上传参考图</option>${options}`;
}

function _defaultPersona() {
  return _maker.personas.find(_personaHasReference) || null;
}

function _renderUnavailable() {
  content().innerHTML = `<div class="page sticker-maker-page">
    <div class="sticker-maker-empty">
      <div class="sticker-maker-empty-icon">${iconHtml("ri-image-add-line")}</div>
      <div class="sticker-maker-empty-title">还没有可用的生图模型</div>
      <div class="sticker-maker-empty-desc">请先配置任意可用的生图服务商和模型。</div>
      <button class="sticker-maker-primary" onclick="PawzoChat.pushPage('settingsImageProviders')">去配置模型</button>
    </div>
  </div>`;
}

function _renderForm() {
  const provider = _maker.providers[0];
  const persona = _defaultPersona();
  const suggestedName = persona ? `${persona.name}表情包` : "我的表情包";

  content().innerHTML = `<div class="page sticker-maker-page">
    <input id="sticker-reference-file" type="file" accept="image/png,image/jpeg,image/webp" hidden onchange="PawzoChat.stickerMakerReferenceSelected(event)">

    <section class="sticker-maker-hero">
      <div class="sticker-maker-hero-icon">${iconHtml("ri-chat-smile-2-line")}</div>
      <div>
        <div class="sticker-maker-hero-title">AI 表情包工坊</div>
        <div class="sticker-maker-hero-desc">生成一张 4×4 表情表，并自动切成 16 张透明 PNG。</div>
      </div>
    </section>

    <section id="sticker-reference-card" class="card sticker-maker-card">
      <div class="sticker-maker-section-title">角色参考</div>
      <label class="sticker-maker-field">
        <span>已有角色</span>
        <select id="sticker-persona" class="form-select" onchange="PawzoChat.stickerMakerPersonaChange()">
          ${_personaOptions()}
        </select>
      </label>
      <button type="button" class="sticker-maker-reference" onclick="PawzoChat.stickerMakerPickReference()">
        <span id="sticker-reference-preview" class="sticker-maker-reference-preview">${iconHtml("ri-upload-cloud-2-line")}</span>
        <span class="sticker-maker-reference-copy">
          <strong id="sticker-reference-title">上传临时参考图</strong>
          <small id="sticker-reference-hint">上传后优先于角色参考图，最大 10 MB</small>
        </span>
        <span class="row-arrow">›</span>
      </button>
    </section>

    <section class="card sticker-maker-card">
      <div class="sticker-maker-section-title">生成设置</div>
      <div class="sticker-maker-fields-grid">
        <label class="sticker-maker-field">
          <span>生图服务商</span>
          <select id="sticker-provider" class="form-select" onchange="PawzoChat.stickerMakerProviderChange()">
            ${_providerOptions(provider.name)}
          </select>
        </label>
        <label class="sticker-maker-field">
          <span>模型</span>
          <select id="sticker-model" class="form-select" onchange="PawzoChat.stickerMakerModelChange()">
            ${_modelOptions(provider.name)}
          </select>
        </label>
      </div>
      <div id="sticker-generation-mode" class="sticker-maker-mode"></div>
      <label class="sticker-maker-field">
        <span>新表情包名称</span>
        <input id="sticker-group-name" class="form-input" maxlength="50" value="${escAttr(suggestedName)}" placeholder="例如：小晚日常" oninput="this.dataset.edited='1'">
      </label>
      <label class="sticker-maker-field">
        <span id="sticker-style-label">画面风格 <small>可选</small></span>
        <textarea id="sticker-style" class="form-textarea sticker-maker-style" maxlength="500" rows="3" placeholder="例如：可爱 LINE 贴纸，简洁粗线条，色彩明快"></textarea>
      </label>
    </section>

    <button id="sticker-generate" class="sticker-maker-primary sticker-maker-generate" onclick="PawzoChat.stickerMakerGenerate()">
      ${iconHtml("ri-sparkling-2-line")}<span>生成 16 张表情</span>
    </button>
    <div class="sticker-maker-footnote">模型只调用一次；切图、去白底和保存均在 PawzoChat 内完成。</div>

    <section id="sticker-result" class="sticker-maker-result" hidden></section>
  </div>`;

  const personaSelect = $("sticker-persona");
  if (personaSelect && persona) personaSelect.value = persona.id;
  _syncGenerationMode();
}

async function renderStickerMaker() {
  setTopBar("表情包工坊", true, "");
  _maker.referenceFile = null;
  _maker.referenceDataUrl = "";
  _maker.result = null;
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;

  try {
    const [providerResult, personaResult] = await Promise.all([
      api.get("/api/image-providers", { bypassCache: true }),
      api.get("/api/personas"),
    ]);
    _maker.providers = availableStickerProviders(providerResult.providers);
    _maker.personas = personaResult.personas || [];
    if (_maker.providers.length === 0) {
      _renderUnavailable();
      return;
    }
    _renderForm();
  } catch (error) {
    content().innerHTML = `<div class="empty-state"><div class="empty-text">加载配置失败</div></div>`;
    toast("加载配置失败", "error");
  }
}

function _syncGenerationMode() {
  const supportsReference = _selectedModelSupportsReference();
  const referenceCard = $("sticker-reference-card");
  const mode = $("sticker-generation-mode");
  const styleLabel = $("sticker-style-label");
  const styleInput = $("sticker-style");

  if (referenceCard) referenceCard.hidden = !supportsReference;
  if (mode) {
    mode.classList.toggle("supports-reference", supportsReference);
    mode.innerHTML = supportsReference
      ? `${iconHtml("ri-image-circle-line")}<span><strong>参考图模式</strong>：可使用角色图片或临时上传图片，也可以留空按文字生成。</span>`
      : `${iconHtml("ri-text-snippet")}<span><strong>文字模式</strong>：当前模型不接收参考图，将根据角色描述和画面风格直接生成。</span>`;
  }
  if (styleLabel) {
    styleLabel.innerHTML = supportsReference
      ? "画面风格 <small>可选</small>"
      : "角色描述与画面风格 <small>可选</small>";
  }
  if (styleInput) {
    styleInput.placeholder = supportsReference
      ? "例如：可爱 LINE 贴纸，简洁粗线条，色彩明快"
      : "例如：戴黄色围巾的橘猫，可爱 LINE 贴纸，简洁粗线条";
  }
}

export function stickerMakerProviderChange() {
  const providerName = $("sticker-provider")?.value || "";
  const modelSelect = $("sticker-model");
  if (modelSelect) modelSelect.innerHTML = _modelOptions(providerName);
  _syncGenerationMode();
}

export function stickerMakerModelChange() {
  _syncGenerationMode();
}

export function stickerMakerPersonaChange() {
  const personaId = $("sticker-persona")?.value || "";
  const persona = _maker.personas.find(item => item.id === personaId);
  const groupInput = $("sticker-group-name");
  if (persona && groupInput && !groupInput.dataset.edited) {
    groupInput.value = `${persona.name}表情包`;
  }
}

export function stickerMakerPickReference() {
  const input = $("sticker-reference-file");
  if (input) {
    input.value = "";
    input.click();
  }
}

export function stickerMakerReferenceSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    toast("请选择图片文件", "error");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    toast("参考图不能超过 10 MB", "error");
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    _maker.referenceFile = file;
    _maker.referenceDataUrl = String(reader.result || "");
    const preview = $("sticker-reference-preview");
    const title = $("sticker-reference-title");
    const hint = $("sticker-reference-hint");
    if (preview) {
      preview.innerHTML = `<img src="${escAttr(_maker.referenceDataUrl)}" alt="参考图预览">`;
      preview.classList.add("has-image");
    }
    if (title) title.textContent = file.name;
    if (hint) hint.textContent = "将优先使用这张临时参考图";
  };
  reader.onerror = () => toast("读取参考图失败", "error");
  reader.readAsDataURL(file);
}

function _renderResult(result) {
  const host = $("sticker-result");
  if (!host) return;
  host.hidden = false;
  host.innerHTML = `
    <div class="sticker-maker-result-head">
      <div>
        <strong>已生成「${esc(result.group)}」</strong>
        <span>${result.count || 16} 张表情已保存 · ${result.used_reference_images ? "参考图模式" : "文字模式"}</span>
      </div>
      <button class="btn-text" onclick="PawzoChat.pushPage('emojiGroup',{name:${jsArg(result.group)}})">管理表情包</button>
    </div>
    <button type="button" class="sticker-maker-sheet" onclick="PawzoChat.openImagePreview('${BASE()}${result.sheet_url}')">
      <img src="${BASE()}${result.sheet_url}" alt="完整表情表">
      <span>查看模型原图</span>
    </button>
    <div class="sticker-maker-grid">
      ${(result.stickers || []).map(sticker => `
        <div class="sticker-maker-item">
          <img src="${BASE()}${sticker.url}" alt="${escAttr(sticker.emotion)}">
          <span>${esc(sticker.emotion)}</span>
        </div>
      `).join("")}
    </div>`;
  host.scrollIntoView({ behavior: "smooth", block: "start" });
}

export async function stickerMakerGenerate() {
  if (_maker.generating) return;
  const provider = $("sticker-provider")?.value || "";
  const model = $("sticker-model")?.value || "";
  const personaId = $("sticker-persona")?.value || "";
  const groupName = ($("sticker-group-name")?.value || "").trim();
  const style = ($("sticker-style")?.value || "").trim();
  const supportsReference = _selectedModelSupportsReference();

  if (!provider || !model) {
    toast("请选择生图服务商和模型", "error");
    return;
  }
  if (!groupName) {
    toast("请输入新表情包名称", "error");
    return;
  }

  const form = new FormData();
  form.append("provider", provider);
  form.append("model", model);
  form.append("group_name", groupName);
  form.append("style", style);
  if (supportsReference) {
    form.append("persona_id", personaId);
    if (_maker.referenceFile) form.append("reference", _maker.referenceFile);
  }

  _maker.generating = true;
  showLoading(
    supportsReference
      ? "模型正在生成表情表…"
      : "模型正在根据文字生成表情表…",
  );
  try {
    const response = await fetch(`${BASE()}/api/emoji/generate`, {
      method: "POST",
      body: form,
    });
    const result = await response.json();
    if (!response.ok) {
      toast(result?.error || "生成失败", "error");
      return;
    }
    _maker.result = result;
    _renderResult(result);
    toast(`已生成 ${result.count || 16} 张表情`, "success");
  } catch (error) {
    toast("生成失败，请检查网络和模型配置", "error");
  } finally {
    _maker.generating = false;
    hideLoading();
  }
}

registerPageRenderer("stickerMaker", renderStickerMaker);