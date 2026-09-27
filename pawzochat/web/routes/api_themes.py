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

"""REST API for user-defined custom themes.

Each theme lives in ``data/theme/<name>/`` with a single ``style.css`` file.
The folder name is the theme's display name — no separate metadata is stored.
The ordered list ``theme.active`` in ``config.yaml`` tracks which themes are
enabled and in what layering order.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from flask import Blueprint, jsonify, request

from pawzochat.paths import THEME_DIR
from pawzochat.web.routes import download_response, get_app, safe_download_stem
from pawzochat.web.routes.api_emoji import _validate_fs_name, _safe_path

api_themes_bp = Blueprint("api_themes", __name__)

_MAX_CSS_BYTES = 200 * 1024   # 200 KB per theme

THEME_PACK_FORMAT = "pawzochat-theme-pack"
THEME_PACK_VERSION = 1
_MAX_THEMES_IN_PACK = 100
_MAX_TOTAL_UNCOMPRESSED = 25 * 1024 * 1024   # 25 MB across all themes in a pack
_MAX_THEME_PACK_BYTES = 30 * 1024 * 1024
_MAX_MANIFEST_BYTES = 256 * 1024


def _read_css(name: str) -> str:
    css_path = THEME_DIR / name / "style.css"
    try:
        with open(css_path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def _atomic_write(path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    os.replace(tmp, path)


def _validate_css(css) -> str | None:
    """Return an error message if *css* is invalid, else None."""
    if css is not None:
        if not isinstance(css, str):
            return "CSS 内容格式非法"
        if len(css.encode("utf-8")) > _MAX_CSS_BYTES:
            return f"CSS 内容不能超过 {_MAX_CSS_BYTES // 1024} KB"
    return None


def _unique_theme_name(base: str) -> str:
    """Return *base* if free, else *base*_2 / _3 / ... that doesn't exist yet."""
    if not (THEME_DIR / base).exists():
        return base
    i = 2
    while True:
        candidate = f"{base}_{i}"
        if not (THEME_DIR / candidate).exists():
            return candidate
        i += 1


def _read_upload_limited(f, max_bytes: int) -> bytes | None:
    """Read at most ``max_bytes`` from an upload stream; None means too large."""
    raw = f.stream.read(max_bytes + 1)
    if len(raw) > max_bytes:
        return None
    return raw


@api_themes_bp.route("", methods=["GET"])
def list_themes():
    THEME_DIR.mkdir(parents=True, exist_ok=True)
    items: list[dict] = []
    for entry in THEME_DIR.iterdir():
        if entry.is_dir() and (entry / "style.css").is_file():
            items.append({"name": entry.name})
    items.sort(key=lambda x: x["name"])
    return jsonify({"themes": items})


@api_themes_bp.route("/_export", methods=["GET"])
def export_themes():
    """Export one or more themes as a PawzoChat-native zip pack.

    Pass theme names via repeated ``?name=`` query params. With one name
    the file is ``<name>_theme_pawzochat.zip``; with multiple it's
    ``themes_pawzochat.zip``. The ZIP layout is uniform either way.
    """
    raw_names = request.args.getlist("name")
    seen: set[str] = set()
    names: list[str] = []
    for n in raw_names:
        n = (n or "").strip()
        if n and n not in seen:
            seen.add(n)
            names.append(n)

    if not names:
        return jsonify({"error": "未指定要导出的主题"}), 400

    for n in names:
        err = _validate_fs_name(n)
        if err:
            return jsonify({"error": f"主题名「{n}」无效: {err}"}), 400
        target = _safe_path(THEME_DIR, n)
        if target is None or not (target / "style.css").is_file():
            return jsonify({"error": f"主题「{n}」不存在"}), 404

    summary: list[dict] = []
    buf = io.BytesIO()
    # CSS compresses well — DEFLATE is worth it here (unlike emoji images).
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for n in names:
            css_path = THEME_DIR / n / "style.css"
            zf.write(css_path, arcname=f"themes/{n}/style.css")
            summary.append({"name": n})

        manifest = {
            "format": THEME_PACK_FORMAT,
            "version": THEME_PACK_VERSION,
            "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "themes": summary,
        }
        zf.writestr(
            "manifest.json",
            json.dumps(manifest, ensure_ascii=False, indent=2),
        )

    if len(names) == 1:
        stem = safe_download_stem(names[0]) or names[0]
        filename = f"{stem}_theme_pawzochat.zip"
    else:
        filename = "themes_pawzochat.zip"

    return download_response(
        buf.getvalue(),
        "application/zip",
        filename,
        fallback_stem="theme-pack",
    )


