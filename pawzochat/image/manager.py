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

"""Image provider registry, factory, and preset definitions.

Routing model: ``type`` is per-model, not per-provider. A single relay can
host both ``gpt-image-2`` (OpenAI image API) and a Gemini chat-mode model;
each model entry carries its own ``type`` and is dispatched independently
when ``ImageManager.get_provider_for_model`` is called. If an entry omits
``type``, it falls back to the preset's ``default_model_type``.
"""

from __future__ import annotations

import logging

from pawzochat.image.base import ImageProvider
from pawzochat.image.providers.gemini_chat_image import GeminiChatImageProvider
from pawzochat.image.providers.gemini_image import GeminiImageProvider
from pawzochat.image.providers.novelai_image import NovelAIImageProvider
from pawzochat.image.providers.openai_image import (
    OpenAIImageProvider,
    openai_model_supports_reference_images,
)

logger = logging.getLogger(__name__)

IMAGE_PROVIDER_PRESETS: dict[str, dict] = {
    "pawapi": {
        "name": "PawAPI (推荐)",
        "default_name": "PawAPI",
        "base_url": "https://paw.v1chat.cc/v1",
        "default_model_type": "openai_image",
        "endpoint_path": "/images/generations",
    },
    "openai": {
        "name": "OpenAI",
        "default_name": "OpenAI Image",
        "base_url": "https://api.openai.com/v1",
        "default_model_type": "openai_image",
        "endpoint_path": "/images/generations",
    },
    "google": {
        "name": "Google NanoBanana",
        "default_name": "NanoBanana",
        "base_url": "https://generativelanguage.googleapis.com/v1beta",
        "default_model_type": "gemini_image",
        "endpoint_path": "/models/{model}:generateContent",
    },
    "novelai": {
        "name": "NovelAI",
        "default_name": "NovelAI",
        "base_url": "https://image.novelai.net",
        "default_model_type": "novelai_image",
        "endpoint_path": "/ai/generate-image",
    },
}

IMAGE_PRESET_MODELS: dict[str, list[dict]] = {
    "pawapi": [
        {
            "id": "gpt-image-2",
            "name": "GPT Image 2",
            "type": "openai_image",
            "supports_reference_images": True,
        },
        {"id": "gemini-3.1-flash-image-preview", "name": "Nano Banana 2", "type": "gemini_chat_image"},
        {"id": "gemini-2.5-flash-image-preview", "name": "Nano Banana", "type": "gemini_chat_image"},
        {"id": "gemini-3-pro-image-preview", "name": "Nano Banana Pro", "type": "gemini_chat_image"},
    ],
    "openai": [
        {"id": "gpt-image-2", "name": "GPT Image 2", "type": "openai_image", "supports_reference_images": True},
        {"id": "gpt-image-1.5", "name": "GPT Image 1.5", "type": "openai_image", "supports_reference_images": True},
        {"id": "gpt-image-1", "name": "GPT Image 1", "type": "openai_image", "supports_reference_images": True},
        {"id": "gpt-image-1-mini", "name": "GPT Image 1 Mini", "type": "openai_image", "supports_reference_images": True},
        {"id": "dall-e-3", "name": "DALL·E 3", "type": "openai_image", "supports_reference_images": False},
        {"id": "dall-e-2", "name": "DALL·E 2", "type": "openai_image", "supports_reference_images": False},
    ],
    "google": [
        {"id": "gemini-3.1-flash-image-preview", "name": "Nano Banana 2", "type": "gemini_image"},
        {"id": "gemini-3-pro-image-preview", "name": "Nano Banana Pro", "type": "gemini_image"},
        {"id": "gemini-2.5-flash-image", "name": "NanoBanana", "type": "gemini_image"},
    ],
    "novelai": [
        {"id": "nai-diffusion-4-5-full", "name": "NAI Diffusion v4.5 Full", "type": "novelai_image"},
        {"id": "nai-diffusion-4-5-curated", "name": "NAI Diffusion v4.5 Curated", "type": "novelai_image"},
        {"id": "nai-diffusion-4-full", "name": "NAI Diffusion v4 Full", "type": "novelai_image"},
        {"id": "nai-diffusion-4-curated-preview", "name": "NAI Diffusion v4 Curated", "type": "novelai_image"},
        {"id": "nai-diffusion-3", "name": "NAI Diffusion v3", "type": "novelai_image"},
        {"id": "nai-diffusion-furry-3", "name": "NAI Diffusion Furry v3", "type": "novelai_image"},
    ],
}

IMAGE_PROVIDER_CLASSES: dict[str, type[ImageProvider]] = {
    "openai_image": OpenAIImageProvider,
    "gemini_image": GeminiImageProvider,
    "gemini_chat_image": GeminiChatImageProvider,
    "novelai_image": NovelAIImageProvider,
}

