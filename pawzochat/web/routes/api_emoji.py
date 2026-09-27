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

"""REST API for emoji pack management — groups, emotions, images."""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from flask import Blueprint, jsonify, request

from pawzochat.paths import EMOJI_DIR
from pawzochat.web.routes import download_response, get_app, safe_download_stem

api_emoji_bp = Blueprint("api_emoji", __name__)

ALLOWED_IMAGE_EXTS = {".png", ".gif", ".jpg", ".jpeg", ".webp"}

_ILLEGAL_CHARS_RE = re.compile(r'[\\/:*?"<>|]')
_RESERVED_NAMES = frozenset(
    [".", "..", "CON", "PRN", "AUX", "NUL"]
    + [f"COM{i}" for i in range(1, 10)]
    + [f"LPT{i}" for i in range(1, 10)]
)


def _validate_fs_name(name: str) -> str | None:
    """Return an error message if *name* is invalid for use as a directory or file stem."""
    if not name:
        return "名称不能为空"
    if len(name) > 50:
        return "名称过长（最多 50 个字符）"
    if _ILLEGAL_CHARS_RE.search(name):
        return "名称包含非法字符，不可使用 \\ / : * ? \" < > |"
    if name.upper() in _RESERVED_NAMES:
        return f"「{name}」是系统保留名称"
    if name.startswith((" ", ".")) or name.endswith((" ", ".")):
        return "名称不能以空格或句点开头/结尾"
    return None


def _validate_image_filename(filename: str) -> str | None:
    """Validate a complete image filename (stem + extension)."""
    if not filename:
        return "文件名不能为空"
    stem, ext = os.path.splitext(filename)
    err = _validate_fs_name(stem)
    if err:
        return err
    if ext.lower() not in ALLOWED_IMAGE_EXTS:
        return f"不支持的图片格式，仅允许: {', '.join(sorted(ALLOWED_IMAGE_EXTS))}"
    return None


def _safe_path(base: Path, *parts: str) -> Path | None:
    """Resolve a path and ensure it stays within *base*. Returns None on escape."""
    target = base.joinpath(*parts).resolve()
    try:
        target.relative_to(base.resolve())
    except ValueError:
        return None
    return target


# ---------------------------------------------------------------------------
# Groups
# ---------------------------------------------------------------------------

@api_emoji_bp.route("/groups", methods=["GET"])
def list_groups():
    EMOJI_DIR.mkdir(parents=True, exist_ok=True)
    groups = []
    for entry in sorted(EMOJI_DIR.iterdir()):
        if not entry.is_dir():
            continue
        emotions = []
        total_images = 0
        for emo_entry in sorted(entry.iterdir()):
            if not emo_entry.is_dir():
                continue
            count = sum(
                1 for f in emo_entry.iterdir()
                if f.is_file() and f.suffix.lower() in ALLOWED_IMAGE_EXTS
            )
            emotions.append({"name": emo_entry.name, "image_count": count})
            total_images += count
        groups.append({
            "name": entry.name,
            "emotions": emotions,
            "total_images": total_images,
        })
    return jsonify({"groups": groups})


@api_emoji_bp.route("/groups", methods=["POST"])
def create_group():
    data = request.get_json(force=True)
    name = data.get("name", "").strip()
    err = _validate_fs_name(name)
    if err:
        return jsonify({"error": err}), 400

    target = _safe_path(EMOJI_DIR, name)
    if target is None:
        return jsonify({"error": "非法路径"}), 400
    if target.exists():
        return jsonify({"error": f"分组「{name}」已存在"}), 409

    target.mkdir(parents=True)
    return jsonify({"ok": True}), 201


@api_emoji_bp.route("/groups/<path:name>", methods=["PATCH"])
def rename_group(name: str):
    err = _validate_fs_name(name)
    if err:
        return jsonify({"error": f"原名称无效: {err}"}), 400

    data = request.get_json(force=True)
    new_name = data.get("name", "").strip()
    err = _validate_fs_name(new_name)
    if err:
        return jsonify({"error": err}), 400

    src = _safe_path(EMOJI_DIR, name)
    dst = _safe_path(EMOJI_DIR, new_name)
    if src is None or dst is None:
        return jsonify({"error": "非法路径"}), 400
    if not src.is_dir():
        return jsonify({"error": "分组不存在"}), 404
    if dst.exists():
        return jsonify({"error": f"分组「{new_name}」已存在"}), 409

    src.rename(dst)

    _sync_persona_emoji_group(name, new_name)
    return jsonify({"ok": True})


