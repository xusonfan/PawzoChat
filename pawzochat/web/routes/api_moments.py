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

"""REST API for the Moments (朋友圈) feature."""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path

from flask import Blueprint, jsonify, request, send_from_directory

from pawzochat.paths import MOMENTS_DIR
from pawzochat.services.moments import (
    DEFAULT_COUNTER_REPLY_PROMPT,
    DEFAULT_POST_PROMPT,
    DEFAULT_REPLY_PROMPT,
    MAX_PUBLISH_IMAGES,
)
from pawzochat.utils.profile import load_profile_name
from pawzochat.web.routes import get_app

api_moments_bp = Blueprint("api_moments", __name__)

ALLOWED_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
COVER_EXTS = (".png", ".jpg", ".jpeg", ".webp")
MAX_POST_TEXT = 2000
MAX_REPLY_TEXT = 500
MAX_PROMPT_TEXT = 4000
MAX_COVER_BYTES = 10 * 1024 * 1024
MAX_PUBLISH_IMAGE_BYTES = 10 * 1024 * 1024

_MOMENT_ID_RE = re.compile(r"^mom_[0-9a-fA-F]{12}$")
_REPLY_ID_RE = re.compile(r"^rep_[0-9a-fA-F]{12}$")

# Moments uses a stable domain identity for the person operating this
# single-user web panel.  Display names are deliberately not ownership keys.
_CURRENT_USER_AUTHOR = "user"


# ----- helpers -----

def _owned_by_current_user(item: dict) -> bool:
    """Return whether a stored moment/reply belongs to the web-panel user."""
    return item.get("author") == _CURRENT_USER_AUTHOR

def _valid_moment_id(mid: str) -> bool:
    return bool(mid and _MOMENT_ID_RE.match(mid))


def _image_ext_from_upload(filename: str | None, mime: str | None) -> str | None:
    """Pick a normalized lowercase extension or ``None`` to reject."""
    if filename:
        ext = os.path.splitext(filename)[1].lower()
        if ext in ALLOWED_IMAGE_EXTS:
            return ext
    if mime:
        m = mime.lower()
        if m == "image/png":
            return ".png"
        if m in {"image/jpeg", "image/jpg"}:
            return ".jpg"
        if m == "image/webp":
            return ".webp"
        if m == "image/gif":
            return ".gif"
    return None


def _existing_cover() -> Path | None:
    if not MOMENTS_DIR.is_dir():
        return None
    for ext in COVER_EXTS:
        candidate = MOMENTS_DIR / f"cover{ext}"
        if candidate.is_file():
            return candidate
    return None


def _file_version(path: Path) -> str:
    """Return a stable version that changes whenever a managed file changes."""
    try:
        return str(path.stat().st_mtime_ns)
    except OSError:
        return ""


def _cover_url(cover: Path | None = None) -> str:
    cover = cover or _existing_cover()
    if cover is None:
        return ""
    version = _file_version(cover)
    return f"/api/moments/cover?v={version}" if version else "/api/moments/cover"


def _persona_summaries(app) -> list[dict]:
    """Lightweight persona list for the settings UI (id/name/has_avatar)."""
    from pawzochat.paths import CHATS_DIR

    personas = app.config.load_personas()
    result = []
    for pid, p in personas.items():
        avatar = CHATS_DIR / pid / "avatar.png"
        result.append({
            "id": pid,
            "name": p.name,
            "has_avatar": avatar.is_file(),
            "avatar_version": _file_version(avatar),
        })
    return result


def _serialize_moment(app, m: dict) -> dict:
    """Decorate a stored moment with author display info for the frontend."""
    author = m.get("author", "")
    replies_raw = list(m.get("replies", []) or [])
    reply_authors = {r.get("id", ""): r.get("author", "") for r in replies_raw}
    replies = []
    for r in replies_raw:
        rt = r.get("reply_to") or None
        rt_author = reply_authors.get(rt) if rt else None
        replies.append({
            "id": r.get("id", ""),
            "author": r.get("author", ""),
            "author_label": _author_label(app, r.get("author", "")),
            "timestamp": r.get("timestamp", ""),
            "text": r.get("text", ""),
            "reply_to": rt,
            "reply_to_label": _author_label(app, rt_author) if rt_author else None,
            "can_edit": _owned_by_current_user(r),
            "can_delete": _owned_by_current_user(r),
        })
    likes = [
        {"author": w, "author_label": _author_label(app, w)}
        for w in (m.get("likes", []) or [])
    ]
    return {
        "id": m.get("id", ""),
        "author": author,
        "author_label": _author_label(app, author),
        "timestamp": m.get("timestamp", ""),
        "text": m.get("text", ""),
        "images": list(m.get("images", []) or []),
        "likes": likes,
        "replies": replies,
        "can_edit": _owned_by_current_user(m),
        "can_delete": _owned_by_current_user(m),
    }