def _write_theme_atomic(raw_name: str, css_text: str) -> tuple[str, bool]:
    """Write a theme to ``THEME_DIR/<final>/style.css`` via a tmp dir + rename.

    Returns ``(final_name, renamed)`` where ``renamed`` is True iff a name
    collision forced ``raw_name`` → ``raw_name_2`` / ``_3`` / ... .
    """
    THEME_DIR.mkdir(parents=True, exist_ok=True)
    final_name = _unique_theme_name(raw_name)
    final_dir = _safe_path(THEME_DIR, final_name)
    if final_dir is None:
        raise ValueError("非法路径")

    tmp_dir = Path(tempfile.mkdtemp(prefix=f"{final_name}.tmp_", dir=str(THEME_DIR)))
    try:
        with open(tmp_dir / "style.css", "w", encoding="utf-8", newline="\n") as f:
            f.write(css_text)
        tmp_dir.rename(final_dir)
    except Exception:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
    return final_name, final_name != raw_name


def _import_css_file(f, original_filename: str):
    raw = _read_upload_limited(f, _MAX_CSS_BYTES)
    if raw is None:
        return jsonify({"error": f"CSS 文件不能超过 {_MAX_CSS_BYTES // 1024} KB"}), 400

    try:
        css_text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return jsonify({"error": "CSS 文件必须是 UTF-8 编码"}), 400

    stem = os.path.basename(original_filename)
    if stem.lower().endswith(".css"):
        stem = stem[:-4]
    stem = stem.strip()
    err = _validate_fs_name(stem)
    if err:
        return jsonify({"error": f"主题名「{stem}」无效: {err}"}), 400

    try:
        final_name, renamed = _write_theme_atomic(stem, css_text)
    except Exception as exc:
        return jsonify({"error": f"导入失败: {exc}"}), 500

    return jsonify({
        "ok": True,
        "imported": [{
            "name": final_name,
            "original_name": stem,
            "renamed": renamed,
        }],
    }), 201


def _import_zip_pack(f):
    raw = _read_upload_limited(f, _MAX_THEME_PACK_BYTES)
    if raw is None:
        return jsonify({"error": "主题包过大，请拆分后导入"}), 400

    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        return jsonify({"error": "无法读取 zip 文件"}), 400

    with zf:
        try:
            manifest_info = zf.getinfo("manifest.json")
        except KeyError:
            return jsonify({"error": "无法识别的主题包格式（缺少 manifest.json）"}), 400
        if manifest_info.flag_bits & 0x1:
            return jsonify({"error": "不支持加密 zip 文件"}), 400
        if manifest_info.file_size > _MAX_MANIFEST_BYTES:
            return jsonify({"error": "主题包 manifest.json 过大"}), 400

        try:
            manifest_bytes = zf.read(manifest_info)
            manifest = json.loads(manifest_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, zipfile.BadZipFile, RuntimeError):
            return jsonify({"error": "无法识别的主题包格式（manifest.json 解析失败）"}), 400

        if not isinstance(manifest, dict) or manifest.get("format") != THEME_PACK_FORMAT:
            return jsonify({"error": "无法识别的主题包格式"}), 400

        # Phase 1 — validate every entry. Collect a map of theme name → CSS text.
        css_by_name: dict[str, str] = {}
        seen_names: list[str] = []   # preserve declared order
        total_uncompressed = manifest_info.file_size

        for info in zf.infolist():
            if info.flag_bits & 0x1:
                return jsonify({"error": "不支持加密 zip 文件"}), 400
            if info.is_dir():
                continue
            arc = info.filename
            if arc == "manifest.json":
                continue

            normalized = arc.replace("\\", "/")
            if normalized.startswith("/") or ".." in normalized.split("/"):
                return jsonify({"error": f"非法路径: {arc}"}), 400

            parts = [p for p in normalized.split("/") if p]
            if len(parts) != 3 or parts[0] != "themes" or parts[2] != "style.css":
                return jsonify({"error": f"非法路径: {arc}"}), 400

            theme_name = parts[1]
            err = _validate_fs_name(theme_name)
            if err:
                return jsonify({"error": f"主题名「{theme_name}」无效: {err}"}), 400

            if info.file_size > _MAX_CSS_BYTES:
                return jsonify({
                    "error": f"主题「{theme_name}」CSS 超过 {_MAX_CSS_BYTES // 1024} KB",
                }), 400
            total_uncompressed += info.file_size
            if total_uncompressed > _MAX_TOTAL_UNCOMPRESSED:
                return jsonify({"error": "主题包过大，请拆分后导入"}), 400
            if len(css_by_name) >= _MAX_THEMES_IN_PACK:
                return jsonify({
                    "error": f"主题包内主题数量超过上限（{_MAX_THEMES_IN_PACK} 个）",
                }), 400

            try:
                css_text = zf.read(info).decode("utf-8")
            except UnicodeDecodeError:
                return jsonify({"error": f"主题「{theme_name}」CSS 不是 UTF-8 编码"}), 400
            except (zipfile.BadZipFile, RuntimeError):
                return jsonify({"error": f"主题「{theme_name}」CSS 无法读取"}), 400

            if theme_name in css_by_name:
                return jsonify({"error": f"主题包内主题名重复: {theme_name}"}), 400
            css_by_name[theme_name] = css_text
            seen_names.append(theme_name)

    if not css_by_name:
        return jsonify({"error": "主题包不包含任何主题"}), 400

    imported: list[dict] = []
    errors: list[dict] = []
    for raw_name in seen_names:
        try:
            final_name, renamed = _write_theme_atomic(raw_name, css_by_name[raw_name])
            imported.append({
                "name": final_name,
                "original_name": raw_name,
                "renamed": renamed,
            })
        except Exception as exc:
            errors.append({"name": raw_name, "error": str(exc)})

    if errors and not imported:
        return jsonify({
            "ok": False,
            "error": errors[0]["error"] if errors else "导入失败",
            "imported": imported,
            "errors": errors,
        }), 500

    status = 207 if errors else 201
    return jsonify({
        "ok": not errors,
        "imported": imported,
        "errors": errors,
    }), status


