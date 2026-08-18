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
import { $, content } from "./state.js";
import { esc, escAttr, iconHtml } from "./utils.js";
import { setTopBar, pushPage, registerPageRenderer } from "./navigation.js";
import { confirm, toast } from "./ui.js";
import { openImagePreview } from "./image_preview.js";
import {
  modelSupportsReferenceImages,
  referenceImageFileError,
} from "./sticker_maker_capabilities.js";
import {
  allImageIds,
  chooseImageModel,
  toggleImageSelection,
} from "./image_gallery_state.js";

const BASE = () => window.PAWZOCHAT_BASE || "";

const _gallery = {
  providers: [],
  provider: "",
  model: "",
  images: [],
  selecting: false,
  selectedIds: new Set(),
  referenceFile: null,
  referenceDataUrl: "",
  generating: false,
};

function _modelsFor(providerName) {
  return _gallery.providers.find(provider => provider.name === providerName)?.models || [];
}

function _providerOptions() {
  return _gallery.providers.map(provider => (
    `<option value="${escAttr(provider.name)}" ${provider.name === _gallery.provider ? "selected" : ""}>${esc(provider.name)}</option>`
  )).join("");
}

function _modelOptions() {
  return _modelsFor(_gallery.provider).map(model => (
    `<option value="${escAttr(model.id)}" ${model.id === _gallery.model ? "selected" : ""}>${esc(model.name || model.id)}</option>`
  )).join("");
}

function _selectedModelSupportsReference() {
  return modelSupportsReferenceImages(
    _gallery.providers,
    _gallery.provider,
    _gallery.model,
  );
}

function _syncReferenceMode() {
  const block = $("image-gallery-reference-block");
  if (block) block.hidden = !_selectedModelSupportsReference();
}

function _renderReferencePreview() {
  const preview = $("image-gallery-reference-preview");
  const title = $("image-gallery-reference-title");
  const hint = $("image-gallery-reference-hint");
  const clear = $("image-gallery-reference-clear");
  if (!preview || !title || !hint || !clear) return;
  if (_gallery.referenceFile && _gallery.referenceDataUrl) {
    preview.innerHTML = `<img src="${escAttr(_gallery.referenceDataUrl)}" alt="参考图预览">`;
    preview.classList.add("has-image");
    title.textContent = _gallery.referenceFile.name;
    hint.textContent = "本次生成将使用这张参考图";
    clear.hidden = false;
    return;
  }
  preview.innerHTML = iconHtml("ri-upload-cloud-2-line");
  preview.classList.remove("has-image");
  title.textContent = "上传参考图";
  hint.textContent = "仅用于本次图片生成，最大 10 MB";
  clear.hidden = true;
}

function _formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function _renderSelectionBar() {
  const target = $("image-gallery-selection-bar");
  if (!target) return;
  if (!_gallery.selecting) {
    target.innerHTML = _gallery.images.length
      ? `<button type="button" class="image-gallery-manage" onclick="PawzoChat.imageGalleryEnterSelection()">批量管理</button>`
      : "";
    return;
  }
  const count = _gallery.selectedIds.size;
  const allSelected = _gallery.images.length > 0 && count === _gallery.images.length;
  target.innerHTML = `
    <div class="image-gallery-selection-copy">已选择 ${count} 张</div>
    <button type="button" class="btn-text" onclick="PawzoChat.imageGalleryToggleAll()">${allSelected ? "取消全选" : "全选"}</button>
    <button type="button" class="btn-text danger" ${count ? "" : "disabled"} onclick="PawzoChat.imageGalleryDeleteSelected()">删除</button>
    <button type="button" class="btn-text" onclick="PawzoChat.imageGalleryExitSelection()">完成</button>`;
}

function _renderGrid() {
  const target = $("image-gallery-grid-wrap");
  if (!target) return;
  if (!_gallery.images.length) {
    target.innerHTML = `<div class="image-gallery-empty">
      <div class="image-gallery-empty-icon">${iconHtml("ri-gallery-line")}</div>
      <strong>还没有生成记录</strong>
      <span>输入提示词生成第一张图片，完成后会自动保存在这里。</span>
    </div>`;
    _renderSelectionBar();
    return;
  }

  target.innerHTML = `<div class="image-gallery-grid">${_gallery.images.map(image => {
    const selected = _gallery.selectedIds.has(image.id);
    return `<article class="image-gallery-item ${selected ? "is-selected" : ""}">
      <button type="button" class="image-gallery-thumb" onclick="PawzoChat.imageGalleryOpen('${escAttr(image.id)}')" aria-label="${_gallery.selecting ? "选择图片" : "预览图片"}">
        <img src="${escAttr(image.image_url)}" alt="AI 生成图片" loading="lazy">
        <time class="image-gallery-time">${esc(_formatDate(image.created_at))}</time>
        ${_gallery.selecting ? `<span class="image-gallery-check" aria-hidden="true">${selected ? "✓" : ""}</span>` : ""}
      </button>
      ${_gallery.selecting ? "" : `<div class="image-gallery-item-body">
        <div class="image-gallery-actions">
          <button type="button" onclick="PawzoChat.imageGalleryReusePrompt('${escAttr(image.id)}')">复用提示词</button>
          <button type="button" class="danger" onclick="PawzoChat.imageGalleryDelete('${escAttr(image.id)}')">删除</button>
        </div>
      </div>`}
    </article>`;
  }).join("")}</div>`;
  _renderSelectionBar();
}

