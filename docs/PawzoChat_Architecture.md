# PawzoChat 架构文档

## 1. 项目目标与边界

PawzoChat 是一个多通道、多人设的 LLM 对话系统。当前内建微信 iLink、QQ 开放平台和 Web 预览通道，并允许运行时插件注册新通道。主要能力包括：

- 多账号、通道与 Persona（角色）绑定
- 多轮上下文、世界书、工具调用、记忆和表情增强
- LLM、生图与 TTS 服务商管理
- 朋友圈动态、评论、配图与记忆联动
- MCP 工具、能力适配器和运行时插件
- 本地 Web 面板，以及可选的 HTTPS 公网面板

本文描述模块边界和主链路。网络防护与插件协议分别见 [network-security.md](network-security.md) 和 [plugin-development-guide.md](plugin-development-guide.md)。

## 2. 分层与启动编排

系统采用“核心服务 + 通道适配 + 能力扩展”的结构，入口为 `main.py`，主编排对象为 `pawzochat/app.py:App`。

启动顺序的关键点如下：

1. `ConfigManager` 加载 `data/config/config.yaml`，合并默认值并处理损坏配置恢复。
2. 初始化 LLM、生图和语音 Provider；迁移旧绑定与明文面板密码。
3. 启动 MCP Server，建立 `CapabilityAdapterRegistry`，注册生图、参考图查看、记忆记录/更新等内置工具。
4. 创建记忆、世界书、聊天、朋友圈、回复分发、消息队列和主动消息服务。
5. 向 `ChannelRegistry` 注册 `web`、`wechat` 和 `qq` 三个内建通道。
6. 加载运行时插件。插件可在此时注册 hook、LLM 工具或 `plugin:<id>` 通道。
7. 启动消息队列、主动消息与朋友圈 worker，再恢复 `data/auth/accounts.json` 中的通道账号。
8. 启动遥测服务（默认关闭）、本地/公网 Web Server 和打包版更新检查。

关闭时会先通知通道离线，再停止 Web Server、各通道、后台服务、插件和 MCP；5 秒看门狗用于避免关机永久阻塞。

## 3. 对话主链路

### 3.1 入站

- 微信：`WeChatChannel` 持有每个账号的 iLink 客户端、发送器和长轮询器，解析文本、图片、文件、语音及引用消息；带转写的入站语音从 CDN 下载，SILK 解码为 WAV 后以结构化 `voice` 块入队。
- QQ：`QQChannel` 通过 WebSocket 网关接收 C2C 私聊，下载图片、视频和文件；兼容 `content_type: "voice"` 等原生语音附件形态，优先下载 `voice_wav_url`，否则解码 SILK，并使用 `asr_refer_text` 作为转写。
- Web：`api_conversations.py` 把面板发送的消息直接交给统一队列。
- 插件通道：插件通过 `ctx.channels.submit_inbound(...)` 提交文本、图片和文件。

外部通道先按账号绑定找到 Persona，然后调用 `MessageQueue.accept_message(...)`。`message.received` hook 在入队前执行，可改写或取消消息。

### 3.2 聚合、持久化与推理

`MessageQueue` 按 Persona 隔离队列，并使用 `chat.queue_wait_seconds` 聚合短时间内连续到达的消息。处理时依次：

1. 把用户消息写入 `ConversationStore`，逐条触发 `message.stored`。
2. `ChatService.process_round(...)` 读取最近若干轮历史并构建上下文。
3. 注入角色 Prompt、记忆、世界书、文件/图片提示以及可选主动消息提示；用户和 AI 的语音历史统一表示为 `[语音] 转写内容`。
4. 触发 `context.build`，然后调用角色绑定的 LLM。
5. 按角色工具策略执行内置能力、插件工具和 MCP 工具的循环。
6. 解析文本与 `[语音]`/`[voice]` 段；可用时合成 TTS，否则降级为文本；同时收集工具生成的图片。
7. 可选由 `EmojiService` 追加表情，再触发 `reply.compose`。

对话记忆按角色的 `memory.trigger_mode` 配置：

