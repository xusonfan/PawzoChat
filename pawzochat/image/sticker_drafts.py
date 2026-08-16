# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

"""Short-lived storage for generated sticker-pack previews."""

from __future__ import annotations

import os
import re
import shutil
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from pawzochat.image.sticker_sheet import (
    STICKER_EMOTIONS,
    ProcessedStickerSheet,
    StickerAsset,
)

DRAFT_TTL_SECONDS = 30 * 60
_TOKEN_RE = re.compile(r"^[0-9a-f]{32}$")


class StickerDraftNotFound(FileNotFoundError):
    """Raised when a draft is missing, expired, or already being saved."""


@dataclass(frozen=True)
class StickerDraftClaim:
    token: str
    path: Path
    processed: ProcessedStickerSheet


def default_draft_root() -> Path:
    return Path(tempfile.gettempdir()) / "pawzochat-sticker-drafts"


def _root(draft_root: Path | None) -> Path:
    return draft_root or default_draft_root()


def _draft_path(token: str, draft_root: Path | None = None) -> Path:
    if not _TOKEN_RE.fullmatch(token or ""):
        raise StickerDraftNotFound(token)
    return _root(draft_root) / token


def _write_processed(path: Path, processed: ProcessedStickerSheet) -> None:
    path.mkdir(parents=True, exist_ok=False)
    (path / "sheet.png").write_bytes(processed.source_png)
    for sticker in processed.stickers:
        emotion_dir = path / sticker.emotion
        emotion_dir.mkdir()
        (emotion_dir / "1.png").write_bytes(sticker.image_data)


def _load_processed(path: Path) -> ProcessedStickerSheet:
    try:
        source_png = (path / "sheet.png").read_bytes()
        stickers = tuple(
            StickerAsset(
                emotion=emotion,
                image_data=(path / emotion / "1.png").read_bytes(),
                width=0,
                height=0,
            )
            for emotion in STICKER_EMOTIONS
        )
    except (FileNotFoundError, NotADirectoryError, OSError) as exc:
        raise StickerDraftNotFound(path.name) from exc
    return ProcessedStickerSheet(source_png=source_png, stickers=stickers)


def cleanup_expired_drafts(
    *,
    draft_root: Path | None = None,
    now: float | None = None,
    ttl_seconds: int = DRAFT_TTL_SECONDS,
) -> int:
    root = _root(draft_root)
    if not root.is_dir():
        return 0
    cutoff = (time.time() if now is None else now) - ttl_seconds
    removed = 0
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        try:
            expired = entry.stat().st_mtime < cutoff
        except OSError:
            continue
        if expired:
            shutil.rmtree(entry, ignore_errors=True)
            removed += 1
    return removed


def create_sticker_draft(
    processed: ProcessedStickerSheet,
    *,
    draft_root: Path | None = None,
) -> str:
    root = _root(draft_root)
    root.mkdir(parents=True, exist_ok=True)
    cleanup_expired_drafts(draft_root=root)
    token = uuid.uuid4().hex
    path = root / token
    try:
        _write_processed(path, processed)
    except Exception:
        shutil.rmtree(path, ignore_errors=True)
        raise
    return token


def sticker_draft_asset_path(
    token: str,
    asset: str,
    *,
    draft_root: Path | None = None,
) -> Path:
    path = _draft_path(token, draft_root)
    try:
        if path.stat().st_mtime < time.time() - DRAFT_TTL_SECONDS:
            shutil.rmtree(path, ignore_errors=True)
            raise StickerDraftNotFound(token)
    except (FileNotFoundError, NotADirectoryError, OSError) as exc:
        raise StickerDraftNotFound(token) from exc
    parts = Path(asset).parts
    allowed = asset == "sheet.png" or (
        len(parts) == 2
        and parts[0] in STICKER_EMOTIONS
        and parts[1] == "1.png"
    )
    if not allowed:
        raise StickerDraftNotFound(token)
    target = path.joinpath(*parts)
    if not target.is_file():
        raise StickerDraftNotFound(token)
    try:
        os.utime(path, None)
    except OSError:
        pass
    return target


def claim_sticker_draft(
    token: str,
    *,
    draft_root: Path | None = None,
) -> StickerDraftClaim:
    root = _root(draft_root)
    cleanup_expired_drafts(draft_root=root)
    source = _draft_path(token, root)
    claimed = root / f".claim-{token}-{uuid.uuid4().hex}"
    try:
        source.rename(claimed)
    except (FileNotFoundError, NotADirectoryError, OSError) as exc:
        raise StickerDraftNotFound(token) from exc
    try:
        processed = _load_processed(claimed)
    except Exception:
        shutil.rmtree(claimed, ignore_errors=True)
        raise
    return StickerDraftClaim(token=token, path=claimed, processed=processed)


def release_sticker_draft(
    claim: StickerDraftClaim,
    *,
    draft_root: Path | None = None,
) -> None:
    destination = _root(draft_root) / claim.token
    if destination.exists():
        shutil.rmtree(claim.path, ignore_errors=True)
        return
    try:
        claim.path.rename(destination)
    except OSError:
        shutil.rmtree(claim.path, ignore_errors=True)


def discard_sticker_draft(claim: StickerDraftClaim) -> None:
    shutil.rmtree(claim.path, ignore_errors=True)