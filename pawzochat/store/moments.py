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

"""Persistent moments store backed by a single JSON file.

Layout under :data:`pawzochat.paths.MOMENTS_DIR`::

    moments.json           # canonical store (atomic-replaced on every write)
    images/<moment_id>/    # per-moment images (user-uploaded + LLM-generated)
    cover.*                # background cover image (served as-is)
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import shutil
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path

from pawzochat.paths import MOMENTS_DIR, MOMENTS_IMAGES_DIR, MOMENTS_STORE_PATH

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def _new_moment_id() -> str:
    return f"mom_{secrets.token_hex(6)}"


def _new_reply_id() -> str:
    return f"rep_{secrets.token_hex(6)}"


def _safe_filename_component(name: str) -> bool:
    """Reject anything that would let a request escape the moments dir."""
    if not name:
        return False
    if name in (".", ".."):
        return False
    if "/" in name or "\\" in name or "\x00" in name:
        return False
    return True


class MomentsStore:
    """JSON-backed moments store.

    Thread-safe: a single global lock guards read-modify-write sequences on the
    canonical file. Writes are atomic (tmp file + ``os.replace``) so a crash
    mid-write cannot corrupt ``moments.json``.
    """

    def __init__(self):
        MOMENTS_DIR.mkdir(parents=True, exist_ok=True)
        MOMENTS_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._cache: dict | None = None

    # ---- File I/O ----

    def _read(self) -> dict:
        if self._cache is not None:
            return self._cache
        if not MOMENTS_STORE_PATH.exists():
            now = _now_iso()
            data = {"created_at": now, "updated_at": now, "moments": []}
            self._cache = data
            return data
        try:
            with open(MOMENTS_STORE_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            logger.exception("读取 moments.json 失败，将使用空数据")
            now = _now_iso()
            data = {"created_at": now, "updated_at": now, "moments": []}
        if not isinstance(data, dict) or not isinstance(data.get("moments"), list):
            now = _now_iso()
            data = {"created_at": now, "updated_at": now, "moments": []}
        self._cache = data
        return data

    def _write(self, data: dict) -> None:
        MOMENTS_STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp_path: str | None = None
        try:
            fd, tmp_path = tempfile.mkstemp(
                dir=str(MOMENTS_STORE_PATH.parent),
                suffix=".tmp",
                prefix=".moments_",
            )
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, str(MOMENTS_STORE_PATH))
            self._cache = data
            tmp_path = None
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

    # ---- Public API ----

    def list_moments(
        self,
        *,
        before: str | None = None,
        limit: int = 20,
        author: str | None = None,
    ) -> tuple[list[dict], bool]:
        """Return moments newest-first plus a ``has_more`` flag.

        Cursor: pass the timestamp of the last item from the previous page as
        ``before`` to get the next slice (strictly older than that timestamp).
        When *author* is set, only moments whose stored ``author`` field equals
        that stable id are returned (never matched by display name).
        Limit is clamped to [1, 100].
        """
        limit = max(1, min(int(limit or 20), 100))
        with self._lock:
            data = self._read()
            ordered = sorted(
                data.get("moments", []),
                key=lambda m: m.get("timestamp", ""),
                reverse=True,
            )
            if author is not None:
                ordered = [m for m in ordered if m.get("author") == author]
            if before:
                ordered = [m for m in ordered if m.get("timestamp", "") < before]
            page = ordered[:limit]
            has_more = len(ordered) > limit
            # Return shallow copies so callers can serialize without races.
            return [dict(m, replies=list(m.get("replies", []))) for m in page], has_more

    def get_moment(self, moment_id: str) -> dict | None:
        with self._lock:
            data = self._read()
            for m in data.get("moments", []):
                if m.get("id") == moment_id:
                    return dict(m, replies=list(m.get("replies", [])))
            return None

    def add_moment(
        self,
        *,
        author: str,
        text: str,
        images: list[str],
        moment_id: str | None = None,
    ) -> str:
        """Append a moment and return its id.

        ``images`` is a list of filenames already saved under
        ``data/moments/images/<moment_id>/``.
        """
        with self._lock:
            data = self._read()
            mid = moment_id or _new_moment_id()
            while any(m.get("id") == mid for m in data["moments"]):
                mid = _new_moment_id()
            moment = {
                "id": mid,
                "author": author,
                "timestamp": _now_iso(),
                "text": text,
                "images": list(images),
                "likes": [],
                "replies": [],
            }
            data["moments"].append(moment)
            data["updated_at"] = moment["timestamp"]
            self._write(data)
            return mid

    def update_moment_text(self, moment_id: str, text: str) -> bool:
        """Replace a moment's text in place. The moment's ``timestamp`` is
        deliberately left untouched so feed ordering doesn't change after an
        edit. Returns False if the moment doesn't exist."""
        with self._lock:
            data = self._read()
            for m in data["moments"]:
                if m.get("id") != moment_id:
                    continue
                m["text"] = text
                data["updated_at"] = _now_iso()
                self._write(data)
                return True
            return False

    def update_reply_text(
        self, moment_id: str, reply_id: str, text: str,
    ) -> bool | None:
        """Replace a reply's text in place. Returns True on success, False
        when the reply doesn't exist on this moment, or None when the moment
        itself is missing. ``timestamp`` is preserved (no "edited" marker)."""
        with self._lock:
            data = self._read()
            for m in data["moments"]:
                if m.get("id") != moment_id:
                    continue
                for r in m.get("replies", []) or []:
                    if r.get("id") != reply_id:
                        continue
                    r["text"] = text
                    data["updated_at"] = _now_iso()
                    self._write(data)
                    return True
                return False
            return None

    def delete_moment(self, moment_id: str) -> bool:
        with self._lock:
            data = self._read()
            before = len(data["moments"])
            data["moments"] = [m for m in data["moments"] if m.get("id") != moment_id]
            if len(data["moments"]) == before:
                return False
            data["updated_at"] = _now_iso()
            self._write(data)
        # Clean up images directory outside the lock.
        img_dir = MOMENTS_IMAGES_DIR / moment_id
        if img_dir.is_dir():
            try:
                shutil.rmtree(img_dir)
            except OSError:
                logger.warning("清理朋友圈图片目录失败: %s", img_dir, exc_info=True)
        return True

    def delete_moments_by_author(self, author_id: str) -> int:
        """Delete all moments authored by *author_id* along with their images.

        Also removes *author_id* from all other moments' replies and likes.
        Additionally removes any reply whose ``reply_to`` chain leads back to
        a reply authored by *author_id* (orphaned descendants).
        Returns the count of deleted moments (replies/likes are cleaned up as
        a side effect).
        """
        with self._lock:
            data = self._read()
            deleted_ids: list[str] = []
            remaining: list[dict] = []
            for m in data.get("moments", []):
                if m.get("author") == author_id:
                    deleted_ids.append(m.get("id", ""))
                    # image dirs cleaned outside the lock below
                else:
                    replies = m.get("replies", []) or []
                    # Collect ids of replies authored by the deleted persona.
                    to_strip: set[str] = {r["id"] for r in replies if r.get("author") == author_id}
                    # Walk descendants: any reply whose parent is in to_strip
                    # is also orphaned.
                    while True:
                        grew = False
                        for r in replies:
                            rid = r.get("id")
                            if rid in to_strip:
                                continue
                            if r.get("reply_to") in to_strip:
                                to_strip.add(rid)
                                grew = True
                        if not grew:
                            break
                    m["replies"] = [r for r in replies if r.get("id") not in to_strip]
                    # Strip likes from this persona.
                    likes = m.get("likes", []) or []
                    m["likes"] = [w for w in likes if w != author_id]
                    remaining.append(m)
            data["moments"] = remaining
            data["updated_at"] = _now_iso()
            self._write(data)
        # Clean up image directories outside the lock.
        for mid in deleted_ids:
            img_dir = MOMENTS_IMAGES_DIR / mid
            if img_dir.is_dir():
                try:
                    shutil.rmtree(img_dir)
                except OSError:
                    logger.warning("清理朋友圈图片目录失败: %s", img_dir, exc_info=True)
        return len(deleted_ids)

    def add_reply(
        self,
        moment_id: str,
        *,
        author: str,
        text: str,
        reply_to: str | None = None,
    ) -> str | None:
        """Append a reply to a moment. Returns the reply id or ``None`` if the
        moment was deleted while the reply was being generated.

        ``reply_to`` is sanitized: if it doesn't point to a reply that exists
        on this moment at write time, it's discarded (stored as ``None``).
        """
        with self._lock:
            data = self._read()
            for m in data["moments"]:
                if m.get("id") == moment_id:
                    rid = _new_reply_id()
                    existing_ids = {r.get("id") for r in m.get("replies", [])}
                    while rid in existing_ids:
                        rid = _new_reply_id()
                    target = reply_to if reply_to in existing_ids else None
                    reply = {
                        "id": rid,
                        "author": author,
                        "timestamp": _now_iso(),
                        "text": text,
                        "reply_to": target,
                    }
                    m.setdefault("replies", []).append(reply)
                    data["updated_at"] = reply["timestamp"]
                    self._write(data)
                    return rid
            return None

    def delete_reply(self, moment_id: str, reply_id: str) -> list[str] | None:
        """Delete a reply and every reply whose ``reply_to`` chain leads back
        to it. Returns the ordered list of deleted reply ids (top-most first),
        ``[]`` when the reply is not on this moment, or ``None`` when the
        moment itself doesn't exist."""
        with self._lock:
            data = self._read()
            for m in data["moments"]:
                if m.get("id") != moment_id:
                    continue
                replies = m.get("replies", []) or []
                if not any(r.get("id") == reply_id for r in replies):
                    return []
                to_delete: set[str] = {reply_id}
                # BFS via reply_to until no new descendants surface.
                while True:
                    grew = False
                    for r in replies:
                        rid = r.get("id")
                        if rid in to_delete:
                            continue
                        if r.get("reply_to") in to_delete:
                            to_delete.add(rid)
                            grew = True
                    if not grew:
                        break
                deleted_ids = [r.get("id") for r in replies if r.get("id") in to_delete]
                m["replies"] = [r for r in replies if r.get("id") not in to_delete]
                data["updated_at"] = _now_iso()
                self._write(data)
                return deleted_ids
            return None

    def get_reply(self, moment_id: str, reply_id: str) -> dict | None:
        """Return a single reply or ``None`` if either id doesn't exist."""
        with self._lock:
            data = self._read()
            for m in data.get("moments", []):
                if m.get("id") != moment_id:
                    continue
                for r in m.get("replies", []) or []:
                    if r.get("id") == reply_id:
                        return dict(r)
                return None
            return None

    def add_like(self, moment_id: str, who: str) -> bool:
        """Append ``who`` to the moment's likes if not already present.

        Returns True when a like was actually added, False on duplicate or
        when the moment doesn't exist.
        """
        if not who:
            return False
        with self._lock:
            data = self._read()
            for m in data["moments"]:
                if m.get("id") != moment_id:
                    continue
                likes = m.setdefault("likes", [])
                if who in likes:
                    return False
                likes.append(who)
                data["updated_at"] = _now_iso()
                self._write(data)
                return True
            return False

    def remove_like(self, moment_id: str, who: str) -> bool:
        """Remove ``who`` from the moment's likes. Returns True if removed."""
        if not who:
            return False
        with self._lock:
            data = self._read()
            for m in data["moments"]:
                if m.get("id") != moment_id:
                    continue
                likes = m.get("likes") or []
                if who not in likes:
                    return False
                m["likes"] = [w for w in likes if w != who]
                data["updated_at"] = _now_iso()
                self._write(data)
                return True
            return False

    # ---- Image helpers ----

    def save_image_bytes(
        self,
        moment_id: str,
        data: bytes,
        ext: str,
    ) -> str:
        """Save image bytes under ``images/<moment_id>/`` and return the
        generated filename."""
        if not _safe_filename_component(moment_id):
            raise ValueError("invalid moment_id")
        if not ext or "/" in ext or "\\" in ext:
            raise ValueError("invalid ext")
        ext = ext if ext.startswith(".") else f".{ext}"
        target_dir = MOMENTS_IMAGES_DIR / moment_id
        target_dir.mkdir(parents=True, exist_ok=True)
        filename = f"img_{secrets.token_hex(6)}{ext.lower()}"
        (target_dir / filename).write_bytes(data)
        return filename

    def get_image_path(self, moment_id: str, filename: str) -> Path | None:
        """Resolve a stored image filename. Returns ``None`` on path traversal."""
        if not _safe_filename_component(moment_id):
            return None
        if not _safe_filename_component(filename):
            return None
        base = MOMENTS_IMAGES_DIR.resolve()
        target = (MOMENTS_IMAGES_DIR / moment_id / filename).resolve()
        try:
            target.relative_to(base)
        except ValueError:
            return None
        if not target.is_file():
            return None
        return target
