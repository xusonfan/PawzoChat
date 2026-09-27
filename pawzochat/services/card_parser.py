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

"""Format detection and PNG tEXt I/O for character-card files.

This module is transport-agnostic. It handles the low-level chore of turning
bytes on disk into a JSON dict (or building one back into bytes) for the three
container types PawzoChat accepts:

    PNG          — SillyTavern v2/v3 card embedded in a tEXt chunk.
                   v3 uses keyword "ccv3" (preferred); v2 uses "chara".
                   Both store base64-encoded UTF-8 JSON.
    JSON         — v2/v3 card JSON (top-level ``spec`` field), or a plain
                   SillyTavern lorebook (top-level ``entries``).
    ZIP          — PawzoChat native ``.ppack`` bundle (see ``bundle.py``).

Higher-level mapping from SillyTavern card JSON to PawzoChat Persona/Worldbook
lives in ``persona_card.py``.
"""

from __future__ import annotations

import base64
import codecs
import io
import json
import logging
import os
import zipfile
from typing import Literal

from PIL import Image, PngImagePlugin

logger = logging.getLogger(__name__)

FormatKind = Literal[
    "png_card",
    "json_card",
    "sillytavern_lorebook",
    "pawzo_bundle",
    "txt",
    "unknown",
]


PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
ZIP_MAGIC = b"PK\x03\x04"


def _utf16_candidates(raw: bytes) -> list[str]:
    """Return likely UTF-16 codec names, or ``[]`` when the bytes don't look UTF-16.

    We only try UTF-16 early when a BOM is present or the payload has the null-
    byte pattern typical of UTF-16 JSON/text. This avoids silently "decoding"
    genuine GBK/Big5 files as mojibake just because ``utf-16`` happened to
    accept the bytes.
    """
    if raw.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return ["utf-16"]
    if len(raw) < 4:
        return []

    sample = raw[: min(len(raw), 128)]
    pair_count = max(1, len(sample) // 2)
    even_nuls = sum(b == 0 for b in sample[0::2]) / pair_count
    odd_nuls = sum(b == 0 for b in sample[1::2]) / pair_count

    if odd_nuls >= 0.3 and even_nuls < 0.1:
        return ["utf-16-le"]
    if even_nuls >= 0.3 and odd_nuls < 0.1:
        return ["utf-16-be"]
    if max(even_nuls, odd_nuls) >= 0.3:
        return ["utf-16", "utf-16-le", "utf-16-be"]
    return []


def decode_card_json(raw: bytes) -> str:
    """Decode a JSON/text blob, tolerating BOMs, UTF-16, and common CJK encodings.

    ``utf-8-sig`` is tried first: it accepts plain UTF-8 bytes *and* strips any
    leading BOM transparently, so downstream ``json.loads`` doesn't choke on
    files saved by Windows tools. UTF-16 is only attempted when the byte stream
    actually looks UTF-16 (BOM or null-byte pattern); otherwise we fall back to
    common CJK encodings for legacy lorebooks saved from Chinese editors.
    """
    tried: set[str] = set()
    for enc in [*_utf16_candidates(raw), "utf-8-sig", "gbk", "gb2312", "big5"]:
        if enc in tried:
            continue
        tried.add(enc)
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    raise UnicodeDecodeError("unknown", raw, 0, 1, "无法识别文件编码")


def _read_png_text_chunks(png_bytes: bytes) -> dict[str, str]:
    """Return all tEXt/iTXt chunks keyed by chunk keyword.

    Pillow collapses tEXt and iTXt into the ``text`` dict on PngImageFile.
    """
    with Image.open(io.BytesIO(png_bytes)) as img:
        img.load()  # force chunk parse
        return dict(getattr(img, "text", {}) or {})


def read_png_card(png_bytes: bytes) -> dict | None:
    """Extract the character-card JSON from a PNG's tEXt chunks.

    Returns the parsed card dict, or ``None`` if no card payload is present
    (e.g. a plain avatar PNG). Raises ``ValueError`` when a chunk is found
    but the payload is malformed — the caller decides how to surface that.

    Lookup order matches SillyTavern: ``ccv3`` wins over ``chara`` so v3 cards
    round-trip without downgrade when both are written side by side.
    """
    try:
        chunks = _read_png_text_chunks(png_bytes)
    except Exception as exc:
        raise ValueError(f"PNG 解析失败: {exc}") from exc

    for key in ("ccv3", "chara"):
        value = chunks.get(key)
        if not value:
            continue
        try:
            decoded = base64.b64decode(value, validate=False)
            return json.loads(decoded.decode("utf-8"))
        except Exception as exc:
            raise ValueError(f"PNG 内嵌角色卡损坏（{key}）: {exc}") from exc
    return None


def write_png_card(png_bytes: bytes, card: dict) -> bytes:
    """Return a new PNG with ``ccv3`` and ``chara`` tEXt chunks embedded.

    Both chunks carry the same v3 payload. Newer SillyTavern clients pick up
    ``ccv3`` (v3); older ones fall back to ``chara`` and ignore the v3-only
    fields as unknown extensions.
    """
    try:
        img = Image.open(io.BytesIO(png_bytes))
        img.load()
    except Exception as exc:
        raise ValueError(f"PNG 打开失败: {exc}") from exc

    payload_b64 = base64.b64encode(
        json.dumps(card, ensure_ascii=False).encode("utf-8")
    ).decode("ascii")
    info = PngImagePlugin.PngInfo()
    info.add_text("ccv3", payload_b64)
    info.add_text("chara", payload_b64)

    out = io.BytesIO()
    # Preserve RGBA so transparency (common in avatar cards) survives.
    save_img = img.convert("RGBA") if img.mode != "RGBA" else img
    save_img.save(out, format="PNG", pnginfo=info)
    return out.getvalue()


def detect_format(raw: bytes, filename: str = "") -> FormatKind:
    """Best-effort detection of the file's logical type."""
    ext = os.path.splitext(filename or "")[1].lower()

    if raw.startswith(PNG_MAGIC):
        return "png_card"

    if raw.startswith(ZIP_MAGIC):
        # Peek inside: a PawzoChat bundle has pawzochat.json at the root.
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as zf:
                names = set(zf.namelist())
                if "pawzochat.json" in names:
                    return "pawzo_bundle"
        except zipfile.BadZipFile:
            pass
        # Unrecognised ZIPs aren't supported yet; report as unknown.
        return "unknown"

    if ext == ".txt":
        return "txt"

    # Text-based: try JSON.
    try:
        text = decode_card_json(raw)
    except UnicodeDecodeError:
        return "unknown"

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return "txt" if ext == ".txt" else "unknown"

    if isinstance(parsed, dict):
        spec = str(parsed.get("spec") or "").lower()
        if spec.startswith("chara_card"):
            return "json_card"
        if "data" in parsed and isinstance(parsed["data"], dict) and "name" in parsed["data"]:
            return "json_card"
        if "entries" in parsed:
            return "sillytavern_lorebook"
        if "content" in parsed and "name" in parsed:
            return "sillytavern_lorebook"  # native PawzoChat book JSON too
    elif isinstance(parsed, list):
        return "sillytavern_lorebook"

    return "unknown"


def parse_json_card(raw: bytes) -> dict:
    """Parse raw bytes as a character-card JSON dict, raising on failure."""
    text = decode_card_json(raw)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"JSON 解析失败: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError("JSON 根节点必须是对象")
    return parsed