function imageGalleryProviderChange() {
  _gallery.provider = $("image-gallery-provider")?.value || "";
  _gallery.model = _modelsFor(_gallery.provider)[0]?.id || "";
  const modelSelect = $("image-gallery-model");
  if (modelSelect) modelSelect.innerHTML = _modelOptions();
  _syncReferenceMode();
}

function imageGalleryModelChange() {
  _gallery.model = $("image-gallery-model")?.value || "";
  _syncReferenceMode();
}

function imageGalleryPickReference() {
  const input = $("image-gallery-reference-file");
  if (!input) return;
  input.value = "";
  input.click();
}

function imageGalleryReferenceSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const validationError = referenceImageFileError(file);
  if (validationError) {
    toast(validationError, "error");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    _gallery.referenceFile = file;
    _gallery.referenceDataUrl = String(reader.result || "");
    _renderReferencePreview();
  };
  reader.onerror = () => toast("读取参考图失败", "error");
  reader.readAsDataURL(file);
}

function imageGalleryClearReference(event) {
  event?.stopPropagation();
  _gallery.referenceFile = null;
  _gallery.referenceDataUrl = "";
  _renderReferencePreview();
}

async function imageGalleryGenerate() {
  if (_gallery.generating) return;
  const prompt = ($("image-gallery-prompt")?.value || "").trim();
  if (!_gallery.provider || !_gallery.model) {
    toast("请先选择生图服务商与模型", "error");
    return;
  }
  if (!prompt) {
    toast("请输入提示词", "error");
    return;
  }

  const form = new FormData();
  form.append("provider", _gallery.provider);
  form.append("model", _gallery.model);
  form.append("prompt", prompt);
  if (_selectedModelSupportsReference() && _gallery.referenceFile) {
    form.append("reference", _gallery.referenceFile);
  }

  localStorage.setItem("pw_last_image_provider", _gallery.provider);
  localStorage.setItem("pw_last_image_model", _gallery.model);
  const button = $("image-gallery-generate");
  _gallery.generating = true;
  if (button) { button.disabled = true; button.textContent = "生成中…"; }
  try {
    const rawResponse = await fetch(`${BASE()}/api/image-gallery/generate`, {
      method: "POST",
      body: form,
    });
    const result = await rawResponse.json();
    if (!rawResponse.ok || !result?.image) {
      toast(result?.error || "图片生成失败", "error");
      return;
    }
    _gallery.images = [result.image, ..._gallery.images];
    _renderGrid();
    toast("图片已生成并保存", "success");
  } catch (error) {
    toast("图片生成失败，请检查网络或生图配置", "error");
  } finally {
    _gallery.generating = false;
    if (button) { button.disabled = false; button.textContent = "生成图片"; }
  }
}

function imageGalleryOpen(imageId) {
  if (_gallery.selecting) {
    _gallery.selectedIds = toggleImageSelection(_gallery.selectedIds, imageId);
    _renderGrid();
    return;
  }
  const image = _gallery.images.find(item => item.id === imageId);
  if (image) openImagePreview(
    image.image_url,
    _gallery.images.map(item => item.image_url),
    _gallery.images.map(item => item.prompt || ""),
  );
}

function imageGalleryReusePrompt(imageId) {
  const image = _gallery.images.find(item => item.id === imageId);
  const input = $("image-gallery-prompt");
  if (!image || !input) return;
  input.value = image.prompt || "";
  $("image-gallery-generator")?.scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => input.focus(), 250);
}

async function _deleteIds(ids) {
  const response = ids.length === 1
    ? await api.del(`/api/image-gallery/${encodeURIComponent(ids[0])}`)
    : await api.post("/api/image-gallery/batch-delete", { ids });
  if (response.status < 200 || response.status >= 300 || !response.data?.ok) {
    throw new Error(response.data?.error || "删除失败");
  }
  const removed = new Set(ids);
  _gallery.images = _gallery.images.filter(image => !removed.has(image.id));
  _gallery.selectedIds = new Set();
  if (!_gallery.images.length) _gallery.selecting = false;
  _renderGrid();
}

async function imageGalleryDelete(imageId) {
  const accepted = await confirm("删除图片", "删除后无法恢复，确定要删除这张图片吗？", true);
  if (!accepted) return;
  try {
    await _deleteIds([imageId]);
    toast("图片已删除", "success");
  } catch (error) {
    toast(error.message || "删除失败", "error");
  }
}

function imageGalleryEnterSelection() {
  _gallery.selecting = true;
  _gallery.selectedIds = new Set();
  _renderGrid();
}

function imageGalleryExitSelection() {
  _gallery.selecting = false;
  _gallery.selectedIds = new Set();
  _renderGrid();
}