def _author_label(app, author: str) -> str:
    if author == "user":
        return load_profile_name()
    if not author:
        return ""
    personas = app.config.load_personas()
    p = personas.get(author)
    return p.name if p else author


# ----- routes -----

@api_moments_bp.route("", methods=["GET"])
def list_moments():
    app = get_app()
    before = request.args.get("before") or None
    # Stable author / persona id filter (not display-name matching).
    author_raw = request.args.get("author")
    author = (author_raw or "").strip() or None
    if author is not None and len(author) > 64:
        return jsonify({"error": "invalid author"}), 400
    try:
        limit = int(request.args.get("limit", 20))
    except ValueError:
        limit = 20
    moments, has_more = app.moments_store.list_moments(
        before=before, limit=limit, author=author,
    )
    return jsonify({
        "moments": [_serialize_moment(app, m) for m in moments],
        "has_more": has_more,
    })


@api_moments_bp.route("/<moment_id>", methods=["GET"])
def get_moment(moment_id: str):
    app = get_app()
    if not _valid_moment_id(moment_id):
        return jsonify({"error": "invalid id"}), 400
    m = app.moments_store.get_moment(moment_id)
    if m is None:
        return jsonify({"error": "not found"}), 404
    return jsonify({"moment": _serialize_moment(app, m)})


@api_moments_bp.route("", methods=["POST"])
def publish_moment():
    app = get_app()
    text = (request.form.get("text", "") or "").strip()
    if len(text) > MAX_POST_TEXT:
        return jsonify({"error": "文案过长"}), 400

    uploads = request.files.getlist("images") or []
    if len(uploads) > MAX_PUBLISH_IMAGES:
        return jsonify({"error": f"最多上传 {MAX_PUBLISH_IMAGES} 张图片"}), 400

    image_files: list[tuple[bytes, str]] = []
    for f in uploads:
        ext = _image_ext_from_upload(f.filename, f.mimetype)
        if ext is None:
            return jsonify({"error": f"不支持的图片格式: {f.filename}"}), 400
        data = f.read()
        if len(data) > MAX_PUBLISH_IMAGE_BYTES:
            return jsonify({"error": f"图片过大: {f.filename}"}), 400
        image_files.append((data, ext))

    if not text and not image_files:
        return jsonify({"error": "文案与图片不能同时为空"}), 400

    try:
        moment_id = app.moments_service.publish(
            text=text, image_files=image_files,
        )
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 409
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify({"ok": True, "moment_id": moment_id}), 201


@api_moments_bp.route("/<moment_id>", methods=["DELETE"])
def delete_moment(moment_id: str):
    app = get_app()
    if not _valid_moment_id(moment_id):
        return jsonify({"error": "invalid id"}), 400
    existing = app.moments_store.get_moment(moment_id)
    if existing is None:
        return jsonify({"error": "not found"}), 404
    if not _owned_by_current_user(existing):
        return jsonify({"error": "只能删除自己发布的朋友圈"}), 403
    ok = app.moments_service.delete_moment(moment_id)
    if not ok:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@api_moments_bp.route("/<moment_id>", methods=["PATCH"])
def edit_moment(moment_id: str):
    app = get_app()
    if not _valid_moment_id(moment_id):
        return jsonify({"error": "invalid id"}), 400
    existing = app.moments_store.get_moment(moment_id)
    if existing is None:
        return jsonify({"error": "not found"}), 404
    if not _owned_by_current_user(existing):
        return jsonify({"error": "只能编辑自己发布的朋友圈"}), 403
    body = request.get_json(force=True, silent=True) or {}
    if "text" not in body:
        return jsonify({"error": "缺少 text 字段"}), 400
    raw = body.get("text")
    if not isinstance(raw, str):
        return jsonify({"error": "text 必须为字符串"}), 400
    text = raw.strip()
    if len(text) > MAX_POST_TEXT:
        return jsonify({"error": "文案过长"}), 400
    # A pure-text moment cannot be emptied — same constraint as publish.
    if not text and not (existing.get("images") or []):
        return jsonify({"error": "文案与图片不能同时为空"}), 400
    ok = app.moments_service.update_moment_text(moment_id, text=text)
    if not ok:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True, "text": text})


