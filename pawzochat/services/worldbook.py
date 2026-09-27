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

"""Worldbook service — manage world-setting documents and inject them into LLM context.

A "worldbook" is a scoped text bundle describing background settings (lore,
rules, etc.) that augments the persona system prompt. Each book is stored as a
standalone JSON file at ``data/books/{name}.json``; the filename is the book's
identity. Personas bind to books by name via ``persona.bound_worldbooks``.

Scope model:
- ``scope.range == "global"``: applied to every persona.
- ``scope.range == "selected"``: applied only to personas that list this name
  in their ``bound_worldbooks``.
- ``scope.keyword_filter``: optional overlay. When true, the book is only
  injected if any entry in ``keywords`` appears in the current user message
  (case-insensitive substring match).
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from pawzochat.paths import BOOKS_DIR

if TYPE_CHECKING:
    from pawzochat.core.config import ConfigManager

logger = logging.getLogger(__name__)

_ILLEGAL_NAME_RE = re.compile(r'[\\/:*?"<>|]')
_MAX_NAME_LEN = 100
_SCOPE_RANGES = ("global", "selected")


def validate_book_name(name: str) -> str | None:
    """Return an error message if *name* is unusable as a filename, else None."""
    if not name:
        return "世界书名称不能为空"
    if len(name) > _MAX_NAME_LEN:
        return f"世界书名称过长（最多 {_MAX_NAME_LEN} 个字符）"
    bad = _ILLEGAL_NAME_RE.search(name)
    if bad:
        return f"名称包含非法字符「{bad.group(0)}」，不可使用 \\ / : * ? \" < > |"
    if name.endswith(" ") or name.endswith("."):
        return "名称不能以空格或句点结尾"
    if name in (".", ".."):
        return "名称不能为 . 或 .."
    return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _normalize_scope(scope_raw: dict | None) -> dict:
    scope_raw = scope_raw or {}
    rng = scope_raw.get("range", "selected")
    if rng not in _SCOPE_RANGES:
        rng = "selected"
    return {
        "range": rng,
        "keyword_filter": bool(scope_raw.get("keyword_filter", False)),
    }


def _normalize_content(content_raw) -> dict:
    """Coerce content to an ordered ``{str: str}`` dict.

    Accepts a flat dict (preferred) or a list of ``{title, text}`` items and
    flattens them. Non-dict / non-list inputs become a single ``{"正文": str}``
    entry so imports never silently lose data.
    """
    if isinstance(content_raw, dict):
        return {str(k): str(v) for k, v in content_raw.items()}
    if isinstance(content_raw, list):
        result: dict[str, str] = {}
        for i, item in enumerate(content_raw):
            if isinstance(item, dict):
                title = str(item.get("title") or item.get("name") or f"section_{i}")
                text = str(item.get("text") or item.get("content") or "")
                result[title] = text
            else:
                result[f"section_{i}"] = str(item)
        return result
    if content_raw:
        return {"正文": str(content_raw)}
    return {}


def _normalize_section_meta(content: dict, raw_meta) -> dict:
    """Align per-section metadata to *content*.

    Returns ``{section: {"enabled": bool}}`` containing exactly the keys in
    *content*. Missing keys default to ``enabled=True`` so legacy books and
    newly added sections are always-on by default. Orphan keys (whose section
    was renamed/deleted) are dropped here so the on-disk file stays clean.
    """
    raw = raw_meta if isinstance(raw_meta, dict) else {}
    result: dict[str, dict] = {}
    for section in content.keys():
        meta = raw.get(section)
        if isinstance(meta, dict) and isinstance(meta.get("enabled"), bool):
            enabled = meta["enabled"]
        else:
            enabled = True
        result[section] = {"enabled": enabled}
    return result


class WorldbookService:
    """File-backed worldbook store with persona-binding sync and prompt formatting."""

    def __init__(self, config: ConfigManager):
        self.config = config

    # ---- File IO ----

    @staticmethod
    def _safe_book_path(name: str) -> Path:
        """Return the absolute file path for *name* if it stays inside BOOKS_DIR."""
        err = validate_book_name(name)
        if err:
            raise ValueError(err)

        books_root = BOOKS_DIR.resolve()
        target = (BOOKS_DIR / f"{name}.json").resolve()
        try:
            target.relative_to(books_root)
        except ValueError as exc:
            raise ValueError("世界书名称非法") from exc
        return target

    def list_books(self) -> list[dict]:
        """Return all books, sorted by name."""
        if not BOOKS_DIR.is_dir():
            return []
        books: list[dict] = []
        for p in sorted(BOOKS_DIR.glob("*.json")):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as exc:
                logger.warning("世界书文件损坏，已跳过: %s (%s)", p, exc)
                continue
            # Trust the filename as the canonical name (defensive against edits).
            data["name"] = p.stem
            data["scope"] = _normalize_scope(data.get("scope"))
            data.setdefault("keywords", [])
            data["content"] = _normalize_content(data.get("content"))
            data["section_meta"] = _normalize_section_meta(
                data["content"], data.get("section_meta"),
            )
            if not isinstance(data.get("extras"), dict):
                data["extras"] = {}
            books.append(data)
        return books

    def get_book(self, name: str) -> dict | None:
        p = self._safe_book_path(name)
        if not p.is_file():
            return None
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("世界书文件损坏: %s (%s)", p, exc)
            return None
        data["name"] = p.stem
        data["scope"] = _normalize_scope(data.get("scope"))
        data.setdefault("keywords", [])
        data["content"] = _normalize_content(data.get("content"))
        data["section_meta"] = _normalize_section_meta(
            data["content"], data.get("section_meta"),
        )
        if not isinstance(data.get("extras"), dict):
            data["extras"] = {}
        return data

    def save_book(
        self,
        name: str,
        scope: dict,
        keywords: list[str],
        content: dict,
        *,
        old_name: str | None = None,
        extras: dict | None = None,
        section_meta: dict | None = None,
    ) -> dict:
        """Write (or rename) a book. Returns the saved book object.

        If ``old_name`` is provided and differs from ``name``, the old file is
        deleted and all persona bindings are updated from ``old_name`` → ``name``.

        ``extras`` carries opaque metadata (e.g. ``{"sillytavern": {...}}`` for
        round-tripping SillyTavern-specific fields). When ``None`` the existing
        book's extras are preserved; pass an empty dict to clear.

        ``section_meta`` is a parallel ``{section: {"enabled": bool}}`` map.
        When ``None`` the existing book's per-section state is preserved (so a
        partial PUT that omits the field doesn't silently re-enable disabled
        sections); pass an explicit dict (even ``{}``) to overwrite.
        """
        BOOKS_DIR.mkdir(parents=True, exist_ok=True)

        renaming = old_name is not None and old_name != name
        target = self._safe_book_path(name)
        old_path = self._safe_book_path(old_name) if old_name else None
        if renaming:
            # Block rename into an existing book — would silently overwrite.
            if target.is_file():
                raise ValueError(f"世界书「{name}」已存在")

        now = _now_iso()
        existing_name = old_name if old_name else name
        existing = self.get_book(existing_name) if (old_name or target.is_file()) else None
        created_at = (existing or {}).get("created_at") or now

        if extras is None:
            book_extras = (existing or {}).get("extras") or {}
        else:
            book_extras = extras if isinstance(extras, dict) else {}

        normalized_content = _normalize_content(content)
        # Preserve existing per-section state on partial updates that omit
        # section_meta — but renames need to be section-keyed against the
        # *renamed* book, so reuse whatever existing carried (keys are the
        # same since rename only changes the file name).
        meta_source = section_meta
        if meta_source is None:
            meta_source = (existing or {}).get("section_meta")
        normalized_meta = _normalize_section_meta(normalized_content, meta_source)

        book = {
            "name": name,
            "scope": _normalize_scope(scope),
            "keywords": [str(k).strip() for k in (keywords or []) if str(k).strip()],
            "content": normalized_content,
            "section_meta": normalized_meta,
            "extras": book_extras,
            "created_at": created_at,
            "updated_at": now,
        }

        tmp = target.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(book, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(tmp, target)

        if renaming:
            if old_path and old_path.is_file():
                old_path.unlink()
            self._sync_persona_bindings(old_name, name)

        return book

    def delete_book(self, name: str) -> bool:
        p = self._safe_book_path(name)
        if not p.is_file():
            return False
        p.unlink()
        self._sync_persona_bindings(name, None)
        return True

    def _sync_persona_bindings(self, old_name: str, new_name: str | None) -> None:
        """Update every persona's ``bound_worldbooks``: rename or remove ``old_name``."""
        with self.config.lock:
            personas_cfg = self.config.get("personas", default={})
            dirty = False
            for _pid, pdata in personas_cfg.items():
                bound = pdata.get("bound_worldbooks") or []
                if old_name not in bound:
                    continue
                if new_name is None:
                    pdata["bound_worldbooks"] = [n for n in bound if n != old_name]
                else:
                    pdata["bound_worldbooks"] = [
                        new_name if n == old_name else n for n in bound
                    ]
                dirty = True
            if dirty:
                self.config._data["personas"] = personas_cfg
                self.config.save()

    def get_bound_personas(self, name: str) -> list[str]:
        """Return persona ids that currently bind ``name``."""
        personas_cfg = self.config.get("personas", default={})
        return [
            pid for pid, pdata in personas_cfg.items()
            if name in (pdata.get("bound_worldbooks") or [])
        ]

    def set_bound_personas(self, name: str, persona_ids: list[str]) -> list[str]:
        """Sync persona bindings so exactly ``persona_ids`` bind ``name``.

        For each persona: if id is in the target set, ensure ``name`` is in its
        ``bound_worldbooks``; otherwise ensure ``name`` is removed. Returns the
        final bound persona list (filtered to existing personas).
        """
        target = set(persona_ids or [])
        with self.config.lock:
            personas_cfg = self.config.get("personas", default={})
            dirty = False
            applied: list[str] = []
            for pid, pdata in personas_cfg.items():
                bound = list(pdata.get("bound_worldbooks") or [])
                want = pid in target
                has = name in bound
                if want and not has:
                    bound.append(name)
                    pdata["bound_worldbooks"] = bound
                    dirty = True
                elif (not want) and has:
                    pdata["bound_worldbooks"] = [n for n in bound if n != name]
                    dirty = True
                if want:
                    applied.append(pid)
            if dirty:
                self.config._data["personas"] = personas_cfg
                self.config.save()
        return applied

    # ---- Selection and formatting ----

    def select_for_round(
        self, persona_id: str, user_message: str,
    ) -> list[dict]:
        """Return the books that should be injected for this round."""
        personas_cfg = self.config.get("personas", default={})
        persona_cfg = personas_cfg.get(persona_id, {}) or {}
        bound_set = set(persona_cfg.get("bound_worldbooks") or [])

        message_lower = (user_message or "").lower()
        applicable: list[dict] = []
        for book in self.list_books():
            scope = book.get("scope", {})
            rng = scope.get("range", "selected")
            if rng == "global":
                in_range = True
            else:
                in_range = book["name"] in bound_set
            if not in_range:
                continue

            if scope.get("keyword_filter"):
                keywords = [str(k).lower() for k in (book.get("keywords") or []) if str(k).strip()]
                if not keywords:
                    continue
                if not any(kw in message_lower for kw in keywords):
                    continue

            applicable.append(book)
        return applicable

    @staticmethod
    def format_for_prompt(books: list[dict]) -> str:
        """Format selected books as a single system-message text.

        Sections whose ``section_meta[section].enabled`` is ``False`` are
        skipped (per-section toggle). If a book ends up contributing no
        sections (all disabled or all empty) its header is also omitted to
        avoid emitting a dangling 【name】 with no body.
        """
        if not books:
            return ""
        lines: list[str] = ["[世界观背景]"]
        any_emitted = False
        for book in books:
            content = book.get("content") or {}
            section_meta = book.get("section_meta") or {}
            book_lines: list[str] = []
            for section, text in content.items():
                if not str(text).strip():
                    continue
                meta = section_meta.get(section)
                if isinstance(meta, dict) and meta.get("enabled") is False:
                    continue
                book_lines.append(f"{section}:")
                book_lines.append(str(text))
                book_lines.append("")
            if not book_lines:
                continue
            if any_emitted:
                lines.append("")
            lines.append(f"【{book['name']}】")
            lines.extend(book_lines)
            any_emitted = True
        if not any_emitted:
            return ""
        # Drop trailing blanks.
        while lines and not lines[-1]:
            lines.pop()
        return "\n".join(lines)

    def get_prompt_text(self, persona_id: str, user_message: str) -> str:
        """Convenience: select and format in one call."""
        return self.format_for_prompt(self.select_for_round(persona_id, user_message))
