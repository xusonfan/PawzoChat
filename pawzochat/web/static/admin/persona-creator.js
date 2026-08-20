import { api } from "./api.js";
import { state, esc } from "./state.js";

const creationImages = { avatar: null, momentsCover: null };

function providerOptions(kind, selected = "") {
  const providers = state.catalogs[kind] || [];
  if (!providers.length) return `<option value="">尚未配置服务商</option>`;
  return providers.map(provider => `
    <option value="${esc(provider.name)}" ${provider.name === selected ? "selected" : ""}>${esc(provider.name)}</option>
  `).join("");
}

function modelOptions(kind, providerName, selected = "") {
  const provider = (state.catalogs[kind] || []).find(item => item.name === providerName);
  const models = provider?.models || [];
  if (!models.length) return `<option value="">该服务商暂无模型</option>`;
  const effective = models.some(model => model.id === selected) ? selected : models[0].id;
  return models.map(model => `
    <option value="${esc(model.id)}" ${model.id === effective ? "selected" : ""}>${esc(model.name || model.id)}</option>
  `).join("");
}

export function buildCreationPayload(values) {
  return {
    enabled: Boolean(values.enabled),
    name: String(values.name || "").trim(),
    signature: String(values.signature || "").trim(),
    llm_provider: String(values.llm_provider || ""),
    llm_model: String(values.llm_model || ""),
    character_prompt: String(values.character_prompt || ""),
    output_examples: String(values.output_examples || ""),
    system_instructions: String(values.system_instructions || ""),
    image_generation: {
      style_prefix: String(values.avatar_prompt || ""),
    },
    avatar_image: values.avatar_image || null,
    moments_cover_image: values.moments_cover_image || null,
  };
}

