# PawzoChat - Human-like, versatile, extensible AI companion engine
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

"""Core emoji composition service and helpers."""

from __future__ import annotations

import logging
import random
import re
from pathlib import Path
from typing import TYPE_CHECKING

from pawzochat.paths import EMOJI_DIR

if TYPE_CHECKING:
    from pawzochat.core.config import ConfigManager
    from pawzochat.llm.manager import LLMManager

logger = logging.getLogger(__name__)

ALLOWED_IMAGE_EXTS = {".png", ".gif", ".jpg", ".jpeg", ".webp"}


class EmojiService:
    """Core service that optionally injects an emoji reply draft."""

    def __init__(self, config: ConfigManager, llm_manager: LLMManager):
        self._config = config
        self._llm_manager = llm_manager

    def compose(self, persona_id: str, messages: list[dict]) -> list[dict]:
        """Return a new reply list with an emoji draft inserted when enabled."""
        if not messages:
            return []

        persona = self._config.load_personas().get(persona_id)
        if not persona:
            return list(messages)

        reply_text = "\n".join(
            "".join(
                block.get("text", "")
                for block in message.get("content", [])
                if block.get("type") == "text"
            )
            for message in messages
        ).strip()
        if not reply_text:
            return list(messages)

        emoji_draft = build_emoji_draft(
            persona_id,
            persona,
            reply_text,
            self._llm_chat,
        )
        if not emoji_draft:
            return list(messages)

        result = list(messages)
        result.insert(random.randint(0, len(result)), emoji_draft)
        return result

    def _llm_chat(
        self,
        provider_name: str,
        model_name: str,
        messages: list[dict],
        *,
        temperature: float,
        max_tokens: int,
    ) -> str:
        provider = self._llm_manager.get_provider(provider_name)
        if not provider:
            raise RuntimeError(f"LLM provider not available: {provider_name}")
        response = provider.chat(
            messages,
            model=model_name or None,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return (response.text or "").strip()


def build_emoji_draft(
    persona_id: str,
    persona,
    reply_text: str,
    llm_chat,
) -> dict | None:
    """Return an assistant message draft containing an emoji block, or ``None``."""
    if not persona or not persona.emoji_enabled or not persona.emoji_group:
        return None

    if random.randint(0, 100) > persona.emoji_send_probability:
        logger.debug(
            "表情包未触发 (概率 %d%%) persona=%s",
            persona.emoji_send_probability, persona_id,
        )
        return None

    group_dir = EMOJI_DIR / persona.emoji_group
    if not group_dir.is_dir():
        logger.warning("表情包分组目录不存在: %s", group_dir)
        return None

    emotions = sorted(
        directory.name
        for directory in group_dir.iterdir()
        if directory.is_dir() and any(
            file.suffix.lower() in ALLOWED_IMAGE_EXTS
            for file in directory.iterdir()
            if file.is_file()
        )
    )
    if not emotions:
        logger.debug("表情包分组无有效情绪分类: %s", persona.emoji_group)
        return None

    emotion = _detect_emotion(persona, reply_text, emotions, llm_chat)
    if not emotion:
        return None

    image_path = _pick_random_image(persona.emoji_group, emotion)
    if not image_path:
        return None

    emoji_url = f"/emoji-static/{persona.emoji_group}/{emotion}/{image_path.name}"
    logger.info(
        "表情包已选择: persona=%s emotion=%s file=%s",
        persona_id, emotion, image_path.name,
    )
    return {
        "role": "assistant",
        "content": [{"type": "emoji", "url": emoji_url, "path": str(image_path)}],
        "source": "emoji",
    }


def _detect_emotion(persona, reply_text: str, emotions: list[str], llm_chat) -> str | None:
    if not persona.llm_provider or not persona.llm_model:
        logger.debug("角色未配置服务商或模型，跳过情绪检测")
        return None

    prompt = (
        f"请判断以下消息表达的情绪，并仅回复一个词语的情绪分类：\n"
        f"{reply_text}\n"
        f"可选的情绪有：{', '.join(emotions)}。"
        f"请直接回复情绪名称，不要包含其他内容，注意大小写。"
        f"若对话未包含明显情绪或上述情绪都不符合，请回复None。"
    )

    try:
        response = llm_chat(
            persona.llm_provider,
            persona.llm_model,
            [{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=2048,
        ).strip()
    except Exception:
        logger.debug("情绪检测 LLM 调用失败", exc_info=True)
        return None

    response = re.sub(r"[^\w\u4e00-\u9fff]", "", response)
    logger.debug("LLM 情绪检测结果: '%s'", response)

    if not response or response.lower() == "none":
        return None

    if response in emotions:
        return response

    for emotion in emotions:
        if emotion in response or response in emotion:
            logger.debug("模糊匹配情绪: '%s' → '%s'", response, emotion)
            return emotion

    logger.debug("未匹配到有效情绪分类, LLM 返回: '%s'", response)
    return None


def _pick_random_image(group: str, emotion: str) -> Path | None:
    emotion_dir = EMOJI_DIR / group / emotion
    if not emotion_dir.is_dir():
        return None
    images = [
        file for file in emotion_dir.iterdir()
        if file.is_file() and file.suffix.lower() in ALLOWED_IMAGE_EXTS
    ]
    return random.choice(images) if images else None
