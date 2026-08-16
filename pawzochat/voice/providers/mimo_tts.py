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

"""Xiaomi MiMo TTS (v2.5) native API provider.

MiMo exposes TTS through a chat/completions-shaped endpoint: the user message
carries a natural-language style instruction, the assistant message carries the
text to synthesize, and the base64 audio comes back in
``choices[0].message.audio.data``. Output is WAV only (24kHz PCM16LE mono) —
there is no MP3 option and no speed parameter.
"""

from __future__ import annotations

import base64
import logging
from typing import Any

import requests

from pawzochat.voice.base import VoiceGenerationError, VoiceProvider, VoiceResponse

logger = logging.getLogger(__name__)


class MimoTTSProvider(VoiceProvider):
    """MiMo TTS native API provider (POST /v1/chat/completions)."""

    provider_type = "mimo_tts"

    # base_url should point to the versioned root, e.g. "https://api.xiaomimimo.com/v1"
    _ENDPOINT = "/chat/completions"

    # MiMo has no structured emotion field; the user message IS the style
    # instruction, so the pipeline's detected emotion is rendered as prose.
    _EMOTION_INSTRUCTIONS = {
        "happy": "请用开心愉悦的语气朗读",
        "sad": "请用低落难过的语气朗读",
        "angry": "请用生气愤怒的语气朗读",
        "fearful": "请用害怕不安的语气朗读",
        "disgusted": "请用嫌弃厌恶的语气朗读",
        "surprised": "请用惊讶的语气朗读",
        "neutral": "请用平静自然的语气朗读",
    }
    _DEFAULT_INSTRUCTION = "请用自然的语气朗读"

    def __init__(self, base_url: str, api_key: str, **kwargs):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def synthesize(
        self,
        text: str,
        *,
        model: str,
        voice: str = "",
        speed: float = 1.0,
        **kwargs,
    ) -> VoiceResponse:
        if not model:
            raise VoiceGenerationError(self.provider_type, "未指定模型")

        if not text:
            raise VoiceGenerationError(self.provider_type, "输入文本为空")

        # speed is accepted for interface compatibility but MiMo has no such
        # parameter; the persona's speed setting does not apply here.
        emotion = kwargs.get("emotion", "")
        instruction = self._EMOTION_INSTRUCTIONS.get(emotion, self._DEFAULT_INSTRUCTION)

        body: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "user", "content": instruction},
                {"role": "assistant", "content": text},
            ],
            "audio": {
                "format": "wav",
                "voice": voice or "mimo_default",
            },
        }

        url = f"{self.base_url}{self._ENDPOINT}"
        # MiMo authenticates with an "api-key" header, not "Authorization: Bearer".
        headers = {
            "api-key": self.api_key,
            "Content-Type": "application/json",
        }

        logger.info(
            "MiMo TTS 调用: model=%s voice=%s emotion=%s text_len=%d",
            model, voice or "mimo_default", emotion or "(无)", len(text),
        )

        try:
            resp = requests.post(url, json=body, headers=headers, timeout=120)
        except requests.exceptions.Timeout:
            raise VoiceGenerationError(self.provider_type, "MiMo TTS 请求超时") from None
        except requests.exceptions.ConnectionError as e:
            raise VoiceGenerationError(self.provider_type, f"连接失败: {e}") from None

        if not resp.ok:
            detail = resp.text[:300]
            raise VoiceGenerationError(
                self.provider_type,
                f"HTTP {resp.status_code}: {detail}",
                status_code=resp.status_code,
            )

        try:
            data = resp.json()
        except Exception:
            raise VoiceGenerationError(
                self.provider_type, "返回数据格式无效（非 JSON）",
            ) from None

        try:
            audio_b64 = data["choices"][0]["message"]["audio"]["data"]
        except (KeyError, IndexError, TypeError):
            audio_b64 = ""
        if not audio_b64:
            raise VoiceGenerationError(self.provider_type, "响应中无音频数据")

        try:
            audio_bytes = base64.b64decode(audio_b64)
        except Exception as e:
            raise VoiceGenerationError(
                self.provider_type, f"base64 解码失败: {e}",
            ) from None

        return VoiceResponse(audio_data=audio_bytes, mime_type="audio/wav", format="wav")
