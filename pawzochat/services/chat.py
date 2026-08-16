# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""Chat service — unified LLM processing for all channels.

User messages are already persisted by :class:`MessageQueue` before this
service is invoked. ``process_round`` calls the LLM, runs the optional
tool-use loop, and returns assistant message drafts for downstream delivery.
"""

from __future__ import annotations

import base64
import logging
import secrets
from pathlib import Path
from typing import TYPE_CHECKING

from pawzochat.image.providers.novelai_image import is_novelai_v4_model
from pawzochat.image.reference import resolve_reference_images
from pawzochat.llm.base import ContentBlock, LLMResponse, ToolCall
from pawzochat.services.mcp_image_extractor import extract_mcp_images
from pawzochat.utils.message_text import (
    clean_assistant_reply_text,
    format_message_time,
    inject_quote_prefix,
)
from pawzochat.utils.text_splitter import (
    VOICE_EMOTIONS,
    contains_voice_marker,
    parse_voice_reply,
    split_reply,
    strip_voice_markers,
)
from pawzochat.transport.models import (
    Persona,
    normalize_image_generation,
    normalize_voice_generation,
)
from pawzochat.voice.synthesis import synthesize_voice_clip

if TYPE_CHECKING:
    from pawzochat.core.config import ConfigManager
    from pawzochat.core.extensions.manager import ExtensionManager
    from pawzochat.image.manager import ImageManager
    from pawzochat.llm.manager import LLMManager
    from pawzochat.mcp.adapters import CapabilityAdapterRegistry
    from pawzochat.mcp.manager import MCPManager
    from pawzochat.services.memory import MemoryService
    from pawzochat.services.worldbook import WorldbookService
    from pawzochat.store.conversation import ConversationStore
    from pawzochat.voice.manager import VoiceManager

from pawzochat.core.extensions.hooks import ContextBuildEvent

logger = logging.getLogger(__name__)


class ChatService:
    """Call the LLM and return normalized assistant message drafts.

    Shared pipeline for all channels — user messages are already stored
    by MessageQueue before this service is invoked.
    """

    def __init__(
        self,
        store: ConversationStore,
        config: ConfigManager,
        llm_manager: LLMManager,
        mcp_manager: MCPManager | None = None,
        capability_registry: CapabilityAdapterRegistry | None = None,
        extension_manager: ExtensionManager | None = None,
        memory_service: MemoryService | None = None,
        worldbook_service: WorldbookService | None = None,
        image_manager: ImageManager | None = None,
        voice_manager: VoiceManager | None = None,
    ):
        self.store = store
        self.config = config
        self.llm_manager = llm_manager
        self.mcp_manager = mcp_manager
        self.capability_registry = capability_registry
        self.extension_manager = extension_manager
        self.memory_service = memory_service
        self.worldbook_service = worldbook_service
        self.image_manager = image_manager
        self.voice_manager = voice_manager

    def process_round(
        self,
        persona_id: str,
        *,
        images: list[dict] | None = None,
        files: list[dict] | None = None,
        extra_hint: str | None = None,
    ) -> list[dict]:
        """Call the LLM with context and return assistant message drafts.

        Context is read from :class:`ConversationStore`; caller must
        persist any new user messages before invoking this method.

        *images* is an optional list of ``{"data": bytes, "mime": str}``
        dicts representing user-uploaded images for this round.

        *files* is an optional list of ``{"path": str, "name": str, "mime": str}``
        dicts representing user-sent files for this round.

        *extra_hint* is an optional out-of-band cue appended as a synthetic
        user turn at the end of history (formatted ``[系统提示] {hint}``).
        Used by :class:`pawzochat.services.proactive.ProactiveService` to
        nudge the LLM into generating a proactive opener without writing
        any fake user message to the conversation store.
        """
        conv = self.store.get_conversation(persona_id)
        if conv is None:
            raise ValueError(f"Conversation not found: {persona_id}")

        max_rounds = int(
            self.config.get("chat", "max_context_rounds", default=20)
        )
        history = self.store.get_recent_rounds(persona_id, max_rounds)
        persona = self._resolve_persona(persona_id)

        capabilities = self.llm_manager.get_model_capabilities(
            persona.llm_provider, persona.llm_model,
        )
        generated_images: list[dict] = []
        pending_images: dict[str, dict] = {}
        pending_files: dict[str, dict] = {}

        # Resolved once per round: gates both "inject voice guidance" and
        # "actually synthesize when a [语音] marker is parsed".
        voice_settings = self._resolve_voice_settings(persona)

        tools = self._collect_tools(persona, capabilities)
        active_tool_names = {t.get("name", "") for t in (tools or [])}

        llm_messages = self._build_llm_messages(
            persona, persona_id, history, images, files, capabilities,
            extra_hint=extra_hint,
            active_tool_names=active_tool_names,
            pending_images=pending_images,
            pending_files=pending_files,
            voice_settings=voice_settings,
        )
        if self.extension_manager:
            context_event = ContextBuildEvent(
                persona_id=persona_id,
                persona=persona,
                messages=llm_messages,
                images=list(images or []),
            )
            self.extension_manager.dispatch_context_build(context_event)
            llm_messages = context_event.messages

        response = self._run_tool_loop(
            persona=persona,
            persona_id=persona_id,
            llm_messages=llm_messages,
            tools=tools,
            pending_images=pending_images,
            pending_files=pending_files,
            generated_images=generated_images,
        )

        # Increment round counter after the tool loop has run (tool handlers
        # may have already called on_memory_recorded in this same round).
        if self.memory_service:
            self.memory_service.on_round_complete(persona_id)

        raw_reply = (response.text if response else None) or ""
        raw_reply = clean_assistant_reply_text(raw_reply)

        do_split_newline = bool(
            self.config.get("reply", "split_by_newline", default=True)
        )

        # Text/voice runs become drafts interleaved in written order; when
        # voice is disabled or a single run fails to synthesize, that run is
        # stripped of its marker and degrades to plain text (split_reply as usual).
        assistant_messages: list[dict] = []
        for seg in parse_voice_reply(raw_reply, split_newline=do_split_newline):
            if seg.kind == "voice" and voice_settings is not None:
                clip = synthesize_voice_clip(
                    self.voice_manager,
                    persona_id=persona_id,
                    settings=voice_settings,
                    text=seg.tts_text,
                    emotion=seg.emotion,
                )
                if clip is not None:
                    assistant_messages.append({
                        "role": "assistant",
                        "content": [{
                            "type": "voice",
                            "path": clip["path"],
                            "mime": clip["mime"],
                            "duration_ms": int(clip["duration_ms"] or 0),
                            "text": clip["text"],
                        }],
                        "source": "llm",
                    })
                    continue
                # Synthesis failed → fall through to the text degrade branch
                # below (the helper already logged a warning).
            for piece in split_reply(seg.raw, split_newline=do_split_newline):
                assistant_messages.append({
                    "role": "assistant",
                    "content": [{"type": "text", "text": piece}],
                    "source": "llm",
                })

        for img in generated_images:
            assistant_messages.append({
                "role": "assistant",
                "content": [{
                    "type": "image",
                    "path": img.get("path", ""),
                    "mime": img.get("mime", "image/png"),
                }],
                "source": "llm",
            })

        if not assistant_messages:
            assistant_messages.append({
                "role": "assistant",
                "content": [{"type": "text", "text": "……"}],
                "source": "llm",
            })

        return assistant_messages

    def run_oneshot(
        self,
        persona_id: str,
        *,
        instruction: str,
        images: list[dict] | None = None,
        include_image_tool: bool = True,
    ) -> tuple[str, list[dict]]:
        """Single LLM round outside the conversation pipeline.

        Used by Moments: reuses the persona's system prompt + worldbook +
        memory but skips conversation history. ``instruction`` becomes a
        synthetic user turn; ``images`` (``[{"data": bytes, "mime": str}]``)
        are attached via the same native-vision / ``recognize_image`` fallback
        path as chat. Returns ``(cleaned_text, generated_images)``.

        ``include_image_tool`` lets callers suppress the ``generate_image``
        tool (e.g. moments replies should not generate images).

        The ``record_memory`` / ``update_memory`` tools are always withheld
        here: they are a conversation feature, and the Moments flows that
        use this method write their own interaction memories via
        ``MomentsService._write_moment_memory`` gated by the separate
        ``moments.memory_enabled`` toggle — exposing them here would bypass
        that toggle and double-write.

        Moments-specific: only ``character_prompt`` is fed as the system
        block — ``[输出示例]`` and ``[系统指令]`` are dropped because they
        normally instruct the LLM to emit ``\\``/``$``-separated segments,
        which is wrong for a single Moments post or comment.
        """
        persona = self._resolve_persona(persona_id)
        if persona.character_prompt:
            system_prompt_override = "[人设设定]\n" + persona.character_prompt
        else:
            system_prompt_override = ""
        capabilities = self.llm_manager.get_model_capabilities(
            persona.llm_provider, persona.llm_model,
        )
        generated_images: list[dict] = []
        pending_images: dict[str, dict] = {}
        pending_files: dict[str, dict] = {}

        tools = self._collect_tools(persona, capabilities)
        if not include_image_tool and tools:
            tools = [t for t in tools if t.get("name") != "generate_image"]
        if tools:
            tools = [
                t for t in tools
                if t.get("name") not in ("record_memory", "update_memory")
            ]
        active_tool_names = {t.get("name", "") for t in (tools or [])}

        # Build system block (persona prompt + worldbook + memory + tool guidance)
        # by reusing _build_llm_messages with an empty history; the instruction
        # is fed as extra_hint to land as the user turn.
        llm_messages = self._build_llm_messages(
            persona,
            persona_id,
            history=[],
            images=images,
            files=None,
            capabilities=capabilities,
            extra_hint=instruction,
            active_tool_names=active_tool_names,
            pending_images=pending_images,
            pending_files=pending_files,
            worldbook_match_text=instruction,
            system_prompt_override=system_prompt_override,
        )

        response = self._run_tool_loop(
            persona=persona,
            persona_id=persona_id,
            llm_messages=llm_messages,
            tools=tools,
            pending_images=pending_images,
            pending_files=pending_files,
            generated_images=generated_images,
        )

        text = (response.text if response else None) or ""
        text = clean_assistant_reply_text(text)
        # Text-only flows like Moments have no voice pipeline: if the model
        # leaks a [语音] marker, drop the marker and publish the content as text.
        text = strip_voice_markers(text)
        return text, generated_images

    def generate_persona_draft(
        self,
        *,
        provider: str,
        model: str,
        system_prompt: str,
        user_request: str,
        temperature: float = 0.9,
        max_tokens: int = 4000,
    ) -> str:
        """One-off persona-text generation for the 人设编写助手.

        Builds a throwaway :class:`Persona` so the existing tool-call loop
        (``_collect_tools`` + ``_run_tool_loop``) can be reused *before any
        real persona exists* — giving the generation MCP tools such as
        联网搜索 exactly like a normal chat round. ``system_prompt`` is the
        fixed internal generation-guidance prompt supplied by the caller and
        ``user_request`` is the user's one-line ask.

        Returns the raw model text (the route parses it as JSON, with a marker
        fallback). Deliberately does NOT call ``clean_assistant_reply_text``:
        that chat-reply cleaner would mangle the JSON / the ``\\`` separators
        inside the examples.
        """
        persona = Persona(
            id="__persona_writer__",
            name="人设编写助手",
            llm_provider=provider,
            llm_model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            tool_policy={
                "mode": "all",
                "list": [],
                "max_iterations": 4,
                "timeout_seconds": 30,
            },
            memory={"enabled": False},
        )
        # image_generation defaults to disabled on this throwaway persona, so
        # _collect_tools already excludes generate_image / view_reference_image;
        # memory is disabled explicitly above so record_memory / update_memory
        # are excluded too. Web search & other MCP tools remain.
        capabilities = self.llm_manager.get_model_capabilities(provider, model)
        tools = self._collect_tools(persona, capabilities)

        llm_messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_request},
        ]

        response = self._run_tool_loop(
            persona=persona,
            persona_id=persona.id,
            llm_messages=llm_messages,
            tools=tools,
            pending_images={},
            pending_files={},
            generated_images=[],
        )
        return (response.text if response else None) or ""

    def _run_tool_loop(
        self,
        *,
        persona,
        persona_id: str,
        llm_messages: list[dict],
        tools: list[dict] | None,
        pending_images: dict[str, dict],
        pending_files: dict[str, dict],
        generated_images: list[dict],
    ) -> LLMResponse | None:
        """Run the provider.chat / tool-call loop. Returns the terminal response.

        Loop terminates when the response's ``finish_reason`` is not
        ``tool_use`` (or after ``persona.tool_policy.max_iterations`` rounds).
        All call-scoped state (pending_images/files, generated_images) is
        passed in as args so concurrent rounds do not stomp on each other.
        """
        if not persona.llm_model:
            raise ValueError(
                f"角色「{persona.name}（{persona.id}）」未配置模型，请在角色设置中选择一个模型"
            )

        provider = self.llm_manager.get_provider(persona.llm_provider)
        if not provider:
            raise RuntimeError(
                f"角色「{persona.name}（{persona.id}）」的服务商「{persona.llm_provider}」不可用"
            )

        tool_policy = persona.tool_policy
        max_iter = tool_policy.get("max_iterations", 10)
        timeout = tool_policy.get("timeout_seconds", 30)

        response: LLMResponse | None = None
        loop_completed = False
        for _ in range(max_iter):
            try:
                response = provider.chat(
                    llm_messages,
                    tools=tools,
                    model=persona.llm_model or None,
                    temperature=persona.temperature,
                    max_tokens=persona.max_tokens,
                )
            except Exception:
                logger.exception("LLM call failed for persona=%s", persona_id)
                raise

            if response.finish_reason != "tool_use" or not response.tool_calls:
                loop_completed = True
                break

            assistant_msg: dict = {
                "role": "assistant",
                "content": response.text,
                "tool_calls": response.tool_calls,
            }
            # Thinking-mode models (DeepSeek v4) require their
            # reasoning_content from the previous turn to be echoed back on
            # the next request. Only attach when present so non-thinking
            # models stay unaffected.
            if response.reasoning_content:
                assistant_msg["reasoning_content"] = response.reasoning_content
            llm_messages.append(assistant_msg)

            for tc in response.tool_calls:
                generated_image_count = len(generated_images)
                try:
                    result_blocks = self._execute_tool(
                        tc,
                        timeout=timeout,
                        persona=persona,
                        persona_id=persona_id,
                        generated_images=generated_images,
                        pending_images=pending_images,
                        pending_files=pending_files,
                    )
                except Exception as exc:
                    result_blocks = [ContentBlock(
                        type="text", text=f"工具调用失败: {exc}",
                    )]
                else:
                    # Built-in tools like generate_image register outbound
                    # images themselves. Other tools, including MCP-backed
                    # capability adapters, may only return image payloads in
                    # the tool result, so extract those unless the handler
                    # already appended images to the outgoing queue.
                    if len(generated_images) == generated_image_count:
                        saved, result_blocks = extract_mcp_images(
                            result_blocks, persona_id=persona_id,
                        )
                        generated_images.extend(saved)
                llm_messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "_function_name": tc.name,
                    "content": result_blocks,
                })

        if response is not None and not loop_completed:
            # Hit when the LLM keeps asking for tools for max_iter rounds and
            # never settles on a final reply — usually a slow/blocked MCP
            # backend combined with a persona prompt that forces tool use.
            # Raising propagates to MessageQueue._process which surfaces a
            # clear error to the user instead of falling back to "……".
            logger.warning(
                "工具调用循环达到上限 (max_iter=%d) persona=%s — "
                "LLM 持续请求工具但未产出回复，可能 MCP 服务阻塞或 prompt 强制要求调用",
                max_iter, persona_id,
            )
            raise RuntimeError(
                f"工具调用次数已达上限（{max_iter} 次）仍未完成，"
                f"请检查 MCP 服务是否阻塞，或 prompt 是否强制要求模型反复调用工具"
            )

        return response

    # ---- Message building -------------------------------------------------

    def _build_llm_messages(
        self,
        persona,
        persona_id: str,
        history: list[dict],
        images: list[dict] | None,
        files: list[dict] | None,
        capabilities: list[str],
        *,
        extra_hint: str | None = None,
        active_tool_names: set[str] | None = None,
        pending_images: dict[str, dict] | None = None,
        pending_files: dict[str, dict] | None = None,
        worldbook_match_text: str | None = None,
        system_prompt_override: str | None = None,
        voice_settings: dict | None = None,
    ) -> list[dict]:
        """Build the LLM message list from raw per-message history.

        Consecutive same-role messages (within a round) are merged so the
        final list strictly alternates user / assistant.

        ``pending_images`` / ``pending_files`` are call-scoped dicts populated
        by ``_attach_images`` / ``_attach_files`` when the LLM lacks native
        vision/file support — the LLM then queries them via tool calls.
        Callers that may run concurrently must pass fresh dicts.

        ``system_prompt_override`` replaces ``persona.prompt`` when not None
        (an empty string is still a valid override meaning "no system block").
        Used by Moments to suppress the persona's [输出示例]/[系统指令] sections
        — those instruct the chat LLM to emit ``\\``/``$``-separated segments,
        which makes no sense for a single Moments post.
        """
        if pending_images is None:
            pending_images = {}
        if pending_files is None:
            pending_files = {}

        llm_messages: list[dict] = []
        system_block = (
            system_prompt_override
            if system_prompt_override is not None
            else persona.prompt
        )
        if system_block:
            llm_messages.append({"role": "system", "content": system_block})

        if self.worldbook_service:
            user_text = (
                worldbook_match_text
                if worldbook_match_text is not None
                else self._latest_user_text(history)
            )
            worldbook_text = self.worldbook_service.get_prompt_text(
                persona_id, user_text,
            )
            if worldbook_text:
                llm_messages.append({"role": "system", "content": worldbook_text})

        if self.memory_service:
            memory_text = self.memory_service.format_memories_for_prompt(persona_id)
            if memory_text:
                llm_messages.append({"role": "system", "content": memory_text})

        if active_tool_names and (
            "generate_image" in active_tool_names
            or "view_reference_image" in active_tool_names
        ):
            guidance = self._build_image_tool_guidance(
                persona, active_tool_names=active_tool_names,
            )
            if guidance:
                llm_messages.append({"role": "system", "content": guidance})

        if voice_settings is not None:
            llm_messages.append({
                "role": "system",
                "content": self._build_voice_reply_guidance(),
            })

        if active_tool_names:
            mem_guidance = self._build_memory_tool_guidance(active_tool_names)
            if mem_guidance:
                llm_messages.append({"role": "system", "content": mem_guidance})

        # Periodic reminder: if N rounds have passed without a memory
        # recording, nudge the AI to consider whether anything is worth
        # remembering. Only inject when record_memory is actually available
        # (it is hidden in run_oneshot / moments flows).
        if self.memory_service and active_tool_names and "record_memory" in active_tool_names:
            reminder = self.memory_service.check_and_ack_reminder(persona_id)
            if reminder:
                llm_messages.append({"role": "system", "content": reminder})

        merged: list[dict] = []
        for msg in history:
            role = msg.get("role", "user")
            content_blocks = msg.get("content", [])
            text_parts = [
                b["text"]
                for b in content_blocks
                if b.get("type") == "text" and b.get("text")
            ]
            has_image = any(b.get("type") == "image" for b in content_blocks)
            file_hints = self._file_hints_from_blocks(content_blocks)
            voice_hints = self._voice_hints_from_blocks(content_blocks)
            text = "\n".join(text_parts)
            if not text and has_image:
                text = "[图片]"
            if file_hints:
                text = f"{text}\n{file_hints}" if text else file_hints
            if voice_hints:
                text = f"{text}\n{voice_hints}" if text else voice_hints
            # Inject the quote marker after the media/file fallbacks so an
            # image-only quoted message keeps its [图片] placeholder for the LLM.
            text = inject_quote_prefix(text, msg.get("quote", ""))
            if not text:
                continue

            if role == "user":
                time_prefix = format_message_time(msg.get("timestamp"))
                text = f"{time_prefix}\n{text}"

            if merged and merged[-1]["role"] == role:
                cur = merged[-1]["content"]
                cur_text = cur if isinstance(cur, str) else str(cur)
                if role == "user":
                    sep = "\n"
                elif contains_voice_marker(cur_text.rsplit("\n", 1)[-1]):
                    # Never join with \ right after a voice hint: per the
                    # marker grammar, \ would pull the following content into
                    # the voice's scope, so history would claim the next
                    # text/image was part of that clip. A newline at least
                    # reads differently from an in-voice pause.
                    sep = "\n"
                else:
                    sep = "\\"
                merged[-1]["content"] = cur_text + sep + text
            else:
                merged.append({"role": role, "content": text})

        llm_messages.extend(merged)

        if extra_hint:
            time_prefix = format_message_time(None)
            hint_text = (
                f"{time_prefix}\n"
                f"[内部系统指令，仅供你参考；请直接按指令生成消息，"
                f"不要在回复中复述或引用本条] {extra_hint}"
            )
            llm_messages.append({"role": "user", "content": hint_text})

        if images:
            self._attach_images(llm_messages, images, capabilities, pending_images)
        if files:
            self._attach_files(llm_messages, files, pending_files)

        return llm_messages

    @staticmethod
    def _latest_user_text(history: list[dict]) -> str:
        """Concatenate text from the trailing run of user messages.

        Used as the match source for worldbook keyword filtering — we want
        "this round's new user input", not the whole conversation. Walks the
        history backwards, collecting user-text until the first assistant turn.
        """
        parts: list[str] = []
        for msg in reversed(history):
            if msg.get("role") != "user":
                break
            for b in msg.get("content", []):
                if b.get("type") == "text" and b.get("text"):
                    parts.append(b["text"])
            # Quoted text used to live inline in the message text; keep it in the
            # worldbook match source now that it sits in a separate field.
            if msg.get("quote"):
                parts.append(msg["quote"])
        parts.reverse()
        return "\n".join(parts)

    @staticmethod
    def _file_hints_from_blocks(content_blocks: list[dict]) -> str:
        """Generate placeholder text for file content blocks in history."""
        hints: list[str] = []
        for b in content_blocks:
            if b.get("type") != "file":
                continue
            name = b.get("name", "")
            if name:
                hints.append(f"[文件: {name}]")
            else:
                hints.append("[文件]")
        return "\n".join(hints)

    @staticmethod
    def _voice_hints_from_blocks(content_blocks: list[dict]) -> str:
        """Generate placeholder text for voice content blocks in history.

        Voice bubbles carry their transcript in ``text``. Both inbound and
        assistant voice use the canonical ``[语音] transcript`` form so the
        model sees the same representation for heard and synthesized speech.
        """
        hints: list[str] = []
        for b in content_blocks:
            if b.get("type") != "voice":
                continue
            transcript = (b.get("text") or "").strip()
            if not transcript:
                hints.append("[语音]")
            else:
                hints.append(f"[语音] {transcript}")
        return "\n".join(hints)

    @staticmethod
    def _image_to_b64(img: dict) -> str:
        """Return base64-encoded image data, reading from disk if needed."""
        raw = img.get("data")
        if raw is None:
            path = img.get("path")
            if not path:
                raise ValueError("Image dict has neither 'data' nor 'path'")
            raw = Path(path).read_bytes()
        return base64.b64encode(raw).decode("ascii") if isinstance(raw, bytes) else raw

    def _attach_images(
        self,
        messages: list[dict],
        images: list[dict],
        capabilities: list[str],
        pending_images: dict[str, dict],
    ):
        """Attach image data to the last user message or append a new one.

        ``pending_images`` is mutated in-place when the LLM lacks native
        vision so the tool layer can later resolve ``[图片 ID:xxx]`` hints.
        """
        has_vision = "vision" in capabilities

        if has_vision:
            content_blocks: list[dict] = []
            if messages and messages[-1]["role"] == "user":
                last = messages[-1]
                existing = last.get("content", "")
                if isinstance(existing, str):
                    content_blocks.append({"type": "text", "text": existing})
                elif isinstance(existing, list):
                    content_blocks.extend(existing)
                for img in images:
                    content_blocks.append({
                        "type": "image",
                        "data": self._image_to_b64(img),
                        "mime_type": img.get("mime", "image/jpeg"),
                    })
                last["content"] = content_blocks
            else:
                for img in images:
                    content_blocks.append({
                        "type": "image",
                        "data": self._image_to_b64(img),
                        "mime_type": img.get("mime", "image/jpeg"),
                    })
                messages.append({"role": "user", "content": content_blocks})
        else:
            hints: list[str] = []
            for img in images:
                img_id = f"img_{secrets.token_hex(4)}"
                b64 = self._image_to_b64(img)
                pending_images[img_id] = {
                    "data": b64,
                    "mime": img.get("mime", "image/jpeg"),
                }
                hints.append(f"[图片 ID:{img_id}]")

            hint_text = "\n".join(hints)
            if messages and messages[-1]["role"] == "user":
                cur = messages[-1].get("content", "")
                messages[-1]["content"] = f"{cur}\n{hint_text}" if cur else hint_text
            else:
                messages.append({"role": "user", "content": hint_text})

    def _attach_files(
        self,
        messages: list[dict],
        files: list[dict],
        pending_files: dict[str, dict],
    ):
        """Attach file references as text hints, populating *pending_files*."""
        hints: list[str] = []
        for f in files:
            file_id = f"file_{secrets.token_hex(4)}"
            pending_files[file_id] = {
                "path": f.get("path", ""),
                "name": f.get("name", ""),
                "mime": f.get("mime", "application/octet-stream"),
            }
            name = f.get("name", "")
            if name:
                hints.append(f"[文件: {name} ID:{file_id}]")
            else:
                hints.append(f"[文件 ID:{file_id}]")

        hint_text = "\n".join(hints)
        if messages and messages[-1]["role"] == "user":
            cur = messages[-1].get("content", "")
            if isinstance(cur, str):
                messages[-1]["content"] = f"{cur}\n{hint_text}" if cur else hint_text
            elif isinstance(cur, list):
                text_parts = [b.get("text", "") for b in cur if b.get("type") == "text"]
                existing = "\n".join(t for t in text_parts if t)
                combined = f"{existing}\n{hint_text}" if existing else hint_text
                non_text = [b for b in cur if b.get("type") != "text"]
                messages[-1]["content"] = [{"type": "text", "text": combined}] + non_text
        else:
            messages.append({"role": "user", "content": hint_text})

    # ---- Tool collection and execution ------------------------------------

    def _collect_tools(
        self,
        persona,
        capabilities: list[str],
    ) -> list[dict] | None:
        if "tool_use" not in capabilities:
            return None

        tools: list[dict] = []

        if self.capability_registry:
            tools.extend(self.capability_registry.get_tool_definitions())

        if self.mcp_manager:
            tools.extend(self.mcp_manager.get_all_tools())

        tools = self._filter_by_policy(tools, persona.tool_policy)
        tools = self._filter_image_generation(tools, persona)
        tools = self._filter_view_reference_image(tools, persona)
        tools = self._filter_memory_tools(tools, persona)

        return tools or None

    # Per-provider prompt-style guidance. NovelAI expects English danbooru-style
    # comma-separated tags; OpenAI / Gemini expect natural language. The
    # variable-segment hint is the only place where the prompt styles
    # meaningfully diverge.
    _IMG_VARIABLE_HINT_NATURAL = (
        "你的 prompt 参数应当**只**描述这些可变内容："
        "场景与环境（地点、时间、天气、背景）、角色的动作/姿态/表情、"
        "镜头与光线（如 50mm lens, soft sunlight, shallow depth of field）。"
    )
    _IMG_VARIABLE_HINT_NAI = (
        "你的 prompt 参数应当**只**描述这些可变内容，且必须使用**英文小写、逗号分隔的"
        "danbooru 风格标签**（NovelAI v4/v4.5 对标签更敏感，自然语言句子效果差）："
        "场景标签（地点、时间、天气、背景物件，如 `cafe interior, evening, neon lights`）"
        "→ 角色动作/姿态/表情（`sitting, holding cup, smiling`）"
        "→ 服饰细节（仅当与 art_style/style_prefix 中已有的不冲突时补充）"
        "→ 镜头/光线/构图（`close-up, soft lighting, depth of field`）。"
        "不要写整句中文，不要写 `a photo of ...` 这类自然语言。"
    )
    _IMG_FALLBACK_HINT_NATURAL = (
        "prompt 结构推荐：「角色形象描述, 场景与动作, 光线/镜头/画风」。"
        "角色形象描述需基于[人设设定]中 appearance/attire 字段（发色、瞳色、"
        "身高、体型、服饰、神态），不要让画面与人设冲突。"
    )
    _IMG_FALLBACK_HINT_NAI = (
        "prompt 必须使用**英文小写、逗号分隔的 danbooru 风格标签**。"
        "推荐顺序：质量与画风标签（如 `masterpiece, best quality, anime`）→ "
        "角色形象标签（基于[人设设定]中 appearance/attire 字段：发色、瞳色、服饰）→ "
        "场景与动作（地点、姿态、表情）→ 镜头/光线/构图。"
        "不要写整句中文，不要写 `a photo of ...` 这类自然语言。"
    )
    _IMG_NAI_SIZE_RULE = (
        "尺寸请优先使用以下普通安全档：1024×1024（方图）、1216×832（横屏）、"
        "832×1216（竖屏）。其他尺寸会被自动吸附到最近的安全档。"
    )
    _IMG_NAI_V4_REF_RULE = (
        "当前 NovelAI v4/v4.5 模型不会接收头像/自定义参考图；"
        "不要依赖参考图保持外观。若已配置的画面风格或角色形象提示未覆盖必要固定外观，"
        "请用少量英文标签补足关键外观细节。"
    )

    def _build_image_tool_guidance(
        self,
        persona,
        *,
        active_tool_names: set[str] | None = None,
    ) -> str:
        """Compose the system-level rules the LLM follows when calling
        ``generate_image`` and/or ``view_reference_image``.

        Tells the LLM exactly which prompt segments are auto-prepended by the
        backend (``art_style`` + ``style_prefix``) so it knows to *not* repeat
        them and to focus its prompt on scene/action/camera. Without this the
        LLM would dutifully restate the character description and the final
        prompt would contain duplicates.

        Branches on the persona's image-backend type: NovelAI wants English
        danbooru tags + normal-safe size guidance; OpenAI / Gemini keep the
        natural-language guidance.

        ``active_tool_names`` controls which tool-specific subsections are
        included — only the rules for tools actually exposed to this round
        appear, so the LLM does not see guidance for tools it cannot call.
        """
        active = active_tool_names or set()
        gen_active = "generate_image" in active
        view_active = "view_reference_image" in active

        ig = normalize_image_generation(getattr(persona, "image_generation", None))
        art_style = ig["art_style"].strip()
        style_prefix = ig["style_prefix"].strip()
        ref_mode = ig["ref_mode"]

        model_type = None
        if self.image_manager and ig["provider"] and ig["model"]:
            model_type = self.image_manager.get_model_type(ig["provider"], ig["model"])
        is_nai = model_type == "novelai_image"
        is_nai_v4 = is_nai and is_novelai_v4_model(ig["model"])

        auto_parts: list[str] = []
        if art_style:
            auto_parts.append(f"画面风格：{art_style}")
        if style_prefix:
            auto_parts.append(f"角色形象：{style_prefix}")

        lines = ["[图片生成工具使用规则]"]

        if gen_active:
            if auto_parts:
                lines.append(
                    "调用 generate_image 时，以下内容会被系统自动拼接到你提供的 prompt 之前——"
                    "你**不需要也不应该**在 prompt 里重复或修改它们：",
                )
                for part in auto_parts:
                    lines.append(f"  · {part}")
                # Show the LLM the final stitched prompt shape so it sees its
                # own argument is just the trailing scene description.
                head = ", ".join(
                    p.split("：", 1)[1] for p in auto_parts
                )
                lines.append(
                    f"  最终发给生图模型的 prompt 形如：`{head}, {{你提供的 prompt}}`",
                )
                lines.append(self._IMG_VARIABLE_HINT_NAI if is_nai else self._IMG_VARIABLE_HINT_NATURAL)
            else:
                lines.append(self._IMG_FALLBACK_HINT_NAI if is_nai else self._IMG_FALLBACK_HINT_NATURAL)

            if is_nai:
                lines.append(self._IMG_NAI_SIZE_RULE)

            if is_nai_v4 and ref_mode in {"custom", "avatar"}:
                lines.append(self._IMG_NAI_V4_REF_RULE)
            elif ref_mode == "custom":
                lines.append(
                    "当前角色默认会自动附加一张自定义参考图给支持的生图模型；"
                    "不要在 prompt 里重复描述那张图里的固定外观。",
                )
            elif ref_mode == "avatar":
                lines.append(
                    "当前角色默认会把头像作为参考图传给支持的生图模型；"
                    "不要在 prompt 里重复描述头像中的固定外观。",
                )

            if ref_mode in {"custom", "avatar"}:
                lines.append(
                    "- `use_reference_image` 参数：默认 true（带上角色形象参考图）。"
                    "纯风景、物品、食物、抽象画面等**不需要出现人物**的场景请传 false，"
                    "避免角色被参考图强行带入。人物特写或需要保持外观一致时省略或传 true。",
                )

            lines.extend([
                "- 仅在用户明确请求图片或当前场景确实适合用图片回应时调用，不要滥用。",
                "- 同一对话多次生图时，场景/动作要自然过渡，不要前后矛盾。",
                "- 直接描述画面，不要写元指令（如『生成一张』『画一幅』）。",
            ])

        if view_active:
            lines.append(
                "- `view_reference_image` 工具：当你需要描述/确认自己的外观"
                "（发色、瞳色、服饰等），或者要决定生图细节、回应用户对外观的提问之前，"
                "先调用 `view_reference_image` 拿到形如 `[图片 ID:img_xxx]` 的图片 ID，"
                "随后用 `recognize_image` 工具并把 `image_id` 设为该 ID 读取图片内容。"
                "同一轮里仅在确有必要时调用一次，不要重复刷。",
            )

        return "\n".join(lines)

    @staticmethod
    def _build_memory_tool_guidance(active_tool_names: set[str]) -> str:
        """Compose the system-level rules for ``record_memory`` /
        ``update_memory``.

        Only the subsections for tools actually exposed this round are
        included — ``update_memory`` may be filtered out on its own when
        ``include_in_prompt`` is off (see :meth:`_filter_memory_tools`).
        """
        record_active = "record_memory" in active_tool_names
        update_active = "update_memory" in active_tool_names
        if not record_active and not update_active:
            return ""

        lines = ["[记忆工具使用规则]"]
        if record_active:
            lines.append(
                "- 当对话中出现值得长期记住的内容时，调用 record_memory 记录一条新记忆："
                "用户的身份/喜好/习惯/近况、你们之间的约定或承诺、对你们关系有意义的事件、"
                "你不想忘记的感受。记忆必须以『我』的第一人称写成，像日记或回忆片段。"
            )
            lines.append(
                "- 不是每轮都需要记录：寒暄、闲聊、已经记过的内容不要重复记录；"
                "一轮对话通常最多记录一条。"
            )
        if update_active:
            lines.append(
                "- [历史记忆]中每条记忆标注的『记忆 #N』就是它的编号。当某条记忆过时、"
                "不准确或有了新进展时，调用 update_memory 并把 index 设为该编号来覆盖它；"
                "新内容要包含旧记忆中仍然有效的信息，而不是只写新增部分。编号请原样照抄。"
            )
        lines.append("- 记录/更新记忆后正常回复用户即可，不要向用户提及你在操作记忆。")
        return "\n".join(lines)

    @staticmethod
    def _build_voice_reply_guidance() -> str:
        """System guidance injected when the persona's voice reply is usable."""
        emotions = "/".join(VOICE_EMOTIONS)
        return (
            "[语音消息规则]\n"
            "- 你可以直接在回复文字里用标记发语音条：写 [语音]要说的话，"
            "例如：[语音]今天也想你了。也可以写成 [voice]今天也想你了。\n"
            "- 语音内容从标记处一直延伸到下一个语音标记或本轮回复结尾。"
            "所以普通文字必须写在语音标记之前；标记之后的内容都会被合成进这条语音。\n"
            "- 需要连发多条语音时，写多个标记：[语音]第一条[语音]第二条。\n"
            f"- 可以为单条语音指定情绪基调：[语音-happy]内容。可选值仅限 {emotions}；"
            "不确定时省略，直接写 [语音] 即可。\n"
            "- 语音内容必须口语化、自然简短（建议单条不超过 60 个字），"
            "不要包含动作/心理描写、颜文字或 emoji。语音内容里可以继续用反斜线(\\)"
            "分隔短语，它们会变成语音里的自然停顿，不计入普通消息的句数限制。\n"
            "- 聊天记录里的 [语音] 内容表示该段话是通过语音说出的；"
            "你要发语音时也使用 [语音] 或 [voice] 标记。\n"
            "- 根据当前对话的上下文、情绪和意境自行判断是否使用语音，不必等待用户主动要求。\n"
            "- 如果用户明确表示想听语音、喜欢语音交流或要求后续使用语音，"
            "则在接下来的对话中积极使用语音，直到上下文表明不再需要；"
            "同时保持表达自然，避免无意义地连续发送。\n"
            "- 不要在普通文字里复述语音的内容，也不要向用户解释你发的是语音。"
        )

    def _filter_image_generation(
        self, tools: list[dict], persona,
    ) -> list[dict]:
        """Hide ``generate_image`` unless the persona has it enabled and the
        chosen provider/model is currently usable.

        Filters early so the LLM never sees the tool when it cannot run.
        """
        ig = getattr(persona, "image_generation", None) or {}
        if not isinstance(ig, dict) or not ig.get("enabled"):
            return [t for t in tools if t.get("name") != "generate_image"]

        provider_name = (ig.get("provider") or "").strip()
        model_id = (ig.get("model") or "").strip()
        if not provider_name or not model_id:
            return [t for t in tools if t.get("name") != "generate_image"]

        if self.image_manager is None:
            return [t for t in tools if t.get("name") != "generate_image"]
        if self.image_manager.get_provider_for_model(provider_name, model_id) is None:
            return [t for t in tools if t.get("name") != "generate_image"]

        return tools

    def _filter_view_reference_image(
        self, tools: list[dict], persona,
    ) -> list[dict]:
        """Hide ``view_reference_image`` when calling it could not produce a
        usable result for the LLM.

        Mirrors :meth:`_filter_image_generation`: filters at tool-list build
        time so the LLM never sees a tool whose call path is broken. Hides
        when any of:

        * image generation is disabled for this persona;
        * ``ref_mode == "none"`` — user explicitly opted out of reference imagery;
        * ``resolve_reference_images`` returns nothing (file missing);
        * ``recognize_image`` is not exposed in the filtered tool list — the
          tool hands the image to the LLM via the ``pending_images`` channel,
          which is only consumable by ``recognize_image``.
        """
        if not any(t.get("name") == "view_reference_image" for t in tools):
            return tools

        drop = [t for t in tools if t.get("name") != "view_reference_image"]

        if not any(t.get("name") == "recognize_image" for t in tools):
            return drop

        ig = normalize_image_generation(getattr(persona, "image_generation", None))
        if not ig["enabled"] or ig["ref_mode"] == "none":
            return drop

        persona_id = getattr(persona, "id", "") or ""
        if not persona_id:
            return drop
        if not resolve_reference_images(persona_id, ig):
            return drop

        return tools

    def _resolve_voice_settings(self, persona) -> dict | None:
        """Voice-reply availability gate.

        Returns the normalized settings when the persona has voice enabled
        with a configured, currently resolvable provider/model; ``None``
        otherwise. ``process_round`` resolves this once per round to gate
        both guidance injection and actual synthesis of parsed [语音] markers.
        """
        settings = normalize_voice_generation(
            getattr(persona, "voice_generation", None)
        )
        if not settings["enabled"] or not settings["provider"] or not settings["model"]:
            return None
        if self.voice_manager is None:
            return None
        if self.voice_manager.get_provider_for_model(
            settings["provider"], settings["model"],
        ) is None:
            return None
        return settings

    def _filter_memory_tools(
        self, tools: list[dict], persona,
    ) -> list[dict]:
        """Hide ``record_memory`` / ``update_memory`` unless the persona has
        memory enabled.

        Reads ``persona.memory`` directly (mirroring
        :meth:`_filter_image_generation`) instead of
        ``MemoryService.get_memory_settings`` — the latter falls back to
        enabled-by-default for personas absent from config, e.g. the
        throwaway persona-writer persona.

        ``update_memory`` additionally requires ``include_in_prompt``:
        without the ``[历史记忆]`` injection the LLM can never see a valid
        ``#N`` index, so exposing the tool would only invite blind writes.
        """
        mem = getattr(persona, "memory", None)
        enabled = isinstance(mem, dict) and bool(mem.get("enabled"))
        if not enabled or self.memory_service is None:
            return [
                t for t in tools
                if t.get("name") not in ("record_memory", "update_memory")
            ]
        if not mem.get("include_in_prompt", True):
            return [t for t in tools if t.get("name") != "update_memory"]
        return tools

    def _execute_tool(
        self,
        tc: ToolCall,
        timeout: int,
        *,
        persona=None,
        persona_id: str = "",
        generated_images: list[dict] | None = None,
        pending_images: dict[str, dict] | None = None,
        pending_files: dict[str, dict] | None = None,
    ) -> list[ContentBlock]:
        if self.capability_registry and self.capability_registry.is_capability_tool(tc.name):
            return self.capability_registry.execute(
                tc.name, tc.arguments,
                context={
                    "pending_images": pending_images if pending_images is not None else {},
                    "pending_files": pending_files if pending_files is not None else {},
                    "persona": persona,
                    "persona_id": persona_id,
                    "generated_images": generated_images if generated_images is not None else [],
                },
                timeout=timeout,
            )

        if self.mcp_manager:
            return self.mcp_manager.call_tool(tc.name, tc.arguments, timeout=timeout)

        return [ContentBlock(type="text", text=f"No handler for tool: {tc.name}")]

    @staticmethod
    def _filter_by_policy(
        tools: list[dict], tool_policy: dict,
    ) -> list[dict]:
        mode = tool_policy.get("mode", "all")
        if mode == "none":
            return []
        if mode == "all":
            return tools

        tool_list = set(tool_policy.get("list", []))
        if mode == "whitelist":
            return [t for t in tools if t["name"] in tool_list]
        if mode == "blacklist":
            return [t for t in tools if t["name"] not in tool_list]
        return tools

    # ---- Helpers ----------------------------------------------------------

    def _resolve_persona(self, persona_id: str):
        personas = self.config.load_personas()
        if persona_id in personas:
            return personas[persona_id]
        raise ValueError(f"Persona not found: {persona_id}")