| 模式 | AI 新增／更新 | 达到 N 轮时 |
| --- | --- | --- |
| `remind`（默认） | 允许 | 提醒 AI，由 AI 决定是否记录 |
| `summarize` | 允许 | 后台总结未处理对话为一条第一人称记忆 |
| `summarize_only` | 禁止 | 同上，不暴露记忆工具或注入工具指引 |

`trigger_rounds = 0` 关闭定期触发；按轮数总结无需模型支持工具调用。计轮沿用用户发言后收到 AI 回复的规则。总结进度保存在 `memory.json` 的 `last_summarized_timestamp`：两种有效总结模式互切保留进度；从提醒模式开启、重新启用记忆或轮数从 0 改为正数时，从当前会话末尾重新计数。朋友圈仍由独立记忆开关控制，手动管理及超限合并不随触发模式改变。

记忆服务的写入约束：

- **防止错位更新**：提示词和“编号 → 内容指纹”从同一快照生成，工具在角色锁内校验后写入。过期／不可见目标或更新撞上其他条目时，停止本轮记忆写入；正常聊天继续，下轮重新读取，不转为新增。同轮成功写入会更新快照。后台合并可以跨轮完成，不能只依赖数组位置。
- **原子保存**：混合模式下，AI 写入和总结游标一次保存，覆盖范围限于本轮输入末尾且不回退。提醒计数仅在实际保存成功后确认；无变化、重复或失败不推进。模型请求期间不持有角色锁。总结／合并写回前重新检查设置，丢弃因关闭功能或调整阈值而失效的结果。
- **精确去重**：各入口只比较 `summary.strip()`，不做近似匹配、不批量清理历史。重复新增保留原条目；更新与其他条目重复则拒绝；自身内容未变仍可修改元数据。重复自动总结仍保存进度；合并结果若已有相同的保留条目，则不再追加副本。
- **结构兼容**：指纹由内容、重要度、创建时间计算，只用于请求／本轮上下文，不存储新 ID 或版本，不迁移文件。保留未知旧字段。日志只记录操作结果及原因，不输出记忆正文。

网页记忆接口保留 `/api/personas/<id>/memories` 路径：

| 请求 | 校验值 | 结果 |
| --- | --- | --- |
| GET 列表 | 无 | 每条返回临时 `fingerprint`，64 位小写十六进制 |
| POST 新增 | 无 | 重复内容返回 409 |
| PUT `/<index>` | JSON 中必填 `fingerprint` | 缺失／格式错误 400；过期、目标消失或内容重复 409；无变化仍返回 200 |
| DELETE `/<index>` | 查询参数中必填 `fingerprint` | 缺失／格式错误 400；过期或目标消失 409 |

网页打开条目、保存和删除使用所看到版本的校验值，重新读取绕过缓存；编辑冲突保留草稿并提示重新打开，不自动重试。旧页面需刷新，外部调用需先读取列表获取指纹。

### 3.3 出站

`ReplyDispatcher` 对每条草稿执行：

1. 触发 `reply.pre_send`，允许改写或取消。
2. 将未取消的 assistant 消息写入会话文件。
3. 按 `reply_ctx.channel` 从 `ChannelRegistry` 查找通道并投递。
4. 通过 SSE 广播给 Web 面板。
5. 触发带 `delivered` 状态的 `reply.sent`。

通道差异由通道实现负责：

- `web`：只做本地预览节奏控制，实际显示依赖 SSE。
- `wechat`：发送文本、图片、文件；TTS 以音频文件卡片投递。
- `qq`：被动回复及主动发送文本/富媒体，TTS 优先转为 SILK 语音气泡。
- `plugin:<id>`：调用插件注册的 `on_outbound`。

主动消息和插件主动发送复用同一 Persona 互斥锁，并由 `Channel.can_push_now(...)` 判断通道是否允许推送。微信使用 23 小时安全窗口和每条用户消息 10 条回复的配额（发送前本地预判，配额用尽则跳过），QQ 单聊主动发送自动限流，离线、冷却或拒收时跳过生成，Web 和插件通道默认允许。QQ 的平台限流及临时网络错误冷却 30 分钟后自动恢复发送资格，拒收/无权限/无好友关系等待有效 QQ 入站消息后再尝试；这些延期不计入通用失败次数。其他主动消息连续失败 3 次会挂起该 Persona 的主动周期（仅内存状态，不落盘、不改写配置），用户下次回复或重启程序后自动恢复。

