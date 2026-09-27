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

"""MiniMax controls over PawAPI's OpenAI-compatible audio endpoint.

The relay merges metadata into its MiniMax request; response_format is omitted
because the relay also maps it to MiniMax's hex/url output_format.
"""
from pawzochat.voice.base import VoiceGenerationError
from pawzochat.voice.providers.openai_tts import OpenAITTSProvider


class PawAPITTSProvider(OpenAITTSProvider):
    control_family = "minimax"

    def _metadata(self, voice, speed, kwargs):
        settings = {
            "voice_id": voice, "speed": max(0.5, min(2.0, speed)),
            "vol": kwargs.get("volume", 1.0), "pitch": kwargs.get("pitch", 0),
        }
        emotion = kwargs.get("emotion")
        if emotion:
            settings["emotion"] = "calm" if emotion == "neutral" else emotion
        metadata = {"voice_setting": settings}
        if kwargs.get("language_boost"):
            metadata["language_boost"] = kwargs["language_boost"]
        return metadata

    def synthesize(self, text, *, model, voice="", speed=1.0, **kwargs):
        if kwargs.get("stream"):
            raise VoiceGenerationError(self.provider_type, "当前不支持流式语音合成")
        return super().synthesize(text, model=model, voice=voice or "male-qn-qingse",
                                  speed=max(0.5, min(2.0, speed)), **kwargs)
