# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Authenticated administration API for bulk persona management."""

from __future__ import annotations

import base64
import io
import json
import uuid
import zipfile

from flask import Blueprint, jsonify, request
from PIL import Image

from pawzochat.image.reference import load_custom_reference_image
from pawzochat.paths import CHATS_DIR
from pawzochat.services import bundle as bundle_mod
from pawzochat.services.persona_management import (
    PROMPT_FIELDS,
    PersonaManagementError,
    PersonaManagementService,
    load_prompt_templates,
    save_prompt_templates,
)
from pawzochat.web.routes.api_image_providers import (
    ImageGenerationRequestError,
    generate_image_payload,
)
from pawzochat.web.routes.api_persona_writer import (
    PersonaWriterError,
    generate_persona_draft,
)
from pawzochat.web.routes import download_response, get_app, safe_download_stem

api_admin_bp = Blueprint("api_admin", __name__)
_MAX_GENERATED_IMAGE_BYTES = 10 * 1024 * 1024


def _service() -> PersonaManagementService:
    return PersonaManagementService(get_app())


def _error(exc: PersonaManagementError):
    return jsonify({"error": str(exc)}), exc.status_code


def _json_body() -> dict:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise PersonaManagementError("请求体必须是 JSON 对象")
    return data


def _decode_generated_image(value, label: str) -> bytes | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise PersonaManagementError(f"{label}数据无效")
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as exc:
        raise PersonaManagementError(f"{label}数据无效") from exc
    if not raw:
        return None
    if len(raw) > _MAX_GENERATED_IMAGE_BYTES:
        raise PersonaManagementError(f"{label}过大（上限 10 MB）")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.verify()
    except Exception as exc:
        raise PersonaManagementError(f"{label}不是有效图片") from exc
    return raw


@api_admin_bp.route("/dashboard")
def dashboard():
    service = _service()
    personas = service.list_personas()
    providers = {item["llm_provider"] for item in personas if item["llm_provider"]}
    return jsonify({
        "total": len(personas),
        "enabled": sum(item["enabled"] for item in personas),
        "disabled": sum(not item["enabled"] for item in personas),
        "providers": len(providers),
        "memory_enabled": sum(item["memory_enabled"] for item in personas),
        "proactive_enabled": sum(item["proactive_enabled"] for item in personas),
    })


@api_admin_bp.route("/catalogs")
def catalogs():
    return jsonify(_service().catalogs())


@api_admin_bp.route("/personas")
def list_personas():
    service = _service()
    items = service.list_personas()
    query = request.args.get("q", "").strip().casefold()
    status = request.args.get("status", "all")
    provider = request.args.get("provider", "").strip()
    capability = request.args.get("capability", "").strip()
    worldbook = request.args.get("worldbook", "").strip()

    if query:
        items = [item for item in items if query in item["name"].casefold() or query in item["id"].casefold() or query in item["signature"].casefold()]
    if status == "enabled":
        items = [item for item in items if item["enabled"]]
    elif status == "disabled":
        items = [item for item in items if not item["enabled"]]
    if provider:
        items = [item for item in items if item["llm_provider"] == provider]
    if capability:
        key = f"{capability}_enabled"
        items = [item for item in items if bool(item.get(key))]
    if worldbook:
        items = [item for item in items if worldbook in item["bound_worldbooks"]]

    try:
        page = max(1, int(request.args.get("page", 1)))
        page_size = min(100, max(10, int(request.args.get("page_size", 30))))
    except ValueError:
        return jsonify({"error": "分页参数无效"}), 400
    start = (page - 1) * page_size
    return jsonify({
        "items": items[start:start + page_size],
        "total": len(items),
        "page": page,
        "page_size": page_size,
        "version": service.version(),
    })


