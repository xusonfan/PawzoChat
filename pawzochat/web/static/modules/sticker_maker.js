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
import { openChoicePicker } from "./choice_picker.js";
import {
  availableStickerProviders,
  modelSupportsReferenceImages,
  nextStickerGroupName,
  referenceImageFileError,
} from "./sticker_maker_capabilities.js";

const BASE = () => window.PAWZOCHAT_BASE || "";

const _maker = {
  providers: [],
  selectedProvider: "",
  selectedModel: "",
  referenceFile: null,
  referenceDataUrl: "",
  result: null,
  generating: false,
  saving: false,
};

function _modelsFor(providerName) {
  return _maker.providers.find(provider => provider.name === providerName)?.models || [];
}

function _selectedProviderLabel() {
  return _maker.providers.find(provider => provider.name === _maker.selectedProvider)?.name
    || "请选择";
}

function _selectedModel() {
  return _modelsFor(_maker.selectedProvider)
    .find(model => model.id === _maker.selectedModel);
}

function _selectedModelLabel() {
  const model = _selectedModel();
  return model?.name || model?.id || "请选择";
}

function _syncPickerLabels() {
  const providerValue = $("sticker-provider-value");
  const modelValue = $("sticker-model-value");
  if (providerValue) providerValue.textContent = _selectedProviderLabel();
  if (modelValue) modelValue.textContent = _selectedModelLabel();
}

