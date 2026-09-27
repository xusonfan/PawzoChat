"""Best-effort platform quote index; media is referenced, never copied."""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from pawzochat.paths import DATA_DIR, CHATS_DIR, EMOJI_DIR

logger = logging.getLogger(__name__)


def resolve_partial(text: str, partial: dict) -> str:
    """Observed global/relative occurrence indexes, verified with UTF-8 MD5."""
    def nth(needle, occurrence, offset=0):
        if not isinstance(needle, str) or not needle or type(occurrence) is not int or occurrence < 0:
            return -1
        # Bound malformed occurrence counts by the maximum possible matches.
        if occurrence > len(text):
            return -1
        for _ in range(occurrence + 1):
            found = text.find(needle, offset)
            if found < 0:
                return -1
            offset = found + len(needle)
        return found

    if not isinstance(partial, dict):
        return text
    expected = str(partial.get("quotemd5") or "").lower()
    if not expected:
        return text
    start = nth(partial.get("start"), partial.get("startindex"))
    if start < 0:
        return text
    for offset in (0, start + len(partial["start"])):
        end = nth(partial.get("end"), partial.get("endindex"), offset)
        if end < start:
            continue
        candidate = text[start:end + len(partial["end"])]
        if hashlib.md5(candidate.encode("utf-8")).hexdigest() == expected:
            return candidate
    return text


def media_blocks(images=(), files=(), voices=()):
    return [
        {k: v for k, v in {**item, "type": kind}.items() if k != "data"}
        for kind, items in (("image", images), ("file", files), ("voice", voices))
        for item in items or ()
    ]