## 4. 关键模块

| 层 | 模块 | 职责 |
| --- | --- | --- |
| 应用 | `pawzochat/app.py` | 生命周期、模块装配、账号恢复、Web Server |
| 配置/路径 | `core/config.py`、`paths.py` | 默认配置、原子保存/恢复、统一运行时路径 |
| 通道 | `channels/base.py`、`registry.py` | 通道抽象与按 `channel_type` 路由 |
| 内建通道 | `channels/web.py`、`wechat.py`、`qq.py` | Web、微信和 QQ 收发 |
| 插件通道 | `channels/plugin.py` | 将插件回调适配为一等通道 |
| 对话 | `services/chat.py` | 上下文、LLM 调用、工具循环、文本/语音草稿 |
| 队列/回复 | `services/message_queue.py`、`reply_dispatcher.py` | 消息聚合、持久化、投递、SSE 和 hook |
| 记忆/知识 | `services/memory.py`、`worldbook.py` | 记忆注入与合并、世界书匹配 |
| 内容 | `services/emoji.py`、`moments.py` | 表情增强和朋友圈工作流 |
| 主动消息 | `services/proactive.py` | 空闲触发、静默时段、通道推送策略 |
| 存储 | `store/conversation.py`、`store/moments.py` | 会话与朋友圈 JSON 持久化 |
| LLM | `llm/manager.py`、`llm/providers/` | OpenAI 兼容、Anthropic、Gemini |
| 生图 | `image/manager.py`、`image/providers/` | OpenAI、Gemini、NovelAI 等生图后端 |
| 语音 | `voice/manager.py`、`voice/providers/` | MiniMax/MiMo/OpenAI 兼容 TTS 与音频转码 |
| MCP | `mcp/manager.py`、`mcp/adapters.py` | Server 生命周期、工具聚合、能力适配 |
| 内置工具 | `mcp/builtin/` | 生图、查看参考图、记录/更新记忆 |
| 插件 | `core/extensions/` | 发现、依赖排序、权限 facade、hook 和卸载 |
| 传输 | `transport/`、`transport/qq/` | iLink、QQ 网关、认证、CDN、发送 |
| Web | `web/app.py`、`web/routes/` | Flask/Cheroot、认证、REST API、静态资源 |
| 前端 | `web/static/`、`web/templates/` | 无构建步骤的 Vanilla JS SPA |

## 5. Provider 与工具体系

### 5.1 模型 Provider

- 对话：`openai_compatible`、`anthropic`、`gemini` 三类实现。
- 生图：独立于对话 Provider，由 `ImageManager` 管理。
- 语音：独立于对话 Provider，由 `VoiceManager` 管理。

Persona 在配置中分别绑定对话、生图和语音 Provider/模型。Prompt 长文本存于 `data/prompts/<persona_id>.json`，而绑定、开关与数值设置保留在主配置中。

### 5.2 工具来源

送入 LLM 的工具可能来自四类来源：

1. 程序内置工具（owner 为 `builtin`）。
2. `capability_adapters` 配置映射的能力。
3. 插件通过 `ctx.mcp.register_tool(...)` 发布的进程内工具（owner 为 `plugin:<id>`）。
4. MCP Server 提供的远端工具。

最终工具集还会按模型 `tool_use` 能力、Persona 的 `tool_policy`、生图/记忆开关及参考图可用性过滤。

## 6. 插件与 hook

插件从 `data/plugins/*/plugin.yaml` 发现，入口工厂返回 `Plugin` 实例。Manifest 的 `hooks` 字段用于声明和展示；真正的 hook 注册由插件在 `setup(ctx)` 中调用 `ctx.hooks.on_*` 完成。

当前 hook 为：

- `message.received`
- `message.stored`
- `context.build`
- `reply.compose`
- `reply.pre_send`
- `reply.sent`

受控 facade 权限包括 `messaging.send`、`mcp.read`、`mcp.invoke`、`mcp.publish` 和 `channel.register`。插件仍在主进程内运行，权限是宿主 API 的能力门控和审计信息，不是 Python 安全沙箱。

## 7. Web 面板