@api_moments_bp.route("/<moment_id>/like", methods=["POST"])
def like_moment(moment_id: str):
    app = get_app()
    if not _valid_moment_id(moment_id):
        return jsonify({"error": "invalid id"}), 400
    if app.moments_store.get_moment(moment_id) is None:
        return jsonify({"error": "not found"}), 404
    added = app.moments_service.like(moment_id, "user")
    return jsonify({"ok": True, "added": added})


@api_moments_bp.route("/<moment_id>/like", methods=["DELETE"])
def unlike_moment(moment_id: str):
    app = get_app()
    if not _valid_moment_id(moment_id):
        return jsonify({"error": "invalid id"}), 400
    if app.moments_store.get_moment(moment_id) is None:
        return jsonify({"error": "not found"}), 404
    removed = app.moments_service.unlike(moment_id, "user")
    return jsonify({"ok": True, "removed": removed})


@api_moments_bp.route("/<moment_id>/replies", methods=["POST"])
def post_reply(moment_id: str):
    app = get_app()
    if not _valid_moment_id(moment_id):
        return jsonify({"error": "invalid id"}), 400
    body = request.get_json(force=True, silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        return jsonify({"error": "评论内容不能为空"}), 400
    if len(text) > MAX_REPLY_TEXT:
        return jsonify({"error": f"评论过长（上限 {MAX_REPLY_TEXT} 字）"}), 400
    reply_to = body.get("reply_to") or None
    if reply_to is not None:
        if not isinstance(reply_to, str) or not _REPLY_ID_RE.match(reply_to):
            return jsonify({"error": "invalid reply_to"}), 400

    try:
        result = app.moments_service.user_reply(
            moment_id, text=text, reply_to=reply_to,
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if result is None:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True, **result}), 201


@api_moments_bp.route("/<moment_id>/replies/<reply_id>", methods=["DELETE"])
def delete_reply(moment_id: str, reply_id: str):
    app = get_app()
    if not _valid_moment_id(moment_id):
        return jsonify({"error": "invalid id"}), 400
    if not _REPLY_ID_RE.match(reply_id):
        return jsonify({"error": "invalid reply_id"}), 400
    moment = app.moments_store.get_moment(moment_id)
    if moment is None:
        return jsonify({"error": "moment not found"}), 404
    reply = app.moments_store.get_reply(moment_id, reply_id)
    if reply is None:
        return jsonify({"error": "reply not found"}), 404
    if not _owned_by_current_user(reply):
        return jsonify({"error": "只能删除自己的评论"}), 403
    result = app.moments_service.delete_reply(moment_id, reply_id)
    if result is None:
        return jsonify({"error": "moment not found"}), 404
    if not result:
        return jsonify({"error": "reply not found"}), 404
    return jsonify({"ok": True, "deleted_ids": result})


@api_moments_bp.route("/<moment_id>/replies/<reply_id>", methods=["PATCH"])
def edit_reply(moment_id: str, reply_id: str):
    app = get_app()
    if not _valid_moment_id(moment_id):
        return jsonify({"error": "invalid id"}), 400
    if not _REPLY_ID_RE.match(reply_id):
        return jsonify({"error": "invalid reply_id"}), 400
    moment = app.moments_store.get_moment(moment_id)
    if moment is None:
        return jsonify({"error": "moment not found"}), 404
    reply = app.moments_store.get_reply(moment_id, reply_id)
    if reply is None:
        return jsonify({"error": "reply not found"}), 404
    if not _owned_by_current_user(reply):
        return jsonify({"error": "只能编辑自己的评论"}), 403
    body = request.get_json(force=True, silent=True) or {}
    if "text" not in body:
        return jsonify({"error": "缺少 text 字段"}), 400
    raw = body.get("text")
    if not isinstance(raw, str):
        return jsonify({"error": "text 必须为字符串"}), 400
    text = raw.strip()
    if not text:
        return jsonify({"error": "评论内容不能为空"}), 400
    if len(text) > MAX_REPLY_TEXT:
        return jsonify({"error": f"评论过长（上限 {MAX_REPLY_TEXT} 字）"}), 400
    result = app.moments_service.update_reply_text(
        moment_id, reply_id, text=text,
    )
    if result is None:
        return jsonify({"error": "moment not found"}), 404
    if result is False:
        return jsonify({"error": "reply not found"}), 404
    return jsonify({"ok": True, "text": text})


