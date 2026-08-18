# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

"""Shared configured image-generation execution."""

from __future__ import annotations

from pawzochat.image.base import ImageResponse
from pawzochat.image.reference import resolve_reference_images


class ImageConfigurationError(ValueError):
    """A requested provider/model pair is not available in current config."""

    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def generate_configured_image(
    app,
    *,
    provider_name: str,
    model: str,
    prompt: str,
    purpose: str = "square",
    persona_id: str = "",
    reference_images: list[tuple[bytes, str]] | None = None,
) -> ImageResponse:
    """Generate through a configured provider with consistent sizing and refs."""
    if purpose not in {"square", "avatar", "moments_cover"}:
        raise ImageConfigurationError("不支持的图片用途")
    if provider_name not in app.config._data.get("image_providers", {}):
        raise ImageConfigurationError("生图服务商未找到", status_code=404)

    provider = app.image_manager.get_provider_for_model(provider_name, model)
    if provider is None:
        raise ImageConfigurationError(
            "服务商或模型未就绪（请检查 API Key 和模型是否已配置）"
        )

    resolved_references = list(reference_images or [])
    if not resolved_references and persona_id and app.image_manager.model_supports_reference_images(
        provider_name,
        model,
    ):
        persona_cfg = app.config.get("personas", default={}).get(persona_id) or {}
        resolved_references = resolve_reference_images(
            persona_id,
            persona_cfg.get("image_generation") or {},
        )

    width, height = (1536, 1024) if purpose == "moments_cover" else (1024, 1024)
    return provider.generate(
        prompt=prompt,
        model=model,
        reference_images=resolved_references,
        width=width,
        height=height,
    )