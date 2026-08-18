# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

"""REST API for generating and managing the persistent image gallery."""

from __future__ import annotations

import logging

from flask import Blueprint, jsonify, request, send_file

from pawzochat.image.base import ImageGenerationError
from pawzochat.image.generation import (
    ImageConfigurationError,
    generate_configured_image,
)
from pawzochat.image.reference import normalize_reference_image_png
from pawzochat.store.image_gallery import ImageGalleryStore
from pawzochat.web.routes import get_app

logger = logging.getLogger(__name__)

api_image_gallery_bp = Blueprint("api_image_gallery", __name__)
_store = ImageGalleryStore()
_MAX_PROMPT_LENGTH = 8000
_REFERENCE_MAX_BYTES = 10 * 1024 * 1024
_SAFE_MIME_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}


def _text(data: dict, key: str) -> str:
    value = data.get(key)
    return value.strip() if isinstance(value, str) else ""


def _uploaded_reference_image() -> tuple[list[tuple[bytes, str]], str | None]:
    upload = request.files.get("reference")
    if not upload or not upload.filename:
        return [], None
    raw = upload.read(_REFERENCE_MAX_BYTES + 1)
    if not raw:
        return [], "参考图为空"
    if len(raw) > _REFERENCE_MAX_BYTES:
        return [], "参考图不能超过 10 MB"
    try:
        normalized = normalize_reference_image_png(raw)
    except (OSError, ValueError) as error:
        logger.info("图库参考图解析失败: %s", error)
        return [], "参考图格式无效"
    return [(normalized, "image/png")], None


def _normalize_mime_type(value: str) -> str:
    mime_type = (value or "").split(";", 1)[0].strip().lower()
    if mime_type == "image/jpg":
        mime_type = "image/jpeg"
    return mime_type if mime_type in _SAFE_MIME_TYPES else "image/png"


def _serialize(item: dict) -> dict:
    return {
        key: value for key, value in item.items() if key != "filename"
    } | {
        "image_url": (
            f"{request.script_root}/api/image-gallery/{item['id']}/{item['filename']}"
        ),
    }


@api_image_gallery_bp.route("", methods=["GET"])
def list_images():
    return jsonify({"images": [_serialize(item) for item in _store.list_images()]})


@api_image_gallery_bp.route("/generate", methods=["POST"])
def generate_image():
    app = get_app()
    if request.files or request.form:
        data = request.form
    else:
        payload = request.get_json(force=True, silent=True)
        data = payload if isinstance(payload, dict) else {}
    provider_name = _text(data, "provider")
    model = _text(data, "model")
    prompt = _text(data, "prompt")

    if not provider_name or not model:
        return jsonify({"error": "请先选择生图服务商与模型"}), 400
    if not prompt:
        return jsonify({"error": "请输入提示词"}), 400
    if len(prompt) > _MAX_PROMPT_LENGTH:
        return jsonify({"error": f"提示词不能超过 {_MAX_PROMPT_LENGTH} 个字符"}), 400

    has_reference_upload = bool(
        request.files.get("reference") and request.files["reference"].filename
    )
    supports_reference_images = False
    if has_reference_upload:
        supports_reference_images = app.image_manager.model_supports_reference_images(
            provider_name,
            model,
        )
        if not supports_reference_images:
            return jsonify({"error": "当前生图模型不支持参考图"}), 400
    reference_images, reference_error = _uploaded_reference_image()
    if reference_error:
        return jsonify({"error": reference_error}), 400

    try:
        response = generate_configured_image(
            app,
            provider_name=provider_name,
            model=model,
            prompt=prompt,
            purpose="square",
            reference_images=reference_images,
        )
        item = _store.add_image(
            image_data=response.image_data,
            mime_type=_normalize_mime_type(response.mime_type),
            prompt=prompt,
            provider=provider_name,
            model=model,
            seed_used=response.seed_used,
        )
    except ImageConfigurationError as error:
        return jsonify({"error": str(error)}), error.status_code
    except ImageGenerationError as error:
        status = error.status_code or 502
        if status < 400 or status >= 600:
            status = 502
        return jsonify({"error": str(error)}), status
    except (OSError, ValueError):
        logger.exception("图库图片保存失败 provider=%s model=%s", provider_name, model)
        return jsonify({"error": "图片已生成，但保存失败，请检查数据目录"}), 500
    except Exception:
        logger.exception("图库生图失败 provider=%s model=%s", provider_name, model)
        return jsonify({"error": "图片生成失败，请检查生图服务配置"}), 500

    return jsonify({
        "ok": True,
        "image": _serialize(item),
        "used_reference_image": bool(reference_images),
    }), 201


@api_image_gallery_bp.route("/<image_id>/<filename>", methods=["GET"])
def serve_image(image_id: str, filename: str):
    path = _store.image_path(image_id)
    if path is None or filename != path.name:
        return jsonify({"error": "图片未找到"}), 404
    response = send_file(path, conditional=True)
    response.headers["Cache-Control"] = "private, max-age=31536000, immutable"
    return response


@api_image_gallery_bp.route("/<image_id>", methods=["DELETE"])
def delete_image(image_id: str):
    try:
        deleted = _store.delete_image(image_id)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    if not deleted:
        return jsonify({"error": "图片未找到"}), 404
    return jsonify({"ok": True})


@api_image_gallery_bp.route("/batch-delete", methods=["POST"])
def batch_delete_images():
    payload = request.get_json(force=True, silent=True)
    data = payload if isinstance(payload, dict) else {}
    image_ids = data.get("ids")
    if not isinstance(image_ids, list) or not image_ids:
        return jsonify({"error": "请选择要删除的图片"}), 400
    if any(not isinstance(image_id, str) for image_id in image_ids):
        return jsonify({"error": "图片 ID 列表无效"}), 400
    try:
        deleted_count = _store.delete_images(image_ids)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    return jsonify({"ok": True, "deleted_count": deleted_count})