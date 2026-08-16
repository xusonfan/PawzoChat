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

"""NovelAI image generation provider.

Calls https://image.novelai.net/ai/generate-image which returns a ZIP archive
containing a single PNG.  Request body shape follows the v4 API spec.
"""

from __future__ import annotations

import base64
import io
import logging
import random
import zipfile

import requests

from pawzochat.image.base import ImageGenerationError, ImageProvider, ImageResponse

logger = logging.getLogger(__name__)


# Normal/free-safe NovelAI resolutions for V2+ / V3 / V4 families. NovelAI can
# support larger paid sizes, but chat tool calls stay on these stable presets to
# avoid accidental high-cost or flaky generations from arbitrary LLM dimensions.
_NAI_NORMAL_PRESETS: tuple[tuple[int, int], ...] = (
    (1024, 1024),
    (1216, 832),
    (832, 1216),
)


def is_novelai_v4_model(model: str) -> bool:
    """v4/v4.5 models don't support v3's Vibe Transfer fields
    (reference_image_multiple, etc.) — passing them gets rejected upstream
    with HTTP 500. ``nai-diffusion-3`` / ``-furry-3`` still use the v3 protocol.
    """
    return model.startswith("nai-diffusion-4")


def _snap_to_nai_normal_size(width: int, height: int) -> tuple[int, int]:
    """Pick the closest normal/free-safe NovelAI preset by aspect ratio."""
    target_ratio = width / height if height > 0 else 1.0
    best = min(
        _NAI_NORMAL_PRESETS,
        key=lambda p: abs((p[0] / p[1]) - target_ratio),
    )
    if (best[0], best[1]) != (width, height):
        logger.warning(
            "NovelAI 尺寸 %dx%d 非普通安全预设，已吸附为 %dx%d",
            width, height, best[0], best[1],
        )
    return best


class NovelAIImageProvider(ImageProvider):
    provider_type = "novelai_image"
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

        width, height = _snap_to_nai_normal_size(int(width), int(height))

        if seed < 0:
            seed = random.randint(0, 9_999_999_999)

        is_v4 = is_novelai_v4_model(model)
        raw_ref_count = len(reference_images or [])

        # v4/v4.5 no longer support v3's Vibe Transfer (reference_image_multiple,
        # etc.) — passing them triggers HTTP 500. Just drop the reference images here and leave an INFO note for the user.
        if is_v4 and raw_ref_count > 0:
            logger.info(
                "NovelAI v4/v4.5 不支持 v3 风格的参考图（model=%s），已忽略 %d 张参考图",
                model, raw_ref_count,
            )
            effective_refs: list[tuple[bytes, str]] = []
        else:
            effective_refs = list(reference_images or [])

        ref_b64 = [base64.b64encode(b).decode("ascii") for (b, _mime) in effective_refs]
        ref_total_bytes = sum(len(b) for (b, _) in effective_refs)

        params = {
            "params_version": 3,
            "prefer_brownian": True,
            "negative_prompt": negative_prompt,
            "width": int(width),
            "height": int(height),
            "scale": kwargs.get("scale", 5),
            "seed": int(seed),
            "sampler": kwargs.get("sampler", "k_euler_ancestral"),
            "noise_schedule": kwargs.get("scheduler", "karras"),
            "steps": kwargs.get("steps", 28),
            "n_samples": 1,
            "ucPreset": 0,
            "qualityToggle": False,
            "add_original_image": False,
            "controlnet_strength": 1,
            "deliberate_euler_ancestral_bug": False,
            "dynamic_thresholding": kwargs.get("decrisper", False),
            "legacy": False,
            "legacy_v3_extend": False,
            "sm": kwargs.get("sm", False),
            "sm_dyn": kwargs.get("sm_dyn", False),
            "uncond_scale": 1,
            "skip_cfg_above_sigma": None,
            "use_coords": False,
            "characterPrompts": [],
            "v4_negative_prompt": {
                "caption": {
                    "base_caption": negative_prompt,
                    "char_captions": [],
                },
            },
            "v4_prompt": {
                "caption": {
                    "base_caption": prompt,
                    "char_captions": [],
                },
                "use_coords": False,
                "use_order": True,
            },
        }

        # v3 fields are only meaningful for v3-series models; don't stuff them into the body for v4, or it's a 500.
        if not is_v4:
            params["reference_image_multiple"] = ref_b64
            params["reference_information_extracted_multiple"] = [1.0] * len(ref_b64)
            params["reference_strength_multiple"] = [float(reference_strength)] * len(ref_b64)

        body = {
            "action": "generate",
            "input": prompt,
            "model": model,
            "parameters": params,
        }

        url = f"{self.base_url}/ai/generate-image"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        logger.info(
            "NovelAI 生图调用: model=%s size=%dx%d seed=%d "
            "prompt_len=%d neg_len=%d ref_count=%d ref_bytes=%d v4=%s",
            model, width, height, seed,
            len(prompt), len(negative_prompt), len(ref_b64), ref_total_bytes, is_v4,
        )
        logger.debug(
            "NovelAI 请求 body 关键字段: prompt[:200]=%r negative[:200]=%r "
            "params_keys=%s",
            prompt[:200], negative_prompt[:200], sorted(params.keys()),
        )

        try:
            resp = requests.post(url, json=body, headers=headers, timeout=180)
        except requests.exceptions.Timeout:
            raise ImageGenerationError(self.provider_type, "请求超时") from None
        except requests.exceptions.ConnectionError as e:
            raise ImageGenerationError(self.provider_type, f"连接失败: {e}") from None

        if not resp.ok:
            logger.error(
                "NovelAI 调用失败 status=%d body[:500]=%r "
                "(model=%s size=%dx%d prompt_len=%d neg_len=%d ref_count=%d v4=%s)",
                resp.status_code, resp.text[:500],
                model, width, height, len(prompt), len(negative_prompt),
                len(ref_b64), is_v4,
            )
            raise ImageGenerationError(
                self.provider_type,
                f"HTTP {resp.status_code}: {resp.text[:300]}",
                status_code=resp.status_code,
            )

        try:
            with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
                png_name = next(
                    (n for n in zf.namelist() if n.lower().endswith(".png")),
                    None,
                )
                if not png_name:
                    raise ImageGenerationError(
                        self.provider_type, "ZIP 响应中未找到 PNG 文件",
                    )
                png_bytes = zf.read(png_name)
        except zipfile.BadZipFile:
            raise ImageGenerationError(
                self.provider_type, "响应不是有效的 ZIP（可能上游返回了错误页）",
            ) from None

        return ImageResponse(
            image_data=png_bytes, mime_type="image/png", seed_used=seed,
        )