function imageGalleryToggleAll() {
  _gallery.selectedIds = _gallery.selectedIds.size === _gallery.images.length
    ? new Set()
    : new Set(allImageIds(_gallery.images));
  _renderGrid();
}

async function imageGalleryDeleteSelected() {
  const ids = [..._gallery.selectedIds];
  if (!ids.length) return;
  const accepted = await confirm(
    "批量删除图片",
    `将永久删除选中的 ${ids.length} 张图片，是否继续？`,
    true,
  );
  if (!accepted) return;
  try {
    await _deleteIds(ids);
    toast(`已删除 ${ids.length} 张图片`, "success");
  } catch (error) {
    toast(error.message || "批量删除失败", "error");
  }
}

async function renderImageGallery() {
  setTopBar("AI 图库", true, "");
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;

  try {
    const [providerResult, galleryResult] = await Promise.all([
      api.get("/api/image-providers", { bypassCache: true }),
      api.get("/api/image-gallery", { bypassCache: true }),
    ]);
    const choice = chooseImageModel(
      providerResult.providers,
      localStorage.getItem("pw_last_image_provider") || "",
      localStorage.getItem("pw_last_image_model") || "",
    );
    _gallery.providers = choice.providers;
    _gallery.provider = choice.provider;
    _gallery.model = choice.model;
    _gallery.images = Array.isArray(galleryResult.images) ? galleryResult.images : [];
  } catch (error) {
    _gallery.providers = [];
    _gallery.provider = "";
    _gallery.model = "";
    _gallery.images = [];
  }
  _gallery.selecting = false;
  _gallery.selectedIds = new Set();
  _gallery.referenceFile = null;
  _gallery.referenceDataUrl = "";

  content().innerHTML = `<div class="page image-gallery-page">
    <section id="image-gallery-generator" class="card image-gallery-generator">
      <input id="image-gallery-reference-file" type="file" accept="image/png,image/jpeg,image/webp" hidden onchange="PawzoChat.imageGalleryReferenceSelected(event)">
      <div class="card-header">图片生成</div>
      ${_gallery.providers.length ? `<div class="form-group"><div class="form-row"><label for="image-gallery-provider">生图服务商</label>
        <select id="image-gallery-provider" onchange="PawzoChat.imageGalleryProviderChange()">${_providerOptions()}</select>
      </div></div>
      <div class="form-group"><div class="form-row"><label for="image-gallery-model">生图模型</label>
        <select id="image-gallery-model" onchange="PawzoChat.imageGalleryModelChange()">${_modelOptions()}</select>
      </div></div>
      <div id="image-gallery-reference-block" class="image-gallery-reference-block" ${_selectedModelSupportsReference() ? "" : "hidden"}>
        <div class="image-gallery-reference-label">参考图 <small>可选</small></div>
        <button type="button" class="sticker-maker-reference" onclick="PawzoChat.imageGalleryPickReference()">
          <span id="image-gallery-reference-preview" class="sticker-maker-reference-preview">${iconHtml("ri-upload-cloud-2-line")}</span>
          <span class="sticker-maker-reference-copy">
            <strong id="image-gallery-reference-title">上传参考图</strong>
            <small id="image-gallery-reference-hint">仅用于本次图片生成，最大 10 MB</small>
          </span>
          <span class="row-arrow">›</span>
        </button>
        <button id="image-gallery-reference-clear" type="button" class="image-gallery-reference-clear" hidden onclick="PawzoChat.imageGalleryClearReference(event)">清除参考图</button>
      </div>
      <textarea id="image-gallery-prompt" class="form-textarea image-gallery-prompt" maxlength="8000" placeholder="描述你想生成的画面，例如：雨夜霓虹街道，一只撑着透明雨伞的白猫，电影感光影"></textarea>
      <div class="image-gallery-generate-wrap"><button id="image-gallery-generate" class="btn-primary" type="button" onclick="PawzoChat.imageGalleryGenerate()">生成图片</button></div>`
      : `<div class="image-gallery-config-empty"><span>尚未配置可用的生图服务商和模型。</span><button type="button" onclick="PawzoChat.pushPage('settingsImageProviders')">去配置</button></div>`}
    </section>
    <section class="image-gallery-library">
      <div class="image-gallery-heading"><div><h2>我的图库</h2><span>${_gallery.images.length} 张图片</span></div><div id="image-gallery-selection-bar"></div></div>
      <div id="image-gallery-grid-wrap"></div>
    </section>
  </div>`;
  _renderGrid();
}

registerPageRenderer("imageGallery", renderImageGallery);

export {
  imageGalleryProviderChange,
  imageGalleryModelChange,
  imageGalleryPickReference,
  imageGalleryReferenceSelected,
  imageGalleryClearReference,
  imageGalleryGenerate,
  imageGalleryOpen,
  imageGalleryReusePrompt,
  imageGalleryDelete,
  imageGalleryEnterSelection,
  imageGalleryExitSelection,
  imageGalleryToggleAll,
  imageGalleryDeleteSelected,
};