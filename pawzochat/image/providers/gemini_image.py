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

"""Google Gemini / NanoBanana image generation provider.

Uses the multimodal :generateContent endpoint with responseModalities=[IMAGE].
This is the path Google exposes for nano-banana (gemini-2.5-flash-image) and
nano-banana pro.  We deliberately avoid the google-genai SDK because its
support for ``responseModalities`` and ``imageConfig`` lags behind the API.
"""

from __future__ import annotations

import base64
import logging
from math import gcd

import requests

from pawzochat.image.base import (
    ImageGenerationError,
    ImageProvider,
    ImageResponse,
    attach_negative_to_prompt,
)

logger = logging.getLogger(__name__)

# Map a width/height pair to one of the aspect ratios accepted by imageConfig.
# Anything outside the supported set falls back to "1:1".
_SUPPORTED_RATIOS: dict[tuple[int, int], str] = {
    (1, 1): "1:1",
    (3, 4): "3:4",
    (4, 3): "4:3",
    (9, 16): "9:16",
    (16, 9): "16:9",
}

_SAFETY_CATEGORIES = (
    "HARM_CATEGORY_HARASSMENT",
    "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_DANGEROUS_CONTENT",
)


def _aspect_from_wh(w: int, h: int) -> str:
    if w <= 0 or h <= 0:
        return "1:1"
    g = gcd(w, h) or 1
    return _SUPPORTED_RATIOS.get((w // g, h // g), "1:1")


class GeminiImageProvider(ImageProvider):
    provider_type = "gemini_image"
    supports_reference_images = True

    def __init__(self, base_url: str, api_key: str, **kwargs):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

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
        if not model:
            raise ImageGenerationError(self.provider_type, "未指定模型")

        # Gemini has no native negative_prompt field; express it by appending natural-language text instead.
        full_prompt = attach_negative_to_prompt(prompt, negative_prompt)

        aspect_ratio = kwargs.get("aspect_ratio") or _aspect_from_wh(width, height)
        safety_threshold = kwargs.get("safety_setting", "BLOCK_ONLY_HIGH")

        parts: list[dict] = [{"text": full_prompt}]
        for img_bytes, mime in (reference_images or []):
            parts.append({
                "inlineData": {
                    "mimeType": mime or "image/png",
                    "data": base64.b64encode(img_bytes).decode("ascii"),
                },
            })

        body: dict = {
            "contents": [
                {"role": "user", "parts": parts},
            ],
            "generationConfig": {
                "responseModalities": ["IMAGE"],
                "imageConfig": {"aspectRatio": aspect_ratio},
            },
            "safetySettings": [
                {"category": cat, "threshold": safety_threshold}
                for cat in _SAFETY_CATEGORIES
            ],
        }

        url = f"{self.base_url}/models/{model}:generateContent"
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": self.api_key,
        }

        logger.info(
            "Gemini 生图调用: model=%s aspect=%s ref_count=%d",
            model, aspect_ratio, len(reference_images or []),
        )
        try:
            resp = requests.post(url, json=body, headers=headers, timeout=180)
        except requests.exceptions.Timeout:
            raise ImageGenerationError(self.provider_type, "请求超时") from None
        except requests.exceptions.ConnectionError as e:
            raise ImageGenerationError(self.provider_type, f"连接失败: {e}") from None

        if not resp.ok:
            raise ImageGenerationError(
                self.provider_type,
                f"HTTP {resp.status_code}: {resp.text[:300]}",
                status_code=resp.status_code,
            )

        try:
            data = resp.json()
        except Exception:
            raise ImageGenerationError(
                self.provider_type, "返回数据格式无效（非 JSON）"
            ) from None

        candidates = data.get("candidates") or []
        if not candidates:
            err = (data.get("promptFeedback") or {}).get("blockReason") or "no candidates"
            raise ImageGenerationError(self.provider_type, f"无候选返回: {err}")

        cand0 = candidates[0]
        parts = (cand0.get("content") or {}).get("parts") or []
        for part in parts:
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and inline.get("data"):
                mime = (
                    inline.get("mimeType")
                    or inline.get("mime_type")
                    or "image/png"
                )
                try:
                    img_bytes = base64.b64decode(inline["data"])
                except Exception as e:
                    raise ImageGenerationError(
                        self.provider_type, f"base64 解码失败: {e}"
                    ) from None
                return ImageResponse(image_data=img_bytes, mime_type=mime)

        finish = cand0.get("finishReason", "unknown")
        raise ImageGenerationError(
            self.provider_type,
            f"响应中无图像数据 (finishReason={finish})",
        )