function renderCreator(showModal) {
  const providers = state.catalogs.llm_providers || [];
  const imageProviders = state.catalogs.image_providers || [];
  const selectedProvider = providers[0]?.name || "";
  const selectedImageProvider = imageProviders[0]?.name || "";
  const canGenerate = Boolean(selectedProvider && providers[0]?.models?.length);
  const canGenerateImages = Boolean(selectedImageProvider && imageProviders[0]?.models?.length);
  creationImages.avatar = null;
  creationImages.momentsCover = null;
  showModal(`<header class="modal-header">
    <div>
      <h2>创作全新人物</h2>
      <div class="muted" style="margin-top:2px">利用大模型自动构思人设草稿，确认前可完整编辑调整</div>
    </div>
    <button class="icon-btn" data-action="close-modal">×</button>
  </header>
  <form id="persona-creator-form">
    <section class="creator-generator">
      <div class="form-grid">
        <label class="form-field">
          <span>生成服务商</span>
          <select id="creator-provider">${providerOptions("llm_providers", selectedProvider)}</select>
        </label>
        <label class="form-field">
          <span>生成模型</span>
          <select id="creator-model">${modelOptions("llm_providers", selectedProvider)}</select>
        </label>
        <label class="form-field wide">
          <span>创作灵感与需求</span>
          <textarea id="creator-request" maxlength="2000" placeholder="例如：创作一位生活在蒸汽都市、嘴硬心软的机械师少女，她与用户是共同经营修理铺的搭档，性格傲娇但关心人…"></textarea>
        </label>
      </div>
      <div class="creator-generate-row">
        <span class="muted" style="font-size:12px">支持已配置的工具与搜索能力，生成结果仅为草稿，不会直接写入</span>
        <button class="btn secondary btn-sparkles" id="creator-generate" type="button" ${canGenerate ? "" : "disabled"}>
          <svg class="btn-svg sparkle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
          <span>AI 生成草稿</span>
        </button>
      </div>
    </section>
    <section class="form-section">
      <div class="form-section-title">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <span>人物草稿详情</span>
      </div>
      <div class="form-grid">
        <label class="checkbox-field"><input name="enabled" type="checkbox" checked>创建后立即启用</label>
        <span></span>
        <label class="form-field"><span>名称</span><input name="name" maxlength="100" placeholder="人物名称" required></label>
        <label class="form-field"><span>个性签名</span><input name="signature" maxlength="100" placeholder="一句话简介"></label>
        <label class="form-field wide"><span>人设设定 (Character Prompt)</span><textarea name="character_prompt" class="creator-prompt" placeholder="角色背景、性格特征、说话口吻…" required></textarea></label>
        <label class="form-field wide"><span>输出示例 (Output Examples)</span><textarea name="output_examples" class="creator-prompt" placeholder="经典对话示范…"></textarea></label>
        <label class="form-field wide"><span>系统指令 (System Instructions)</span><textarea name="system_instructions" class="creator-prompt">${esc(state.catalogs.default_system_instructions || "")}</textarea></label>
        <label class="form-field wide"><span>外貌描述（用于头像生图）</span><textarea name="avatar_prompt" placeholder="AI 生成后会写入生图外貌提示词，如：银发蓝瞳、戴护目镜的少女机械师…"></textarea></label>
        <label class="form-field wide"><span>朋友圈封面提示词</span><textarea name="background_prompt" placeholder="用于生成该人物专属朋友圈封面的画面描述…"></textarea></label>
      </div>
    </section>
    <section class="form-section">
      <div class="form-section-title">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        <span>形象创作（可选生成）</span>
      </div>
      ${canGenerateImages ? `
        <div class="form-grid">
          <label class="form-field"><span>生图服务商</span><select id="creator-image-provider">${providerOptions("image_providers", selectedImageProvider)}</select></label>
          <label class="form-field"><span>生图模型</span><select id="creator-image-model">${modelOptions("image_providers", selectedImageProvider)}</select></label>
          <div class="creator-image-card">
            <strong>人物头像 (1:1)</strong>
            <div id="creator-avatar-preview" class="creator-image-preview square"><span class="muted">尚未生成</span></div>
            <button class="btn secondary btn-iconed" type="button" data-creator-image="avatar">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
              <span>生成头像</span>
            </button>
          </div>
          <div class="creator-image-card">
            <strong>朋友圈封面 (16:9)</strong>
            <div id="creator-cover-preview" class="creator-image-preview cover"><span class="muted">尚未生成</span></div>
            <button class="btn secondary btn-iconed" type="button" data-creator-image="moments_cover">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
              <span>生成封面</span>
            </button>
          </div>
        </div>` : `<div class="muted" style="padding:10px 0">尚未配置可用的生图服务商；仍可直接创建人物，稍后可在后台补充图片。</div>`}
    </section>
    <div class="modal-actions creator-actions" style="margin-top:20px;justify-content:flex-end">
      <button class="btn ghost" type="button" data-action="close-modal">取消</button>
      <button class="btn primary" id="creator-save" type="submit">确认创建人物</button>
    </div>
  </form>`);
}

function formValues(form) {
  const value = name => form.elements[name]?.value ?? "";
  return {
    enabled: form.elements.enabled.checked,
    name: value("name"),
    signature: value("signature"),
    llm_provider: document.getElementById("creator-provider")?.value || "",
    llm_model: document.getElementById("creator-model")?.value || "",
    character_prompt: value("character_prompt"),
    output_examples: value("output_examples"),
    system_instructions: value("system_instructions"),
    avatar_prompt: value("avatar_prompt"),
    avatar_image: creationImages.avatar?.data || null,
    moments_cover_image: creationImages.momentsCover?.data || null,
  };
}

function applyDraft(form, draft) {
  for (const field of ["name", "signature", "character_prompt", "output_examples", "avatar_prompt", "background_prompt"]) {
    if (form.elements[field]) form.elements[field].value = draft[field] || "";
  }
  creationImages.avatar = null;
  creationImages.momentsCover = null;
  renderCreationImage("avatar");
  renderCreationImage("moments_cover");
}

