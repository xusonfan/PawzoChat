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

"""Unified message queue — single pipeline for web and WeChat."""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from pawzochat.core.extensions.hooks import (
    MessageReceivedEvent,
    MessageStoredEvent,
    ReplyComposeEvent,
)
from pawzochat.web.sse import broadcast

if TYPE_CHECKING:
    from pawzochat.app import App

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


class _PersonaQueue:
    """Per-persona accumulation buffer."""

    __slots__ = (
        "last_message_time", "processing", "reply_ctx", "pending_messages",
    )

    def __init__(self):
        self.last_message_time: float = 0.0
        self.processing: bool = False
        self.reply_ctx: dict | None = None
        self.pending_messages: list[dict] = []


def _sanitize_content_blocks(content_blocks: list[dict]) -> list[dict]:
    """Return a store/API-safe copy of *content_blocks* without raw image data."""
    sanitized: list[dict] = []
    for block in content_blocks:
        block_copy = dict(block)
        block_copy.pop("data", None)
        sanitized.append(block_copy)
    return sanitized


def _build_pending_content_blocks(
    text: str,
    images: list[dict] | None,
    files: list[dict] | None,
    voices: list[dict] | None,
) -> list[dict]:
    """Build queue-internal content blocks, preserving in-memory image data."""
    content_blocks: list[dict] = []
    if text:
        content_blocks.append({"type": "text", "text": text})
    if images:
        for img in images:
            block = {
                "type": "image",
                "path": img.get("path", ""),
                "mime": img.get("mime", "image/jpeg"),
            }
            if img.get("data") is not None:
                block["data"] = img.get("data")
            content_blocks.append(block)
    if files:
        for f in files:
            content_blocks.append({
                "type": "file",
                "path": f.get("path", ""),
                "name": f.get("name", ""),
                "mime": f.get("mime", "application/octet-stream"),
            })
    if voices:
        for voice in voices:
            content_blocks.append({
                "type": "voice",
                "path": voice.get("path", ""),
                "mime": voice.get("mime", "audio/wav"),
                "duration_ms": voice.get("duration_ms", 0),
                "text": voice.get("text", ""),
            })
    if not content_blocks:
        content_blocks.append({"type": "text", "text": ""})
    return content_blocks


def _extract_from_pending(
    pending: list[dict],
) -> tuple[list[str], list[dict] | None, list[dict] | None, bool]:
    """Derive process inputs and voice presence from pending content blocks."""
    texts: list[str] = []
    images: list[dict] = []
    files: list[dict] = []
    has_voice = False
    for msg in pending:
        for block in msg.get("content", []):
            btype = block.get("type")
            if btype == "text":
                t = block.get("text", "")
                if t:
                    texts.append(t)
            elif btype == "image":
                image_info = {
                    "path": block.get("path", ""),
                    "mime": block.get("mime", "image/jpeg"),
                }
                if block.get("data") is not None:
                    image_info["data"] = block.get("data")
                images.append(image_info)
            elif btype == "file":
                files.append({
                    "path": block.get("path", ""),
                    "name": block.get("name", ""),
                    "mime": block.get("mime", "application/octet-stream"),
                })
            elif btype == "voice":
                has_voice = True
    return texts, images or None, files or None, has_voice


