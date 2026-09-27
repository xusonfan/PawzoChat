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

"""OpenAI-compatible TTS provider.

Covers both OpenAI official (api.openai.com/v1) and any OpenAI-compatible
proxy serving the /v1/audio/speech endpoint (including PaWAPI).

Response format is raw binary audio body (not JSON-wrapped).
"""

from __future__ import annotations

import logging

import requests

from pawzochat.voice.base import VoiceGenerationError, VoiceProvider, VoiceResponse

logger = logging.getLogger(__name__)


class OpenAITTSProvider(VoiceProvider):
    """OpenAI-compatible TTS provider (POST /v1/audio/speech)."""

    provider_type = "openai_tts"

    _ENDPOINT = "/audio/speech"

    _FORMAT_TO_MIME = {
        "mp3": "audio/mpeg",
        "opus": "audio/opus",
        "aac": "audio/aac",
        "flac": "audio/flac",
        "wav": "audio/wav",
        "pcm": "audio/L16;rate=24000",
    }

    def __init__(self, base_url: str, api_key: str, **kwargs):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _metadata(self, voice, speed, kwargs):
        return {}

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

        audio_format = kwargs.get("format", "mp3")

        body: dict = {
            "model": model,
            "input": text,
            "voice": voice or "alloy",
            "speed": max(0.25, min(4.0, speed)),
        }
        # Only send response_format when it's explicitly non-default (mp3).
        # Some proxies (e.g. PaWAPI → MiniMax) incorrectly map this field to
        # MiniMax's top-level output_format, which only accepts "hex"/"url".
        # Omitting response_format for the default falls back to server-default MP3.
        if audio_format != "mp3":
            body["response_format"] = audio_format

        # PawAPI overrides this hook with its MiniMax-specific metadata.
        metadata = self._metadata(body["voice"], body["speed"], kwargs)
        if metadata:
            body["metadata"] = metadata

        url = f"{self.base_url}{self._ENDPOINT}"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        logger.info(
            "OpenAI 兼容 TTS 调用: model=%s voice=%s format=%s text_len=%d",
            model, voice or "alloy", audio_format, len(text),
        )

        try:
            resp = requests.post(url, json=body, headers=headers, timeout=120)
        except requests.exceptions.Timeout:
            raise VoiceGenerationError(self.provider_type, "TTS 请求超时") from None
        except requests.exceptions.ConnectionError as e:
            raise VoiceGenerationError(self.provider_type, f"连接失败: {e}") from None

        if not resp.ok:
            detail = resp.text[:300]
            raise VoiceGenerationError(
                self.provider_type,
                f"HTTP {resp.status_code}: {detail}",
                status_code=resp.status_code,
            )

        if not resp.content or "json" in resp.headers.get("Content-Type", "").lower():
            raise VoiceGenerationError(self.provider_type, "响应中无音频数据，服务商返回了空内容或 JSON")

        mime = self._FORMAT_TO_MIME.get(audio_format, "audio/mpeg")
        return VoiceResponse(
            audio_data=resp.content,
            mime_type=mime,
            format=audio_format,
        )
