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

"""MiniMax T2A (Text-to-Audio) native API provider.

Uses the MiniMax proprietary endpoint /v1/t2a_v2 with hex-encoded audio
response, supporting rich voice settings (emotion, pitch, speed) and
multiple audio output formats.
"""

from __future__ import annotations

import logging
from typing import Any

import requests

from pawzochat.voice.base import VoiceGenerationError, VoiceProvider, VoiceResponse

logger = logging.getLogger(__name__)


class MiniMaxTTSProvider(VoiceProvider):
    """MiniMax T2A native API provider (non-OpenAI format)."""

    provider_type = "minimaxi_tts"
    control_family = "minimax"

    # MiniMax T2A uses /v1/t2a_v2; base_url should point to the root,
    # e.g. "https://api.minimaxi.com"
    _ENDPOINT = "/v1/t2a_v2"

    # Map from format string (as sent in audio_setting.format) to MIME type
    _FORMAT_TO_MIME = {
        "mp3": "audio/mpeg",
        "pcm": "audio/L16;rate=24000",
        "wav": "audio/wav",
        "flac": "audio/flac",
        "opus": "audio/opus",
        "pcmu_raw": "audio/basic",
        "pcmu_wav": "audio/wav",
    }

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

        if kwargs.get("stream"):
            raise VoiceGenerationError(self.provider_type, "当前不支持流式语音合成")
        audio_format = kwargs.get("format", "mp3")

        body: dict[str, Any] = {
            "model": model,
            "text": text,
            "voice_setting": {
                "voice_id": voice or "male-qn-qingse",
                "speed": max(0.5, min(2.0, speed)),
                "vol": kwargs.get("volume", 1.0),
                "pitch": kwargs.get("pitch", 0),
            },
            "audio_setting": {
                "sample_rate": kwargs.get("sample_rate", 32000),
                "bitrate": kwargs.get("bitrate", 128000),
                "format": audio_format,
                "channel": 1,
            },
        }

        # emotion is only sent when explicitly specified: when MiniMax doesn't
        # receive this field it falls back to the voice's default emotion;
        # forcing a fixed emotion would throw off the tone in scenarios like
        # comforting or saying goodnight.
        emotion = kwargs.get("emotion")
        if emotion:
            body["voice_setting"]["emotion"] = "calm" if emotion == "neutral" else emotion

        if kwargs.get("language_boost"):
            body["language_boost"] = kwargs["language_boost"]

        url = f"{self.base_url}{self._ENDPOINT}"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        logger.info(
            "MiniMax TTS 调用: model=%s voice=%s format=%s text_len=%d",
            model, voice or "(默认)", audio_format, len(text),
        )

        try:
            resp = requests.post(url, json=body, headers=headers, timeout=60)
        except requests.exceptions.Timeout:
            raise VoiceGenerationError(self.provider_type, "MiniMax TTS 请求超时") from None
        except requests.exceptions.ConnectionError as e:
            raise VoiceGenerationError(self.provider_type, f"连接失败: {e}") from None

        if not resp.ok:
            detail = resp.text[:300]
            raise VoiceGenerationError(
                self.provider_type,
                f"HTTP {resp.status_code}: {detail}",
                status_code=resp.status_code,
            )

        # MiniMax returns JSON with hex-encoded audio in data.audio
        try:
            data = resp.json()
        except Exception:
            raise VoiceGenerationError(
                self.provider_type, "返回数据格式无效（非 JSON）",
            ) from None

        base_resp = data.get("base_resp", {})
        if base_resp.get("status_code", 0) != 0:
            raise VoiceGenerationError(
                self.provider_type,
                f"API 错误 {base_resp.get('status_code')}: {base_resp.get('status_msg', '未知')}",
                status_code=base_resp.get("status_code"),
            )

        audio_hex = data.get("data", {}).get("audio", "")
        if not audio_hex:
            raise VoiceGenerationError(self.provider_type, "响应中无音频数据")

        try:
            audio_bytes = bytes.fromhex(audio_hex)
        except Exception as e:
            raise VoiceGenerationError(
                self.provider_type, f"hex 解码失败: {e}",
            ) from None

        mime = self._FORMAT_TO_MIME.get(audio_format, "audio/mpeg")
        return VoiceResponse(audio_data=audio_bytes, mime_type=mime, format=audio_format)