@api_admin_bp.route("/personas", methods=["POST"])
def create_persona():
    try:
        data = _json_body()
        avatar = _decode_generated_image(data.get("avatar_image"), "头像")
        moments_cover = _decode_generated_image(data.get("moments_cover_image"), "朋友圈封面")
        payload = {
            key: value for key, value in data.items()
            if key not in ("avatar_image", "moments_cover_image")
        }
        return jsonify(_service().create_persona(
            payload,
            avatar=avatar,
            moments_cover=moments_cover,
        )), 201
    except PersonaManagementError as exc:
        return _error(exc)


@api_admin_bp.route("/creation/generate", methods=["POST"])
def generate_creation_draft():
    try:
        return jsonify(generate_persona_draft(get_app(), _json_body()))
    except (PersonaManagementError, PersonaWriterError) as exc:
        status_code = getattr(exc, "status_code", 400)
        return jsonify({"error": str(exc)}), status_code


@api_admin_bp.route("/creation/image", methods=["POST"])
def generate_creation_image():
    try:
        data = _json_body()
        provider = str(data.get("provider") or "").strip()
        if not provider:
            raise PersonaManagementError("请选择生图服务商")
        return jsonify(generate_image_payload(get_app(), provider, data))
    except (PersonaManagementError, ImageGenerationRequestError) as exc:
        status_code = getattr(exc, "status_code", 400)
        return jsonify({"error": str(exc)}), status_code


@api_admin_bp.route("/personas/<persona_id>")
def get_persona(persona_id: str):
    try:
        return jsonify({"persona": _service().get_persona(persona_id)})
    except PersonaManagementError as exc:
        return _error(exc)


@api_admin_bp.route("/personas/<persona_id>", methods=["PUT"])
def update_persona(persona_id: str):
    try:
        result = _service().update_persona(persona_id, _json_body())
        return jsonify(result)
    except PersonaManagementError as exc:
        return _error(exc)


@api_admin_bp.route("/batch/preview", methods=["POST"])
def preview_batch():
    try:
        data = _json_body()
        result = _service().preview_batch(data.get("ids") or [], data.get("operations") or [])
        return jsonify(result)
    except PersonaManagementError as exc:
        return _error(exc)


@api_admin_bp.route("/batch/apply", methods=["POST"])
def apply_batch():
    try:
        data = _json_body()
        result = _service().apply_batch(
            data.get("ids") or [], data.get("operations") or [], str(data.get("version") or ""),
        )
        return jsonify(result)
    except PersonaManagementError as exc:
        return _error(exc)


@api_admin_bp.route("/personas/clone", methods=["POST"])
def clone_personas():
    try:
        created = _service().clone_personas(_json_body().get("ids") or [])
        return jsonify({"ok": True, "created": created}), 201
    except PersonaManagementError as exc:
        return _error(exc)


@api_admin_bp.route("/personas/delete", methods=["POST"])
def delete_personas():
    try:
        data = _json_body()
        if data.get("confirmation") != "DELETE":
            raise PersonaManagementError("批量删除需要确认文本 DELETE")
        count = _service().delete_personas(
            data.get("ids") or [], delete_conversations=bool(data.get("delete_conversations")),
        )
        return jsonify({"ok": True, "deleted_count": count})
    except PersonaManagementError as exc:
        return _error(exc)


@api_admin_bp.route("/personas/import", methods=["POST"])
def import_personas():
    files = request.files.getlist("files")
    if not files:
        return jsonify({"error": "请选择至少一个角色文件"}), 400
    if len(files) > 50:
        return jsonify({"error": "单次最多导入 50 个角色"}), 400
    include_worldbooks = request.form.get("include_worldbooks", "true").lower() != "false"
    service = _service()
    imported = []
    errors = []
    for uploaded in files:
        filename = uploaded.filename or "未命名文件"
        try:
            imported.append(service.import_persona(
                uploaded.read(), filename, include_worldbooks=include_worldbooks,
            ))
        except (PersonaManagementError, ValueError) as exc:
            errors.append({"filename": filename, "error": str(exc)})
        except Exception as exc:
            errors.append({"filename": filename, "error": f"导入失败：{exc}"})
    status = 201 if imported else 400
    return jsonify({"ok": bool(imported), "imported": imported, "errors": errors}), status