@api_themes_bp.route("/_import", methods=["POST"])
def import_themes():
    """Import a theme pack (.zip) or a raw stylesheet (.css)."""
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "未选择文件"}), 400

    original_filename = f.filename or ""
    lower = original_filename.lower()
    if lower.endswith(".zip"):
        return _import_zip_pack(f)
    if lower.endswith(".css"):
        return _import_css_file(f, original_filename)
    return jsonify({"error": "仅支持 .zip 或 .css 文件"}), 400


@api_themes_bp.route("/<name>", methods=["GET"])
def get_theme(name):
    target = _safe_path(THEME_DIR, name)
    if not target or not (target / "style.css").is_file():
        return jsonify({"error": "主题不存在"}), 404
    return jsonify({"name": name, "css": _read_css(name)})


@api_themes_bp.route("", methods=["POST"])
def create_theme():
    data = request.get_json(force=True, silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "请求体必须是 JSON 对象"}), 400

    name = (data.get("name") or "").strip() if isinstance(data.get("name"), str) else ""
    err = _validate_fs_name(name)
    if err:
        return jsonify({"error": err}), 400

    css = data.get("css", "")
    err = _validate_css(css)
    if err:
        return jsonify({"error": err}), 400

    target = _safe_path(THEME_DIR, name)
    if not target:
        return jsonify({"error": "主题名称非法"}), 400
    if target.is_dir():
        return jsonify({"error": f"主题「{name}」已存在"}), 409

    target.mkdir(parents=True, exist_ok=True)
    _atomic_write(target / "style.css", css)
    return jsonify({"name": name}), 201


@api_themes_bp.route("/<name>", methods=["PUT"])
def update_theme(name):
    target = _safe_path(THEME_DIR, name)
    if not target or not target.is_dir():
        return jsonify({"error": "主题不存在"}), 404

    data = request.get_json(force=True, silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "请求体必须是 JSON 对象"}), 400

    css = data.get("css")
    err = _validate_css(css)
    if err:
        return jsonify({"error": err}), 400

    new_name = data.get("name")
    final_name = name

    # Handle rename
    if isinstance(new_name, str):
        new_name = new_name.strip()
        if new_name != name:
            err = _validate_fs_name(new_name)
            if err:
                return jsonify({"error": err}), 400
            new_target = _safe_path(THEME_DIR, new_name)
            if not new_target:
                return jsonify({"error": "主题名称非法"}), 400
            if new_target.is_dir():
                return jsonify({"error": f"主题「{new_name}」已存在"}), 409
            target.rename(new_target)
            target = new_target
            final_name = new_name
            # Update active list in config
            app = get_app()
            theme_cfg = app.config._data.get("theme", {})
            active = theme_cfg.get("active") or []
            if name in active:
                theme_cfg["active"] = [new_name if x == name else x for x in active]
                app.config.save()

    if css is not None:
        _atomic_write(target / "style.css", css)

    return jsonify({"name": final_name})


@api_themes_bp.route("/<name>", methods=["DELETE"])
def delete_theme(name):
    target = _safe_path(THEME_DIR, name)
    if not target or not target.is_dir():
        return jsonify({"error": "主题不存在"}), 404
    shutil.rmtree(target, ignore_errors=True)

    app = get_app()
    theme_cfg = app.config._data.get("theme", {})
    active = theme_cfg.get("active") or []
    if name in active:
        theme_cfg["active"] = [x for x in active if x != name]
        app.config.save()
    return jsonify({"ok": True})
