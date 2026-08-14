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

"""OpenAI-compatible image generation provider.

Covers both OpenAI official (api.openai.com/v1) and any OpenAI-compatible
proxy serving the /images/generations endpoint.
"""

from __future__ import annotations

import base64
import logging
import os

import requests

from pawzochat.image.base import (
    ImageGenerationError,
    ImageProvider,
    ImageResponse,
    attach_negative_to_prompt,
)

logger = logging.getLogger(__name__)

IMAGE_REQUEST_TIMEOUT_SECONDS = float(
    os.getenv("PAWZOCHAT_IMAGE_TIMEOUT_SECONDS", "180"),
)


class OpenAIImageProvider(ImageProvider):
    provider_type = "openai_image"

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

        if reference_images:
            logger.warning(
                "OpenAI /images/generations 不支持参考图，已忽略 %d 张 (model=%s)",
                len(reference_images), model,
            )

        # OpenAI's image-generation API doesn't accept a negative_prompt field; if the caller gave one, append it to the end of the prompt.
        full_prompt = attach_negative_to_prompt(prompt, negative_prompt)

        body: dict = {
            "model": model,
            "prompt": full_prompt,
            "n": 1,
            "size": f"{width}x{height}",
            "response_format": "b64_json",
        }

        if "quality" in kwargs:
            body["quality"] = kwargs["quality"]
        if "style" in kwargs:
            body["style"] = kwargs["style"]
        if "moderation" in kwargs:
            body["moderation"] = kwargs["moderation"]
        if "background" in kwargs:
            body["background"] = kwargs["background"]

        url = f"{self.base_url}/images/generations"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        logger.info("OpenAI 兼容生图调用: model=%s size=%s", model, body["size"])
        resp = self._post_with_format_fallback(url, headers, body)

        try:
            data = resp.json()
        except Exception:
            raise ImageGenerationError(
                self.provider_type, "返回数据格式无效（非 JSON）",
            ) from None

        items = data.get("data") or []
        if not items:
            raise ImageGenerationError(self.provider_type, f"无图像返回: {data}")

        first = items[0]
        b64 = first.get("b64_json")
        if b64:
            try:
                img_bytes = base64.b64decode(b64)
            except Exception as e:
                raise ImageGenerationError(
                    self.provider_type, f"base64 解码失败: {e}",
                ) from None
            return ImageResponse(image_data=img_bytes, mime_type="image/png")

        url_field = first.get("url")
        if url_field:
            return self._download_url(url_field)

        raise ImageGenerationError(self.provider_type, f"无图像数据: {first}")

    def _post_with_format_fallback(self, url, headers, body):
        """POST, retrying once without `response_format` if upstream 4xx's on that field.

        OpenAI's official gpt-image-* explicitly rejects response_format (it
        defaults to b64_json anyway), but many relays are the opposite — they
        default to returning a URL unless it's omitted. There's no clean way
        to branch on model name alone, so this submits with the field
        included first and retries without it only if the error looks
        response_format-related.
        """
        try:
            resp = requests.post(
                url,
                json=body,
                headers=headers,
                timeout=IMAGE_REQUEST_TIMEOUT_SECONDS,
            )
        except requests.exceptions.Timeout:
            raise ImageGenerationError(self.provider_type, "请求超时") from None
        except requests.exceptions.ConnectionError as e:
            raise ImageGenerationError(self.provider_type, f"连接失败: {e}") from None

        if resp.ok:
            return resp

        text_lower = (resp.text or "").lower()
        if (
            resp.status_code in (400, 422)
            and "response_format" in body
            and "response_format" in text_lower
        ):
            logger.info("上游拒绝 response_format，去掉后重试")
            body2 = {k: v for k, v in body.items() if k != "response_format"}
            try:
                resp2 = requests.post(
                    url,
                    json=body2,
                    headers=headers,
                    timeout=IMAGE_REQUEST_TIMEOUT_SECONDS,
                )
            except requests.exceptions.Timeout:
                raise ImageGenerationError(self.provider_type, "请求超时") from None
            except requests.exceptions.ConnectionError as e:
                raise ImageGenerationError(self.provider_type, f"连接失败: {e}") from None
            if resp2.ok:
                return resp2
            raise ImageGenerationError(
                self.provider_type,
                f"HTTP {resp2.status_code}: {resp2.text[:300]}",
                status_code=resp2.status_code,
            )

        raise ImageGenerationError(
            self.provider_type,
            f"HTTP {resp.status_code}: {resp.text[:300]}",
            status_code=resp.status_code,
        )

    def _download_url(self, image_url: str) -> ImageResponse:
        try:
            r = requests.get(image_url, timeout=60)
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
