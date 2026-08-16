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
import { esc, escAttr, CAP_ICONS } from "./utils.js";
import { api } from "./api.js";
import { $, content } from "./state.js";
import { toast, showLoading, hideLoading } from "./ui.js";
import { setTopBar, pushPage, registerPageRenderer } from "./navigation.js";

// Persona Writing Assistant: one-line request + model choice → reuses the
// existing AI call pipeline (including MCP tools like web search) to
// generate a persona draft → preview/tweak → one-click create character.
//
// Note the two distinct "system prompts":
//   - The generation-guidance prompt that drives generation is a fixed
//     internal backend constant — invisible to and never sent by the frontend.
//   - The editable "system instructions" on the page belong to the character
//     being created itself — the [系统指令] section, pre-filled with the
//     project defaults.

const _pw = {
  providers: [],          // [{name, models:[{id,name,capabilities}], ...}]
  imageProviders: [],     // configured providers with usable image models
  defaultSysInstr: "",    // DEFAULT_SYSTEM_INSTRUCTIONS (from /api/personas/default-system-instructions)
  images: {
    avatar: null,         // {dataUrl, mimeType}
    background: null,
  },
};

function _providerOptions(selected) {
  return _pw.providers
    .map(pr => `<option value="${esc(pr.name)}" ${pr.name === selected ? "selected" : ""}>${esc(pr.name)}</option>`)
    .join("");
}

// Build <option>s for the model select. Always lands on a valid selection:
// the requested model if present, otherwise the provider's first model.
function _modelOptions(provName, selectedModel) {
  const prov = _pw.providers.find(pr => pr.name === provName);
  const models = prov?.models || [];
  if (!models.length) return `<option value="" disabled selected>该服务商下没有模型</option>`;
  const effective = models.some(m => m.id === selectedModel) ? selectedModel : models[0].id;
  return models.map(m => {
    const caps = (m.capabilities || []).map(c => CAP_ICONS[c] || "").join("");
    const sel = m.id === effective ? "selected" : "";
    return `<option value="${esc(m.id)}" ${sel}>${esc(m.name || m.id)} ${caps}</option>`;
  }).join("");
}

function pwOnProviderChange() {
  const provName = $("pw-provider")?.value || "";
  const modelSel = $("pw-model");
  if (modelSel) modelSel.innerHTML = _modelOptions(provName, "");
}

function _imageProviderOptions(selected) {
  return _pw.imageProviders.map(provider => (
    `<option value="${escAttr(provider.name)}" ${provider.name === selected ? "selected" : ""}>${esc(provider.name)}</option>`
  )).join("");
}

function _imageModelOptions(providerName, selected) {
  const provider = _pw.imageProviders.find(item => item.name === providerName);
  const models = provider?.models || [];
  if (!models.length) return `<option value="" disabled selected>该服务商下没有模型</option>`;
  const effective = models.some(model => model.id === selected) ? selected : models[0].id;
  return models.map(model => (
    `<option value="${escAttr(model.id)}" ${model.id === effective ? "selected" : ""}>${esc(model.name || model.id)}</option>`
  )).join("");
}

function pwOnImageProviderChange() {
  const providerName = $("pw-image-provider")?.value || "";
  const modelSelect = $("pw-image-model");
  if (modelSelect) modelSelect.innerHTML = _imageModelOptions(providerName, "");
}

function _renderGeneratedImage(kind) {
  const target = $(kind === "avatar" ? "pw-avatar-preview" : "pw-background-preview");
  if (!target) return;
  const image = _pw.images[kind];
  if (!image) {
    target.innerHTML = `<div class="form-hint" style="text-align:center">尚未生成</div>`;
    return;
  }
  const fit = kind === "avatar" ? "aspect-ratio:1/1;max-width:256px" : "aspect-ratio:3/2;width:100%";
  target.innerHTML = `<img src="${escAttr(image.dataUrl)}" alt="${kind === "avatar" ? "角色头像预览" : "朋友圈封面预览"}" style="${fit};object-fit:cover;border-radius:12px;display:block;margin:auto">`;
}

