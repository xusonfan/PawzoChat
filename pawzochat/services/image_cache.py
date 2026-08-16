# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

"""Persist remote images referenced by chat messages into conversation storage."""

from __future__ import annotations

import hashlib
import io
import ipaddress
import logging
import os
import re
import socket
import tempfile
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from PIL import Image

from pawzochat.paths import CHATS_DIR

logger = logging.getLogger(__name__)

_MAX_IMAGE_BYTES = 20 * 1024 * 1024
_MAX_IMAGES_PER_MESSAGE = 8
_MAX_REDIRECTS = 4
_REQUEST_TIMEOUT = (4, 12)

_MARKDOWN_IMAGE_RE = re.compile(
    r"!\[[^\]\r\n]*\]\(\s*(https?://[^\s)]+)(?:\s+(?:\"[^\"\r\n]*\"|'[^'\r\n]*'))?\s*\)",
    re.IGNORECASE,
)
_LINKED_IMAGE_RE = re.compile(
    r"\[(?:图片|图像|照片|image|img|picture)(?:链接|地址|url)?\]"
    r"\(\s*(https?://[^\s)]+)(?:\s+(?:\"[^\"\r\n]*\"|'[^'\r\n]*'))?\s*\)",
    re.IGNORECASE,
)
_RAW_IMAGE_RE = re.compile(
    r"https?://[^\s<>\"'`]+?\.(?:apng|avif|bmp|gif|ico|jpe?g|jp2|png|tiff?|webp)"
    r"(?:\?[^\s<>\"'`]*)?(?:#[^\s<>\"'`]*)?",
    re.IGNORECASE,
)

_FORMATS = {
    "PNG": ("image/png", "png"),
    "JPEG": ("image/jpeg", "jpg"),
    "JPEG2000": ("image/jp2", "jp2"),
    "GIF": ("image/gif", "gif"),
    "WEBP": ("image/webp", "webp"),
    "BMP": ("image/bmp", "bmp"),
    "TIFF": ("image/tiff", "tiff"),
    "ICO": ("image/x-icon", "ico"),
    "AVIF": ("image/avif", "avif"),
    "HEIF": ("image/heic", "heic"),
}


def _is_public_http_url(url: str) -> bool:
    """Reject non-HTTP and non-public destinations before server-side fetching."""
    try:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return False
        if parsed.username or parsed.password:
            return False
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError:
        return False

    hostname = parsed.hostname.rstrip(".").lower()
    if hostname == "localhost" or hostname.endswith(".localhost"):
        return False

    try:
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
        }
    except OSError:
        return False
    if not addresses:
        return False

    try:
        return all(ipaddress.ip_address(address).is_global for address in addresses)
    except ValueError:
        return False


def _verified_image(raw: bytes) -> tuple[str, str] | None:
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image_format = (image.format or "").upper()
            image.verify()
    except Exception:
        return None
    return _FORMATS.get(image_format)


def _download_image(url: str) -> tuple[bytes, str, str] | None:
    current_url = url
    headers = {
        "Accept": "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8",
        "User-Agent": "PawzoChat/remote-image-cache",
    }

    for _ in range(_MAX_REDIRECTS + 1):
        if not _is_public_http_url(current_url):
            logger.warning("拒绝缓存非公网图片 URL: %s", current_url)
            return None
        try:
            with requests.get(
                current_url,
                headers=headers,
                stream=True,
                allow_redirects=False,
                timeout=_REQUEST_TIMEOUT,
            ) as response:
                if response.is_redirect or response.is_permanent_redirect:
                    location = response.headers.get("Location", "")
                    if not location:
                        return None
                    current_url = urljoin(current_url, location)
                    continue
                response.raise_for_status()
                content_length = response.headers.get("Content-Length")
                if content_length:
                    try:
                        if int(content_length) > _MAX_IMAGE_BYTES:
                            return None
                    except ValueError:
                        pass

                chunks: list[bytes] = []
                total = 0
                for chunk in response.iter_content(chunk_size=64 * 1024):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > _MAX_IMAGE_BYTES:
                        return None
                    chunks.append(chunk)
        except requests.RequestException:
            logger.info("外链图片下载失败: %s", current_url, exc_info=True)
            return None

        raw = b"".join(chunks)
        detected = _verified_image(raw)
        if detected is None:
            logger.warning("外链响应不是受支持的图片: %s", current_url)
            return None
        mime, extension = detected
        return raw, mime, extension

    logger.warning("外链图片重定向次数过多: %s", url)
    return None


