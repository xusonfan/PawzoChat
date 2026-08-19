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
import { esc } from "./utils.js";
import { setTopBar, pushPage, registerPageRenderer } from "./navigation.js";
import { toast } from "./ui.js";
import { openChoicePicker } from "./choice_picker.js";

const RADAR_CACHE_KEY = "pawzo_radar_recommendations_v1";
const RADAR_PERSONA_TYPES = [
  "偏真人角色",
  "偏动漫角色",
  "游戏角色",
  "影视剧角色",
  "小说角色",
  "虚拟偶像",
  "历史幻想角色",
  "非人类角色",
];

const _radar = {
  providers: [],
  selectedProvider: "",
  selectedModel: "",
  personaType: "",
  personaTypeInitialized: false,
  recommendations: [],
  requestVersion: 0,
};

function _validRecommendation(item) {
  return item && typeof item === "object"
    && typeof item.title === "string" && item.title.trim()
    && typeof item.summary === "string" && item.summary.trim()
    && typeof item.request === "string" && item.request.trim()
    && Array.isArray(item.tags) && item.tags.length > 0
    && item.tags.every(tag => typeof tag === "string" && tag.trim());
}

function _readRecommendationCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(RADAR_CACHE_KEY) || "null");
    if (!cached || !Array.isArray(cached.recommendations)) return null;
    const recommendations = cached.recommendations.filter(_validRecommendation);
    if (!recommendations.length) return null;
    return {
      provider: typeof cached.provider === "string" ? cached.provider : "",
      model: typeof cached.model === "string" ? cached.model : "",
      personaType: typeof cached.personaType === "string" ? cached.personaType : "",
      recommendations,
    };
  } catch (error) {
    return null;
  }
}

function _writeRecommendationCache(provider, model, personaType, recommendations) {
  try {
    localStorage.setItem(RADAR_CACHE_KEY, JSON.stringify({
      provider,
      model,
      personaType,
      recommendations,
    }));
  } catch (error) {
    // Storage may be disabled or full; the current in-memory result still works.
  }
}

function _modelsFor(providerName) {
  return _radar.providers.find(provider => provider.name === providerName)?.models || [];
}

function _selectedProviderLabel() {
  return _radar.providers.find(provider => provider.name === _radar.selectedProvider)?.name
    || "请选择";
}

function _selectedModelLabel() {
  const model = _modelsFor(_radar.selectedProvider)
    .find(item => item.id === _radar.selectedModel);
  return model?.name || model?.id || "请选择";
}

function _syncPickerLabels() {
  const providerValue = $("radar-provider-value");
  const modelValue = $("radar-model-value");
  if (providerValue) providerValue.textContent = _selectedProviderLabel();
  if (modelValue) modelValue.textContent = _selectedModelLabel();
}

function radarOpenProviderPicker() {
  openChoicePicker({
    title: "选择服务商",
    selectedValue: _radar.selectedProvider,
    options: _radar.providers.map(provider => ({
      value: provider.name,
      label: provider.name,
    })),
    onSelect: providerName => {
      if (providerName === _radar.selectedProvider) return;
      _radar.selectedProvider = providerName;
      _radar.selectedModel = _modelsFor(providerName)[0]?.id || "";
      _syncPickerLabels();
    },
  });
}

function radarOpenModelPicker() {
  openChoicePicker({
    title: "选择模型",
    selectedValue: _radar.selectedModel,
    options: _modelsFor(_radar.selectedProvider).map(model => ({
      value: model.id,
      label: model.name || model.id,
      description: model.name && model.name !== model.id ? model.id : "",
    })),
    onSelect: modelId => {
      _radar.selectedModel = modelId;
      _syncPickerLabels();
    },
  });
}

function radarSetPersonaType(value) {
  _radar.personaType = typeof value === "string" ? value.slice(0, 50) : "";
  _radar.personaTypeInitialized = true;
}

