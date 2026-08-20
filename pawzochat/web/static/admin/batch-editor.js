export const BATCH_FIELDS = [
  { value: "enabled", label: "启用状态", type: "boolean" },
  { value: "name_affix", label: "名称前缀/后缀", type: "affix" },
  { value: "signature", label: "人物签名", type: "text" },
  { value: "llm_provider", label: "LLM 服务商", type: "llm-provider" },
  { value: "llm_model", label: "LLM 模型", type: "text" },
  { value: "temperature", label: "温度", type: "number", min: 0, max: 2, step: 0.1 },
  { value: "max_tokens", label: "最大令牌", type: "number", min: 1, step: 1 },
  { value: "tool_policy.mode", label: "工具策略", type: "choice", options: [["all", "全部工具"], ["none", "禁用工具"], ["whitelist", "仅白名单"], ["blacklist", "排除黑名单"]] },
  { value: "tool_policy.list", label: "工具名单", type: "list" },
  { value: "tool_policy.max_iterations", label: "工具最大迭代", type: "number", min: 1, step: 1 },
  { value: "tool_policy.timeout_seconds", label: "工具超时秒数", type: "number", min: 1, step: 1 },
  { value: "memory.enabled", label: "记忆", type: "boolean" },
  { value: "memory.include_in_prompt", label: "记忆注入提示词", type: "boolean" },
  { value: "memory.max_memories", label: "最大记忆数", type: "number", min: 1, step: 1 },
  { value: "memory.trigger_rounds", label: "记忆触发轮数", type: "number", min: 0, step: 1 },
  { value: "memory.trigger_mode", label: "记忆触发模式", type: "choice", options: [["remind", "提醒模型"], ["summarize", "自动总结"]] },
  { value: "emoji_enabled", label: "表情", type: "boolean" },
  { value: "emoji_send_probability", label: "表情发送概率", type: "number", min: 0, max: 100, step: 1 },
  { value: "emoji_group", label: "表情分组", type: "text" },
  { value: "image_generation.enabled", label: "生图", type: "boolean" },
  { value: "image_generation.provider", label: "生图服务商", type: "image-provider" },
  { value: "image_generation.model", label: "生图模型", type: "text" },
  { value: "image_generation.style_prefix", label: "生图外貌提示词", type: "textarea" },
  { value: "image_generation.art_style", label: "生图画风", type: "textarea" },
  { value: "image_generation.negative_prompt", label: "生图负面提示词", type: "textarea" },
  { value: "image_generation.negative_enabled", label: "启用生图负面提示词", type: "boolean" },
  { value: "image_generation.ref_mode", label: "生图参考图模式", type: "choice", options: [["avatar", "人物头像"], ["custom", "自定义参考图"], ["none", "不使用参考图"]] },
  { value: "voice_generation.enabled", label: "语音", type: "boolean" },
  { value: "voice_generation.provider", label: "语音服务商", type: "voice-provider" },
  { value: "voice_generation.model", label: "语音模型", type: "text" },
  { value: "voice_generation.voice", label: "音色 ID", type: "text" },
  { value: "voice_generation.speed", label: "语速", type: "number", min: 0.25, max: 4, step: 0.05 },
  { value: "proactive.enabled", label: "主动消息", type: "boolean" },
  { value: "proactive.min_idle_hours", label: "最短空闲小时", type: "number", min: 0, step: 0.1 },
  { value: "proactive.max_idle_hours", label: "最长空闲小时", type: "number", min: 0, step: 0.1 },
  { value: "proactive.max_consecutive", label: "最大连续主动消息", type: "number", min: 1, step: 1 },
  { value: "proactive.prompt", label: "主动消息提示词", type: "textarea" },
  { value: "proactive.quiet_hours.enabled", label: "主动消息免打扰", type: "boolean" },
  { value: "proactive.quiet_hours.start", label: "免打扰开始时间", type: "text" },
  { value: "proactive.quiet_hours.end", label: "免打扰结束时间", type: "text" },
  { value: "worldbooks", label: "世界书绑定", type: "worldbooks" },
  { value: "moments.publisher", label: "参与朋友圈发布", type: "boolean" },
  { value: "moments.replier", label: "参与朋友圈回复", type: "boolean" },
  { value: "moments.reply_probability", label: "朋友圈回复概率", type: "number", min: 0, max: 100, step: 1 },
  { value: "moments.memory_enabled", label: "朋友圈写入记忆", type: "boolean" },
  { value: "character_prompt", label: "人设设定", type: "prompt" },
  { value: "output_examples", label: "输出示例", type: "prompt" },
  { value: "system_instructions", label: "系统指令", type: "prompt" },
];

export const fieldDefinition = value => BATCH_FIELDS.find(field => field.value === value);

export function buildOperation(field, input) {
  const definition = fieldDefinition(field);
  if (!definition) throw new Error("请选择要修改的字段");
  if (definition.type === "prompt") {
    return {
      kind: "prompt",
      field,
      mode: input.mode || "overwrite",
      value: input.value || "",
      find: input.find || "",
      separator: "\n",
    };
  }
  if (definition.type === "worldbooks") {
    return { kind: "worldbooks", mode: input.mode || "replace", values: input.values || [] };
  }
  if (definition.type === "affix") {
    if (!input.prefix && !input.suffix) throw new Error("请填写名称前缀或后缀");
    return { kind: "name_affix", prefix: input.prefix || "", suffix: input.suffix || "" };
  }
  let value = input.value;
  if (definition.type === "boolean") value = value === true || value === "true";
  if (definition.type === "number") {
    value = Number(value);
    if (!Number.isFinite(value)) throw new Error("请输入有效数值");
  }
  if (definition.type === "list") {
    value = String(value || "").split(",").map(item => item.trim()).filter(Boolean);
  }
  return { kind: "set", path: field, value };
}

export function describeOperation(operation, fieldLabel) {
  if (operation.kind === "prompt") {
    const modes = { overwrite: "覆盖", prepend: "前置", append: "追加", replace: "查找替换", template: "套用模板" };
    return `${fieldLabel(operation.field)}：${modes[operation.mode] || operation.mode}`;
  }
  if (operation.kind === "worldbooks") {
    const modes = { replace: "替换", append: "追加", remove: "移除" };
    return `世界书：${modes[operation.mode]} ${operation.values.join("、") || "空列表"}`;
  }
  if (operation.kind === "name_affix") return `名称：前缀「${operation.prefix}」 后缀「${operation.suffix}」`;
  return `${fieldLabel(operation.path)}：${typeof operation.value === "boolean" ? (operation.value ? "开启" : "关闭") : operation.value}`;
}