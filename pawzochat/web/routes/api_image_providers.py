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

"""REST API for image generation provider management."""

from __future__ import annotations

import base64
import logging
import re

from flask import Blueprint, jsonify, request

from pawzochat.image.base import ImageGenerationError
from pawzochat.image.manager import (
    IMAGE_PRESET_MODELS,
    IMAGE_PROVIDER_PRESETS,
    MODEL_TYPE_OPTIONS,
    VALID_MODEL_TYPES,
    ensure_image_models_list,
    resolve_model_type,
)
from pawzochat.image.reference import resolve_reference_images
from pawzochat.web.routes import get_app

logger = logging.getLogger(__name__)

api_image_providers_bp = Blueprint("api_image_providers", __name__)

_NAME_RE = re.compile(r'^[a-zA-Z0-9一-鿿][a-zA-Z0-9一-鿿_\-]*$')
_SAFE_IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}


def _validate_provider_name(name: str) -> str | None:
    if not name:
        return "名称不能为空"
    if len(name) > 30:
        return "名称不能超过 30 个字符"
    if not _NAME_RE.match(name):
        return "名称只能包含字母、数字、中文、下划线和连字符，且不能以符号开头"
    return None


def _normalize_image_mime_type(mime_type: str | None) -> str:
    """Return a browser-safe image MIME type for data URLs."""
    mime = (mime_type or "").split(";", 1)[0].strip().lower()
    if mime == "image/jpg":
        mime = "image/jpeg"
    if mime in _SAFE_IMAGE_MIME_TYPES:
        return mime
    return "image/png"


def _reinit_image(app):
    app.image_manager.init_from_config(app.config.get("image_providers", default={}))


def _provider_summary(name: str, cfg: dict) -> dict:
    """Build a JSON-safe summary dict for one image provider entry."""
    preset = cfg.get("preset", "custom")
    preset_info = IMAGE_PROVIDER_PRESETS.get(preset)
    base_url = preset_info["base_url"] if preset_info else cfg.get("base_url", "")

    return {
        "name": name,
        "preset": preset,
        "base_url": base_url,
        "api_key_set": bool(cfg.get("api_key", "")),
        "models": ensure_image_models_list(cfg),
    }


@api_image_providers_bp.route("", methods=["GET"])
def list_image_providers():
    app = get_app()
    providers_cfg = app.config.get("image_providers", default={})
    result = [_provider_summary(name, cfg) for name, cfg in providers_cfg.items()]

    presets_out = {
        pid: {
            "name": p["name"],
            "default_name": p.get("default_name", p["name"]),
            "base_url": p["base_url"],
            "default_model_type": p.get("default_model_type", "openai_image"),
            "endpoint_path": p["endpoint_path"],
        }
        for pid, p in IMAGE_PROVIDER_PRESETS.items()
    }
    return jsonify({
        "providers": result,
        "presets": presets_out,
        "preset_models": IMAGE_PRESET_MODELS,
        "model_type_options": MODEL_TYPE_OPTIONS,
    })


def _normalize_models_payload(models, provider_cfg) -> tuple[list[dict], str | None]:
    """Validate every model carries a known type; fill default when omitted."""
    out = []
    for m in models or []:
        mid = (m.get("id") or "").strip()
        if not mid:
            return [], "模型 ID 不能为空"
        entry = {
            "id": mid,
            "name": m.get("name") or mid,
        }
        # Honor explicit type if given; else fall back through resolver.
        t = m.get("type")
        if t and t not in VALID_MODEL_TYPES:
            return [], f"模型「{mid}」的调用方式不支持: {t}"
        entry["type"] = t or resolve_model_type(provider_cfg, m)
        if isinstance(m.get("supports_reference_images"), bool):
            entry["supports_reference_images"] = m["supports_reference_images"]
        out.append(entry)
    return out, None