@api_moments_bp.route("/refresh", methods=["POST"])
def refresh_moments():
    app = get_app()
    try:
        result = app.moments_service.refresh()
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 409
    return jsonify({"ok": True, **result})


@api_moments_bp.route("/state", methods=["GET"])
def get_state():
    app = get_app()
    return jsonify(app.moments_service.get_state())


# ----- settings -----

@api_moments_bp.route("/settings", methods=["GET"])
def get_settings():
    app = get_app()
    cfg = app.config.get("moments", default={}) or {}
    prompts = cfg.get("prompts", {}) or {}
    saved_probs = cfg.get("reply_probabilities", {}) or {}
    saved_mem = cfg.get("memory_enabled", {}) or {}
    personas = _persona_summaries(app)
    probabilities: dict[str, int] = {}
    memory_enabled: dict[str, bool] = {}
    for p in personas:
        try:
            v = int(saved_probs.get(p["id"], 50))
        except (TypeError, ValueError):
            v = 50
        probabilities[p["id"]] = max(0, min(100, v))
        memory_enabled[p["id"]] = bool(saved_mem.get(p["id"], True))
    return jsonify({
        "publishers": list(cfg.get("publishers", []) or []),
        "repliers": list(cfg.get("repliers", []) or []),
        "reply_probabilities": probabilities,
        "memory_enabled": memory_enabled,
        "prompts": {
            "post": (prompts.get("post") or "").strip() or DEFAULT_POST_PROMPT,
            "reply": (prompts.get("reply") or "").strip() or DEFAULT_REPLY_PROMPT,
            "counter_reply": (prompts.get("counter_reply") or "").strip() or DEFAULT_COUNTER_REPLY_PROMPT,
            "post_default": DEFAULT_POST_PROMPT,
            "reply_default": DEFAULT_REPLY_PROMPT,
            "counter_reply_default": DEFAULT_COUNTER_REPLY_PROMPT,
        },
        "personas": personas,
        # Versioned cover URL so browsers can cache the binary long-term and
        # still pick up a new cover immediately after upload/replace.
        "cover_url": _cover_url(),
    })


@api_moments_bp.route("/settings", methods=["PUT"])
def update_settings():
    app = get_app()
    body = request.get_json(force=True, silent=True) or {}

    publishers_raw = body.get("publishers", [])
    repliers_raw = body.get("repliers", [])
    if not isinstance(publishers_raw, list) or not isinstance(repliers_raw, list):
        return jsonify({"error": "publishers/repliers 必须为列表"}), 400

    valid_ids = set((app.config.get("personas", default={}) or {}).keys())
    publishers = [pid for pid in publishers_raw if isinstance(pid, str) and pid in valid_ids]
    repliers = [pid for pid in repliers_raw if isinstance(pid, str) and pid in valid_ids]
    # Drop duplicates but preserve order.
    publishers = list(dict.fromkeys(publishers))
    repliers = list(dict.fromkeys(repliers))

    probs_in = body.get("reply_probabilities", {}) or {}
    if not isinstance(probs_in, dict):
        return jsonify({"error": "reply_probabilities 必须为对象"}), 400
    probabilities: dict[str, int] = {}
    for pid, raw in probs_in.items():
        if not isinstance(pid, str) or pid not in valid_ids:
            continue
        try:
            v = int(raw)
        except (TypeError, ValueError):
            continue
        probabilities[pid] = max(0, min(100, v))

    mem_in = body.get("memory_enabled", {}) or {}
    if not isinstance(mem_in, dict):
        return jsonify({"error": "memory_enabled 必须为对象"}), 400
    memory_enabled: dict[str, bool] = {}
    for pid, raw in mem_in.items():
        if not isinstance(pid, str) or pid not in valid_ids:
            continue
        memory_enabled[pid] = bool(raw)

    prompts_in = body.get("prompts", {}) or {}
    if not isinstance(prompts_in, dict):
        return jsonify({"error": "prompts 必须为对象"}), 400
    post_prompt = (prompts_in.get("post") or "").strip()
    reply_prompt = (prompts_in.get("reply") or "").strip()
    counter_reply_prompt = (prompts_in.get("counter_reply") or "").strip()
    if (
        len(post_prompt) > MAX_PROMPT_TEXT
        or len(reply_prompt) > MAX_PROMPT_TEXT
        or len(counter_reply_prompt) > MAX_PROMPT_TEXT
    ):
        return jsonify({"error": "提示词过长"}), 400
    # Persist as empty when the user-edited value equals the built-in default —
    # keeps config.yaml clean and lets future default tweaks reach existing users.
    if post_prompt == DEFAULT_POST_PROMPT.strip():
        post_prompt = ""
    if reply_prompt == DEFAULT_REPLY_PROMPT.strip():
        reply_prompt = ""
    if counter_reply_prompt == DEFAULT_COUNTER_REPLY_PROMPT.strip():
        counter_reply_prompt = ""

    with app.config.lock:
        moments_cfg = dict(app.config.get("moments", default={}) or {})
        moments_cfg["publishers"] = publishers
        moments_cfg["repliers"] = repliers
        moments_cfg["reply_probabilities"] = probabilities
        moments_cfg["memory_enabled"] = memory_enabled
        moments_cfg["prompts"] = {
            "post": post_prompt,
            "reply": reply_prompt,
            "counter_reply": counter_reply_prompt,
        }
        # Drop the legacy global-probability key if present so the saved
        # YAML stays clean.
        moments_cfg.pop("reply_probability", None)
        app.config._data["moments"] = moments_cfg
        app.config.save()

    return jsonify({"ok": True})