function _selectedModelSupportsReference() {
  return modelSupportsReferenceImages(
    _maker.providers,
    _maker.selectedProvider,
    _maker.selectedModel,
  );
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

function _renderForm(suggestedName) {
  const provider = _maker.providers.find(item => item.name === _maker.selectedProvider)
    || _maker.providers[0];
  const model = provider.models.find(item => item.id === _maker.selectedModel)
    || provider.models[0];
  _maker.selectedProvider = provider.name;
  _maker.selectedModel = model?.id || "";

  content().innerHTML = `<div class="page sticker-maker-page">
    <input id="sticker-reference-file" type="file" accept="image/png,image/jpeg,image/webp" hidden onchange="PawzoChat.stickerMakerReferenceSelected(event)">

    <section class="sticker-maker-hero">
      <div class="sticker-maker-hero-icon">${iconHtml("ri-chat-smile-2-line")}</div>
      <div>
        <div class="sticker-maker-hero-title">AI 表情包工坊</div>
        <div class="sticker-maker-hero-desc">生成一张 4×4 表情表，并自动切成 16 张透明 PNG。</div>
      </div>
    </section>

    <section class="card sticker-maker-selector-card">
      <div class="sticker-maker-selectors">
        <div class="form-group">
          <button type="button" class="form-row choice-picker-trigger" onclick="PawzoChat.stickerMakerOpenProviderPicker()">
            <span class="choice-picker-trigger-label">服务商</span>
            <span id="sticker-provider-value" class="choice-picker-trigger-value">${esc(_selectedProviderLabel())}</span>
            <span class="row-arrow" aria-hidden="true">›</span>
          </button>
        </div>
        <div class="form-group">
          <button type="button" class="form-row choice-picker-trigger" onclick="PawzoChat.stickerMakerOpenModelPicker()">
            <span class="choice-picker-trigger-label">模型</span>
            <span id="sticker-model-value" class="choice-picker-trigger-value">${esc(_selectedModelLabel())}</span>
            <span class="row-arrow" aria-hidden="true">›</span>
          </button>
        </div>
      </div>
    </section>

    <section id="sticker-reference-card" class="card sticker-maker-card sticker-maker-reference-card">
      <div class="sticker-maker-section-title">参考图 <small>可选</small></div>
      <button type="button" class="sticker-maker-reference" onclick="PawzoChat.stickerMakerPickReference()">
        <span id="sticker-reference-preview" class="sticker-maker-reference-preview">${iconHtml("ri-upload-cloud-2-line")}</span>
        <span class="sticker-maker-reference-copy">
          <strong id="sticker-reference-title">上传参考图</strong>
          <small id="sticker-reference-hint">仅用于本次表情包生成，最大 10 MB</small>
        </span>
        <span class="row-arrow">›</span>
      </button>
    </section>

    <section class="card sticker-maker-card">
      <div class="sticker-maker-section-title">生成设置</div>
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
    <div class="sticker-maker-footnote">生成后可先预览切图；只有点击“保存表情包”才会写入表情包管理。</div>

    <section id="sticker-result" class="sticker-maker-result" hidden></section>
  </div>`;

  _syncGenerationMode();
}

async function renderStickerMaker() {
  setTopBar("表情包工坊", true, "");
  _maker.referenceFile = null;
  _maker.referenceDataUrl = "";
  _maker.result = null;
  _maker.saving = false;
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;

  try {
    const [providerResult, groupResult] = await Promise.all([
      api.get("/api/image-providers", { bypassCache: true }),
      api.get("/api/emoji/groups", { bypassCache: true }),
    ]);
    _maker.providers = availableStickerProviders(providerResult.providers);
    if (_maker.providers.length === 0) {
      _renderUnavailable();
      return;
    }
    _renderForm(nextStickerGroupName(groupResult.groups));
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
      ? `${iconHtml("ri-image-circle-line")}<span><strong>参考图模式</strong>：可上传一张参考图，也可以不上传直接按文字生成。</span>`
      : `${iconHtml("ri-text-snippet")}<span><strong>文字模式</strong>：当前模型不接收参考图，将根据画面描述与风格直接生成。</span>`;
  }
  if (styleLabel) {
    styleLabel.innerHTML = "画面描述与风格 <small>可选</small>";
  }
  if (styleInput) {
    styleInput.placeholder = supportsReference
      ? "例如：保持参考图主体特征，可爱 LINE 贴纸，简洁粗线条"
      : "例如：戴黄色围巾的橘猫，可爱 LINE 贴纸，简洁粗线条";
  }
}

export function stickerMakerOpenProviderPicker() {
  openChoicePicker({
    title: "选择生图服务商",
    selectedValue: _maker.selectedProvider,
    options: _maker.providers.map(provider => ({
      value: provider.name,
      label: provider.name,
    })),
    onSelect: providerName => {
      if (providerName === _maker.selectedProvider) return;
      _maker.selectedProvider = providerName;
      _maker.selectedModel = _modelsFor(providerName)[0]?.id || "";
      _syncPickerLabels();
      _syncGenerationMode();
    },
  });
}

export function stickerMakerOpenModelPicker() {
  openChoicePicker({
    title: "选择生图模型",
    selectedValue: _maker.selectedModel,
    options: _modelsFor(_maker.selectedProvider).map(model => ({
      value: model.id,
      label: model.name || model.id,
      description: model.name && model.name !== model.id ? model.id : "",
    })),
    onSelect: modelId => {
      _maker.selectedModel = modelId;
      _syncPickerLabels();
      _syncGenerationMode();
    },
  });
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
  const validationError = referenceImageFileError(file);
  if (validationError) {
    toast(validationError, "error");
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
    if (hint) hint.textContent = "本次生成将使用这张参考图";
  };
  reader.onerror = () => toast("读取参考图失败", "error");
  reader.readAsDataURL(file);
}

function _renderResult(result) {
  const host = $("sticker-result");
  if (!host) return;
  const modeLabel = result.used_reference_images ? "参考图模式" : "文字模式";
  const saved = result.saved === true;
  const statusText = saved
    ? `${result.count || 16} 张表情已保存 · ${modeLabel}`
    : `${result.count || 16} 张表情已生成 · 尚未保存 · ${modeLabel}`;
  const headerAction = saved
    ? `<button class="btn-text" onclick="PawzoChat.pushPage('emojiGroup',{name:${jsArg(result.group)}})">管理表情包</button>`
    : "";
  const saveAction = saved ? "" : `
    <div class="sticker-maker-save-bar">
      <span>确认切图效果后再保存，未保存草稿会自动过期。</span>
      <button class="sticker-maker-primary sticker-maker-save" onclick="PawzoChat.stickerMakerSave()">
        ${iconHtml("ri-save-line")}<span>保存表情包</span>
      </button>
    </div>`;

  host.hidden = false;
  host.innerHTML = `
    <div class="sticker-maker-result-head">
      <div>
        <strong>${saved ? "已保存" : "预览"}「${esc(result.group)}」</strong>
        <span>${statusText}</span>
      </div>
      ${headerAction}
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
    </div>
    ${saveAction}`;
  host.scrollIntoView({ behavior: "smooth", block: "start" });
}

export async function stickerMakerSave() {
  if (_maker.saving || !_maker.result || _maker.result.saved) return;
  const draftToken = _maker.result.draft_token || "";
  const groupName = ($("sticker-group-name")?.value || "").trim();
  if (!draftToken) {
    toast("表情包草稿不存在，请重新生成", "error");
    return;
  }
  if (!groupName) {
    toast("请输入表情包名称", "error");
    return;
  }

  _maker.saving = true;
  showLoading("正在保存表情包…");
  try {
    const response = await api.post(
      `/api/emoji/drafts/${encodeURIComponent(draftToken)}/save`,
      { group_name: groupName },
    );
    if (response.status >= 400) {
      toast(response.data?.error || "保存失败", "error");
      return;
    }
    _maker.result = {
      ..._maker.result,
      ...response.data,
      draft_token: "",
    };
    _renderResult(_maker.result);
    toast("表情包已保存", "success");
  } catch (error) {
    toast("保存失败，请稍后重试", "error");
  } finally {
    _maker.saving = false;
    hideLoading();
  }
}

export async function stickerMakerGenerate() {
  if (_maker.generating) return;
  const provider = _maker.selectedProvider;
  const model = _maker.selectedModel;
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
  if (supportsReference && _maker.referenceFile) {
    form.append("reference", _maker.referenceFile);
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
    toast(`已生成 ${result.count || 16} 张表情，请确认后保存`, "success");
  } catch (error) {
    toast("生成失败，请检查网络和模型配置", "error");
  } finally {
    _maker.generating = false;
    hideLoading();
  }
}

registerPageRenderer("stickerMaker", renderStickerMaker);