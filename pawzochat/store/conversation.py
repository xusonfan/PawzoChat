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

"""Persistent conversation store backed by JSON files."""

from __future__ import annotations

import json
import hashlib
import logging
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path

from pawzochat.paths import CHATS_DIR

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def _round_start_indices(messages: list[dict]) -> list[int]:
    """Return the index where each conversation round begins.

    A new round starts at index 0 and wherever role transitions
    from 'assistant' back to 'user'.
    """
    if not messages:
        return []
    starts = [0]
    for i in range(1, len(messages)):
        if messages[i].get("role") == "user" and messages[i - 1].get("role") == "assistant":
            starts.append(i)
    return starts


_FINGERPRINT_LEN = 0x6c  # 108


def _message_fingerprint(message: dict) -> str:
    payload = {
        "role": message.get("role", ""),
        "content": message.get("content", []),
        "source": message.get("source", ""),
        "timestamp": message.get("timestamp", ""),
        "quote": message.get("quote", ""),
    }
    raw = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:_FINGERPRINT_LEN]


class ConversationStore:
    """CRUD operations on per-persona conversation JSON files.

    Each persona has its own directory at ``{data_dir}/{persona_id}/``
    containing ``{persona_id}.json`` and an ``images/`` folder.
    """

    def __init__(self, data_dir: str | Path = CHATS_DIR):
        self._data_dir = Path(data_dir)
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, threading.Lock] = {}
        self._global_lock = threading.Lock()
        self._cache: dict[str, dict] = {}
        # {account_id: persona_id} — inbound routing index, built once at
        # startup. {account_id: channel} tracks which channel owns each link
        # so routing/UI can branch without re-reading files.
        self._link_map: dict[str, str] = {}
        self._link_channel: dict[str, str] = {}
        self._load_all_metadata()

    def _get_lock(self, persona_id: str) -> threading.Lock:
        with self._global_lock:
            if persona_id not in self._locks:
                self._locks[persona_id] = threading.Lock()
            return self._locks[persona_id]

    def _file_path(self, persona_id: str) -> Path:
        return self._data_dir / persona_id / f"{persona_id}.json"

    def _prepare_read_state(self, data: dict) -> bool:
        """Migrate message sequence/read and chat-list metadata in memory.

        Existing conversations are treated as fully read on first upgrade, so
        installing unread support never turns the whole history into alerts.
        Legacy chat-list entries default to visible and unpinned.
        """
        changed = False
        if not isinstance(data.get("pinned"), bool):
            data["pinned"] = False
            changed = True
        if "hidden_at" not in data or (
            data.get("hidden_at") is not None
            and not isinstance(data.get("hidden_at"), str)
        ):
            data["hidden_at"] = None
            changed = True
        next_seq = 1
        for message in data.get("messages", []):
            seq = message.get("_seq")
            if not isinstance(seq, int) or seq < next_seq:
                message["_seq"] = next_seq
                seq = next_seq
                changed = True
            next_seq = seq + 1
        stored_next = data.get("next_message_seq")
        if not isinstance(stored_next, int) or stored_next < next_seq:
            data["next_message_seq"] = next_seq
            changed = True
        if "last_read_message_seq" not in data:
            data["last_read_message_seq"] = next_seq - 1
            changed = True
        return changed

    def _load_all_metadata(self):
        """Scan existing conversation files to build caches."""
        for fp in self._data_dir.glob("*/*.json"):
            if fp.stem != fp.parent.name:
                continue
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    data = json.load(f)
                pid = data.get("persona_id", fp.stem)
                if self._prepare_read_state(data):
                    self._write_file(pid, data)
                else:
                    self._cache[pid] = data
                link = self._link_from_data(data)
                if link and link.get("account_id"):
                    self._link_map[link["account_id"]] = pid
                    self._link_channel[link["account_id"]] = link.get(
                        "channel", "wechat",
                    )
            except Exception:
                logger.exception("Failed to load conversation file: %s", fp)

    def _read_file(self, persona_id: str) -> dict | None:
        if persona_id in self._cache:
            return self._cache[persona_id]
        fp = self._file_path(persona_id)
        if not fp.exists():
            return None
        try:
            with open(fp, "r", encoding="utf-8") as f:
                data = json.load(f)
            self._cache[persona_id] = data
            return data
        except Exception:
            logger.exception("Failed to read conversation: %s", persona_id)
            return None

    def _write_file(self, persona_id: str, data: dict):
        fp = self._file_path(persona_id)
        fp.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd, tmp_path = tempfile.mkstemp(
                dir=str(fp.parent), suffix=".tmp", prefix=f".{persona_id}_"
            )
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, str(fp))
            self._cache[persona_id] = data
        except Exception:
            logger.exception("Failed to write conversation: %s", persona_id)
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

    # ---- Channel link normalization ----

    @staticmethod
    def _link_from_data(data: dict | None) -> dict | None:
        """Return the canonical channel_link for a conversation.

        Prefers the new ``channel_link`` key; falls back to migrating a legacy
        ``wechat_link`` blob (``user_id``→``peer_id``, ``context_token``→
        ``reply_target``) in-memory. Read-only — never writes to disk.
        """
        if not data:
            return None
        link = data.get("channel_link")
        if link and link.get("account_id"):
            return link
        legacy = data.get("wechat_link")
        if legacy and legacy.get("account_id"):
            return {
                "channel": "wechat",
                "account_id": legacy.get("account_id", ""),
                "peer_id": legacy.get("user_id", ""),
                "reply_target": legacy.get("context_token", ""),
                "chat_type": legacy.get("chat_type", "single"),
                "linked_at": legacy.get("linked_at", ""),
            }
        return None

    @staticmethod
    def _store_link(data: dict, link: dict | None) -> None:
        """Write the canonical ``channel_link`` onto ``data``, plus a legacy
        ``wechat_link`` mirror for WeChat links.

        All in-tree readers go through :meth:`_link_from_data` /
        :meth:`channel_link`, so the mirror is no longer needed for correctness.
        It is kept deliberately so a user who downgrades to a pre-channel build
        keeps their WeChat bindings; non-WeChat links clear it.
        """
        data["channel_link"] = link
        if link and link.get("channel") == "wechat":
            data["wechat_link"] = {
                "account_id": link.get("account_id", ""),
                "context_token": link.get("reply_target", ""),
                "user_id": link.get("peer_id", ""),
                "chat_type": link.get("chat_type", "single"),
                "linked_at": link.get("linked_at", ""),
            }
        else:
            data["wechat_link"] = None

    # ---- Public API ----

    def list_conversations(self, *, include_hidden: bool = False) -> list[dict]:
        """Return visible summaries, pinned first then newest within each group."""
        summaries = []
        for pid, data in self._cache.items():
            hidden_at = data.get("hidden_at")
            if hidden_at and not include_hidden:
                continue
            messages = data.get("messages", [])
            last_msg = None
            if messages:
                m = messages[-1]
                content = m.get("content", [])
                first = (
                    content[0]
                    if isinstance(content, list) and content and isinstance(content[0], dict)
                    else None
                )
                if first is None:
                    text = ""
                else:
                    t = first.get("type")
                    if t == "emoji":
                        text = "[表情]"
                    elif t == "image":
                        text = "[图片]"
                    elif t == "file":
                        text = "[文件]"
                    elif t == "voice":
                        text = "[语音]"
                    else:
                        text = first.get("text", "") or ""
                last_msg = {
                    "role": m.get("role", ""),
                    # Keep the full first text block so the frontend can classify
                    # an image reference before applying the 60-character preview cap.
                    "text": text,
                    "has_image": any(
                        isinstance(block, dict) and block.get("type") == "image"
                        for block in content
                    ) if isinstance(content, list) else False,
                    "source": m.get("source", ""),
                    "timestamp": m.get("timestamp", ""),
                }
            last_read_seq = data.get("last_read_message_seq", 0)
            unread_count = sum(
                1 for message in messages
                if message.get("role") == "assistant"
                and message.get("_seq", 0) > last_read_seq
            )
            link = self._link_from_data(data)
            summaries.append({
                "persona_id": pid,
                "created_at": data.get("created_at", ""),
                "updated_at": data.get("updated_at", ""),
                "unread_count": unread_count,
                "pinned": data.get("pinned", False),
                "hidden_at": hidden_at,
                # Kept for chat.js back-compat; true for any bound channel.
                "wechat_linked": bool(link),
                "linked_channel": link.get("channel", "") if link else "",
                "last_message": last_msg,
            })
        summaries.sort(
            key=lambda s: (bool(s.get("pinned")), s.get("updated_at", "")),
            reverse=True,
        )
        return summaries

    def get_conversation(self, persona_id: str) -> dict | None:
        lock = self._get_lock(persona_id)
        with lock:
            return self._read_file(persona_id)

    def create_conversation(self, persona_id: str) -> dict:
        lock = self._get_lock(persona_id)
        with lock:
            existing = self._read_file(persona_id)
            if existing:
                raise ValueError(f"Conversation already exists: {persona_id}")
            now = _now_iso()
            data = {
                "persona_id": persona_id,
                "created_at": now,
                "updated_at": now,
                "channel_link": None,
                "wechat_link": None,
                "pinned": False,
                "hidden_at": None,
                "next_message_seq": 1,
                "last_read_message_seq": 0,
                "messages": [],
            }
            self._write_file(persona_id, data)
            return data

    def ensure_conversation(self, persona_id: str) -> dict:
        """Get or create a conversation for the given persona."""
        lock = self._get_lock(persona_id)
        with lock:
            existing = self._read_file(persona_id)
            if existing:
                return existing
            now = _now_iso()
            data = {
                "persona_id": persona_id,
                "created_at": now,
                "updated_at": now,
                "channel_link": None,
                "wechat_link": None,
                "pinned": False,
                "hidden_at": None,
                "next_message_seq": 1,
                "last_read_message_seq": 0,
                "messages": [],
            }
            self._write_file(persona_id, data)
            return data

    def set_pinned(self, persona_id: str, pinned: bool) -> bool:
        """Persist a conversation's pinned state without changing its recency."""
        lock = self._get_lock(persona_id)
        with lock:
            data = self._read_file(persona_id)
            if data is None:
                return False
            if data.get("pinned", False) != pinned:
                data["pinned"] = pinned
                self._write_file(persona_id, data)
            return True

    def hide_conversation(self, persona_id: str) -> bool:
        """Remove a conversation from list results without deleting its data."""
        lock = self._get_lock(persona_id)
        with lock:
            data = self._read_file(persona_id)
            if data is None:
                return False
            if not data.get("hidden_at"):
                data["hidden_at"] = _now_iso()
                self._write_file(persona_id, data)
            return True

    def restore_hidden(self, persona_id: str) -> bool:
        """Make a hidden conversation visible again, preserving all other state."""
        lock = self._get_lock(persona_id)
        with lock:
            data = self._read_file(persona_id)
            if data is None:
                return False
            if data.get("hidden_at") is not None:
                data["hidden_at"] = None
                self._write_file(persona_id, data)
            return True

    def delete_conversation(self, persona_id: str) -> bool:
        lock = self._get_lock(persona_id)
        with lock:
            fp = self._file_path(persona_id)
            if not fp.exists():
                return False
            data = self._read_file(persona_id)
            link = self._link_from_data(data)
            if link and link.get("account_id"):
                aid = link["account_id"]
                self._link_map.pop(aid, None)
                self._link_channel.pop(aid, None)
            fp.unlink()
            self._cache.pop(persona_id, None)
            return True

    def add_message(
        self,
        persona_id: str,
        role: str,
        content: list[dict],
        source: str,
        *,
        timestamp: str | None = None,
        quote: str = "",
    ) -> dict:
        lock = self._get_lock(persona_id)
        with lock:
            data = self._read_file(persona_id)
            if data is None:
                raise ValueError(f"Conversation not found: {persona_id}")
            msg = {
                "role": role,
                "content": content,
                "source": source,
                "timestamp": timestamp or _now_iso(),
                "_seq": data.get("next_message_seq", 1),
            }
            data["next_message_seq"] = msg["_seq"] + 1
            if quote:
                msg["quote"] = quote
            data["messages"].append(msg)
            data["updated_at"] = msg["timestamp"]
            # All persisted-message entry points converge here. Any new message
            # restores a hidden chat while preserving its messages/read marker.
            data["hidden_at"] = None
            self._write_file(persona_id, data)
            return msg

    def replace_pending_image(
        self,
        persona_id: str,
        task_id: str,
        replacement: dict,
    ) -> dict | None:
        """Atomically replace one asynchronous image placeholder.

        The message keeps its original sequence and timestamp so completion
        cannot reorder the conversation. Returns a detached message copy for
        SSE broadcasting, or ``None`` when the placeholder no longer exists.
        """
        lock = self._get_lock(persona_id)
        with lock:
            data = self._read_file(persona_id)
            if data is None:
                return None
            for message in data.get("messages", []):
                content = message.get("content", [])
                if not isinstance(content, list):
                    continue
                for index, block in enumerate(content):
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") != "image" or block.get("task_id") != task_id:
                        continue
                    content[index] = dict(replacement)
                    self._write_file(persona_id, data)
                    return json.loads(json.dumps(message, ensure_ascii=False))
            return None

    def recover_interrupted_image_tasks(self) -> int:
        """Mark image tasks left pending by a previous process as failed."""
        recovered = 0
        for persona_id in list(self._cache):
            lock = self._get_lock(persona_id)
            with lock:
                data = self._read_file(persona_id)
                if data is None:
                    continue
                changed = False
                for message in data.get("messages", []):
                    content = message.get("content", [])
                    if not isinstance(content, list):
                        continue
                    for index, block in enumerate(content):
                        if not isinstance(block, dict):
                            continue
                        if block.get("type") != "image" or block.get("status") != "pending":
                            continue
                        replacement = {
                            "type": "image",
                            "status": "failed",
                            "task_id": block.get("task_id", ""),
                            "error": "服务重启，图片生成任务已中断",
                        }
                        retry_arguments = block.get("retry_arguments")
                        if isinstance(retry_arguments, dict):
                            replacement["retry_arguments"] = dict(retry_arguments)
                        content[index] = replacement
                        recovered += 1
                        changed = True
                if changed:
                    self._write_file(persona_id, data)
        return recovered

    def claim_failed_image_retry(
        self,
        persona_id: str,
        task_id: str,
    ) -> tuple[str, dict | None, dict | None]:
        """Atomically move a failed image task back to pending.

        Returns ``(status, retry_arguments, updated_message)``. Only ``failed``
        placeholders can be claimed, which prevents duplicate paid requests
        when the user taps retry more than once.
        """
        lock = self._get_lock(persona_id)
        with lock:
            data = self._read_file(persona_id)
            if data is None:
                return "not_found", None, None
            for message in data.get("messages", []):
                content = message.get("content", [])
                if not isinstance(content, list):
                    continue
                for index, block in enumerate(content):
                    if not isinstance(block, dict) or block.get("task_id") != task_id:
                        continue
                    if block.get("type") != "image":
                        return "invalid", None, None
                    if block.get("status") == "pending":
                        return "pending", None, None
                    if block.get("status") != "failed":
                        return "not_retryable", None, None
                    retry_arguments = block.get("retry_arguments")
                    if not isinstance(retry_arguments, dict):
                        return "not_retryable", None, None
                    content[index] = {
                        "type": "image",
                        "status": "pending",
                        "task_id": task_id,
                        "retry_arguments": dict(retry_arguments),
                    }
                    self._write_file(persona_id, data)
                    updated = json.loads(json.dumps(message, ensure_ascii=False))
                    return "ok", dict(retry_arguments), updated
            return "not_found", None, None

    def get_messages(
        self,
        persona_id: str,
        rounds: int = 10,
        *,
        before_seq: int | None = None,
    ) -> tuple[list[dict], bool]:
        """Return one page of conversation rounds, newest page first.

        ``before_seq`` is an exclusive, stable cursor.  The returned messages
        remain in chronological order while ``has_more`` indicates that an
        older page exists.
        """
        lock = self._get_lock(persona_id)
        with lock:
            data = self._read_file(persona_id)
            if data is None:
                return [], False
            all_messages = data.get("messages", [])
            if before_seq is None:
                messages = all_messages
            else:
                messages = [
                    message for message in all_messages
                    if message.get("_seq", 0) < before_seq
                ]
            starts = _round_start_indices(messages)
            if len(starts) <= rounds:
                return list(messages), False
            cut = starts[-rounds]
            return messages[cut:], True

    def get_recent_rounds(self, persona_id: str, count: int) -> list[dict]:
        """Return messages from the most recent *count* rounds (for LLM context)."""
        lock = self._get_lock(persona_id)
        with lock:
            data = self._read_file(persona_id)
            if data is None:
                return []
            messages = data.get("messages", [])
            starts = _round_start_indices(messages)
            if len(starts) <= count:
                return list(messages)
            cut = starts[-count]
            return messages[cut:]

    def unread_count(self, persona_id: str) -> int | None:
        """Return the current assistant-message unread count for one chat."""
        lock = self._get_lock(persona_id)
        with lock:
            data = self._read_file(persona_id)
            if data is None:
                return None
            last_read_seq = data.get("last_read_message_seq", 0)
            return sum(
                1 for message in data.get("messages", [])
                if message.get("role") == "assistant"
                and message.get("_seq", 0) > last_read_seq
            )

    def mark_read(self, persona_id: str, through_seq: int | None = None) -> bool:
        """Advance the durable read marker through an actually displayed message."""
        lock = self._get_lock(persona_id)
        with lock:
            data = self._read_file(persona_id)
            if data is None:
                return False
            latest_seq = data.get("next_message_seq", 1) - 1
            if through_seq is not None and through_seq > latest_seq:
                logger.warning(
                    "忽略超出会话范围的已读序号 persona=%s through=%s latest=%s",
                    persona_id,
                    through_seq,
                    latest_seq,
                )
                return True
            target_seq = latest_seq if through_seq is None else through_seq
            target_seq = max(data.get("last_read_message_seq", 0), target_seq, 0)
            if data.get("last_read_message_seq", 0) != target_seq:
                data["last_read_message_seq"] = target_seq
                self._write_file(persona_id, data)
            return True

    def rewind_to_latest_user(self, persona_id: str, message_seq: int) -> str:
        """Delete replies after the latest user message while preserving sequence IDs."""
        lock = self._get_lock(persona_id)
        with lock:
            data = self._read_file(persona_id)
            if data is None:
                return "not_found"
            messages = data.get("messages", [])
            latest_user_index = next(
                (
                    index
                    for index in range(len(messages) - 1, -1, -1)
                    if messages[index].get("role") == "user"
                ),
                None,
            )
            if latest_user_index is None:
                return "not_retryable"
            latest_user = messages[latest_user_index]
            if latest_user.get("_seq") != message_seq:
                return "not_retryable"

            del messages[latest_user_index + 1:]
            data["updated_at"] = _now_iso()
            self._write_file(persona_id, data)
            return "ok"

    def clear_messages(self, persona_id: str) -> bool:
        lock = self._get_lock(persona_id)
        with lock:
            data = self._read_file(persona_id)
            if data is None:
                return False
            data["messages"] = []
            data["updated_at"] = _now_iso()
            self._write_file(persona_id, data)
            return True

    @staticmethod
    def _resolve_message(
        messages: list[dict],
        index: int,
        *,
        expected_fingerprint: str = "",
    ) -> tuple[dict | None, str]:
        if index < 0 or index >= len(messages):
            return None, "not_found"
        message = messages[index]
        if expected_fingerprint and _message_fingerprint(message) != expected_fingerprint:
            return None, "conflict"
        return message, "ok"

    def update_message(
        self,
        persona_id: str,
        index: int,
        text: str,
        *,
        expected_fingerprint: str = "",
        quote: str | None = None,
    ) -> str:
        """Replace the first text block of a message; optionally set its quote.

        ``quote`` semantics: ``None`` leaves the existing quote untouched
        (back-compat with callers that only edit text), ``""`` clears the
        quote field, and any non-empty string sets it.
        """
        lock = self._get_lock(persona_id)
        with lock:
            data = self._read_file(persona_id)
            if data is None:
                return "not_found"
            messages = data.get("messages", [])
            message, status = self._resolve_message(
                messages,
                index,
                expected_fingerprint=expected_fingerprint,
            )
            if status != "ok" or message is None:
                return status

            content = message.get("content", [])
            if not isinstance(content, list):
                return "invalid"

            new_content = []
            replaced = False
            for block in content:
                if not isinstance(block, dict):
                    return "invalid"
                if block.get("type") == "text":
                    if replaced:
                        continue
                    updated_block = dict(block)
                    updated_block["text"] = text
                    new_content.append(updated_block)
                    replaced = True
                    continue
                new_content.append(block)

            if not replaced:
                return "not_editable"

            messages[index]["content"] = new_content
            if quote is not None:
                if quote:
                    messages[index]["quote"] = quote
                else:
                    messages[index].pop("quote", None)
            data["updated_at"] = _now_iso()
            self._write_file(persona_id, data)
            return "ok"

    def delete_message(
        self,
        persona_id: str,
        index: int,
        *,
        expected_fingerprint: str = "",
    ) -> str:
        lock = self._get_lock(persona_id)
        with lock:
            data = self._read_file(persona_id)
            if data is None:
                return "not_found"
            messages = data.get("messages", [])
            _, status = self._resolve_message(
                messages,
                index,
                expected_fingerprint=expected_fingerprint,
            )
            if status != "ok":
                return status
            messages.pop(index)
            data["updated_at"] = _now_iso()
            self._write_file(persona_id, data)
            return "ok"

    @staticmethod
    def _date_from_ts(ts: str) -> str:
        """Extract YYYY-MM-DD from an ISO timestamp string."""
        try:
            return datetime.fromisoformat(ts).strftime("%Y-%m-%d")
        except Exception:
            return ""

    def get_message_dates(self, persona_id: str) -> list[dict]:
        """Return dates that have messages, with counts, newest first."""
        lock = self._get_lock(persona_id)
        with lock:
            data = self._read_file(persona_id)
            if data is None:
                return []
            counts: dict[str, int] = {}
            for m in data.get("messages", []):
                d = self._date_from_ts(m.get("timestamp", ""))
                if d:
                    counts[d] = counts.get(d, 0) + 1
            return [
                {"date": d, "count": c}
                for d, c in sorted(counts.items(), reverse=True)
            ]

    def get_messages_by_date(
        self, persona_id: str, date_str: str
    ) -> list[dict]:
        """Return messages for a specific date, each annotated with its
        global index in the full messages array."""
        lock = self._get_lock(persona_id)
        with lock:
            data = self._read_file(persona_id)
            if data is None:
                return []
            result = []
            for i, m in enumerate(data.get("messages", [])):
                if self._date_from_ts(m.get("timestamp", "")) == date_str:
                    result.append({"index": i, **m, "fingerprint": _message_fingerprint(m)})
            return result

    # ---- Channel link management ----

    def set_channel_link(
        self,
        persona_id: str,
        account_id: str,
        *,
        channel: str = "wechat",
        peer_id: str = "",
        reply_target: str = "",
        chat_type: str = "single",
    ) -> bool:
        """Bind a persona to a channel account.

        ``peer_id`` is the remote user id (WeChat from_user_id / QQ openid);
        ``reply_target`` is the channel's reply anchor (WeChat context_token /
        QQ msg_id). An account can be linked to at most one persona.
        """
        # Resolve the per-persona lock outside _global_lock (_get_lock takes
        # _global_lock internally and threading.Lock is non-reentrant), then
        # serialize the whole bind under _global_lock so the duplicate-account
        # guard and the index mutation are atomic against a concurrent bind of
        # the same account to a different persona.
        lock = self._get_lock(persona_id)
        with self._global_lock:
            existing_pid = self._link_map.get(account_id)
            if existing_pid is not None and existing_pid != persona_id:
                raise ValueError(
                    f"Account {account_id} already linked to {existing_pid}"
                )
            with lock:
                data = self._read_file(persona_id)
                if data is None:
                    return False
                # Rebinding this persona to a different account: drop its prior
                # index entries so the old account no longer routes here (and
                # doesn't appear as a phantom link).
                old = self._link_from_data(data)
                if old and old.get("account_id") and old["account_id"] != account_id:
                    self._link_map.pop(old["account_id"], None)
                    self._link_channel.pop(old["account_id"], None)
                link = {
                    "channel": channel,
                    "account_id": account_id,
                    "peer_id": peer_id,
                    "reply_target": reply_target,
                    "chat_type": chat_type,
                    "linked_at": _now_iso(),
                }
                self._store_link(data, link)
                self._write_file(persona_id, data)
                self._link_map[account_id] = persona_id
                self._link_channel[account_id] = channel
                return True

    def update_channel_peer(
        self, persona_id: str, peer_id: str, chat_type: str = ""
    ) -> None:
        """Lazy-backfill peer_id (and optionally chat_type) on an existing
        link, used when an inbound message arrives for a persona whose link
        was created before these fields were known."""
        if not peer_id:
            return
        lock = self._get_lock(persona_id)
        with lock:
            data = self._read_file(persona_id)
            link = self._link_from_data(data)
            if not data or not link:
                return
            changed = False
            if not link.get("peer_id"):
                link["peer_id"] = peer_id
                changed = True
            if chat_type and not link.get("chat_type"):
                link["chat_type"] = chat_type
                changed = True
            if changed:
                self._store_link(data, link)
                self._write_file(persona_id, data)

    def update_reply_target(self, persona_id: str, reply_target: str) -> None:
        """Refresh the channel reply anchor (WeChat context_token / QQ msg_id)."""
        lock = self._get_lock(persona_id)
        with lock:
            data = self._read_file(persona_id)
            link = self._link_from_data(data)
            if data and link:
                link["reply_target"] = reply_target
                self._store_link(data, link)
                self._write_file(persona_id, data)

    def remove_channel_link(self, persona_id: str) -> bool:
        lock = self._get_lock(persona_id)
        with lock:
            data = self._read_file(persona_id)
            link = self._link_from_data(data)
            if data is None or not link:
                return False
            aid = link.get("account_id", "")
            self._store_link(data, None)
            self._write_file(persona_id, data)
            self._link_map.pop(aid, None)
            self._link_channel.pop(aid, None)
            return True

    def find_by_account(self, account_id: str) -> dict | None:
        pid = self._link_map.get(account_id)
        if pid is None:
            return None
        return self._read_file(pid)

    def channel_link(self, persona_id: str) -> dict | None:
        """Return the canonical channel_link for a persona (or None).

        Migrates a legacy ``wechat_link`` on the fly; read-only.
        """
        lock = self._get_lock(persona_id)
        with lock:
            return self._link_from_data(self._read_file(persona_id))

    def get_link_channel(self, account_id: str) -> str:
        """Return the channel ("wechat"/"qq"/"plugin:<id>") for an account."""
        return self._link_channel.get(account_id, "wechat")

    def remove_links_for_account(self, account_id: str):
        """Remove the channel link from the conversation bound to this account."""
        pid = self._link_map.pop(account_id, None)
        self._link_channel.pop(account_id, None)
        if pid:
            lock = self._get_lock(pid)
            with lock:
                data = self._read_file(pid)
                if data and self._link_from_data(data):
                    self._store_link(data, None)
                    self._write_file(pid, data)

    def get_link_map(self) -> dict[str, str]:
        """Return a copy of {account_id: persona_id} mapping."""
        return dict(self._link_map)