# ----- cover image -----

@api_moments_bp.route("/cover", methods=["GET"])
def serve_cover():
    cover = _existing_cover()
    if cover is None:
        return jsonify({"error": "not found"}), 404
    # conditional=True enables ETag/304; with ?v= the URL itself is the
    # cache key (mtime changes on replace), matching avatar caching.
    resp = send_from_directory(str(MOMENTS_DIR), cover.name, conditional=True)
    if request.args.get("v"):
        resp.headers["Cache-Control"] = "private, max-age=31536000, immutable"
    else:
        resp.headers["Cache-Control"] = "private, no-cache"
    return resp


@api_moments_bp.route("/cover", methods=["POST"])
def upload_cover():
    f = request.files.get("cover")
    if not f:
        return jsonify({"error": "未选择文件"}), 400
    ext = _image_ext_from_upload(f.filename, f.mimetype)
    if ext is None:
        return jsonify({"error": "不支持的图片格式"}), 400
    data = f.read()
    if not data:
        return jsonify({"error": "文件为空"}), 400
    if len(data) > MAX_COVER_BYTES:
        return jsonify({"error": "封面图过大（上限 10 MB）"}), 400

    MOMENTS_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path: str | None = None
    try:
        fd, tmp_path = tempfile.mkstemp(
            dir=str(MOMENTS_DIR),
            prefix=".cover_",
            suffix=ext,
        )
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp_path, str(MOMENTS_DIR / f"cover{ext}"))
        tmp_path = None
        # Drop any previously stored cover regardless of extension.
        for old_ext in COVER_EXTS:
            if old_ext == ext:
                continue
            old = MOMENTS_DIR / f"cover{old_ext}"
            if old.is_file():
                try:
                    old.unlink()
                except OSError:
                    pass
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    return jsonify({"ok": True, "cover_url": _cover_url()})


@api_moments_bp.route("/cover", methods=["DELETE"])
def delete_cover():
    removed = False
    for ext in COVER_EXTS:
        old = MOMENTS_DIR / f"cover{ext}"
        if old.is_file():
            try:
                old.unlink()
                removed = True
            except OSError:
                pass
    return jsonify({"ok": True, "removed": removed, "cover_url": ""})


# ----- image serving -----

@api_moments_bp.route("/images/<moment_id>/<filename>", methods=["GET"])
def serve_image(moment_id: str, filename: str):
    app = get_app()
    path = app.moments_store.get_image_path(moment_id, filename)
    if path is None:
        return jsonify({"error": "not found"}), 404
    # Filenames are random hex (img_<hex>.ext) with immutable content, same
    # policy as chat images — long-lived browser cache, no third-party URLs.
    resp = send_from_directory(str(path.parent), path.name, conditional=True)
    resp.headers["Cache-Control"] = "private, max-age=31536000, immutable"
    return resp
