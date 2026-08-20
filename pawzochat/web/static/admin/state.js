export const initialState = () => ({
  dashboard: {},
  catalogs: { llm_providers: [], image_providers: [], voice_providers: [], worldbooks: [] },
  personas: [],
  total: 0,
  page: 1,
  pageSize: 30,
  version: "",
  selected: new Set(),
  filters: { q: "", status: "all", provider: "", capability: "", worldbook: "" },
  operations: [],
  templates: [],
});

export const state = initialState();

export const updateState = patch => Object.assign(state, patch);

export function setSelection(id, selected) {
  const next = new Set(state.selected);
  if (selected) next.add(id);
  else next.delete(id);
  state.selected = next;
  return next;
}

export function selectVisible(selected) {
  const next = new Set(state.selected);
  for (const persona of state.personas) {
    if (selected) next.add(persona.id);
    else next.delete(persona.id);
  }
  state.selected = next;
  return next;
}

export function clearSelection() {
  state.selected = new Set();
}

export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function fieldLabel(path) {
  const labels = {
    enabled: "启用状态",
    name: "名称",
    signature: "签名",
    llm_provider: "LLM 服务商",
    llm_model: "LLM 模型",
    temperature: "温度",
    max_tokens: "最大令牌",
    emoji_enabled: "表情开关",
    emoji_send_probability: "表情概率",
    emoji_group: "表情分组",
    character_prompt: "人设设定",
    output_examples: "输出示例",
    system_instructions: "系统指令",
    memory: "记忆配置",
    proactive: "主动消息",
    image_generation: "生图配置",
    voice_generation: "语音配置",
    tool_policy: "工具策略",
    bound_worldbooks: "世界书",
    "moments.publishers": "朋友圈发布者",
    "moments.repliers": "朋友圈回复者",
    "moments.reply_probabilities": "朋友圈回复概率",
    "moments.memory_enabled": "朋友圈记忆",
  };
  return labels[path] || path;
}