@api_image_providers_bp.route("", methods=["POST"])
def create_image_provider():
    app = get_app()
    data = request.get_json(force=True)
    name = data.get("name", "").strip()

    err = _validate_provider_name(name)
    if err:
        return jsonify({"error": err}), 400

    preset = data.get("preset", "custom")
    entry: dict = {"preset": preset}

    if preset == "custom":
        entry["base_url"] = data.get("base_url", "")

    entry["api_key"] = data.get("api_key", "")

    models, merr = _normalize_models_payload(data.get("models", []), entry)
    if merr:
        return jsonify({"error": merr}), 400
    entry["models"] = models

    with app.config.lock:
        providers = app.config._data.setdefault("image_providers", {})
        if name in providers:
            return jsonify({"error": f"生图服务商「{name}」已存在"}), 409
        providers[name] = entry
        app.config.save()
        _reinit_image(app)
    return jsonify({"ok": True}), 201


@api_image_providers_bp.route("/<name>", methods=["PUT"])
def update_image_provider(name: str):
    app = get_app()
    data = request.get_json(force=True)
    new_name = data.get("name", "").strip() if "name" in data else name

    with app.config.lock:
        providers = app.config._data.get("image_providers", {})
        if name not in providers:
            return jsonify({"error": "生图服务商未找到"}), 404

        if new_name != name:
            err = _validate_provider_name(new_name)
            if err:
                return jsonify({"error": err}), 400
            if new_name in providers:
                return jsonify({"error": f"生图服务商「{new_name}」已存在"}), 409

        preset = data.get("preset", providers[name].get("preset", "custom"))
        entry: dict = {"preset": preset}

        if preset == "custom":
            entry["base_url"] = data.get("base_url", providers[name].get("base_url", ""))

        if data.get("api_key"):
            entry["api_key"] = data["api_key"]
        else:
            entry["api_key"] = providers[name].get("api_key", "")

        if "models" in data:
            models, merr = _normalize_models_payload(data["models"], entry)
            if merr:
                return jsonify({"error": merr}), 400
            entry["models"] = models
        else:
            # Preserve existing models, but resolve any missing type fields.
            entry["models"] = ensure_image_models_list(providers[name])

        if new_name != name:
            del providers[name]

        providers[new_name] = entry
        app.config.save()
        _reinit_image(app)
    return jsonify({"ok": True})


@api_image_providers_bp.route("/<name>", methods=["DELETE"])
def delete_image_provider(name: str):
    app = get_app()
    with app.config.lock:
        providers = app.config._data.get("image_providers", {})
        if name not in providers:
            return jsonify({"error": "生图服务商未找到"}), 404

        del providers[name]
        app.config.save()
        _reinit_image(app)
    return jsonify({"ok": True})


# ---- Model CRUD under an image provider ---------------------------------

@api_image_providers_bp.route("/<name>/models", methods=["POST"])
def add_image_model(name: str):
    app = get_app()
    data = request.get_json(force=True)
    model_id = data.get("id", "").strip()
    if not model_id:
        return jsonify({"error": "模型 ID 不能为空"}), 400

    mtype = data.get("type")
    if mtype and mtype not in VALID_MODEL_TYPES:
        return jsonify({"error": f"不支持的调用方式: {mtype}"}), 400

    with app.config.lock:
        providers = app.config._data.get("image_providers", {})
        if name not in providers:
            return jsonify({"error": "生图服务商未找到"}), 404

        provider_cfg = providers[name]
        models = provider_cfg.setdefault("models", [])
        if any(m["id"] == model_id for m in models):
            return jsonify({"error": f"模型「{model_id}」已存在"}), 409

        new_entry = {
            "id": model_id,
            "name": data.get("name", model_id),
            "type": mtype or resolve_model_type(provider_cfg, {"id": model_id}),
        }
        if isinstance(data.get("supports_reference_images"), bool):
            new_entry["supports_reference_images"] = data[
                "supports_reference_images"
            ]
        models.append(new_entry)
        app.config.save()
        _reinit_image(app)
    return jsonify({"ok": True}), 201