@api_admin_bp.route("/personas/export", methods=["POST"])
def export_personas():
    try:
        data = _json_body()
        ids = list(dict.fromkeys(str(pid) for pid in (data.get("ids") or [])))
        if not ids:
            raise PersonaManagementError("请至少选择一个人物")
        app = get_app()
        personas = app.config.load_personas()
        missing = [pid for pid in ids if pid not in personas]
        if missing:
            raise PersonaManagementError(f"人物不存在：{'、'.join(missing)}", status_code=404)
        include_books = bool(data.get("include_worldbooks", True))
        output = io.BytesIO()
        used_names: set[str] = set()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for persona_id in ids:
                persona = personas[persona_id]
                avatar_path = CHATS_DIR / persona_id / "avatar.png"
                avatar = avatar_path.read_bytes() if avatar_path.is_file() else None
                reference = load_custom_reference_image(persona_id, persona.image_generation)
                books = []
                if include_books:
                    for name in persona.bound_worldbooks:
                        book = app.worldbook_service.get_book(name)
                        if book:
                            books.append(book)
                package = bundle_mod.pack_persona(
                    persona,
                    avatar_png=avatar,
                    reference_image_png=reference[0] if reference else None,
                    bound_books=books,
                )
                stem = safe_download_stem(persona.name) or persona_id
                filename = f"{stem}.ppack"
                suffix = 2
                while filename in used_names:
                    filename = f"{stem}_{suffix}.ppack"
                    suffix += 1
                used_names.add(filename)
                archive.writestr(filename, package)
        return download_response(
            output.getvalue(), "application/zip", "pawzochat-personas.zip",
            fallback_stem="pawzochat-personas",
        )
    except PersonaManagementError as exc:
        return _error(exc)


@api_admin_bp.route("/prompt-templates", methods=["GET"])
def list_templates():
    return jsonify({"templates": load_prompt_templates()})


@api_admin_bp.route("/prompt-templates", methods=["POST"])
def create_template():
    try:
        data = _json_body()
        name = str(data.get("name") or "").strip()
        field = str(data.get("field") or "character_prompt")
        content = str(data.get("content") or "")
        if not name or len(name) > 100:
            raise PersonaManagementError("模板名称不能为空且不能超过 100 个字符")
        if field not in PROMPT_FIELDS:
            raise PersonaManagementError("模板字段无效")
        templates = load_prompt_templates()
        item = {"id": uuid.uuid4().hex[:12], "name": name, "field": field, "content": content}
        templates.append(item)
        save_prompt_templates(templates)
        return jsonify({"template": item}), 201
    except PersonaManagementError as exc:
        return _error(exc)


@api_admin_bp.route("/prompt-templates/<template_id>", methods=["PUT"])
def update_template(template_id: str):
    try:
        data = _json_body()
        templates = load_prompt_templates()
        item = next((item for item in templates if item.get("id") == template_id), None)
        if item is None:
            raise PersonaManagementError("模板不存在", status_code=404)
        name = str(data.get("name", item.get("name", ""))).strip()
        field = str(data.get("field", item.get("field", "character_prompt")))
        if not name or len(name) > 100:
            raise PersonaManagementError("模板名称不能为空且不能超过 100 个字符")
        if field not in PROMPT_FIELDS:
            raise PersonaManagementError("模板字段无效")
        item.update(name=name, field=field, content=str(data.get("content", item.get("content", ""))))
        save_prompt_templates(templates)
        return jsonify({"template": item})
    except PersonaManagementError as exc:
        return _error(exc)


@api_admin_bp.route("/prompt-templates/<template_id>", methods=["DELETE"])
def delete_template(template_id: str):
    templates = load_prompt_templates()
    remaining = [item for item in templates if item.get("id") != template_id]
    if len(remaining) == len(templates):
        return jsonify({"error": "模板不存在"}), 404
    save_prompt_templates(remaining)
    return jsonify({"ok": True})