`pawzochat/web/app.py:create_app(app_instance)` 创建一个 Flask 应用，本地与公网 Cheroot Server 共享它。主要 API 前缀为：

- `/api/conversations`、`/api/personas`、`/api/persona-writer`
- `/api/accounts`、`/api/providers`
- `/api/image-providers`、`/api/voice-providers`
- `/api/mcp`、`/api/plugins`
- `/api/moments`、`/api/worldbooks`
- `/api/emoji`、`/api/themes`
- `/api/settings`、`/api/setup`、`/api/telemetry`

此外还有 `/api/events`（SSE）、`/api/profile`、`/api/status`、媒体读取接口和仅打包版可用的更新接口。插件管理与更新接口只允许本地访问。

聊天页通过 `GET /api/conversations/{persona_id}/messages?limit=60` 加载最新页，用互斥的 `before` / `after` 游标向前翻历史或向后补齐新消息；`limit` 范围为 1–100。返回 `messages`、`before_cursor`、`after_cursor`、`has_more`（请求方向上是否还有消息）。消息附带 `_position` 和 `_page_key`，兼容没有 `local_id` 的旧记录。游标绑定会话、内存版本与数组边界；追加消息保持有效，编辑、删除、清空或重启后返回 409，客户端重新加载。无分页参数时保留 `rounds` / `date` 行为，LLM 上下文逻辑不变。

前端 `chat_history.js` 管理分页请求、会话代次和未读状态，`chat_timeline.js` 合并持久化、SSE 与乐观发送消息，`virtual_messages.js` 通过高度缓存和上下占位仅挂载可视区域附近的消息（最多 200 行）。动态高度由 `ResizeObserver` 校正，滚动按帧处理；消息请求绕过通用 SWR 缓存，SSE 重连后补齐遗漏。离开页面释放请求和观察器，跨桌面／手机布局保留聊天实例与阅读位置。此优化限制网络响应和 DOM 成本；已经加载的消息数据仍保留在当前页面内存中，后端 JSON 全量缓存与整文件写入方式不变。

## 8. 配置与数据落盘

主配置为 `data/config/config.yaml`，当前默认段包括：

- `llm_providers`、`image_providers`、`voice_providers`
- `personas`
- `mcp_servers`、`capability_adapters`
- `chat`、`reply`
- `web`、`theme`
- `moments`、`telemetry`

主要运行时数据：

```text
data/
├── auth/accounts.json                         # 微信、QQ、插件通道账号与凭据
├── books/*.json                               # 世界书
├── certs/server.crt|server.key                # 公网面板自签名证书
├── chats/<persona_id>/
│   ├── <persona_id>.json                      # 消息与 channel_link
│   ├── memory.json
│   ├── proactive_state.json
│   ├── avatar.png
│   ├── image_refs/ref.png
│   └── images/ | files/ | voice/
├── config/config.yaml                         # 主配置
├── emoji/                                     # 表情包
├── logs/pawzochat.log
├── mcp_servers/                               # 随应用携带的本地 MCP 实现
├── moments/moments.json                       # 朋友圈主数据
├── moments/images/<moment_id>/                # 朋友圈图片
├── plugins/<directory_name>/                  # 运行时插件；实际标识取 manifest.id
├── profile/                                   # 用户资料与头像
├── prompts/<persona_id>.json                  # 对话/生图 Prompt 长文本
├── telemetry_id.txt                           # 便携遥测 ID 副本
└── theme/<name>/style.css                     # 自定义主题
```

遥测 ID 还会按操作系统约定写入用户级应用数据目录，以便升级后保持稳定。旧 `data/bindings.json` 仅作为迁移输入，成功迁移后重命名为 `bindings.json.bak`。

## 9. 当前边界

- 会话、配置、朋友圈等以本地 JSON/YAML 文件存储，不使用数据库。
- Web 前端是原生 JS/CSS，无 Node 构建步骤。
- 插件只支持进程内 Python 模块，不提供隔离进程或安全沙箱。
- QQ 当前仅处理 C2C 私聊，主动消息复用角色已有设置，无需额外配置；每日平台额度由腾讯服务端判定。
- 公网面板使用自签名 TLS 与随机路径前缀；完整限制见网络安全文档。
