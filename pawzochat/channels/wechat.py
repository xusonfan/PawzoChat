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

"""Core WeChat bridge for inbound and outbound messaging."""

from __future__ import annotations

import logging
import secrets
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from pawzochat.channels.base import Channel
from pawzochat.paths import CHATS_DIR
from pawzochat.transport.client import (
    DEFAULT_BASE_URL,
    DEFAULT_LONG_POLL_TIMEOUT,
    ILinkClient,
)
from pawzochat.transport.models import Account, Message, MessageItemType
from pawzochat.transport.poller import MessagePoller
from pawzochat.transport.sender import MessageSender
from pawzochat.utils.message_text import (
    build_wechat_inbound_text,
    extract_wechat_quote,
)

if TYPE_CHECKING:
    from pawzochat.app import App

logger = logging.getLogger(__name__)

_MIME_SIGNATURES: list[tuple[bytes, str]] = [
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"RIFF", "image/webp"),
]

_MIME_TO_EXT = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
}

MAX_INBOUND_IMAGE_BYTES = 20 * 1024 * 1024
MAX_INBOUND_MEDIA_BYTES = 100 * 1024 * 1024
MAX_INBOUND_VOICE_BYTES = 20 * 1024 * 1024

# openclaw active-push policy: a context_token stays valid for 24h and accepts
# at most 10 bot messages; both reset when the user sends a new message.
WECHAT_SAFETY_WINDOW_SECONDS = 23 * 3600  # 1h buffer under the 24h TTL
WECHAT_MAX_REPLIES_PER_CONTEXT = 10


def _scan_push_context(messages: list[dict]) -> tuple[float, int]:
    """Return (epoch of the WeChat message anchoring the context_token,
    estimated reply slots already used against it).

    Web-preview user messages (``source == "web"``) are skipped: they never
    reach WeChat, so they refresh neither the context_token nor its quota.
    Reply slots are counted per individual WeChat send (mirroring
    ``deliver_message``: one per image/emoji/file/voice block plus one per
    non-empty text) across all assistant messages stored after the anchor.
    Replies that never went to WeChat (web-chat replies, failed sends) still
    count — overcounting only skips a push early, the safe direction.

    Returns ``(0.0, used)`` when no anchorable user message exists.
    """
    used = 0
    for msg in reversed(messages):
        role = msg.get("role")
        if role == "user":
            if msg.get("source") == "web":
                continue
            try:
                return datetime.fromisoformat(msg.get("timestamp", "")).timestamp(), used
            except (ValueError, TypeError):
                continue  # unusable anchor — keep scanning older messages
        if role != "assistant":
            continue
        text = ""
        for block in msg.get("content", []) or []:
            btype = block.get("type", "")
            if btype in {"emoji", "image", "file", "voice"}:
                if block.get("path"):
                    used += 1
            elif btype == "text":
                text += block.get("text", "")
        if text.strip():
            used += 1
    return 0.0, used


def _detect_mime(data: bytes) -> str:
    for sig, mime in _MIME_SIGNATURES:
        if data[:len(sig)] == sig:
            if mime == "image/webp" and data[8:12] != b"WEBP":
                continue
            return mime
    return "image/jpeg"


def _ext_from_name(filename: str) -> str:
    idx = filename.rfind(".")
    return filename[idx:].lower() if idx >= 0 else ""


_EXT_TO_MIME = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".zip": "application/zip",
    ".rar": "application/x-rar-compressed",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
}


def _mime_from_ext(ext: str) -> str:
    return _EXT_TO_MIME.get(ext.lower(), "application/octet-stream")


def _parse_declared_size(raw: object) -> int | None:
    try:
        size = int(raw)
    except (TypeError, ValueError):
        return None
    return size if size >= 0 else None