function radarOpenPersonaTypePicker() {
  openChoicePicker({
    title: "选择角色类型",
    selectedValue: _radar.personaType,
    options: [
      {
        value: "",
        label: "不限类型",
        description: "自由探索不同类型的角色",
      },
      ...RADAR_PERSONA_TYPES.map(type => ({ value: type, label: type })),
    ],
    onSelect: personaType => {
      radarSetPersonaType(personaType);
      const input = $("radar-persona-type");
      if (input) input.value = personaType;
    },
  });
}

function _renderRecommendations() {
  const target = $("radar-results");
  if (!target) return;
  if (!_radar.recommendations.length) {
    target.innerHTML = `<div class="radar-empty">暂时没有可用灵感，点击“换一批”重新探索</div>`;
    return;
  }
  target.innerHTML = _radar.recommendations.map((item, index) => `
    <article class="radar-card">
      <div class="radar-card-head">
        <div class="radar-card-index">${String(index + 1).padStart(2, "0")}</div>
        <h2>${esc(item.title)}</h2>
      </div>
      <div class="radar-tags">${item.tags.map(tag => `<span>${esc(tag)}</span>`).join("")}</div>
      <p>${esc(item.summary)}</p>
      <button class="radar-use-btn" onclick="PawzoChat.radarUseRecommendation(${index})">用这个灵感生成人设</button>
    </article>
  `).join("");
}

async function radarRefresh() {
  const provider = _radar.selectedProvider;
  const model = _radar.selectedModel;
  const personaType = ($("radar-persona-type")?.value || _radar.personaType).trim();
  radarSetPersonaType(personaType);
  if (!provider || !model) {
    toast("请先选择服务商与模型", "error");
    return;
  }

  localStorage.setItem("pw_last_provider", provider);
  localStorage.setItem("pw_last_model", model);
  const version = ++_radar.requestVersion;
  const previousRecommendations = _radar.recommendations;
  const button = $("radar-refresh-btn");
  const results = $("radar-results");
  if (button) { button.disabled = true; button.textContent = "探索中…"; }
  if (results) results.innerHTML = `<div class="radar-loading"><div class="spinner"></div><span>AI 正在搜索新的角色灵感…</span></div>`;

  try {
    const response = await api.post("/api/persona-writer/recommendations", {
      provider,
      model,
      persona_type: personaType,
    });
    if (version !== _radar.requestVersion) return;
    if (response.status < 200 || response.status >= 300 || !response.data?.ok) {
      _radar.recommendations = previousRecommendations;
      _renderRecommendations();
      toast(response.data?.error || "推荐生成失败", "error");
      return;
    }
    const recommendations = (response.data.recommendations || []).filter(_validRecommendation);
    if (!recommendations.length) {
      _radar.recommendations = previousRecommendations;
      _renderRecommendations();
      toast("模型未返回有效的推荐列表", "error");
      return;
    }
    _radar.recommendations = recommendations;
    _writeRecommendationCache(provider, model, personaType, recommendations);
    _renderRecommendations();
  } catch (error) {
    if (version !== _radar.requestVersion) return;
    _radar.recommendations = previousRecommendations;
    _renderRecommendations();
    toast("推荐生成失败，请检查网络或模型配置", "error");
  } finally {
    if (version === _radar.requestVersion && button) {
      button.disabled = false;
      button.textContent = "换一批";
    }
  }
}

function radarUseRecommendation(index) {
  const recommendation = _radar.recommendations[index];
  if (!recommendation) return;
  pushPage("personaWriter", {
    request: recommendation.request,
    sourceTitle: recommendation.title,
  });
}

