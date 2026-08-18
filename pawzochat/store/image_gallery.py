# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

"""Persistent metadata and image files for the global image gallery."""

from __future__ import annotations

import json
import os
import secrets
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path

from pawzochat.paths import IMAGE_GALLERY_IMAGES_DIR, IMAGE_GALLERY_STORE_PATH

_MIME_EXTENSIONS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def _valid_id(image_id: str) -> bool:
    return image_id.startswith("img_") and len(image_id) == 28 and all(
        char in "0123456789abcdef" for char in image_id[4:]
    )


class ImageGalleryStore:
    """Thread-safe, JSON-indexed image gallery with atomic metadata writes."""

    def __init__(
        self,
        *,
        store_path: Path = IMAGE_GALLERY_STORE_PATH,
        images_dir: Path = IMAGE_GALLERY_IMAGES_DIR,
    ):
        self.store_path = Path(store_path)
        self.images_dir = Path(images_dir)
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        self.images_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._cache: dict | None = None

    def _read(self) -> dict:
        if self._cache is not None:
            return self._cache
        if not self.store_path.exists():
            self._cache = {"version": 1, "images": []}
            return self._cache
        try:
            data = json.loads(self.store_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {"version": 1, "images": []}
        if not isinstance(data, dict) or not isinstance(data.get("images"), list):
            data = {"version": 1, "images": []}
        self._cache = data
        return data

    def _write(self, data: dict) -> None:
        fd, temporary = tempfile.mkstemp(
            dir=str(self.store_path.parent),
            prefix=".gallery_",
            suffix=".tmp",
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.store_path)
            self._cache = data
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def list_images(self) -> list[dict]:
        with self._lock:
            images = self._read().get("images", [])
            return [dict(item) for item in sorted(
                images,
                key=lambda item: item.get("created_at", ""),
                reverse=True,
            )]

    def add_image(
        self,
        *,
        image_data: bytes,
        mime_type: str,
        prompt: str,
        provider: str,
        model: str,
        seed_used: int | None = None,
    ) -> dict:
        extension = _MIME_EXTENSIONS.get(mime_type)
        if not extension:
            raise ValueError("不支持的图片格式")
        if not image_data:
            raise ValueError("生成结果为空")

        with self._lock:
            data = self._read()
            existing = {item.get("id") for item in data.get("images", [])}
            image_id = f"img_{secrets.token_hex(12)}"
            while image_id in existing:
                image_id = f"img_{secrets.token_hex(12)}"
            filename = f"{image_id}.{extension}"
            destination = self.images_dir / filename

            fd, temporary = tempfile.mkstemp(
                dir=str(self.images_dir),
                prefix=f".{image_id}_",
                suffix=".tmp",
            )
            try:
                with os.fdopen(fd, "wb") as handle:
                    handle.write(image_data)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, destination)
                item = {
                    "id": image_id,
                    "filename": filename,
                    "mime_type": mime_type,
                    "prompt": prompt,
                    "provider": provider,
                    "model": model,
                    "seed_used": seed_used,
                    "created_at": _now_iso(),
                }
                updated = {
                    **data,
                    "images": [*data.get("images", []), item],
                }
                self._write(updated)
                return dict(item)
            except Exception:
                destination.unlink(missing_ok=True)
                raise
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)

    def image_path(self, image_id: str) -> Path | None:
        if not _valid_id(image_id):
            return None
        with self._lock:
            item = next(
                (entry for entry in self._read().get("images", []) if entry.get("id") == image_id),
                None,
            )
            if not item:
                return None
            filename = item.get("filename", "")
            expected_prefix = f"{image_id}."
            if not filename.startswith(expected_prefix) or "/" in filename or "\\" in filename:
                return None
            path = self.images_dir / filename
            return path if path.is_file() else None

    def delete_images(self, image_ids: list[str]) -> int:
        requested = set(image_ids)
        if not requested or any(not _valid_id(image_id) for image_id in requested):
            raise ValueError("图片 ID 无效")

        with self._lock:
            data = self._read()
            removed = [
                item for item in data.get("images", []) if item.get("id") in requested
            ]
            if not removed:
                return 0
            updated = {
                **data,
                "images": [
                    item for item in data.get("images", []) if item.get("id") not in requested
                ],
            }
            self._write(updated)
            for item in removed:
                filename = item.get("filename", "")
                if filename.startswith(f"{item.get('id')}.") and "/" not in filename and "\\" not in filename:
                    (self.images_dir / filename).unlink(missing_ok=True)
            return len(removed)

    def delete_image(self, image_id: str) -> bool:
        return self.delete_images([image_id]) == 1