class WeChatChannel(Channel):
    """Bridge between iLink messages and the internal chat pipeline.

    Owns the per-account iLink transport (HTTP client, message sender, and
    long-poll receive loop) for every WeChat account.
    """

    channel_type = "wechat"
    display_name = "微信"

    def __init__(self, app: App):
        super().__init__(app)
        self._clients: dict[str, ILinkClient] = {}
        self._senders: dict[str, MessageSender] = {}
        self._pollers: dict[str, MessagePoller] = {}

    # ---- Per-account lifecycle ----

    def start_account(self, account: Account) -> None:
        # Idempotent: tear down any stale transport for this bot_id first so a
        # double-start can't leak an orphaned poller thread / client.
        if account.bot_id in self._pollers or account.bot_id in self._clients:
            self.stop_account(account.bot_id)
        base_url = str(
            (account.extra or {}).get("base_url", "") or DEFAULT_BASE_URL
        )
        client = ILinkClient(account.bot_token, base_url)
        self._clients[account.bot_id] = client

        reply_cfg = self._app.config.get("reply", default={})
        sender = MessageSender(client, reply_cfg)
        self._senders[account.bot_id] = sender

        poller = MessagePoller(
            account,
            client,
            self._app._auth_manager,
            self.handle_incoming,
            DEFAULT_LONG_POLL_TIMEOUT,
        )
        self._pollers[account.bot_id] = poller
        poller.start()

        # Best-effort online notify; fire-and-forget so startup restore of N
        # accounts isn't serialized behind N HTTP round-trips.
        threading.Thread(
            target=client.notify_start,
            name=f"notify-start-{account.bot_id[:8]}",
            daemon=True,
        ).start()

        logger.info("账号已上线: %s", account.bot_id)

    def stop_account(self, account_id: str) -> None:
        poller = self._pollers.pop(account_id, None)
        if poller:
            poller.stop()
        # Best-effort offline notify before discarding the client.
        client = self._clients.pop(account_id, None)
        if client:
            threading.Thread(target=client.notify_stop, daemon=True).start()
        self._senders.pop(account_id, None)

    def notify_offline(self) -> None:
        # Fire all offline notifies concurrently (no join) so they get maximum
        # wall-clock before exit without serializing N×timeout.
        for client in self._clients.values():
            threading.Thread(target=client.notify_stop, daemon=True).start()

    def shutdown(self) -> None:
        for poller in self._pollers.values():
            poller.stop()

    def is_online(self, account_id: str) -> bool:
        poller = self._pollers.get(account_id)
        return bool(poller and poller.running)

    # ---- Account creation metadata ----

    def account_form(self) -> dict:
        return {"method": "qr", "fields": []}

    def reply_ctx_from_link(self, channel_link: dict) -> dict:
        # WeChat's deliver_message reads ``context_token``, not ``reply_target``.
        return {
            "channel": "wechat",
            "account_id": channel_link.get("account_id", ""),
            "user_id": channel_link.get("peer_id", ""),
            "context_token": channel_link.get("reply_target", ""),
        }

    def can_push_now(
        self,
        channel_link: dict,
        last_user_at: float,
        messages: list[dict],
    ) -> bool:
        # WeChat group chats can't be proactively messaged; the iLink
        # context_token expires after the openclaw 23h window and accepts at
        # most 10 bot messages. Both reset only on an inbound WeChat message,
        # so the anchor is derived from message provenance here rather than
        # from ``last_user_at`` (which web-preview chatter also refreshes).
        if (channel_link.get("chat_type") or "single") == "group":
            return False
        anchor_at, used = _scan_push_context(messages)
        if anchor_at <= 0:
            return False
        if (time.time() - anchor_at) > WECHAT_SAFETY_WINDOW_SECONDS:
            return False
        return used < WECHAT_MAX_REPLIES_PER_CONTEXT

    # ---- Inbound ----

    def handle_incoming(self, account_id: str, message: Message) -> None:
        images = self._extract_images(account_id, message)
        files = self._extract_files(account_id, message)
        voice_metas = self._extract_voices(account_id, message)
        text = build_wechat_inbound_text(message)
        quote = extract_wechat_quote(message)

        if not text and not images and not files and not voice_metas:
            logger.debug("忽略空消息 from=%s", message.from_user_id)
            return

        conversation = self._app.conversation_store.find_by_account(account_id)
        if not conversation:
            self._reply_no_binding(account_id, message)
            return

        persona_id = conversation["persona_id"]

        if images:
            images = self._download_and_save_images(images, persona_id)
        if files:
            files = self._download_and_save_files(files, persona_id)
        voices, failed_voice_texts = self._download_and_save_voices(
            voice_metas, persona_id,
        )
        for transcript in failed_voice_texts:
            fallback = f"[语音] {transcript}"
            text = f"{text}\n{fallback}" if text else fallback

        if not text and not images and not files and not voices:
            logger.debug("媒体下载失败，无有效内容 from=%s", message.from_user_id)
            return

        source_ts: str | None = None
        if message.create_time_ms:
            dt = datetime.fromtimestamp(
                message.create_time_ms / 1000, tz=timezone.utc,
            ).astimezone()
            source_ts = dt.isoformat()

        reply_ctx = {
            "channel": "wechat",
            "account_id": account_id,
            "user_id": message.from_user_id,
            "context_token": message.context_token,
        }
        accepted = self._app.message_queue.accept_message(
            persona_id,
            text or "",
            source="wechat",
            reply_ctx=reply_ctx,
            images=images or None,
            files=files or None,
            voices=voices or None,
            raw_message=message,
            account_id=account_id,
            user_id=message.from_user_id,
            context_token=message.context_token,
            timestamp=source_ts,
            quote=quote,
        )
        if accepted:
            actual_persona_id, _msg = accepted
            if message.context_token:
                self._app.conversation_store.update_reply_target(
                    actual_persona_id, message.context_token,
                )
            # Lazy-backfill peer_id / chat_type so proactive messages can
            # build a reply_ctx without an inbound trigger.
            chat_type = "group" if message.group_id else "single"
            self._app.conversation_store.update_channel_peer(
                actual_persona_id, message.from_user_id, chat_type=chat_type,
            )

    # ---- Voice extraction --------------------------------------------------

    @staticmethod
    def _extract_voices(account_id: str, message: Message) -> list[dict]:
        """Return transcribed WeChat voice items for deferred media download."""
        voices: list[dict] = []
        for item in message.items:
            if item.type != MessageItemType.VOICE or not item.voice:
                continue
            transcript = (item.voice.text or "").strip()
            if not transcript:
                logger.info(
                    "[%s] 收到语音消息，但事件未包含转写 from=%s",
                    account_id[:8], message.from_user_id[:12],
                )
                continue
            voices.append({
                "voice_data": item.voice,
                "text": transcript,
            })
        return voices

    @staticmethod
    def _download_and_save_voices(
        voice_metas: list[dict],
        persona_id: str,
    ) -> tuple[list[dict], list[str]]:
        """Persist browser-playable inbound voices and return failed transcripts."""
        if not voice_metas:
            return [], []

        from pawzochat.transport.cdn import download_media
        from pawzochat.voice.transcode import normalize_inbound_audio

        voice_dir = CHATS_DIR / persona_id / "voice"
        voice_dir.mkdir(parents=True, exist_ok=True)
        result: list[dict] = []
        failed: list[str] = []

        for meta in voice_metas:
            voice_data = meta["voice_data"]
            transcript = meta["text"]
            media = voice_data.media
            if (
                not media
                or (not media.encrypt_query_param and not media.full_url)
                or not media.aes_key
            ):
                logger.warning(
                    "微信语音缺少可下载的 CDN 信息: persona=%s", persona_id,
                )
                failed.append(transcript)
                continue
            try:
                raw = download_media(
                    media,
                    label="voice",
                    max_bytes=MAX_INBOUND_VOICE_BYTES,
                )
                playable, ext, mime, probed_duration = normalize_inbound_audio(
                    raw,
                    encode_type=voice_data.encode_type,
                    sample_rate=voice_data.sample_rate,
                )
                save_path = voice_dir / f"voice_{secrets.token_hex(4)}{ext}"
                save_path.write_bytes(playable)
            except Exception:
                logger.exception("微信语音下载或转码失败: persona=%s", persona_id)
                failed.append(transcript)
                continue

            duration_ms = _parse_declared_size(voice_data.playtime) or probed_duration
            result.append({
                "path": str(save_path),
                "mime": mime,
                "duration_ms": duration_ms,
                "text": transcript,
            })
            logger.info(
                "微信语音已保存: %s (%d bytes, %s, %dms)",
                save_path.name, len(playable), mime, duration_ms,
            )
        return result, failed

    # ---- Image extraction --------------------------------------------------

    @staticmethod
    def _extract_images(account_id: str, message: Message) -> list[dict]:
        """Return a list of image CDN metadata dicts from the message items."""
        images = []
        for item in message.items:
            if item.type != MessageItemType.IMAGE or not item.image:
                continue
            img = item.image
            if not img.media:
                continue
            if not img.media.encrypt_query_param and not img.media.full_url:
                continue
            declared_size = _parse_declared_size(img.mid_size)
            if declared_size and declared_size > MAX_INBOUND_IMAGE_BYTES:
                logger.warning(
                    "[%s] 跳过超限图片 from=%s size=%d limit=%d",
                    account_id[:8], message.from_user_id[:12],
                    declared_size, MAX_INBOUND_IMAGE_BYTES,
                )
                continue
            images.append({"image_data": img})
        if images:
            logger.info(
                "[%s] 检测到 %d 张图片 from=%s",
                account_id[:8], len(images), message.from_user_id[:12],
            )
        return images

    @staticmethod
    def _download_and_save_images(
        image_metas: list[dict],
        persona_id: str,
    ) -> list[dict]:
        """Download images from CDN and save to disk. Returns image dicts
        compatible with the message queue (data, mime, path)."""
        from pawzochat.transport.cdn import download_image

        img_dir = CHATS_DIR / persona_id / "images"
        img_dir.mkdir(parents=True, exist_ok=True)

        result: list[dict] = []
        for meta in image_metas:
            image_data = meta["image_data"]
            try:
                raw_bytes = download_image(
                    image_data,
                    max_bytes=MAX_INBOUND_IMAGE_BYTES,
                )
            except ValueError as exc:
                logger.warning("CDN 图片已跳过: persona=%s reason=%s", persona_id, exc)
            except Exception:
                logger.exception("CDN 图片下载失败: persona=%s", persona_id)
                continue
            else:
                mime = _detect_mime(raw_bytes)
                ext = _MIME_TO_EXT.get(mime, ".jpg")
                img_id = f"img_{secrets.token_hex(4)}"
                save_path = img_dir / f"{img_id}{ext}"
                save_path.write_bytes(raw_bytes)

                result.append({
                    "data": raw_bytes,
                    "mime": mime,
                    "path": str(save_path),
                })
                logger.info(
                    "微信图片已保存: %s (%d bytes, %s)",
                    save_path.name, len(raw_bytes), mime,
                )

        return result

    # ---- File / video extraction -------------------------------------------

    _FILE_TYPE_LABELS = {
        MessageItemType.FILE: "文件",
        MessageItemType.VIDEO: "视频",
    }

    @staticmethod
    def _extract_files(account_id: str, message: Message) -> list[dict]:
        """Return a list of file/video CDN metadata dicts from message items."""
        files: list[dict] = []
        for item in message.items:
            if item.type == MessageItemType.FILE and item.file:
                if not item.file.media:
                    continue
                media = item.file.media
                if not media.encrypt_query_param and not media.full_url:
                    continue
                if not media.aes_key:
                    logger.warning(
                        "[%s] 跳过缺少 aes_key 的文件 from=%s",
                        account_id[:8], message.from_user_id[:12],
                    )
                    continue
                declared_size = _parse_declared_size(item.file.length)
                if declared_size and declared_size > MAX_INBOUND_MEDIA_BYTES:
                    logger.warning(
                        "[%s] 跳过超限文件 from=%s size=%d limit=%d",
                        account_id[:8], message.from_user_id[:12],
                        declared_size, MAX_INBOUND_MEDIA_BYTES,
                    )
                    continue
                files.append({
                    "media": media,
                    "name": item.file.file_name or "file",
                    "kind": "file",
                })
            elif item.type == MessageItemType.VIDEO and item.video:
                if not item.video.media:
                    continue
                media = item.video.media
                if not media.encrypt_query_param and not media.full_url:
                    continue
                if not media.aes_key:
                    logger.warning(
                        "[%s] 跳过缺少 aes_key 的视频 from=%s",
                        account_id[:8], message.from_user_id[:12],
                    )
                    continue
                declared_size = _parse_declared_size(item.video.video_size)
                if declared_size and declared_size > MAX_INBOUND_MEDIA_BYTES:
                    logger.warning(
                        "[%s] 跳过超限视频 from=%s size=%d limit=%d",
                        account_id[:8], message.from_user_id[:12],
                        declared_size, MAX_INBOUND_MEDIA_BYTES,
                    )
                    continue
                files.append({
                    "media": media,
                    "name": "video.mp4",
                    "kind": "video",
                })
        if files:
            logger.info(
                "[%s] 检测到 %d 个文件/视频 from=%s",
                account_id[:8], len(files), message.from_user_id[:12],
            )
        return files

    @staticmethod
    def _download_and_save_files(
        file_metas: list[dict],
        persona_id: str,
    ) -> list[dict]:
        """Download files from CDN and save to disk. Returns file dicts
        with path, name, and mime for downstream processing."""
        from pawzochat.transport.cdn import download_media_to_path

        files_dir = CHATS_DIR / persona_id / "files"
        files_dir.mkdir(parents=True, exist_ok=True)

        result: list[dict] = []
        for meta in file_metas:
            original_name = meta["name"]
            file_id = f"file_{secrets.token_hex(4)}"
            ext = _ext_from_name(original_name)
            if meta["kind"] == "video" and not ext:
                ext = ".mp4"
            save_name = f"{file_id}{ext}"
            save_path = files_dir / save_name

            try:
                saved_size = download_media_to_path(
                    meta["media"],
                    save_path,
                    label=meta["kind"],
                    max_bytes=MAX_INBOUND_MEDIA_BYTES,
                )
            except ValueError as exc:
                logger.warning(
                    "CDN %s已跳过: persona=%s reason=%s",
                    meta["kind"], persona_id, exc,
                )
                continue
            except Exception:
                logger.exception(
                    "CDN %s下载失败: persona=%s", meta["kind"], persona_id,
                )
                continue

            mime = _mime_from_ext(ext)
            result.append({
                "path": str(save_path),
                "name": original_name,
                "mime": mime,
            })
            logger.info(
                "微信%s已保存: %s (%d bytes, %s)",
                meta["kind"], save_name, saved_size, mime,
            )

        return result

    def deliver_message(
        self,
        persona_id: str,
        message: dict,
        reply_ctx: dict | None = None,
        *,
        is_first: bool = False,
        is_last: bool = False,
    ) -> bool:
        if not reply_ctx:
            return False

        account_id = reply_ctx.get("account_id", "")
        user_id = reply_ctx.get("user_id", "")
        context_token = reply_ctx.get("context_token", "")

        if not account_id or not user_id:
            return False

        sender = self._senders.get(account_id)
        if not sender:
            return False

        ilink_user_id = self._resolve_ilink_user_id(account_id)
        content_blocks = message.get("content", [])

        delivered = True
        image_blocks = [
            block
            for block in content_blocks
            if block.get("type") in {"emoji", "image"}
        ]
        for block in image_blocks:
            image_path = block.get("path", "")
            if image_path:
                delivered = sender.send_image(
                    user_id, image_path, context_token,
                ) and delivered

        file_blocks = [
            block
            for block in content_blocks
            if block.get("type") == "file"
        ]
        for block in file_blocks:
            file_path = block.get("path", "")
            if file_path:
                delivered = sender.send_file(
                    user_id,
                    file_path,
                    context_token,
                    block.get("name", ""),
                ) and delivered

        voice_blocks = [
            block
            for block in content_blocks
            if block.get("type") == "voice"
        ]
        if voice_blocks:
            # iLink's delivery pipeline drops bot-sent voice_item: sendmessage
            # returns 200 + message_id but the recipient never gets a bubble.
            # Verified empirically (byte-mirroring a real inbound voice_item
            # included); the official openclaw-weixin plugin never sends VOICE
            # either. Deliver TTS clips as an audio file card instead.
            for block in voice_blocks:
                voice_path = block.get("path", "")
                if not voice_path:
                    continue
                ext = Path(voice_path).suffix or ".mp3"
                delivered = sender.send_file(
                    user_id,
                    voice_path,
                    context_token,
                    f"语音消息{ext}",
                ) and delivered

        text = "".join(
            block.get("text", "")
            for block in content_blocks
            if block.get("type") == "text"
        )
        if text.strip():
            delivered = sender.send_one_reply(
                user_id,
                text,
                context_token,
                ilink_user_id,
                is_first=is_first,
            ) and delivered

        if is_last and delivered:
            logger.info("[%s] 回复 %s 投递完成", account_id[:8], user_id[:12])

        return delivered

    def _resolve_ilink_user_id(self, account_id: str) -> str:
        for account in self._app.accounts:
            if account.bot_id == account_id:
                return account.ilink_user_id
        return ""

    def _reply_no_binding(self, account_id: str, message: Message) -> None:
        sender = self._senders.get(account_id)
        if not sender:
            return
        ilink_user_id = self._resolve_ilink_user_id(account_id)
        sender.send_reply(
            message.from_user_id,
            "当前尚未绑定任何角色",
            message.context_token,
            ilink_user_id,
        )
