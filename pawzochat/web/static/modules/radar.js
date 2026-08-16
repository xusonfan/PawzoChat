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
import { esc, escAttr } from "./utils.js";
import { setTopBar, pushPage, registerPageRenderer } from "./navigation.js";
import { toast } from "./ui.js";

const RADAR_CACHE_KEY = "pawzo_radar_recommendations_v1";

const _radar = {
  providers: [],
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
      recommendations,
    };
  } catch (error) {
    return null;
  }
}

function _writeRecommendationCache(provider, model, recommendations) {
  try {
    localStorage.setItem(RADAR_CACHE_KEY, JSON.stringify({
      provider,
      model,
      recommendations,
    }));
  } catch (error) {
    // Storage may be disabled or full; the current in-memory result still works.
  }
}

function _providerOptions(selected) {
  return _radar.providers.map(provider => (
    `<option value="${escAttr(provider.name)}" ${provider.name === selected ? "selected" : ""}>${esc(provider.name)}</option>`
  )).join("");
}

function _modelOptions(providerName, selected) {
  const provider = _radar.providers.find(item => item.name === providerName);
  const models = provider?.models || [];
  if (!models.length) return `<option value="" disabled selected>该服务商下没有模型</option>`;
  const effective = models.some(model => model.id === selected) ? selected : models[0].id;
  return models.map(model => (
    `<option value="${escAttr(model.id)}" ${model.id === effective ? "selected" : ""}>${esc(model.name || model.id)}</option>`
  )).join("");
}

function radarOnProviderChange() {
  const provider = $("radar-provider")?.value || "";
  const modelSelect = $("radar-model");
  if (modelSelect) modelSelect.innerHTML = _modelOptions(provider, "");
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
  const provider = $("radar-provider")?.value || "";
  const model = $("radar-model")?.value || "";
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
    const response = await api.post("/api/persona-writer/recommendations", { provider, model });
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
    _writeRecommendationCache(provider, model, recommendations);
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
  const lastProvider = cached?.provider || localStorage.getItem("pw_last_provider") || "";
  const lastModel = cached?.model || localStorage.getItem("pw_last_model") || "";
  const selectedProvider = _radar.providers.some(provider => provider.name === lastProvider)
    ? lastProvider
    : _radar.providers[0].name;
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
      <div class="form-group"><div class="form-row"><label>服务商</label>
        <select id="radar-provider" onchange="PawzoChat.radarOnProviderChange()">${_providerOptions(selectedProvider)}</select>
      </div></div>
      <div class="form-group"><div class="form-row"><label>模型</label>
        <select id="radar-model">${_modelOptions(selectedProvider, lastModel)}</select>
      </div></div>
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
  radarOnProviderChange,
  radarRefresh,
  radarUseRecommendation,
};