# Type options surfaced in the model add/edit sheet. All four are exposed to
# every preset — a custom relay may host any combination, and even a "preset"
# provider could conceivably grow a model that needs a different mode in the
# future. Frontend uses these for the dropdown options.
MODEL_TYPE_OPTIONS: list[dict] = [
    {
        "value": "openai_image",
        "label": "OpenAI 图片接口（纯文本 /images/generations，参考图 /images/edits）",
        "endpoint_path": "/images/generations",
    },
    {
        "value": "gemini_chat_image",
        "label": "Gemini 聊天接口（/chat/completions，中转 NanoBanana）",
        "endpoint_path": "/chat/completions",
    },
    {
        "value": "gemini_image",
        "label": "Gemini 原生（/v1beta/models/{model}:generateContent）",
        "endpoint_path": "/models/{model}:generateContent",
    },
    {
        "value": "novelai_image",
        "label": "NovelAI（/ai/generate-image）",
        "endpoint_path": "/ai/generate-image",
    },
]

VALID_MODEL_TYPES: set[str] = {opt["value"] for opt in MODEL_TYPE_OPTIONS}


def _preset_default_type(preset: str) -> str:
    info = IMAGE_PROVIDER_PRESETS.get(preset)
    return info["default_model_type"] if info else "openai_image"


def resolve_model_type(provider_cfg: dict, model_entry: dict) -> str:
    """Pick the type for one model: ``model.type`` or the preset default."""
    return model_entry.get("type") or _preset_default_type(
        provider_cfg.get("preset", "custom"),
    )


def resolve_base_url(provider_cfg: dict) -> str:
    preset = provider_cfg.get("preset", "custom")
    info = IMAGE_PROVIDER_PRESETS.get(preset)
    return info["base_url"] if info else provider_cfg.get("base_url", "")


def model_type_supports_reference_images(model_type: str) -> bool:
    provider_class = IMAGE_PROVIDER_CLASSES.get(model_type)
    return bool(provider_class and provider_class.supports_reference_images)


def model_supports_reference_images(
    provider_cfg: dict,
    model_entry: dict,
) -> bool:
    """Resolve per-model capability, allowing explicit relay overrides."""
    declared = model_entry.get("supports_reference_images")
    if isinstance(declared, bool):
        return declared

    model_type = resolve_model_type(provider_cfg, model_entry)
    if model_type == "openai_image":
        return openai_model_supports_reference_images(model_entry.get("id", ""))
    return model_type_supports_reference_images(model_type)


def _image_model_summary(provider_cfg: dict, model_entry: dict) -> dict:
    model_type = resolve_model_type(provider_cfg, model_entry)
    model_id = model_entry.get("id", "")
    return {
        "id": model_id,
        "name": model_entry.get("name", model_id),
        "type": model_type,
        "supports_reference_images": model_supports_reference_images(
            provider_cfg,
            model_entry,
        ),
    }


def ensure_image_models_list(provider_cfg: dict) -> list[dict]:
    """Return models with resolved routing type and capabilities."""
    return [
        _image_model_summary(provider_cfg, model)
        for model in (provider_cfg.get("models") or [])
    ]


class ImageManager:
    """Resolve image providers per (provider_name, model_id) at call time.

    Instances are constructed on demand rather than at startup. Image
    generation calls are slow (seconds to minutes), so the per-call class
    instantiation cost is negligible — and pay-as-you-go avoids the bookkeeping
    of caching one provider class per model.
    """

    def __init__(self):
        self._providers_cfg: dict[str, dict] = {}

    def init_from_config(self, providers_cfg: dict):
        """Stash the image_providers config section. No instantiation up front."""
        self._providers_cfg = providers_cfg or {}

    def get_provider_for_model(
        self, name: str, model_id: str,
    ) -> ImageProvider | None:
        """Build (or return None) the right provider class for one model.

        Returns ``None`` when the provider is unknown, has no API key, the
        model isn't registered, or the resolved type maps to no class.
        """
        cfg = self._providers_cfg.get(name)
        if cfg is None or not cfg.get("api_key"):
            return None

        model_entry = next(
            (m for m in (cfg.get("models") or []) if m.get("id") == model_id),
            None,
        )
        if model_entry is None:
            return None

        ptype = resolve_model_type(cfg, model_entry)
        cls = IMAGE_PROVIDER_CLASSES.get(ptype)
        if cls is None:
            logger.warning(
                "不支持的生图 type: %s (provider=%s model=%s)", ptype, name, model_id,
            )
            return None

        return cls(
            base_url=resolve_base_url(cfg),
            api_key=cfg["api_key"],
            supports_reference_images=model_supports_reference_images(
                cfg,
                model_entry,
            ),
        )

    def get_model_type(self, name: str, model_id: str) -> str | None:
        """Resolve the backend type for a (provider_name, model_id) pair.

        Returns the type string (e.g. ``"novelai_image"``) without instantiating
        the provider class. Used by ``ChatService`` to branch system guidance
        per backend.
        """
        cfg = self._providers_cfg.get(name)
        if cfg is None:
            return None
        model_entry = next(
            (m for m in (cfg.get("models") or []) if m.get("id") == model_id),
            None,
        )
        if model_entry is None:
            return None
        return resolve_model_type(cfg, model_entry)

    def model_supports_reference_images(self, name: str, model_id: str) -> bool:
        """Return the declared reference-image capability for one model."""
        cfg = self._providers_cfg.get(name)
        if cfg is None:
            return False
        model_entry = next(
            (m for m in (cfg.get("models") or []) if m.get("id") == model_id),
            None,
        )
        return bool(
            model_entry and model_supports_reference_images(cfg, model_entry)
        )

    @property
    def available_providers(self) -> list[str]:
        return list(self._providers_cfg.keys())