@api_image_providers_bp.route("/<name>/models/<model_id>", methods=["PUT"])
def update_image_model(name: str, model_id: str):
    app = get_app()
    data = request.get_json(force=True)

    with app.config.lock:
        providers = app.config._data.get("image_providers", {})
        if name not in providers:
            return jsonify({"error": "生图服务商未找到"}), 404

        provider_cfg = providers[name]
        models = provider_cfg.setdefault("models", [])
        target = next((m for m in models if m["id"] == model_id), None)
        if target is None:
            return jsonify({"error": "模型未找到"}), 404

        if "name" in data:
            target["name"] = data["name"]
        if "type" in data:
            if data["type"] not in VALID_MODEL_TYPES:
                return jsonify({"error": f"不支持的调用方式: {data['type']}"}), 400
            target["type"] = data["type"]
        if isinstance(data.get("supports_reference_images"), bool):
            target["supports_reference_images"] = data[
                "supports_reference_images"
            ]

        app.config.save()
        _reinit_image(app)
    return jsonify({"ok": True})


@api_image_providers_bp.route("/<name>/models/<model_id>", methods=["DELETE"])
def delete_image_model(name: str, model_id: str):
    app = get_app()
    with app.config.lock:
        providers = app.config._data.get("image_providers", {})
        if name not in providers:
            return jsonify({"error": "生图服务商未找到"}), 404

        models = providers[name].get("models", [])
        new_models = [m for m in models if m["id"] != model_id]
        if len(new_models) == len(models):
            return jsonify({"error": "模型未找到"}), 404

        providers[name]["models"] = new_models
        app.config.save()
        _reinit_image(app)
    return jsonify({"ok": True})


# ---- Test invocation -----------------------------------------------------

@api_image_providers_bp.route("/<name>/_test", methods=["POST"])
@api_image_providers_bp.route("/<name>/generate", methods=["POST"])
def test_image_provider(name: str):
    """Invoke the provider with a minimal prompt and return the image inline.

    The (provider_name, model_id) pair routes to whichever class the model's
    type points to — same path business code will use later.
    """
    app = get_app()
    data = request.get_json(force=True)
    model = (data.get("model") or "").strip()
    prompt = (data.get("prompt") or "").strip()
    persona_id = (data.get("persona_id") or "").strip()
    purpose = (data.get("purpose") or "square").strip()
    if purpose not in {"square", "avatar", "moments_cover"}:
        return jsonify({"error": "不支持的图片用途"}), 400

    if not model:
        return jsonify({"error": "请选择模型"}), 400
    if not prompt:
        return jsonify({"error": "请输入提示词"}), 400

    if name not in app.config._data.get("image_providers", {}):
        return jsonify({"error": "生图服务商未找到"}), 404

    provider = app.image_manager.get_provider_for_model(name, model)
    if provider is None:
        return jsonify({
            "error": "服务商或模型未就绪（请检查 API Key 和模型是否已配置）",
        }), 400

    ref_images: list[tuple[bytes, str]] = []
    if persona_id and app.image_manager.model_supports_reference_images(
        name,
        model,
    ):
        persona_cfg = app.config.get("personas", default={}).get(persona_id) or {}
        ref_images = resolve_reference_images(
            persona_id, persona_cfg.get("image_generation") or {},
        )

    width, height = (1536, 1024) if purpose == "moments_cover" else (1024, 1024)
    try:
        resp = provider.generate(
            prompt=prompt,
            model=model,
            reference_images=ref_images,
            width=width,
            height=height,
        )
    except ImageGenerationError as e:
        status = e.status_code or 502
        if status < 400 or status >= 600:
            status = 502
        return jsonify({"error": str(e)}), status
    except Exception as e:
        logger.exception("生图测试调用失败: name=%s model=%s", name, model)
        return jsonify({"error": f"调用失败: {e}"}), 500

    return jsonify({
        "ok": True,
        "image_b64": base64.b64encode(resp.image_data).decode("ascii"),
        "mime_type": _normalize_image_mime_type(resp.mime_type),
        "seed_used": resp.seed_used,
    })
