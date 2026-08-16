# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

"""AI sticker-pack generation API."""

from __future__ import annotations

import logging
from urllib.parse import quote

from flask import Blueprint, jsonify, request

from pawzochat.image.base import ImageGenerationError
from pawzochat.image.reference import (
    normalize_reference_image_png,
    resolve_reference_images,
)
from pawzochat.image.sticker_sheet import (
    StickerSheetError,
    build_sticker_prompt,
    process_sticker_sheet,
    save_sticker_pack,
)
from pawzochat.paths import EMOJI_DIR
from pawzochat.web.routes import get_app
from pawzochat.web.routes.api_emoji import _validate_fs_name

api_sticker_maker_bp = Blueprint("api_sticker_maker", __name__)
logger = logging.getLogger(__name__)

STICKER_REFERENCE_MAX_BYTES = 10 * 1024 * 1024
STICKER_STYLE_MAX_LENGTH = 500


def _reference_images(app, persona_id: str) -> tuple[list[tuple[bytes, str]], str | None]:
    upload = request.files.get("reference")
    if upload and upload.filename:
        raw = upload.read(STICKER_REFERENCE_MAX_BYTES + 1)
        if not raw:
            return [], "参考图为空"
        if len(raw) > STICKER_REFERENCE_MAX_BYTES:
            return [], "参考图不能超过 10 MB"
        try:
            normalized = normalize_reference_image_png(raw)
        except (OSError, ValueError) as exc:
            logger.info("表情包参考图解析失败: %s", exc)
            return [], "参考图格式无效"
        return [(normalized, "image/png")], None

    if not persona_id:
        return [], None
    persona_cfg = app.config.get("personas", default={}).get(persona_id)
    if persona_cfg is None:
        return [], "角色不存在"
    refs = resolve_reference_images(
        persona_id,
        persona_cfg.get("image_generation") or {},
    )
    if not refs:
        return [], "所选角色没有可用参考图，请上传一张图片"
    return refs, None


@api_sticker_maker_bp.route("/generate", methods=["POST"])
def generate_sticker_pack():
    """Generate one strict sheet, crop it in-process, then save a new pack."""
    app = get_app()
    group_name = (request.form.get("group_name") or "").strip()
    provider_name = (request.form.get("provider") or "").strip()
    model = (request.form.get("model") or "").strip()
    persona_id = (request.form.get("persona_id") or "").strip()
    style = (request.form.get("style") or "").strip()

    name_error = _validate_fs_name(group_name)
    if name_error:
        return jsonify({"error": name_error}), 400
    if (EMOJI_DIR / group_name).exists():
        return jsonify({"error": f"分组「{group_name}」已存在"}), 409
    if not provider_name or not model:
        return jsonify({"error": "请选择生图服务商和模型"}), 400
    if len(style) > STICKER_STYLE_MAX_LENGTH:
        return jsonify({"error": "风格描述不能超过 500 个字符"}), 400

    provider = app.image_manager.get_provider_for_model(provider_name, model)
    if provider is None:
        return jsonify({"error": "服务商或模型未就绪，请检查 API Key 和模型配置"}), 400

    supports_reference_images = app.image_manager.model_supports_reference_images(
        provider_name,
        model,
    )
    reference_images: list[tuple[bytes, str]] = []
    if supports_reference_images:
        reference_images, reference_error = _reference_images(app, persona_id)
        if reference_error:
            return jsonify({"error": reference_error}), 400

    try:
        generated = provider.generate(
            prompt=build_sticker_prompt(
                style,
                has_reference=bool(reference_images),
            ),
            model=model,
            reference_images=reference_images,
            width=1024,
            height=1024,
        )
        processed = process_sticker_sheet(generated.image_data)
        save_sticker_pack(EMOJI_DIR, group_name, processed)
    except ImageGenerationError as exc:
        status = exc.status_code or 502
        if status < 400 or status >= 600:
            status = 502
        return jsonify({"error": str(exc)}), status
    except StickerSheetError as exc:
        return jsonify({"error": str(exc)}), 422
    except FileExistsError:
        return jsonify({"error": f"分组「{group_name}」已存在"}), 409
    except Exception:
        logger.exception(
            "生成表情包失败: provider=%s model=%s group=%s",
            provider_name,
            model,
            group_name,
        )
        return jsonify({"error": "生成表情包失败，请查看服务日志"}), 500

    encoded_group = quote(group_name, safe="")
    stickers = [
        {
            "emotion": sticker.emotion,
            "url": (
                f"/emoji-static/{encoded_group}/"
                f"{quote(sticker.emotion, safe='')}/1.png"
            ),
        }
        for sticker in processed.stickers
    ]
    return jsonify({
        "ok": True,
        "group": group_name,
        "count": len(stickers),
        "supports_reference_images": supports_reference_images,
        "used_reference_images": bool(reference_images),
        "sheet_url": f"/emoji-static/{encoded_group}/sheet.png",
        "stickers": stickers,
    }), 201