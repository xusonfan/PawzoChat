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

"""Abstract image generation provider interface and shared data structures."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


def attach_negative_to_prompt(prompt: str, negative_prompt: str) -> str:
    """Append a negative-prompt notice to *prompt*.

    Used by providers whose upstream API has no native ``negative_prompt``
    field (OpenAI ``/images/generations``, Gemini ``generateContent``,
    Gemini-via-chat). Returns *prompt* unchanged when *negative_prompt* is
    empty/whitespace, so an upstream caller's empty-string default also means
    "do not append anything" for these providers.
    """
    neg = (negative_prompt or "").strip()
    if not neg:
        return prompt
    return f"{prompt}\n\nNegative prompt (do not include): {neg}"


@dataclass
class ImageResponse:
    """Structured response from an image provider."""

    image_data: bytes
    mime_type: str = "image/png"
    seed_used: int | None = None
    raw_meta: dict = field(default_factory=dict)


class ImageGenerationError(RuntimeError):
    """Unified image-generation failure carrying provider type and upstream status."""

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


class ImageProvider(ABC):
    """Base class for all image generation service providers."""

    provider_type: str = ""
    supports_reference_images: bool = False

    @abstractmethod
    def generate(
        self,
        prompt: str,
        *,
        model: str,
        negative_prompt: str = "",
        width: int = 1024,
        height: int = 1024,
        seed: int = -1,
        reference_images: list[tuple[bytes, str]] | None = None,
        reference_strength: float = 0.6,
        **kwargs,
    ) -> ImageResponse:
        """Generate an image and return its raw bytes.

        ``reference_images`` is a list of ``(bytes, mime_type)`` for character /
        scene consistency. Support is model-specific for OpenAI-compatible
        providers because reference inputs use ``/images/edits`` rather than
        ``/images/generations``. ``reference_strength`` is currently honored
        only by NovelAI.

        ``**kwargs`` forwards provider-specific tunables (sampler, quality,
        style, aspect_ratio, etc.).  The web "test" endpoint passes only
        ``prompt`` + ``model``; richer call sites will fill more later.
        """
