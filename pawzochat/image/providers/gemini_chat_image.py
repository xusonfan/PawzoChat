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

"""Gemini-via-OpenAI-chat image generation provider.

Many OpenAI-compatible relays don't proxy Google's native
``:generateContent`` endpoint. They instead expose NanoBanana through the
standard ``/v1/chat/completions`` route — input as a chat message, output as
either an inline base64 image part, an image_url part, or a markdown image
embedded in text content.

This provider POSTs to ``{base_url}/chat/completions`` and tolerates all the
common response shapes:

1. ``choices[0].message.images[*].image_url.url``  (OpenRouter / some relays)
2. an ``{type:"image_url", image_url:{url:...}}`` entry inside the
   ``choices[0].message.content`` array
3. a ``choices[0].message.content`` string containing
   ``data:image/...;base64,...`` or a markdown image link
"""

from __future__ import annotations

import base64
import logging
import re

import requests

from pawzochat.image.base import (
    ImageGenerationError,
    ImageProvider,
    ImageResponse,
    attach_negative_to_prompt,
)

logger = logging.getLogger(__name__)

_DATA_URL_RE = re.compile(
    r"data:(image/[a-zA-Z0-9.+-]+)(?:;[^;,]+)*;base64,([A-Za-z0-9+/=\s]+)",
    re.IGNORECASE,
)
_MD_IMAGE_RE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)")


class GeminiChatImageProvider(ImageProvider):
    provider_type = "gemini_chat_image"
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

        # The chat-completions relay path doesn't surface a negative_prompt field
        # either; fold it into the user prompt with the shared notice format.
        full_prompt = attach_negative_to_prompt(prompt, negative_prompt)

        if reference_images:
            content: list[dict] = [{"type": "text", "text": full_prompt}]
            for img_bytes, mime in reference_images:
                m = mime or "image/png"
                b64 = base64.b64encode(img_bytes).decode("ascii")
                content.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{m};base64,{b64}"},
                })
            message_content: str | list[dict] = content
        else:
            message_content = full_prompt

        body: dict = {
            "model": model,
            "messages": [{"role": "user", "content": message_content}],
            "max_tokens": 4096,
            "modalities": ["text", "image"],
        }

        url = f"{self.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        logger.info(
            "Gemini 聊天接口生图调用: model=%s ref_count=%d",
            model, len(reference_images or []),
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
                self.provider_type, "返回数据格式无效（非 JSON）",
            ) from None

        choices = data.get("choices") or []
        if not choices:
            raise ImageGenerationError(self.provider_type, f"无返回: {data}")

        message = (choices[0] or {}).get("message") or {}

        img = self._extract_from_images_field(message)
        if img is not None:
            return img

        img = self._extract_from_content(message.get("content"))
        if img is not None:
            return img

        raise ImageGenerationError(
            self.provider_type,
            f"未在响应中找到图像数据: {str(message)[:300]}",
        )

    def _extract_from_images_field(self, message: dict) -> ImageResponse | None:
        images = message.get("images")
        if not isinstance(images, list) or not images:
            return None
        for entry in images:
            if not isinstance(entry, dict):
                continue
            url_obj = entry.get("image_url")
            if isinstance(url_obj, dict):
                u = url_obj.get("url")
            elif isinstance(url_obj, str):
                u = url_obj
            else:
                u = entry.get("url")
            if isinstance(u, str) and u:
                return self._fetch_image_url(u)
        return None

    def _extract_from_content(self, content) -> ImageResponse | None:
        if isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    continue
                ptype = part.get("type") or ""
                if ptype in ("image_url", "image"):
                    u = part.get("image_url")
                    if isinstance(u, dict):
                        u = u.get("url")
                    if isinstance(u, str) and u:
                        return self._fetch_image_url(u)
                if ptype == "input_image" and isinstance(part.get("image"), dict):
                    inline = part["image"]
                    b64 = inline.get("data") or inline.get("b64_json")
                    mime = inline.get("mime_type") or "image/png"
                    if b64:
                        return self._decode_b64(b64, mime)
            return None

        if isinstance(content, str):
            m = _DATA_URL_RE.search(content)
            if m:
                return self._decode_b64(m.group(2), m.group(1))
            md = _MD_IMAGE_RE.search(content)
            if md:
                u = md.group(1).strip()
                if u.startswith("data:"):
                    m2 = _DATA_URL_RE.search(u)
                    if m2:
                        return self._decode_b64(m2.group(2), m2.group(1))
                if u.startswith("http://") or u.startswith("https://"):
                    return self._fetch_image_url(u)
        return None

    def _fetch_image_url(self, u: str) -> ImageResponse:
        if u.startswith("data:"):
            m = _DATA_URL_RE.search(u)
            if not m:
                raise ImageGenerationError(self.provider_type, "data URL 格式异常")
            return self._decode_b64(m.group(2), m.group(1))

        try:
            r = requests.get(u, timeout=60)
        except requests.exceptions.Timeout:
            raise ImageGenerationError(self.provider_type, "下载图片超时") from None
        except requests.exceptions.ConnectionError as e:
            raise ImageGenerationError(
                self.provider_type, f"下载图片连接失败: {e}",
            ) from None

        if not r.ok:
            raise ImageGenerationError(
                self.provider_type,
                f"下载图片 HTTP {r.status_code}",
                status_code=r.status_code,
            )
        mime = r.headers.get("Content-Type", "image/png").split(";")[0].strip()
        if not mime.startswith("image/"):
            mime = "image/png"
        return ImageResponse(image_data=r.content, mime_type=mime)

    def _decode_b64(self, b64: str, mime: str) -> ImageResponse:
        try:
            img_bytes = base64.b64decode(b64)
        except Exception as e:
            raise ImageGenerationError(
                self.provider_type, f"base64 解码失败: {e}",
            ) from None
        if not mime or not mime.startswith("image/"):
            mime = "image/png"
        return ImageResponse(image_data=img_bytes, mime_type=mime)