def _images_dir(persona_id: str) -> Path | None:
    directory = CHATS_DIR / persona_id / "images"
    try:
        resolved = directory.resolve()
        base = CHATS_DIR.resolve()
    except OSError:
        return None
    if resolved != base and base not in resolved.parents:
        logger.warning("拒绝写入 chats 目录外的图片缓存: %s", directory)
        return None
    return resolved


def _save_remote_image(persona_id: str, url: str) -> dict | None:
    downloaded = _download_image(url)
    if downloaded is None:
        return None
    raw, mime, extension = downloaded
    directory = _images_dir(persona_id)
    if directory is None:
        return None

    digest = hashlib.sha256(raw).hexdigest()
    filename = f"remote_{digest[:24]}.{extension}"
    output = directory / filename
    try:
        directory.mkdir(parents=True, exist_ok=True)
        if not output.exists():
            fd, temporary = tempfile.mkstemp(dir=directory, prefix=".remote_", suffix=".tmp")
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(raw)
                os.replace(temporary, output)
            except Exception:
                if os.path.exists(temporary):
                    os.unlink(temporary)
                raise
    except OSError:
        logger.exception("外链图片缓存落盘失败 persona=%s url=%s", persona_id, url)
        return None

    return {
        "type": "image",
        "path": str(output),
        "mime": mime,
        "original_url": url,
    }


def _image_references(text: str) -> list[tuple[int, int, str]]:
    references: list[tuple[int, int, str]] = []
    for pattern in (_MARKDOWN_IMAGE_RE, _LINKED_IMAGE_RE, _RAW_IMAGE_RE):
        for match in pattern.finditer(text):
            start, end = match.span()
            if any(start < existing_end and end > existing_start for existing_start, existing_end, _ in references):
                continue
            url = match.group(1) if match.lastindex else match.group(0)
            references.append((start, end, url.rstrip(")]}>，。！？；：、,.!?;:")))
    references.sort(key=lambda item: item[0])
    return references


def cache_external_images(persona_id: str, content: list[dict]) -> list[dict]:
    """Replace downloadable remote image references with durable image blocks.

    Failed downloads remain unchanged, so caching never removes message content.
    """
    result: list[dict] = []
    cache: dict[str, dict | None] = {}
    cached_count = 0

    def cached(url: str) -> dict | None:
        nonlocal cached_count
        if url in cache:
            entry = cache[url]
            return dict(entry) if entry else None
        if cached_count >= _MAX_IMAGES_PER_MESSAGE:
            cache[url] = None
            return None
        entry = _save_remote_image(persona_id, url)
        cache[url] = entry
        if entry:
            cached_count += 1
            return dict(entry)
        return None

    for source_block in content:
        block = dict(source_block)
        block_type = block.get("type")

        if block_type == "image" and isinstance(block.get("url"), str):
            url = block["url"].strip()
            if url.startswith(("http://", "https://")):
                entry = cached(url)
                result.append(entry if entry else block)
                continue

        if block_type != "text" or not isinstance(block.get("text"), str):
            result.append(block)
            continue

        text = block["text"]
        references = _image_references(text)
        if not references:
            result.append(block)
            continue

        cursor = 0
        for start, end, url in references:
            entry = cached(url)
            if entry is None:
                continue
            if start > cursor:
                result.append({"type": "text", "text": text[cursor:start]})
            result.append(entry)
            cursor = end
        if cursor == 0:
            result.append(block)
        elif cursor < len(text):
            result.append({"type": "text", "text": text[cursor:]})

    return result