@api_emoji_bp.route("/groups/<path:name>", methods=["DELETE"])
def delete_group(name: str):
    err = _validate_fs_name(name)
    if err:
        return jsonify({"error": f"名称无效: {err}"}), 400

    target = _safe_path(EMOJI_DIR, name)
    if target is None:
        return jsonify({"error": "非法路径"}), 400
    if not target.is_dir():
        return jsonify({"error": "分组不存在"}), 404

    referencing = _find_personas_using_group(name)
    force = request.args.get("force", "").lower() == "true"
    expected_refs_raw = request.args.get("expected_refs")

    if force and expected_refs_raw is not None:
        try:
            expected_refs = json.loads(expected_refs_raw)
        except json.JSONDecodeError:
            return jsonify({"error": "expected_refs 格式无效"}), 400
        if not isinstance(expected_refs, list) or not all(isinstance(v, str) for v in expected_refs):
            return jsonify({"error": "expected_refs 格式无效"}), 400
        current_ids = sorted(r["id"] for r in referencing)
        if current_ids != sorted(expected_refs):
            return jsonify({
                "error": "表情包绑定状态已变化，请重试",
                "referencing_personas": referencing,
                "stale_references": True,
            }), 409

    if referencing and not force:
        names = [r["name"] for r in referencing]
        return jsonify({
            "error": "该分组正在被角色使用",
            "referencing_personas": referencing,
            "message": f"以下角色正在使用此分组：{', '.join(names)}。确认删除将清空这些角色的表情包分组设置。",
        }), 409

    shutil.rmtree(target)

    if referencing:
        _clear_persona_emoji_group(name)

    return jsonify({"ok": True})


@api_emoji_bp.route("/groups/<path:name>/references", methods=["GET"])
def get_group_references(name: str):
    """List personas referencing this group — used by the delete-confirmation UI
    so it can fold the "this clears bindings" warning into a single dialog."""
    err = _validate_fs_name(name)
    if err:
        return jsonify({"error": f"名称无效: {err}"}), 400
    target = _safe_path(EMOJI_DIR, name)
    if target is None or not target.is_dir():
        return jsonify({"error": "分组不存在"}), 404
    return jsonify({"referencing_personas": _find_personas_using_group(name)})


# ---------------------------------------------------------------------------
# Emotions
# ---------------------------------------------------------------------------

@api_emoji_bp.route("/groups/<path:group>/emotions", methods=["POST"])
def create_emotion(group: str):
    for n in [group]:
        err = _validate_fs_name(n)
        if err:
            return jsonify({"error": f"路径参数无效: {err}"}), 400

    data = request.get_json(force=True)
    name = data.get("name", "").strip()
    err = _validate_fs_name(name)
    if err:
        return jsonify({"error": err}), 400

    group_dir = _safe_path(EMOJI_DIR, group)
    if group_dir is None or not group_dir.is_dir():
        return jsonify({"error": "分组不存在"}), 404

    target = _safe_path(EMOJI_DIR, group, name)
    if target is None:
        return jsonify({"error": "非法路径"}), 400
    if target.exists():
        return jsonify({"error": f"情绪分类「{name}」已存在"}), 409

    target.mkdir()
    return jsonify({"ok": True}), 201


@api_emoji_bp.route("/groups/<path:group>/emotions/<path:name>", methods=["PATCH"])
def rename_emotion(group: str, name: str):
    for n in [group, name]:
        err = _validate_fs_name(n)
        if err:
            return jsonify({"error": f"路径参数无效: {err}"}), 400

    data = request.get_json(force=True)
    new_name = data.get("name", "").strip()
    err = _validate_fs_name(new_name)
    if err:
        return jsonify({"error": err}), 400

    src = _safe_path(EMOJI_DIR, group, name)
    dst = _safe_path(EMOJI_DIR, group, new_name)
    if src is None or dst is None:
        return jsonify({"error": "非法路径"}), 400
    if not src.is_dir():
        return jsonify({"error": "情绪分类不存在"}), 404
    if dst.exists():
        return jsonify({"error": f"情绪分类「{new_name}」已存在"}), 409

    src.rename(dst)
    return jsonify({"ok": True})


@api_emoji_bp.route("/groups/<path:group>/emotions/<path:name>", methods=["DELETE"])
def delete_emotion(group: str, name: str):
    for n in [group, name]:
        err = _validate_fs_name(n)
        if err:
            return jsonify({"error": f"路径参数无效: {err}"}), 400

    target = _safe_path(EMOJI_DIR, group, name)
    if target is None:
        return jsonify({"error": "非法路径"}), 400
    if not target.is_dir():
        return jsonify({"error": "情绪分类不存在"}), 404

    shutil.rmtree(target)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------