class MessageQueue:
    """Unified message queue shared by Web and WeChat channels."""

    def __init__(self, app: App):
        self._app = app
        self._queues: dict[str, _PersonaQueue] = {}
        self._lock = threading.Lock()
        self._running = False

    def start(self) -> None:
        self._running = True
        threading.Thread(
            target=self._checker_loop,
            name="message-queue-checker",
            daemon=True,
        ).start()

    def stop(self) -> None:
        self._running = False
        self._wait_for_processing()
        self._flush_pending()

    # ---- Proactive coordination ------------------------------------------

    def try_begin_proactive(self, persona_id: str) -> bool:
        """Acquire a per-persona slot for a proactive LLM call.

        Reuses the existing ``processing`` flag as a mutex so that
        :class:`pawzochat.services.proactive.ProactiveService` cannot
        interleave its LLM call with the queue's own ``_process``. Returns
        ``False`` if the persona has pending user messages or is already
        processing — caller should skip and retry on the next tick.
        """
        with self._lock:
            queue = self._queues.get(persona_id)
            if queue is None:
                queue = _PersonaQueue()
                self._queues[persona_id] = queue
            if queue.processing or queue.pending_messages:
                return False
            queue.processing = True
            return True

    def end_proactive(self, persona_id: str) -> None:
        """Release the slot acquired by :meth:`try_begin_proactive`.

        Mirrors the cleanup in :meth:`_process`'s ``finally`` block.
        """
        with self._lock:
            queue = self._queues.get(persona_id)
            if queue is None:
                return
            queue.processing = False

    def _wait_for_processing(self, timeout: float = 30.0) -> None:
        """Block until all active ``_process()`` threads finish."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                if not any(q.processing for q in self._queues.values()):
                    return
            time.sleep(0.5)
        logger.warning("关机等待处理完成超时 (%.0fs)", timeout)

    def _flush_pending(self) -> None:
        """Persist all buffered user messages on shutdown so nothing is lost."""
        with self._lock:
            snapshot = {
                pid: list(q.pending_messages)
                for pid, q in self._queues.items()
                if q.pending_messages
            }
        for persona_id, pending in snapshot.items():
            for msg in pending:
                try:
                    stored = self._app.conversation_store.add_message(
                        persona_id,
                        msg["role"],
                        _sanitize_content_blocks(msg["content"]),
                        msg["source"],
                        timestamp=msg.get("timestamp"),
                        quote=msg.get("quote", ""),
                    )
                    self._dispatch_message_stored(persona_id, stored, msg)
                except Exception:
                    logger.exception("关机 flush 失败: persona=%s", persona_id)
            logger.info("关机 flush: persona=%s, %d 条消息已持久化", persona_id, len(pending))

    def _dispatch_message_stored(
        self,
        persona_id: str,
        stored_message: dict,
        pending_message: dict,
    ) -> None:
        meta = pending_message.get("stored_event") or {}
        self._app.extension_manager.dispatch_message_stored(
            MessageStoredEvent(
                channel=meta.get("channel", pending_message.get("source", "")),
                source=pending_message.get("source", ""),
                persona_id=persona_id,
                message=stored_message,
                account_id=meta.get("account_id", ""),
                user_id=meta.get("user_id", ""),
                context_token=meta.get("context_token", ""),
                reply_ctx=meta.get("reply_ctx"),
                raw_message=meta.get("raw_message"),
            ),
        )

    def accept_message(
        self,
        persona_id: str,
        text: str,
        *,
        source: str,
        reply_ctx: dict | None = None,
        images: list[dict] | None = None,
        files: list[dict] | None = None,
        voices: list[dict] | None = None,
        raw_message: Any = None,
        account_id: str = "",
        user_id: str = "",
        context_token: str = "",
        timestamp: str | None = None,
        quote: str = "",
    ) -> tuple[str, dict] | None:
        """Run inbound hooks and enqueue the user message for deferred storage."""
        channel = (reply_ctx or {}).get("channel", source)
        event = MessageReceivedEvent(
            channel=channel,
            source=source,
            persona_id=persona_id,
            text=text,
            images=list(images or []),
            files=list(files or []),
            voices=list(voices or []),
            account_id=account_id,
            user_id=user_id,
            context_token=context_token,
            reply_ctx=dict(reply_ctx or {}),
            raw_message=raw_message,
        )
        self._app.extension_manager.dispatch_message_received(event)
        if event.cancelled or (
            not event.text
            and not event.images
            and not event.files
            and not event.voices
        ):
            logger.info(
                "消息已被插件取消: persona=%s source=%s",
                event.persona_id,
                event.source,
            )
            return None

        if not event.persona_id:
            logger.warning("消息缺少 persona_id，已丢弃: source=%s", event.source)
            return None

        self._app.conversation_store.ensure_conversation(event.persona_id)
        stored = self.enqueue(
            event.persona_id,
            event.text,
            event.source,
            reply_ctx=event.reply_ctx,
            images=event.images,
            files=event.files,
            voices=event.voices,
            timestamp=timestamp,
            quote=quote,
            stored_event={
                "channel": channel,
                "account_id": event.account_id,
                "user_id": event.user_id,
                "context_token": event.context_token,
                "reply_ctx": event.reply_ctx,
                "raw_message": event.raw_message,
            },
        )
        if getattr(self._app, "proactive_service", None):
            try:
                self._app.proactive_service.on_user_message(event.persona_id)
            except Exception:
                logger.exception(
                    "proactive on_user_message 失败 persona=%s", event.persona_id,
                )
        return event.persona_id, stored

    def enqueue(
        self,
        persona_id: str,
        text: str,
        source: str,
        *,
        reply_ctx: dict | None = None,
        images: list[dict] | None = None,
        files: list[dict] | None = None,
        voices: list[dict] | None = None,
        timestamp: str | None = None,
        quote: str = "",
        stored_event: dict | None = None,
    ) -> dict:
        """Buffer a user message for deferred storage and processing.

        The message is NOT written to :class:`ConversationStore` here; it
        is persisted later in :meth:`_process` right before the LLM call,
        which guarantees that user messages always come after the previous
        round's assistant messages in the store.
        """
        content_blocks = _build_pending_content_blocks(text, images, files, voices)
        pending_message: dict = {
            "role": "user",
            "content": content_blocks,
            "source": source,
            "timestamp": timestamp or _now_iso(),
            "quote": quote,
        }
        if stored_event:
            pending_message["stored_event"] = dict(stored_event)
        message: dict = {
            "role": pending_message["role"],
            "content": _sanitize_content_blocks(content_blocks),
            "source": pending_message["source"],
            "timestamp": pending_message["timestamp"],
        }
        if quote:
            message["quote"] = quote

        with self._lock:
            if persona_id not in self._queues:
                self._queues[persona_id] = _PersonaQueue()
            queue = self._queues[persona_id]
            queue.pending_messages.append(pending_message)
            queue.last_message_time = time.time()
            if reply_ctx:
                queue.reply_ctx = dict(reply_ctx)

        return message

    def _checker_loop(self) -> None:
        wait_seconds = self._app.config.get(
            "chat", "queue_wait_seconds", default=7,
        )
        while self._running:
            time.sleep(1)
            now = time.time()
            ready: list[str] = []

            with self._lock:
                for persona_id, queue in self._queues.items():
                    if (
                        queue.pending_messages
                        and not queue.processing
                        and now - queue.last_message_time >= wait_seconds
                    ):
                        queue.processing = True
                        ready.append(persona_id)

            for persona_id in ready:
                threading.Thread(
                    target=self._process,
                    args=(persona_id,),
                    daemon=True,
                ).start()

    def _process(self, persona_id: str) -> None:
        try:
            with self._lock:
                queue = self._queues.get(persona_id)
                if not queue or not queue.pending_messages:
                    return
                pending = list(queue.pending_messages)
                n_pending = len(pending)
                reply_ctx = dict(queue.reply_ctx or {})
                queue.reply_ctx = None

            texts, images, files, has_voice = _extract_from_pending(pending)

            stored_count = 0
            for msg_data in pending:
                try:
                    stored = self._app.conversation_store.add_message(
                        persona_id,
                        msg_data["role"],
                        _sanitize_content_blocks(msg_data["content"]),
                        msg_data["source"],
                        timestamp=msg_data.get("timestamp"),
                        quote=msg_data.get("quote", ""),
                    )
                    self._dispatch_message_stored(persona_id, stored, msg_data)
                    stored_count += 1
                except Exception:
                    logger.exception(
                        "存储用户消息失败 persona=%s (%d/%d)",
                        persona_id, stored_count + 1, n_pending,
                    )
                    break

            with self._lock:
                del queue.pending_messages[:stored_count]
                if stored_count < n_pending and queue.reply_ctx is None:
                    queue.reply_ctx = reply_ctx

            if stored_count == 0:
                return
            broadcast("new_message", persona_id=persona_id)
            if stored_count < n_pending:
                return

            merged_text = "\n".join(texts)
            if not merged_text.strip() and not images and not files and not has_voice:
                return

            broadcast("processing", persona_id=persona_id)
            logger.info("开始处理 persona=%s, %d 条待处理消息", persona_id, len(pending))

            try:
                drafts = self._app.chat_service.process_round(
                    persona_id,
                    images=images,
                    files=files,
                )
            except Exception:
                logger.exception("LLM 调用失败 persona=%s", persona_id)
                drafts = [{
                    "role": "assistant",
                    "content": [{"type": "text", "text": "抱歉，我遇到了一些问题，请稍后再试。"}],
                    "source": "llm",
                }]

            if self._app.emoji_service:
                try:
                    drafts = self._app.emoji_service.compose(persona_id, drafts)
                except Exception:
                    logger.exception("表情包生成失败 persona=%s", persona_id)

            channel = reply_ctx.get("channel", "web")
            compose_event = ReplyComposeEvent(
                channel=channel,
                persona_id=persona_id,
                messages=list(drafts),
                account_id=reply_ctx.get("account_id", ""),
                user_id=reply_ctx.get("user_id", ""),
                reply_ctx=reply_ctx,
            )
            self._app.extension_manager.dispatch_reply_compose(compose_event)

            delivered_messages = self._app.reply_dispatcher.deliver_messages(
                persona_id,
                compose_event.messages,
                reply_ctx=reply_ctx,
            )
            logger.info(
                "处理完成 persona=%s, %d 条用户消息 → %d 条回复",
                persona_id,
                len(pending),
                len(delivered_messages),
            )

            # Round-end consolidation check. Triggered here instead of inside
            # the tool handler so that index-shifting consolidation never races
            # with an in-flight update_memory that references #N from the prompt.
            # The actual merge runs in a background thread.
            # Moments has its own trigger (moments.py).
            if self._app.memory_service:
                try:
                    self._app.memory_service.maybe_consolidate(persona_id)
                except Exception:
                    logger.exception("记忆合并检查失败: persona=%s", persona_id)

            # Round-end automatic summarization check (only effective when the
            # persona's memory.trigger_mode is "summarize"). Runs in a
            # background thread; the cutoff pins the window to this round's
            # last delivered message so messages arriving while the summary
            # LLM call is in flight are not skipped by the cursor.
            # Moments has its own trigger (moments.py).
            if (
                self._app.memory_service
                and delivered_messages
                and self._app.memory_service.should_check_summarize(persona_id)
            ):
                cutoff_timestamp = delivered_messages[-1].get("timestamp", "")
                try:
                    threading.Thread(
                        target=self._check_memory_bg,
                        args=(persona_id, cutoff_timestamp),
                        daemon=True,
                    ).start()
                except Exception:
                    logger.exception("启动后台记忆检查失败: persona=%s", persona_id)
        except Exception:
            logger.exception("处理消息队列失败: persona=%s", persona_id)
        finally:
            with self._lock:
                queue = self._queues.get(persona_id)
                if queue:
                    queue.processing = False

    def _check_memory_bg(self, persona_id: str, cutoff_timestamp: str):
        try:
            self._app.memory_service.check_and_summarize(
                persona_id,
                cutoff_timestamp=cutoff_timestamp,
            )
        except Exception:
            logger.exception("后台记忆检查失败: persona=%s", persona_id)
