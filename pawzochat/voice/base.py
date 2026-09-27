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

"""Abstract TTS (Text-to-Speech) provider interface and shared data structures."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class VoiceResponse:
    """Structured response from a TTS provider."""

    audio_data: bytes
    mime_type: str = "audio/mpeg"
    format: str = "mp3"


class VoiceGenerationError(RuntimeError):
    """Unified TTS failure carrying provider type and upstream status."""

    def __init__(
        self,
        provider_type: str,
        message: str,
        *,
        status_code: int | None = None,
    ):
        super().__init__(message)
        self.provider_type = provider_type
        self.status_code = status_code


class VoiceProvider(ABC):
    """Base class for all TTS (Text-to-Speech) service providers."""

    provider_type: str = ""
    control_family: str = "openai"

    @abstractmethod
    def synthesize(
        self,
        text: str,
        *,
        model: str,
        voice: str = "",
        speed: float = 1.0,
        **kwargs,
    ) -> VoiceResponse:
        """Synthesize speech from text.

        Args:
            text: The text to convert to speech.
            model: Model identifier (e.g. "tts-1", "speech-02-hd").
            voice: Voice / timbre identifier. Each provider has its own set.
            speed: Speaking speed. Provider-specific range (OpenAI: 0.25-4.0,
                   MiniMax: 0.5-2.0).

        ``**kwargs`` forwards provider-specific tunables (format, sample_rate,
        emotion, etc.). Chat and preview both resolve persona settings through
        ``synthesize_with_settings`` before calling this interface.
        """
