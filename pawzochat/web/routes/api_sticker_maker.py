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

from flask import Blueprint, jsonify, request, send_file

from pawzochat.image.base import ImageGenerationError
from pawzochat.image.reference import normalize_reference_image_png
from pawzochat.image.sticker_drafts import (
    StickerDraftNotFound,
    claim_sticker_draft,
    create_sticker_draft,
    discard_sticker_draft,
    release_sticker_draft,
    sticker_draft_asset_path,
)
from pawzochat.image.sticker_sheet import (
    STICKER_EMOTIONS,
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


def _uploaded_reference_image() -> tuple[list[tuple[bytes, str]], str | None]:
    upload = request.files.get("reference")
    if not upload or not upload.filename:
        return [], None

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


@api_sticker_maker_bp.route("/generate", methods=["POST"])
def generate_sticker_pack():
    """Generate and crop a preview draft without touching the emoji library."""
    app = get_app()
    group_name = (request.form.get("group_name") or "").strip()
    provider_name = (request.form.get("provider") or "").strip()
    model = (request.form.get("model") or "").strip()
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
        reference_images, reference_error = _uploaded_reference_image()
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
        draft_token = create_sticker_draft(processed)
    except ImageGenerationError as exc:
        status = exc.status_code or 502
        if status < 400 or status >= 600:
            status = 502
        return jsonify({"error": str(exc)}), status
    except StickerSheetError as exc:
        return jsonify({"error": str(exc)}), 422
    except Exception:
        logger.exception(
            "生成表情包失败: provider=%s model=%s group=%s",
            provider_name,
            model,
            group_name,
        )
        return jsonify({"error": "生成表情包失败，请查看服务日志"}), 500

    draft_base = f"/api/emoji/drafts/{draft_token}"
    stickers = [
        {
            "emotion": sticker.emotion,
            "url": f"{draft_base}/{quote(sticker.emotion, safe='')}/1.png",
        }
        for sticker in processed.stickers
    ]
    return jsonify({
        "ok": True,
        "saved": False,
        "draft_token": draft_token,
        "group": group_name,
        "count": len(stickers),
        "supports_reference_images": supports_reference_images,
        "used_reference_images": bool(reference_images),
        "sheet_url": f"{draft_base}/sheet.png",
        "stickers": stickers,
    }), 201


def _saved_pack_payload(group_name: str) -> dict:
    encoded_group = quote(group_name, safe="")
    return {
        "ok": True,
        "saved": True,
        "group": group_name,
        "count": len(STICKER_EMOTIONS),
        "sheet_url": f"/emoji-static/{encoded_group}/sheet.png",
        "stickers": [
            {
                "emotion": emotion,
                "url": (
                    f"/emoji-static/{encoded_group}/"
                    f"{quote(emotion, safe='')}/1.png"
                ),
            }
            for emotion in STICKER_EMOTIONS
        ],
    }


@api_sticker_maker_bp.route("/drafts/<token>/<path:asset>", methods=["GET"])
def serve_sticker_draft_asset(token: str, asset: str):
    try:
        path = sticker_draft_asset_path(token, asset)
    except StickerDraftNotFound:
        return jsonify({"error": "表情包草稿不存在或已过期"}), 404
    response = send_file(path, mimetype="image/png", conditional=True)
    response.headers["Cache-Control"] = "private, no-store"
    return response


@api_sticker_maker_bp.route("/drafts/<token>/save", methods=["POST"])
def save_sticker_draft(token: str):
    body = request.get_json(force=True, silent=True) or {}
    group_name = (body.get("group_name") or "").strip()
    name_error = _validate_fs_name(group_name)
    if name_error:
        return jsonify({"error": name_error}), 400
    if (EMOJI_DIR / group_name).exists():
        return jsonify({"error": f"分组「{group_name}」已存在"}), 409

    try:
        claim = claim_sticker_draft(token)
    except StickerDraftNotFound:
        return jsonify({"error": "表情包草稿不存在或已过期，请重新生成"}), 404

    try:
        save_sticker_pack(EMOJI_DIR, group_name, claim.processed)
    except FileExistsError:
        release_sticker_draft(claim)
        return jsonify({"error": f"分组「{group_name}」已存在"}), 409
    except Exception:
        release_sticker_draft(claim)
        logger.exception("保存表情包草稿失败: token=%s group=%s", token, group_name)
        return jsonify({"error": "保存表情包失败，请查看服务日志"}), 500

    discard_sticker_draft(claim)
    return jsonify(_saved_pack_payload(group_name)), 201