function renderCreationImage(kind) {
  const isAvatar = kind === "avatar";
  const preview = document.getElementById(isAvatar ? "creator-avatar-preview" : "creator-cover-preview");
  if (!preview) return;
  const image = isAvatar ? creationImages.avatar : creationImages.momentsCover;
  preview.innerHTML = image
    ? `<img src="data:${esc(image.mimeType)};base64,${image.data}" alt="${isAvatar ? "人物头像" : "朋友圈封面"}">`
    : `<span class="muted">尚未生成</span>`;
}

async function generateCreationImage(kind, form, toast) {
  const isAvatar = kind === "avatar";
  const provider = document.getElementById("creator-image-provider")?.value || "";
  const model = document.getElementById("creator-image-model")?.value || "";
  const prompt = form.elements[isAvatar ? "avatar_prompt" : "background_prompt"]?.value.trim() || "";
  if (!provider || !model) {
    toast("请先选择生图服务商和模型", "error");
    return;
  }
  if (!prompt) {
    toast(`请先填写${isAvatar ? "外貌" : "封面"}描述提示词`, "error");
    return;
  }

  const button = form.querySelector(`[data-creator-image="${kind}"]`);
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span>生成中…</span>`;
  try {
    const result = await api.post("/api/admin/creation/image", {
      provider,
      model,
      prompt,
      purpose: kind,
    });
    const image = { data: result.image_b64, mimeType: result.mime_type || "image/png" };
    if (isAvatar) creationImages.avatar = image;
    else creationImages.momentsCover = image;
    renderCreationImage(kind);
    toast(`${isAvatar ? "人物头像" : "朋友圈封面"}已生成`, "success");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

function setBusy(form, busy, message = "") {
  const generate = form.querySelector("#creator-generate");
  const save = form.querySelector("#creator-save");
  if (generate) {
    generate.disabled = busy || !(document.getElementById("creator-model")?.value);
    generate.innerHTML = busy && message ? `<span>${message}</span>` : `<svg class="btn-svg sparkle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg><span>AI 生成草稿</span>`;
  }
  if (save) save.disabled = busy;
  for (const button of form.querySelectorAll("[data-creator-image]")) button.disabled = busy;
}

export function openPersonaCreator({ showModal, closeModal, toast, onCreated }) {
  renderCreator(showModal);
  const form = document.getElementById("persona-creator-form");
  const provider = document.getElementById("creator-provider");
  const model = document.getElementById("creator-model");
  const generate = document.getElementById("creator-generate");
  const imageProvider = document.getElementById("creator-image-provider");
  const imageModel = document.getElementById("creator-image-model");

  provider?.addEventListener("change", () => {
    model.innerHTML = modelOptions("llm_providers", provider.value);
    generate.disabled = !model.value;
  });
  imageProvider?.addEventListener("change", () => {
    imageModel.innerHTML = modelOptions("image_providers", imageProvider.value);
  });
  for (const button of form.querySelectorAll("[data-creator-image]")) {
    button.addEventListener("click", () => void generateCreationImage(button.dataset.creatorImage, form, toast));
  }

  generate?.addEventListener("click", async () => {
    const request = document.getElementById("creator-request")?.value.trim() || "";
    if (!provider.value || !model.value) {
      toast("请先选择生成服务商和模型", "error");
      return;
    }
    if (!request) {
      toast("请输入创作需求", "error");
      return;
    }
    setBusy(form, true, "正在构思人设…");
    try {
      const draft = await api.post("/api/admin/creation/generate", {
        provider: provider.value,
        model: model.value,
        request,
      });
      applyDraft(form, draft);
      toast("草稿已成功生成，请审阅修改", "success");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(form, false);
    }
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const payload = buildCreationPayload(formValues(form));
    if (!payload.name) {
      toast("人物名称不能为空", "error");
      return;
    }
    if (!payload.character_prompt.trim()) {
      toast("人设设定不能为空", "error");
      return;
    }
    setBusy(form, true);
    try {
      const result = await api.post("/api/admin/personas", payload);
      closeModal();
      toast(`人物「${result.name}」创建成功`, "success");
      await onCreated();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(form, false);
    }
  });
}