@api_emoji_bp.route("/groups/<path:group>/all-images", methods=["GET"])
def list_all_images(group: str):
    """Return every image across all emotions in *group* as a flat list."""
    err = _validate_fs_name(group)
    if err:
        return jsonify({"error": f"路径参数无效: {err}"}), 400

    group_dir = _safe_path(EMOJI_DIR, group)
    if group_dir is None or not group_dir.is_dir():
        return jsonify({"error": "分组不存在"}), 404

    images = []
    for emo_entry in sorted(group_dir.iterdir()):
        if not emo_entry.is_dir():
            continue
        for f in sorted(emo_entry.iterdir()):
            if f.is_file() and f.suffix.lower() in ALLOWED_IMAGE_EXTS:
                images.append({
                    "filename": f.name,
                    "url": f"/emoji-static/{group}/{emo_entry.name}/{f.name}",
                })
    return jsonify({"images": images})


@api_emoji_bp.route("/groups/<path:group>/emotions/<path:emotion>/images", methods=["GET"])
def list_images(group: str, emotion: str):
    for n in [group, emotion]:
        err = _validate_fs_name(n)
        if err:
            return jsonify({"error": f"路径参数无效: {err}"}), 400

    target = _safe_path(EMOJI_DIR, group, emotion)
    if target is None or not target.is_dir():
        return jsonify({"error": "路径不存在"}), 404

    images = []
    for f in sorted(target.iterdir()):
        if f.is_file() and f.suffix.lower() in ALLOWED_IMAGE_EXTS:
            images.append({
                "filename": f.name,
                "url": f"/emoji-static/{group}/{emotion}/{f.name}",
            })
    return jsonify({"images": images})


@api_emoji_bp.route("/groups/<path:group>/emotions/<path:emotion>/images", methods=["POST"])
def upload_images(group: str, emotion: str):
    for n in [group, emotion]:
        err = _validate_fs_name(n)
        if err:
            return jsonify({"error": f"路径参数无效: {err}"}), 400

    target = _safe_path(EMOJI_DIR, group, emotion)
    if target is None or not target.is_dir():
        return jsonify({"error": "路径不存在"}), 404

    files = request.files.getlist("files")
    if not files:
        return jsonify({"error": "没有上传文件"}), 400

    saved = []
    for f in files:
        filename = f.filename or ""
        err = _validate_image_filename(filename)
        if err:
            return jsonify({"error": f"文件「{filename}」: {err}"}), 400

        dest = _safe_path(EMOJI_DIR, group, emotion, filename)
        if dest is None:
            return jsonify({"error": "非法路径"}), 400

        f.save(str(dest))
        saved.append(filename)

    return jsonify({"ok": True, "saved": saved}), 201


@api_emoji_bp.route(
    "/groups/<path:group>/emotions/<path:emotion>/images/<path:filename>",
    methods=["PATCH"],
)
def rename_image(group: str, emotion: str, filename: str):
    for n in [group, emotion]:
        err = _validate_fs_name(n)
        if err:
            return jsonify({"error": f"路径参数无效: {err}"}), 400

    err = _validate_image_filename(filename)
    if err:
        return jsonify({"error": f"原文件名无效: {err}"}), 400

    data = request.get_json(force=True)
    new_filename = data.get("filename", "").strip()
    err = _validate_image_filename(new_filename)
    if err:
        return jsonify({"error": err}), 400

    src = _safe_path(EMOJI_DIR, group, emotion, filename)
    dst = _safe_path(EMOJI_DIR, group, emotion, new_filename)
    if src is None or dst is None:
        return jsonify({"error": "非法路径"}), 400
    if not src.is_file():
        return jsonify({"error": "文件不存在"}), 404
    if dst.exists():
        return jsonify({"error": f"文件「{new_filename}」已存在"}), 409

    src.rename(dst)
    return jsonify({"ok": True})


@api_emoji_bp.route(
    "/groups/<path:group>/emotions/<path:emotion>/images/<path:filename>",
    methods=["DELETE"],
)
def delete_image(group: str, emotion: str, filename: str):
    for n in [group, emotion]:
        err = _validate_fs_name(n)
        if err:
            return jsonify({"error": f"路径参数无效: {err}"}), 400

    err = _validate_image_filename(filename)
    if err:
        return jsonify({"error": f"文件名无效: {err}"}), 400

    target = _safe_path(EMOJI_DIR, group, emotion, filename)
    if target is None:
        return jsonify({"error": "非法路径"}), 400
    if not target.is_file():
        return jsonify({"error": "文件不存在"}), 404

    target.unlink()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Import / Export — single group as PawzoChat-native zip
