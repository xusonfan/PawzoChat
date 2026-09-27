# PawzoChat - Human-like, versatile, extensible AI companion engine
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

"""REST API for worldbook CRUD, import and export.

Worldbooks are stored as ``data/books/{name}.json`` files. The filename is the
book's identity; there is no separate id. Persona → book binding lives on the
persona side (``persona.bound_worldbooks``).
"""

from __future__ import annotations

import json
import os

from flask import Blueprint, jsonify, request

from pawzochat.services import card_parser, persona_card
from pawzochat.services.worldbook import validate_book_name
from pawzochat.web.routes import download_response, get_app, safe_download_stem

api_worldbooks_bp = Blueprint("api_worldbooks", __name__)


def _book_summary(book: dict) -> dict:
    """Light-weight dict for list views."""
    content = book.get("content") or {}
    sections = list(content.keys())
    return {
        "name": book.get("name", ""),
        "scope": book.get("scope", {}),
        "keywords": book.get("keywords", []),
        "section_count": len(sections),
        "sections": sections[:6],
        "updated_at": book.get("updated_at", ""),
    }


def _unique_name(service, name: str) -> str:
    """Return ``name`` if free, else append ``_2``, ``_3``, … until unique."""
    if not service.get_book(name):
        return name
    i = 2
    while service.get_book(f"{name}_{i}"):
        i += 1
    return f"{name}_{i}"


@api_worldbooks_bp.route("", methods=["GET"])
def list_worldbooks():
    app = get_app()
    books = app.worldbook_service.list_books()
    return jsonify({"books": [_book_summary(b) for b in books]})


@api_worldbooks_bp.route("/<name>", methods=["GET"])
def get_worldbook(name: str):
    app = get_app()
    try:
        book = app.worldbook_service.get_book(name)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if book is None:
        return jsonify({"error": "世界书不存在"}), 404
    book["bound_personas"] = app.worldbook_service.get_bound_personas(name)
    return jsonify(book)


def _apply_persona_bindings(app, book_name: str, data: dict) -> list[str] | None:
    """If *data* contains ``bound_personas``, sync; return the resulting list."""
    if "bound_personas" not in data:
        return None
    raw = data.get("bound_personas") or []
    if not isinstance(raw, list):
        raw = []
    persona_ids = [str(p) for p in raw]
    return app.worldbook_service.set_bound_personas(book_name, persona_ids)


