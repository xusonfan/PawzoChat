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

"""Resolve and manage a persona's image-generation reference images."""

from __future__ import annotations

import io
import logging
import mimetypes
from pathlib import Path

from PIL import Image

from pawzochat.paths import CHATS_DIR

logger = logging.getLogger(__name__)

CUSTOM_REFERENCE_DIRNAME = "image_refs"
CUSTOM_REFERENCE_FILENAME = "ref.png"
CUSTOM_REFERENCE_ZIP_PATH = f"{CUSTOM_REFERENCE_DIRNAME}/{CUSTOM_REFERENCE_FILENAME}"
CUSTOM_REFERENCE_MIME = "image/png"
CUSTOM_REFERENCE_MAX_DIM = 1024

_DEFAULT_MIME = "image/png"

# WebP and a few other image types may be missing from Python's default
# mimetypes table on some platforms; register them up front so the data URLs
# we hand to providers carry the correct media type cross-platform.
for _ext, _mime in (
    (".webp", "image/webp"),
    (".avif", "image/avif"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".png", "image/png"),
    (".gif", "image/gif"),
):
    mimetypes.add_type(_mime, _ext)


def _safe_read(path: Path) -> bytes | None:
    """Return file bytes if *path* lives under CHATS_DIR, else None.

    Uses ``resolve()`` + ``parents`` membership to block traversal attacks; goes
    straight to ``read_bytes()`` rather than pre-checking ``is_file()`` to avoid
    a TOCTOU race and a redundant stat.
    """
    try:
        resolved = path.resolve()
        if CHATS_DIR.resolve() not in resolved.parents:
            logger.warning("拒绝读取非 chats 目录下的参考图: %s", path)
            return None
        return resolved.read_bytes()
    except (FileNotFoundError, IsADirectoryError):
        return None
    except OSError as exc:
        logger.warning("读取参考图失败: %s (%s)", path, exc)
        return None


def normalize_reference_image_png(raw: bytes, *, max_dim: int = CUSTOM_REFERENCE_MAX_DIM) -> bytes:
    """Normalize arbitrary image bytes into a bounded PNG payload."""
    with Image.open(io.BytesIO(raw)) as img:
        img.load()
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
        img.thumbnail((max_dim, max_dim), Image.LANCZOS)
        out = io.BytesIO()
        img.save(out, "PNG")
        return out.getvalue()


def _mime_from_ext(path: Path) -> str:
    mime, _ = mimetypes.guess_type(path.name)
    return mime if (mime or "").startswith("image/") else _DEFAULT_MIME


def custom_reference_path(persona_id: str, filename: str = CUSTOM_REFERENCE_FILENAME) -> Path:
    return CHATS_DIR / persona_id / CUSTOM_REFERENCE_DIRNAME / filename


def save_custom_reference_image(
    persona_id: str,
    raw: bytes,
    *,
    filename: str = CUSTOM_REFERENCE_FILENAME,
    max_dim: int = CUSTOM_REFERENCE_MAX_DIM,
) -> Path:
    """Normalize *raw* and store it as the persona's custom reference image."""
    path = custom_reference_path(persona_id, filename)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(normalize_reference_image_png(raw, max_dim=max_dim))
    return path


def delete_custom_reference_image(
    persona_id: str,
    *,
    filename: str = CUSTOM_REFERENCE_FILENAME,
) -> None:
    try:
        custom_reference_path(persona_id, filename).unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:
        logger.warning("删除参考图失败 persona=%s: %s", persona_id, exc)


def load_custom_reference_image(
    persona_id: str,
    image_cfg: dict,
) -> tuple[bytes, str] | None:
    """Return the configured custom reference image as ``(bytes, mime)``."""
    cfg = image_cfg or {}
    filename = (cfg.get("custom_ref_filename") or "").strip()
    if not filename:
        return None

    candidate = Path(filename)
    if candidate.is_absolute() or candidate.name != filename or filename in (".", ".."):
        logger.warning("拒绝读取非法参考图文件名: %s (persona=%s)", filename, persona_id)
        return None

    path = custom_reference_path(persona_id, filename)
    data = _safe_read(path)
    if not data:
        return None
    return data, _mime_from_ext(path)


def resolve_reference_images(
    persona_id: str, image_cfg: dict,
) -> list[tuple[bytes, str]]:
    """Read the persona's configured reference image(s) into ``(bytes, mime)`` pairs."""
    if not persona_id:
        return []

    cfg = image_cfg or {}
    mode = cfg.get("ref_mode", "avatar")

    if mode == "none":
        return []

    if mode == "avatar":
        path = CHATS_DIR / persona_id / "avatar.png"
        data = _safe_read(path)
        return [(data, "image/png")] if data else []

    if mode == "custom":
        custom = load_custom_reference_image(persona_id, cfg)
        return [custom] if custom else []

    logger.warning("未知 ref_mode: %s (persona=%s)", mode, persona_id)
    return []