# ---------------------------------------------------------------------------

EMOJI_PACK_FORMAT = "pawzochat-emoji-pack"
EMOJI_PACK_VERSION = 1
EMOJI_PACK_MAX_FILES = 2000
EMOJI_PACK_MAX_FILE_BYTES = 20 * 1024 * 1024
EMOJI_PACK_MAX_TOTAL_BYTES = 200 * 1024 * 1024


def _unique_group_name(name: str) -> str:
    """Return name if free, else append _2, _3, ... until the dir does not exist."""
    if not (EMOJI_DIR / name).exists():
        return name
    i = 2
    while True:
        suffix = f"_{i}"
        base_limit = 50 - len(suffix)
        base = name[:base_limit].rstrip(" .") if base_limit > 0 else ""
        if not base:
            base = "emoji"
        candidate = f"{base}{suffix}"
        if not (EMOJI_DIR / candidate).exists():
            return candidate
        i += 1


@api_emoji_bp.route("/groups/<path:name>/_export", methods=["GET"])
def export_group(name: str):
    """Download a single emoji group as a PawzoChat-native zip pack."""
    err = _validate_fs_name(name)
    if err:
        return jsonify({"error": f"名称无效: {err}"}), 400

    group_dir = _safe_path(EMOJI_DIR, name)
    if group_dir is None or not group_dir.is_dir():
        return jsonify({"error": "分组不存在"}), 404

    emotions_summary: list[dict] = []
    buf = io.BytesIO()
    # ZIP_STORED: emoji images are already compressed (png/gif/jpg/webp);
    # DEFLATE adds CPU cost with near-zero size benefit.
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        for emo_entry in sorted(group_dir.iterdir()):
            if not emo_entry.is_dir():
                continue
            count = 0
            for img in sorted(emo_entry.iterdir()):
                if img.is_file() and img.suffix.lower() in ALLOWED_IMAGE_EXTS:
                    arc = f"emotions/{emo_entry.name}/{img.name}"
                    zf.write(img, arcname=arc)
                    count += 1
            emotions_summary.append({"name": emo_entry.name, "image_count": count})

        manifest = {
            "format": EMOJI_PACK_FORMAT,
            "version": EMOJI_PACK_VERSION,
            "name": name,
            "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "emotions": emotions_summary,
        }
        zf.writestr(
            "manifest.json",
            json.dumps(manifest, ensure_ascii=False, indent=2),
        )

    stem = safe_download_stem(name) or name
    return download_response(
        buf.getvalue(),
        "application/zip",
        f"{stem}_emoji_pawzochat.zip",
        fallback_stem="emoji-pack",
    )


