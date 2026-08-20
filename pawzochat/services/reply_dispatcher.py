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

"""Final reply persistence, broadcasting, hook dispatch, and channel delivery."""

from __future__ import annotations

import logging
import queue
import threading
from collections.abc import Callable
from typing import TYPE_CHECKING

from pawzochat.core.extensions.hooks import ReplyPreSendEvent, ReplySentEvent
from pawzochat.services.image_cache import (
    cache_external_image,
    cache_external_images,
    prepare_external_images,
)
from pawzochat.utils.message_text import clean_assistant_reply_text
from pawzochat.web.sse import broadcast

if TYPE_CHECKING:
    from pawzochat.app import App

logger = logging.getLogger(__name__)


class ReplyDispatcher:
    """Dispatch assistant message drafts to storage, UI, and external channels."""

    def __init__(self, app: App):
        self._app = app
        self._image_cache_queue: queue.Queue[tuple[str, str, str]] = queue.Queue()
        threading.Thread(
            target=self._image_cache_worker,
            name="external-image-cache",
            daemon=True,
        ).start()

    def deliver_messages(
        self,
        persona_id: str,
        messages: list[dict],
        reply_ctx: dict | None = None,
        before_first_message: Callable[[], bool] | None = None,
    ) -> list[dict]:
        delivered_messages: list[dict] = []
        channel = (reply_ctx or {}).get("channel", "web")
        account_id = (reply_ctx or {}).get("account_id", "")
        user_id = (reply_ctx or {}).get("user_id", "")
        reply_started = False
        superseded = False

        for index, draft in enumerate(messages):
            is_first = index == 0
            is_last = index == len(messages) - 1
            message = self._normalize_message(draft)

            pre_send = ReplyPreSendEvent(
                channel=channel,
                persona_id=persona_id,
                message=message,
                is_last=is_last,
                account_id=account_id,
                user_id=user_id,
                reply_ctx=reply_ctx,
            )
            self._app.extension_manager.dispatch_reply_pre_send(pre_send)
            if pre_send.cancelled:
                continue

            message = self._normalize_message(pre_send.message)
            cache_jobs: list[tuple[str, str]] = []
            if channel == "web":
                message["content"], cache_jobs = prepare_external_images(
                    persona_id,
                    message.get("content", []),
                )
            else:
                message["content"] = cache_external_images(
                    persona_id,
                    message.get("content", []),
                )
            if not reply_started:
                if before_first_message is not None and not before_first_message():
                    superseded = True
                    break
                reply_started = True
            stored = self._app.conversation_store.add_message(
                persona_id,
                message.get("role", "assistant"),
                message.get("content", []),
                message.get("source", "llm"),
            )

            channel_impl = self._app.channel_registry.get(channel, default=None)
            if channel_impl is None:
                # A named-but-unregistered external channel (e.g. a plugin
                # channel disabled/reloaded between intake and delivery). Don't
                # silently fall back to web (which would report phantom success);
                # persist + broadcast below, but record a non-delivery so
                # ProactiveService increments fail_streak / applies cooldown.
                logger.warning(
                    "通道 %s 未注册，消息仅本地保存未投递 persona=%s",
                    channel, persona_id,
                )
                delivered = False
            else:
                delivered = channel_impl.deliver_message(
                    persona_id,
                    stored,
                    pre_send.reply_ctx,
                    is_first=is_first,
                    is_last=is_last,
                )

            broadcast(
                "assistant_message",
                persona_id=persona_id,
                message=stored,
                is_last=is_last,
                unread_count=self._app.conversation_store.unread_count(persona_id),
            )
            if cache_jobs:
                for task_id, url in cache_jobs:
                    self._image_cache_queue.put((persona_id, task_id, url))
            if self._app.web_push_service:
                self._app.web_push_service.send_assistant_message(
                    persona_id=persona_id,
                    persona_name=self._app.config.get(
                        "personas", persona_id, "name", default="PawzoChat",
                    ),
                    message=stored,
                )
            # Only count as delivered when the channel actually accepted
            # it — lets callers (e.g. ProactiveService) detect wechat send
            # failures even though the message was persisted.
            if delivered:
                delivered_messages.append(stored)

            self._app.extension_manager.dispatch_reply_sent(
                ReplySentEvent(
                    channel=channel,
                    persona_id=persona_id,
                    message=stored,
                    delivered=delivered,
                    is_last=is_last,
                    account_id=account_id,
                    user_id=user_id,
                    reply_ctx=pre_send.reply_ctx,
                ),
            )

        if not superseded:
            broadcast("conversation_updated", persona_id=persona_id)
        return delivered_messages

    def _image_cache_worker(self) -> None:
        while True:
            persona_id, task_id, url = self._image_cache_queue.get()
            try:
                replacement = cache_external_image(persona_id, url)
                if replacement is None:
                    continue
                updated = self._app.conversation_store.replace_pending_image(
                    persona_id,
                    task_id,
                    replacement,
                )
                if updated is not None:
                    broadcast(
                        "assistant_message_updated",
                        persona_id=persona_id,
                        message=updated,
                    )
            except Exception:
                logger.exception(
                    "后台缓存外链图片失败 persona=%s url=%s",
                    persona_id,
                    url,
                )
            finally:
                self._image_cache_queue.task_done()

    @staticmethod
    def _normalize_message(message: dict) -> dict:
        content = list(message.get("content", []) or [])
        for block in content:
            if block.get("type") == "text" and block.get("text"):
                block["text"] = clean_assistant_reply_text(block["text"])
        return {
            "role": message.get("role", "assistant"),
            "content": content,
            "source": message.get("source", "llm"),
        }