async function renderRadar() {
  setTopBar("雷达", true, "");
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;

  try {
    const result = await api.get("/api/providers");
    _radar.providers = (result.providers || []).filter(provider => (provider.models || []).length > 0);
  } catch (error) {
    _radar.providers = [];
  }

  if (!_radar.providers.length) {
    content().innerHTML = `<div class="page"><div class="empty-state">
      <div class="empty-text">尚未配置任何 LLM 服务商</div>
      <div class="form-hint" style="text-align:center">请先到「设置 → 服务商」添加带 API Key 的服务商与模型</div>
    </div></div>`;
    return;
  }

  const cached = _readRecommendationCache();
  if (!_radar.personaTypeInitialized) {
    _radar.personaType = cached?.personaType || "";
    _radar.personaTypeInitialized = true;
  }
  const lastProvider = cached?.provider || localStorage.getItem("pw_last_provider") || "";
  const lastModel = cached?.model || localStorage.getItem("pw_last_model") || "";
  const selectedProvider = _radar.providers.some(provider => provider.name === lastProvider)
    ? lastProvider
    : _radar.providers[0].name;
  const selectedModels = _modelsFor(selectedProvider);
  const selectedModel = selectedModels.some(model => model.id === lastModel)
    ? lastModel
    : selectedModels[0]?.id || "";
  _radar.selectedProvider = selectedProvider;
  _radar.selectedModel = selectedModel;
  _radar.recommendations = cached?.recommendations || [];

  content().innerHTML = `<div class="page radar-page">
    <section class="radar-hero">
      <div class="radar-sweep" aria-hidden="true"><span></span></div>
      <div>
        <h1>角色灵感雷达</h1>
        <p>让 AI 探索不同题材与关系，为你的下一个角色提供起点。</p>
      </div>
    </section>
    <div class="card radar-controls">
      <div class="form-group">
        <button type="button" class="form-row choice-picker-trigger" onclick="PawzoChat.radarOpenProviderPicker()">
          <span class="choice-picker-trigger-label">服务商</span>
          <span id="radar-provider-value" class="choice-picker-trigger-value">${esc(_selectedProviderLabel())}</span>
          <span class="row-arrow" aria-hidden="true">›</span>
        </button>
      </div>
      <div class="form-group">
        <button type="button" class="form-row choice-picker-trigger" onclick="PawzoChat.radarOpenModelPicker()">
          <span class="choice-picker-trigger-label">模型</span>
          <span id="radar-model-value" class="choice-picker-trigger-value">${esc(_selectedModelLabel())}</span>
          <span class="row-arrow" aria-hidden="true">›</span>
        </button>
      </div>
      <div class="form-group radar-type-group">
        <div class="form-row radar-type-row">
          <label for="radar-persona-type">角色类型 <span>可选</span></label>
          <div class="radar-type-control">
            <input id="radar-persona-type" maxlength="50"
              value="${esc(_radar.personaType)}" placeholder="自由输入类型"
              autocomplete="off" spellcheck="false"
              oninput="PawzoChat.radarSetPersonaType(this.value)">
            <button type="button" class="radar-type-preset-btn"
              aria-label="选择预设角色类型"
              onclick="PawzoChat.radarOpenPersonaTypePicker()">
              <span>预设</span><span class="row-arrow" aria-hidden="true">›</span>
            </button>
          </div>
        </div>
        <div class="radar-type-hint">可以自由输入，也可以从统一预设列表中选择；留空则不限制类型</div>
      </div>
    </div>
    <button class="btn-primary" id="radar-refresh-btn" onclick="PawzoChat.radarRefresh()">${cached ? "换一批" : "开始探索"}</button>
    <div class="radar-section-title"><span>本次发现</span><small>选择一个方向继续完善</small></div>
    <div id="radar-results"></div>
  </div>`;

  if (cached) {
    _renderRecommendations();
  } else {
    await radarRefresh();
  }
}

registerPageRenderer("radar", renderRadar);

export {
  radarOpenProviderPicker,
  radarOpenModelPicker,
  radarOpenPersonaTypePicker,
  radarSetPersonaType,
  radarRefresh,
  radarUseRecommendation,
};