@api_emoji_bp.route("/_import", methods=["POST"])
def import_group():
    """Import a single emoji group from a PawzoChat-native zip pack.

    Same conflict policy as worldbook import: on name clash, auto-suffix
    ``_2``, ``_3``, ... — never overwrites existing groups.
    """
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "未选择文件"}), 400

    original_filename = f.filename or ""
    if not original_filename.lower().endswith(".zip"):
        return jsonify({"error": "仅支持 .zip 文件"}), 400

    raw = f.read()
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        return jsonify({"error": "无法读取 zip 文件"}), 400

    try:
        manifest_bytes = zf.read("manifest.json")
    except KeyError:
        return jsonify({"error": "无法识别的表情包格式（缺少 manifest.json）"}), 400

    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return jsonify({"error": "无法识别的表情包格式（manifest.json 解析失败）"}), 400

    if not isinstance(manifest, dict) or manifest.get("format") != EMOJI_PACK_FORMAT:
        return jsonify({"error": "无法识别的表情包格式"}), 400

    raw_name = str(manifest.get("name") or "").strip()
    if not raw_name:
        # Fallback to the upload filename stem. Strip our native suffix first
        # so a re-imported `<group>_emoji_pawzochat.zip` resolves back to <group>.
        stem = original_filename
        for suffix in ("_emoji_pawzochat.zip", ".zip"):
            if stem.lower().endswith(suffix):
                stem = stem[: -len(suffix)]
                break
        raw_name = os.path.basename(stem).strip()

    err = _validate_fs_name(raw_name)
    if err:
        return jsonify({"error": f"分组名无效: {err}"}), 400

    EMOJI_DIR.mkdir(parents=True, exist_ok=True)
    final_name = _unique_group_name(raw_name)
    final_dir = _safe_path(EMOJI_DIR, final_name)
    if final_dir is None:
        return jsonify({"error": "非法路径"}), 400

    # Phase 1 — validate every entry before touching the filesystem.
    file_entries: list[tuple[str, str, zipfile.ZipInfo]] = []
    total_uncompressed = 0
    for info in zf.infolist():
        if info.flag_bits & 0x1:
            return jsonify({"error": "不支持加密 zip 文件"}), 400
        if info.is_dir():
            continue
        arc = info.filename
        if arc == "manifest.json":
            continue
        # Normalize and reject absolute paths or backrefs explicitly; the
        # _safe_path check below catches this too but a clear error helps.
        normalized = arc.replace("\\", "/")
        if normalized.startswith("/") or ".." in normalized.split("/"):
            return jsonify({"error": f"非法路径: {arc}"}), 400

        parts = [p for p in normalized.split("/") if p]
        if len(parts) != 3 or parts[0] != "emotions":
            return jsonify({"error": f"非法路径: {arc}"}), 400

        emotion, filename = parts[1], parts[2]
        e = _validate_fs_name(emotion)
        if e:
            return jsonify({"error": f"情绪分类名无效「{emotion}」: {e}"}), 400
        e = _validate_image_filename(filename)
        if e:
            return jsonify({"error": f"图片文件名无效「{filename}」: {e}"}), 400
        if info.file_size > EMOJI_PACK_MAX_FILE_BYTES:
            return jsonify({"error": f"图片文件过大「{filename}」"}), 400
        total_uncompressed += info.file_size
        if total_uncompressed > EMOJI_PACK_MAX_TOTAL_BYTES:
            return jsonify({"error": "表情包过大，请拆分后导入"}), 400
        if len(file_entries) >= EMOJI_PACK_MAX_FILES:
            return jsonify({"error": "表情包图片数量过多，请拆分后导入"}), 400

        file_entries.append((emotion, filename, info))

    # Phase 2 — write into a sibling temp dir, then atomic-ish rename. Any
    # failure (zip slip detected here, IO error) cleans up the temp dir so
    # we never leave a half-imported group behind.
    tmp_dir = Path(tempfile.mkdtemp(prefix=f"{final_name}.tmp_", dir=str(EMOJI_DIR)))
    try:
        for emotion, filename, info in file_entries:
            target = _safe_path(tmp_dir, emotion, filename)
            if target is None:
                return jsonify({"error": f"非法路径: emotions/{emotion}/{filename}"}), 400
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)

        # Materialize empty emotion dirs declared in manifest (a group can
        # legitimately have an emotion with zero images yet, e.g. a fresh
        # placeholder). Skip silently if the manifest entry is malformed.
        for emo in manifest.get("emotions") or []:
            if not isinstance(emo, dict):
                continue
            ename = str(emo.get("name") or "").strip()
            if not ename or _validate_fs_name(ename):
                continue
            edir = _safe_path(tmp_dir, ename)
            if edir is None:
                continue
            edir.mkdir(parents=True, exist_ok=True)

        tmp_dir.rename(final_dir)
    except Exception as exc:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return jsonify({"error": f"导入失败: {exc}"}), 500

    return jsonify({
        "ok": True,
        "group": final_name,
        "renamed": final_name != raw_name,
        "original_name": raw_name,
    }), 201


# ---------------------------------------------------------------------------
# Helpers — persona emoji_group sync
# ---------------------------------------------------------------------------

def _find_personas_using_group(group_name: str) -> list[dict]:
    """Return persona names/ids that reference the given emoji group."""
    app = get_app()
    personas_cfg = app.config.get("personas", default={})
    result = []
    for pid, pdata in personas_cfg.items():
        if pdata.get("emoji_group") == group_name:
            result.append({"id": pid, "name": pdata.get("name", pid)})
    return result


def _sync_persona_emoji_group(old_name: str, new_name: str):
    """After renaming a group, update all personas that referenced the old name."""
    app = get_app()
    personas_cfg = app.config.get("personas", default={})
    changed = False
    for pdata in personas_cfg.values():
        if pdata.get("emoji_group") == old_name:
            pdata["emoji_group"] = new_name
            changed = True
    if changed:
        app.config.save()


def _clear_persona_emoji_group(group_name: str):
    """After deleting a group, clear emoji_group for all personas that used it."""
    app = get_app()
    personas_cfg = app.config.get("personas", default={})
    changed = False
    for pdata in personas_cfg.values():
        if pdata.get("emoji_group") == group_name:
            pdata["emoji_group"] = ""
            changed = True
    if changed:
        app.config.save()