@api_worldbooks_bp.route("", methods=["POST"])
def create_worldbook():
    app = get_app()
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()

    err = validate_book_name(name)
    if err:
        return jsonify({"error": err}), 400

    if app.worldbook_service.get_book(name) is not None:
        return jsonify({"error": f"世界书「{name}」已存在"}), 409

    try:
        book = app.worldbook_service.save_book(
            name,
            scope=data.get("scope", {}),
            keywords=data.get("keywords", []),
            content=data.get("content", {}),
            section_meta=data.get("section_meta") if "section_meta" in data else None,
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    bound_personas = _apply_persona_bindings(app, name, data)
    if bound_personas is not None:
        book["bound_personas"] = bound_personas
    return jsonify(book), 201


@api_worldbooks_bp.route("/<name>", methods=["PUT"])
def update_worldbook(name: str):
    app = get_app()
    data = request.get_json(force=True) or {}

    try:
        existing = app.worldbook_service.get_book(name)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if existing is None:
        return jsonify({"error": "世界书不存在"}), 404

    new_name = (data.get("name") or name).strip()
    err = validate_book_name(new_name)
    if err:
        return jsonify({"error": err}), 400

    try:
        book = app.worldbook_service.save_book(
            new_name,
            scope=data.get("scope", existing.get("scope", {})),
            keywords=data.get("keywords", existing.get("keywords", [])),
            content=data.get("content", existing.get("content", {})),
            section_meta=data.get("section_meta") if "section_meta" in data else None,
            old_name=name,
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    # save_book already migrated existing bindings on rename; sync target set after.
    bound_personas = _apply_persona_bindings(app, new_name, data)
    if bound_personas is not None:
        book["bound_personas"] = bound_personas
    return jsonify(book)


@api_worldbooks_bp.route("/<name>", methods=["DELETE"])
def delete_worldbook(name: str):
    app = get_app()
    try:
        ok = app.worldbook_service.delete_book(name)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if not ok:
        return jsonify({"error": "世界书不存在"}), 404
    return jsonify({"ok": True})


# ---- Import ----------------------------------------------------------------

def _stem_filename(filename: str) -> str:
    return os.path.splitext(os.path.basename(filename or ""))[0].strip()


@api_worldbooks_bp.route("/_import", methods=["POST"])
def import_worldbook():
    """Import a worldbook from an uploaded .txt or .json file.

    Delegates shared parsing to ``card_parser`` and ``persona_card`` so this
    entry point and the character-card-embedded worldbook path behave
    identically (sort order, key→section fallback, encoding detection, and
    extras preservation).

    Supported JSON shapes:
      - SillyTavern lorebook: ``{"entries": {...} | [...]}`` (plus optional
        ``name``, ``description``, ``scan_depth``, ``token_budget``,
        ``recursive_scanning``, ``extensions``).
      - PawzoChat native: ``{"name"?, "content": {...}, "scope"?,
        "keywords"?, "extras"?}``.
      - Array of entries: ``[{...}, ...]`` — treated as SillyTavern entries.

    For .txt: the whole file becomes ``content["正文"]``.
    """
    app = get_app()
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "未选择文件"}), 400

    original_name = f.filename or ""
    ext = os.path.splitext(original_name)[1].lower()
    if ext not in (".txt", ".json"):
        return jsonify({"error": "仅支持 .txt 或 .json 文件"}), 400

    raw_bytes = f.read()
    try:
        text = card_parser.decode_card_json(raw_bytes)
    except UnicodeDecodeError:
        return jsonify({"error": "无法识别文件编码"}), 400

    book_name = ""
    content: dict[str, str] = {}
    scope = {"range": "selected", "keyword_filter": False}
    keywords: list[str] = []
    extras: dict = {}
    # ``None`` means "no per-section state was provided" → service will default
    # everything to enabled. An explicit dict (even empty) overwrites.
    section_meta: dict | None = None

    if ext == ".txt":
        book_name = _stem_filename(original_name)
        content = {"正文": text}
    else:
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            return jsonify({"error": f"JSON 解析失败: {exc}"}), 400

        fallback = _stem_filename(original_name)
        if isinstance(parsed, dict) and "entries" in parsed:
            # SillyTavern lorebook — reuse the shared flattener so behavior
            # matches character-card-embedded imports.
            converted = persona_card.character_book_to_worldbook(parsed, fallback_name=fallback)
            book_name = converted["name"] or fallback
            content = converted["content"]
            scope = converted["scope"]
            keywords = converted["keywords"]
            extras = converted.get("extras") or {}
            section_meta = converted.get("section_meta")
        elif isinstance(parsed, list):
            converted = persona_card.character_book_to_worldbook(
                {"entries": parsed}, fallback_name=fallback,
            )
            book_name = fallback
            content = converted["content"]
            scope = converted["scope"]
            keywords = converted["keywords"]
            extras = converted.get("extras") or {}
            section_meta = converted.get("section_meta")
        elif isinstance(parsed, dict) and "content" in parsed:
            # PawzoChat native export.
            book_name = (parsed.get("name") or fallback).strip()
            raw_content = parsed.get("content")
            if isinstance(raw_content, dict):
                content = {str(k): str(v) for k, v in raw_content.items()}
            elif isinstance(raw_content, str):
                content = {"正文": raw_content}
            else:
                return jsonify({"error": "JSON content 字段格式不支持"}), 400
            scope_raw = parsed.get("scope") or {}
            if isinstance(scope_raw, dict):
                scope = {
                    "range": scope_raw.get("range", "selected"),
                    "keyword_filter": bool(scope_raw.get("keyword_filter", False)),
                }
            keywords = list(parsed.get("keywords") or [])
            native_extras = parsed.get("extras")
            if isinstance(native_extras, dict):
                extras = native_extras
            raw_meta = parsed.get("section_meta")
            if isinstance(raw_meta, dict):
                section_meta = raw_meta
        else:
            return jsonify({"error": "无法识别的 JSON 结构"}), 400

    if not book_name:
        return jsonify({"error": "无法确定世界书名称，请重命名文件后再试"}), 400
    if not content:
        return jsonify({"error": "未能从文件中解析出任何内容"}), 400

    err = validate_book_name(book_name)
    if err:
        return jsonify({"error": err}), 400

    final_name = _unique_name(app.worldbook_service, book_name)

    try:
        book = app.worldbook_service.save_book(
            final_name,
            scope=scope,
            keywords=keywords,
            content=content,
            extras=extras,
            section_meta=section_meta,
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify({
        "ok": True,
        "book": book,
        "renamed": final_name != book_name,
        "original_name": book_name,
    }), 201


# ---- Export ----------------------------------------------------------------


@api_worldbooks_bp.route("/<name>/_export", methods=["GET"])
def export_worldbook(name: str):
    """Download a worldbook as PawzoChat native JSON or SillyTavern lorebook JSON.

    Query params:
      - ``format`` (``pawzochat`` | ``sillytavern``): output shape.
    """
    app = get_app()
    try:
        book = app.worldbook_service.get_book(name)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if book is None:
        return jsonify({"error": "世界书不存在"}), 404

    fmt = (request.args.get("format") or "pawzochat").lower()
    stem = safe_download_stem(name) or name

    if fmt == "pawzochat":
        body = json.dumps(book, ensure_ascii=False, indent=2).encode("utf-8")
        return download_response(
            body, "application/json", f"{stem}.pawzo.json", fallback_stem="worldbook",
        )

    if fmt == "sillytavern":
        payload = persona_card.worldbook_to_character_book([book])
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        return download_response(
            body, "application/json", f"{stem}.lorebook.json", fallback_stem="worldbook",
        )

    return jsonify({"error": f"未知导出格式: {fmt}"}), 400
