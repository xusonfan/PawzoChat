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

Text-only requests use ``/images/generations``. GPT Image models with one or
more reference images use the multipart ``/images/edits`` endpoint.
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

OPENAI_REFERENCE_IMAGE_MODELS = frozenset({
    "gpt-image-2",
    "gpt-image-2-2026-04-21",
    "gpt-image-1.5",
    "gpt-image-1",
    "gpt-image-1-mini",
    "chatgpt-image-latest",
})
OPENAI_MAX_REFERENCE_IMAGES = 16
_IMAGE_FILE_EXTENSIONS = {
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}


def openai_model_supports_reference_images(model: str) -> bool:
    """Return whether a known OpenAI image model supports ``/images/edits``."""
    return (model or "").strip().lower() in OPENAI_REFERENCE_IMAGE_MODELS


def _reference_image_file(index: int, image_data: bytes, mime_type: str) -> tuple:
    mime = (mime_type or "image/png").split(";", 1)[0].strip().lower()
    extension = _IMAGE_FILE_EXTENSIONS.get(mime, "png")
    return (f"reference-{index}.{extension}", image_data, mime)


class OpenAIImageProvider(ImageProvider):
    provider_type = "openai_image"

    def __init__(self, base_url: str, api_key: str, **kwargs):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        declared = kwargs.get("supports_reference_images")
        self._reference_image_capability = (
            declared if isinstance(declared, bool) else None
        )

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

        references = list(reference_images or [])
        supports_reference_images = self._reference_image_capability
        if supports_reference_images is None:
            supports_reference_images = openai_model_supports_reference_images(model)
        if references and not supports_reference_images:
            logger.warning(
                "OpenAI 模型未声明支持参考图，已忽略 %d 张 (model=%s)",
                len(references), model,
            )
            references = []
        if len(references) > OPENAI_MAX_REFERENCE_IMAGES:
            raise ImageGenerationError(
                self.provider_type,
                f"参考图不能超过 {OPENAI_MAX_REFERENCE_IMAGES} 张",
            )

        # OpenAI's image API has no negative_prompt field.
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

        headers = {"Authorization": f"Bearer {self.api_key}"}
        if references:
            url = f"{self.base_url}/images/edits"
            files = [
                ("image[]", _reference_image_file(index, image_data, mime_type))
                for index, (image_data, mime_type) in enumerate(references, start=1)
            ]
            logger.info(
                "OpenAI 兼容参考图生图调用: model=%s size=%s ref_count=%d",
                model, body["size"], len(references),
            )
            resp = self._post_with_format_fallback(
                url,
                headers,
                body,
                files=files,
            )
        else:
            url = f"{self.base_url}/images/generations"
            headers["Content-Type"] = "application/json"
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

    def _post_with_format_fallback(self, url, headers, body, *, files=None):
        """POST once, retrying without ``response_format`` when rejected."""
        resp = self._post(url, headers, body, files=files)
        if resp.ok:
            return resp

        text_lower = (resp.text or "").lower()
        if (
            resp.status_code in (400, 422)
            and "response_format" in body
            and "response_format" in text_lower
        ):
            logger.info("上游拒绝 response_format，去掉后重试")
            body_without_format = {
                key: value
                for key, value in body.items()
                if key != "response_format"
            }
            retry = self._post(
                url,
                headers,
                body_without_format,
                files=files,
            )
            if retry.ok:
                return retry
            raise ImageGenerationError(
                self.provider_type,
                f"HTTP {retry.status_code}: {retry.text[:300]}",
                status_code=retry.status_code,
            )

        raise ImageGenerationError(
            self.provider_type,
            f"HTTP {resp.status_code}: {resp.text[:300]}",
            status_code=resp.status_code,
        )

    def _post(self, url, headers, body, *, files=None):
        try:
            if files:
                return requests.post(
                    url,
                    data=body,
                    files=files,
                    headers=headers,
                    timeout=IMAGE_REQUEST_TIMEOUT_SECONDS,
                )
            return requests.post(
                url,
                json=body,
                headers=headers,
                timeout=IMAGE_REQUEST_TIMEOUT_SECONDS,
            )
        except requests.exceptions.Timeout:
            raise ImageGenerationError(self.provider_type, "请求超时") from None
        except requests.exceptions.ConnectionError as exc:
            raise ImageGenerationError(
                self.provider_type,
                f"连接失败: {exc}",
            ) from None

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