class QuoteStore:
    def __init__(self, path=None, *, retention=30 * 86400, capacity=10_000, chats_dir=None, emoji_dir=None):
        self.path = Path(path) if path is not None else DATA_DIR / "cache" / "channel_quotes.sqlite3"
        self.retention, self.capacity = retention, capacity
        self.chats_dir = Path(chats_dir) if chats_dir is not None else CHATS_DIR
        self.emoji_dir = Path(emoji_dir) if emoji_dir is not None else EMOJI_DIR
        self._lock = threading.RLock()
        self._warned = False

    @contextmanager
    def _db(self):
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            db = sqlite3.connect(self.path, timeout=0.25)
            try:
                db.execute('''CREATE TABLE IF NOT EXISTS quotes (
                    channel TEXT, account TEXT, peer TEXT, platform_id TEXT,
                    persona TEXT, local_id TEXT, body TEXT, media TEXT, created REAL,
                    PRIMARY KEY(channel, account, peer, platform_id))''')
                db.execute('CREATE INDEX IF NOT EXISTS quotes_owner ON quotes(persona, local_id)')
                db.execute('CREATE INDEX IF NOT EXISTS quotes_age ON quotes(channel, account, created)')
                db.execute('''CREATE TABLE IF NOT EXISTS deleted_sources (
                    persona TEXT, local_id TEXT, created REAL,
                    PRIMARY KEY(persona, local_id))''')
                with db:
                    yield db
            finally:
                db.close()

    def _failed(self):
        if not self._warned:
            self._warned = True
            logger.warning("引用索引暂不可用，普通消息继续处理", exc_info=True)

    def remember(self, channel, account, peer, platform_id, persona, local_id, body, media=()):
        if not all((channel, account, peer, platform_id, persona, local_id)):
            return
        try:
            with self._db() as db:
                db.execute('DELETE FROM deleted_sources WHERE created < ?', (time.time() - self.retention,))
                if db.execute('SELECT 1 FROM deleted_sources WHERE persona=? AND local_id=?',
                              (persona, local_id)).fetchone():
                    return
                db.execute('INSERT OR REPLACE INTO quotes VALUES (?,?,?,?,?,?,?,?,?)', (
                    channel, account, peer, str(platform_id), persona, local_id,
                    body or "", json.dumps(media or [], ensure_ascii=False), time.time(),
                ))
                db.execute('DELETE FROM quotes WHERE created < ?', (time.time() - self.retention,))
                db.execute('''DELETE FROM quotes WHERE rowid IN (
                    SELECT rowid FROM quotes WHERE channel=? AND account=?
                    ORDER BY created DESC, rowid DESC LIMIT -1 OFFSET ?)''',
                    (channel, account, self.capacity))
        except Exception:
            self._failed()

    def find(self, channel, account, peer, platform_id, persona):
        if not platform_id:
            return None
        try:
            with self._db() as db:
                row = db.execute('''SELECT body,media FROM quotes
                    WHERE channel=? AND account=? AND peer=? AND platform_id=?
                    AND persona=? AND created>=?''',
                    (channel, account, peer, str(platform_id), persona, time.time() - self.retention)).fetchone()
            if row:
                media = json.loads(row[1])
                if not isinstance(row[0], str) or not isinstance(media, list) or any(not isinstance(item, dict) for item in media):
                    raise ValueError("引用缓存格式异常")
                return {"body": row[0], "media": media}
        except Exception:
            self._failed()
        return None

    def available_media(self, persona, media):
        result = []
        persona_root = (self.chats_dir / persona).resolve()
        if not persona_root.is_relative_to(self.chats_dir.resolve()) or persona_root == self.chats_dir.resolve():
            return []
        roots = (persona_root, self.emoji_dir.resolve())
        for item in media or ():
            if not isinstance(item, dict):
                continue
            block = {k: v for k, v in item.items() if k in {
                "type", "path", "name", "mime", "text", "duration_ms"}}
            try:
                path = Path(block.get("path", "")).resolve()
                allowed = any(path.is_relative_to(root) for root in roots)
                exists = allowed and path.is_file()
            except (OSError, ValueError, RuntimeError, TypeError):
                exists = False
            block["expired"] = not exists
            if not exists:
                block.pop("path", None)
            result.append(block)
        return result

    def resolve(self, channel, account, peer, platform_id, persona, *, inline="", partial=None, inline_media=()):
        record = self.find(channel, account, peer, platform_id, persona)
        body = inline or (record or {}).get("body", "")
        cached = list((record or {}).get("media", []))
        media = []
        for item in inline_media:
            # Platform metadata is preferred, but only this exact cached
            # message may supply a managed path. Never follow a temporary URL.
            match = next((i for i, saved in enumerate(cached)
                          if saved.get("type") == item.get("type") and
                          (not item.get("name") or not saved.get("name") or
                           item["name"] == saved["name"])), None)
            saved = cached.pop(match) if match is not None else {}
            media.append({**saved, **{k: v for k, v in item.items()
                                      if k in {"type", "name", "mime", "text", "duration_ms"} and v}})
        media = self.available_media(persona, media + cached)
        if partial and body:
            body = resolve_partial(body, partial)
        if not body:
            body = "[引用附件]" if media else "[引用内容未缓存]"
        if any(item.get("expired") for item in media):
            body += "\n[引用附件已失效]"
        return {"quote": body, "quote_ref": {
            "channel": channel, "account_id": account, "peer_id": peer,
            "platform_id": str(platform_id or ""),
        }, "quote_media": media}

    def purge(self, *, persona=None, local_id=None, channel=None, account=None, local_ids=()):
        values = {"persona": persona, "local_id": local_id, "channel": channel, "account": account}
        values = {k: v for k, v in values.items() if v is not None}
        if not values:
            return
        try:
            with self._db() as db:
                # A response arriving after deletion must not recreate its index.
                condition = ' AND '.join(f'{k}=?' for k in values)
                sources = set(db.execute('SELECT persona,local_id FROM quotes WHERE ' + condition,
                                         tuple(values.values())).fetchall())
                for source_id in ([local_id] if local_id else local_ids):
                    if persona and source_id:
                        sources.add((persona, source_id))
                now = time.time()
                db.execute('DELETE FROM deleted_sources WHERE created < ?', (now - self.retention,))
                db.executemany('INSERT OR REPLACE INTO deleted_sources VALUES (?,?,?)',
                               [(owner, source_id, now) for owner, source_id in sources])
                db.execute('DELETE FROM quotes WHERE ' + condition, tuple(values.values()))
        except Exception:
            self._failed()