async function pwGenerateImage(kind) {
  const isAvatar = kind === "avatar";
  if (!isAvatar && kind !== "background") return;
  const provider = $("pw-image-provider")?.value || "";
  const model = $("pw-image-model")?.value || "";
  const prompt = ($(isAvatar ? "pw-avatar-prompt" : "pw-background-prompt")?.value || "").trim();
  if (!provider || !model) { toast("请先选择生图服务商与模型", "error"); return; }
  if (!prompt) { toast("请先生成或填写图片提示词", "error"); return; }
  localStorage.setItem("pw_last_image_provider", provider);
  localStorage.setItem("pw_last_image_model", model);

  const button = $(isAvatar ? "pw-avatar-generate" : "pw-background-generate");
  const original = button?.textContent || "生成图片";
  if (button) { button.disabled = true; button.textContent = "生成中…"; }
  try {
    const response = await api.post(`/api/image-providers/${encodeURIComponent(provider)}/generate`, {
      model,
      prompt,
      purpose: isAvatar ? "avatar" : "moments_cover",
    });
    if (response.status < 200 || response.status >= 300 || !response.data?.image_b64) {
      toast(response.data?.error || "图片生成失败", "error");
      return;
    }
    const mimeType = response.data.mime_type || "image/png";
    _pw.images[kind] = {
      dataUrl: `data:${mimeType};base64,${response.data.image_b64}`,
      mimeType,
    };
    _renderGeneratedImage(kind);
    toast(`${isAvatar ? "头像" : "朋友圈封面"}生成完成`, "success");
  } catch (error) {
    toast("图片生成失败，请检查生图服务配置", "error");
  } finally {
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

function _clearGeneratedImages() {
  _pw.images.avatar = null;
  _pw.images.background = null;
  _renderGeneratedImage("avatar");
  _renderGeneratedImage("background");
}

async function pwGenerate() {
  const provider = $("pw-provider")?.value || "";
  const model = $("pw-model")?.value || "";
  const reqText = ($("pw-request")?.value || "").trim();
  if (!provider || !model) { toast("请先选择服务商与模型", "error"); return; }
  if (!reqText) { toast("请输入生成需求", "error"); return; }

  localStorage.setItem("pw_last_provider", provider);
  localStorage.setItem("pw_last_model", model);

  const btn = $("pw-generate-btn");
  const orig = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "生成中…"; }
  try {
    const r = await api.post("/api/persona-writer/generate", { provider, model, request: reqText });
    if (r.status === 200 && r.data && r.data.ok) {
      if ($("pw-character")) $("pw-character").value = r.data.character_prompt || "";
      if ($("pw-examples")) $("pw-examples").value = r.data.output_examples || "";
      if ($("pw-signature")) $("pw-signature").value = r.data.signature || "";
      if ($("pw-avatar-prompt")) $("pw-avatar-prompt").value = r.data.avatar_prompt || "";
      if ($("pw-background-prompt")) $("pw-background-prompt").value = r.data.background_prompt || "";
      const nameEl = $("pw-name");
      if (nameEl && r.data.name) nameEl.value = r.data.name;
      _clearGeneratedImages();
      toast("生成完成", "success");
    } else {
      toast((r.data && r.data.error) || "生成失败", "error");
    }
  } catch (e) {
    toast("生成失败，请检查网络或模型配置", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig || "生成"; }
  }
}

function _dataUrlBlob(dataUrl) {
  const [header, payload] = dataUrl.split(",", 2);
  const mimeType = header.match(/^data:([^;]+);base64$/)?.[1] || "image/png";
  const binary = atob(payload || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

async function _uploadGeneratedAsset(personaId, kind, image) {
  if (!image) return;
  const isAvatar = kind === "avatar";
  const form = new FormData();
  const field = isAvatar ? "avatar" : "cover";
  const extension = image.mimeType === "image/jpeg" ? "jpg" : (image.mimeType.split("/")[1] || "png");
  form.append(field, _dataUrlBlob(image.dataUrl), `${kind}.${extension}`);
  const path = isAvatar
    ? `/api/personas/${encodeURIComponent(personaId)}/avatar`
    : `/api/personas/${encodeURIComponent(personaId)}/moments-cover`;
  const response = await fetch(`${window.PAWZOCHAT_BASE || ""}${path}`, { method: "POST", body: form });
  if (!response.ok) {
    let message = "图片保存失败";
    try { message = (await response.json())?.error || message; } catch (error) { /* ignore */ }
    throw new Error(message);
  }
}

async function pwCreatePersona() {
  const name = ($("pw-name")?.value || "").trim();
  const signature = ($("pw-signature")?.value || "").trim();
  const characterPrompt = $("pw-character")?.value || "";
  const outputExamples = $("pw-examples")?.value || "";
  const systemInstructions = $("pw-sysinstr")?.value || "";
  const provider = $("pw-provider")?.value || "";
  const model = $("pw-model")?.value || "";

  if (!name) { toast("请输入角色名称", "error"); return; }
  if (!characterPrompt.trim()) { toast("请先生成或填写人设设定", "error"); return; }

  showLoading("创建中…");
  try {
    const r = await api.post("/api/personas", {
      name,
      signature,
      character_prompt: characterPrompt,
      output_examples: outputExamples,
      system_instructions: systemInstructions,
      llm_provider: provider,
      llm_model: model,
    });
    if ((r.status === 200 || r.status === 201) && r.data && r.data.ok) {
      const uploads = [
        ["avatar", _pw.images.avatar],
        ["background", _pw.images.background],
      ].filter(([, image]) => !!image);
      const results = await Promise.allSettled(
        uploads.map(([kind, image]) => _uploadGeneratedAsset(r.data.id, kind, image)),
      );
      const failedCount = results.filter(result => result.status === "rejected").length;
      api.invalidate("/api/personas");
      toast(
        failedCount ? `角色已创建，但有 ${failedCount} 张图片保存失败` : "角色创建成功",
        failedCount ? "error" : "success",
      );
      pushPage("personaEdit", { personaId: r.data.id });
    } else {
      toast((r.data && r.data.error) || "创建失败", "error");
    }
  } catch (e) {
    toast("创建失败", "error");
  } finally {
    hideLoading();
  }
}

async function renderPersonaWriter(data = {}) {
  setTopBar("人设编写助手", true, "");
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;

  try {
    const [provRes, siRes, imageRes] = await Promise.all([
      api.get("/api/providers"),
      api.get("/api/personas/default-system-instructions"),
      api.get("/api/image-providers"),
    ]);
    _pw.providers = provRes.providers || [];
    _pw.imageProviders = (imageRes.providers || []).filter(provider => (
      provider.api_key_set && (provider.models || []).length > 0
    ));
    _pw.defaultSysInstr = siRes.text || "";
  } catch (e) {
    _pw.providers = [];
    _pw.imageProviders = [];
    _pw.defaultSysInstr = "";
  }

  const lastProvider = localStorage.getItem("pw_last_provider") || "";
  const lastModel = localStorage.getItem("pw_last_model") || "";
  const selProvider = _pw.providers.some(p => p.name === lastProvider)
    ? lastProvider
    : (_pw.providers[0]?.name || "");
  const lastImageProvider = localStorage.getItem("pw_last_image_provider") || "";
  const lastImageModel = localStorage.getItem("pw_last_image_model") || "";
  const selectedImageProvider = _pw.imageProviders.some(p => p.name === lastImageProvider)
    ? lastImageProvider
    : (_pw.imageProviders[0]?.name || "");
  _pw.images.avatar = null;
  _pw.images.background = null;

  if (!_pw.providers.length) {
    content().innerHTML = `<div class="page"><div class="empty-state">
      <div class="empty-text">尚未配置任何 LLM 服务商</div>
      <div class="form-hint" style="text-align:center">请先到「设置 → 服务商」添加带 API Key 的服务商与模型</div>
    </div></div>`;
    return;
  }

  content().innerHTML = `<div class="page">
    <div class="card">
      <div class="card-header">生成模型</div>
      <div class="form-group"><div class="form-row"><label>服务商</label>
        <select id="pw-provider" onchange="PawzoChat.pwOnProviderChange()">${_providerOptions(selProvider)}</select>
      </div></div>
      <div class="form-group"><div class="form-row"><label>模型</label>
        <select id="pw-model">${_modelOptions(selProvider, lastModel)}</select>
      </div></div>
      <div class="form-hint">🔧 表示该模型支持工具调用（如果您配置了联网搜索mcp则可进行联网搜索）</div>
    </div>

    <div class="card">
      <div class="card-header">生成需求${data.sourceTitle ? ` · 来自雷达：${esc(data.sourceTitle)}` : ""}</div>
      <textarea class="form-textarea" id="pw-request" style="min-height:84px" placeholder="为我生成xxx游戏的xxx角色的人设">${esc(data.request || "")}</textarea>
    </div>
    <div style="margin-bottom:12px">
      <button class="btn-primary" id="pw-generate-btn" onclick="PawzoChat.pwGenerate()">生成</button>
    </div>

    <div class="card">
      <div class="card-header">角色资料</div>
      <div class="form-group"><div class="form-row"><label>角色名称</label>
        <input id="pw-name" placeholder="点击「生成」后自动填充，可手动编辑">
      </div></div>
      <div class="form-group"><div class="form-row"><label>个性签名</label>
        <input id="pw-signature" maxlength="100" placeholder="符合角色口吻的签名">
      </div></div>
    </div>

    <div class="card">
      <div class="card-header">人设设定</div>
      <textarea class="form-textarea prompt-part" id="pw-character" placeholder="点击「生成」后自动填充，可手动编辑"></textarea>
    </div>
    <div class="card">
      <div class="card-header">输出示例</div>
      <textarea class="form-textarea prompt-part" id="pw-examples" placeholder="点击「生成」后自动填充，可手动编辑"></textarea>
      <div class="form-hint">用反斜线 \\ 分隔短句，例如：你已觉悟\\无需多言</div>
    </div>
    <div class="card">
      <div class="card-header">系统指令</div>
      <textarea class="form-textarea prompt-part" id="pw-sysinstr">${esc(_pw.defaultSysInstr)}</textarea>
      <div class="form-hint">角色的 [系统指令] 段，已预填默认值，可修改</div>
    </div>

    <div class="card">
      <div class="card-header">角色图片</div>
      ${_pw.imageProviders.length ? `
        <div class="form-group"><div class="form-row"><label>生图服务商</label>
          <select id="pw-image-provider" onchange="PawzoChat.pwOnImageProviderChange()">${_imageProviderOptions(selectedImageProvider)}</select>
        </div></div>
        <div class="form-group"><div class="form-row"><label>生图模型</label>
          <select id="pw-image-model">${_imageModelOptions(selectedImageProvider, lastImageModel)}</select>
        </div></div>
      ` : `<div class="form-hint" style="padding:0 16px 14px">尚未配置可用的生图服务商。提示词仍会生成，配置服务商后可返回此页生成图片。</div>`}
    </div>

    <div class="card">
      <div class="card-header">角色头像</div>
      <textarea class="form-textarea" id="pw-avatar-prompt" style="min-height:110px" placeholder="点击上方「生成」获取头像提示词，可手动编辑"></textarea>
      <div id="pw-avatar-preview" style="padding:12px 16px"><div class="form-hint" style="text-align:center">尚未生成</div></div>
      <div style="padding:0 16px 16px">
        <button class="btn-primary" id="pw-avatar-generate" ${_pw.imageProviders.length ? "" : "disabled"} onclick="PawzoChat.pwGenerateImage('avatar')">生成头像</button>
      </div>
    </div>

    <div class="card">
      <div class="card-header">专属朋友圈封面</div>
      <textarea class="form-textarea" id="pw-background-prompt" style="min-height:110px" placeholder="点击上方「生成」获取封面提示词，可手动编辑"></textarea>
      <div class="form-hint">封面属于当前角色，不会覆盖其他角色或全局封面</div>
      <div id="pw-background-preview" style="padding:12px 16px"><div class="form-hint" style="text-align:center">尚未生成</div></div>
      <div style="padding:0 16px 16px">
        <button class="btn-primary" id="pw-background-generate" ${_pw.imageProviders.length ? "" : "disabled"} onclick="PawzoChat.pwGenerateImage('background')">生成朋友圈封面</button>
      </div>
    </div>

    <div>
      <button class="btn-primary" id="pw-create-btn" onclick="PawzoChat.pwCreatePersona()">通过该人设创建角色</button>
    </div>
  </div>`;
}

registerPageRenderer("personaWriter", renderPersonaWriter);

export {
  pwOnProviderChange,
  pwOnImageProviderChange,
  pwGenerate,
  pwGenerateImage,
  pwCreatePersona,
};
