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

"""QQ Bot API v2 data models and protocol constants."""

from __future__ import annotations

from dataclasses import dataclass, field

# ---- WebSocket gateway opcodes ----
OP_DISPATCH = 0
OP_HEARTBEAT = 1
OP_IDENTIFY = 2
OP_RESUME = 6
OP_RECONNECT = 7
OP_INVALID_SESSION = 9
OP_HELLO = 10
OP_HEARTBEAT_ACK = 11

# ---- Intents ----
# Bit 25 subscribes to the group-and-C2C event family, which includes
# C2C_MESSAGE_CREATE (private 1:1 messages) and GROUP_AT_MESSAGE_CREATE. The
# bot must also have C2C messaging enabled in the QQ dev console.
INTENT_GROUP_AND_C2C = 1 << 25

# ---- Dispatch event types we care about ----
EVENT_C2C_MESSAGE_CREATE = "C2C_MESSAGE_CREATE"
EVENT_READY = "READY"
EVENT_RESUMED = "RESUMED"

# ---- Rich-media file_type values (upload) ----
FILE_TYPE_IMAGE = 1
FILE_TYPE_VIDEO = 2
FILE_TYPE_AUDIO = 3
FILE_TYPE_FILE = 4

# ---- Message types (send) ----
MSG_TYPE_TEXT = 0
MSG_TYPE_MARKDOWN = 2
MSG_TYPE_MEDIA = 7
MSG_TYPE_QUOTE = 103


@dataclass
class QQAttachment:
    content_type: str = ""
    url: str = ""
    # QQ voice events may expose a decoded WAV URL in addition to their original
    # SILK URL. Its presence is also an unambiguous native-voice marker.
    voice_wav_url: str = ""
    filename: str = ""
    size: int = 0
    # Speech-to-text supplied with the QQ attachment.  It is optional, so the
    # channel must not assume every voice event contains a transcript.
    asr_refer_text: str = ""

    @property
    def is_image(self) -> bool:
        return self.content_type.startswith("image/")

    @property
    def is_video(self) -> bool:
        return self.content_type.startswith("video/")

    @property
    def is_voice(self) -> bool:
        # QQ's gateway does not consistently use a MIME type here: native
        # voice bubbles commonly arrive as content_type="voice" with an .amr
        # filename whose payload is actually SILK. Conversely, an "audio/*"
        # MIME type or audio filename alone may be a regular file and must
        # remain eligible for the generic file path.
        content_type = self.content_type.strip().lower()
        return bool(
            content_type == "voice"
            or content_type.startswith("voice/")
            or self.voice_wav_url
            or self.asr_refer_text
        )


@dataclass
class QQInboundMessage:
    """A parsed inbound C2C (private) message from the gateway."""

    msg_id: str = ""        # passive-reply anchor (the event's "id")
    openid: str = ""        # author.user_openid — the C2C send target
    content: str = ""
    timestamp: str = ""
    attachments: list[QQAttachment] = field(default_factory=list)
    message_type: int | None = None
    msg_idx: str = ""
    ref_msg_idx: str = ""
    msg_elements: list[dict] = field(default_factory=list)
    quote: str = ""
    quote_text: str = ""
    quote_media: list[dict] = field(default_factory=list)
    raw: dict = field(default_factory=dict)

    @classmethod
    def from_c2c_event(cls, d: dict) -> "QQInboundMessage":
        author = d.get("author", {}) or {}
        attachments = [
            _parse_attachment(a)
            for a in d.get("attachments", []) or []
            if isinstance(a, dict)
        ]
        msg_elements = [
            element for element in d.get("msg_elements", []) or []
            if isinstance(element, dict)
        ]
        try:
            message_type = int(d["message_type"])
        except (KeyError, TypeError, ValueError):
            message_type = None
        message_scene = d.get("message_scene")
        msg_idx, ref_msg_idx = _parse_ref_indices(
            message_scene.get("ext") if isinstance(message_scene, dict) else None,
            message_type,
            msg_elements,
        )
        return cls(
            msg_id=str(d.get("id", "") or ""),
            openid=author.get("user_openid", "") or author.get("id", "") or "",
            content=d.get("content", "") or "",
            timestamp=d.get("timestamp", "") or "",
            attachments=attachments,
            message_type=message_type,
            msg_idx=msg_idx,
            ref_msg_idx=ref_msg_idx,
            msg_elements=msg_elements,
            quote=_quote_from_elements(msg_elements) if ref_msg_idx else "",
            quote_text=str(msg_elements[0].get("content") or "") if ref_msg_idx and msg_elements else "",
            quote_media=_quote_media_from_elements(msg_elements) if ref_msg_idx else [],
            raw=d,
        )

    @property
    def image_attachments(self) -> list[QQAttachment]:
        return [a for a in self.attachments if a.is_image and a.url]

    @property
    def video_attachments(self) -> list[QQAttachment]:
        return [a for a in self.attachments if a.is_video and a.url]

    @property
    def voice_attachments(self) -> list[QQAttachment]:
        return [a for a in self.attachments if a.is_voice]

    @property
    def file_attachments(self) -> list[QQAttachment]:
        """Attachments that are neither image, video, nor native QQ voice."""
        return [
            a for a in self.attachments
            if a.url and not a.is_image and not a.is_video and not a.is_voice
        ]


def _parse_attachment(data: dict) -> QQAttachment:
    try:
        size = int(data.get("size", 0) or 0)
    except (TypeError, ValueError):
        size = 0
    return QQAttachment(
        content_type=data.get("content_type", "") or "",
        url=data.get("url", "") or "",
        voice_wav_url=data.get("voice_wav_url", "") or "",
        filename=data.get("filename", "") or "",
        size=size,
        asr_refer_text=data.get("asr_refer_text", "") or "",
    )


def _parse_ref_indices(
    ext: object,
    message_type: int | None,
    msg_elements: list[dict],
) -> tuple[str, str]:
    """Parse native and legacy QQ reference-index markers."""
    msg_idx = ""
    ref_msg_idx = ""
    if isinstance(ext, list):
        for item in ext:
            if not isinstance(item, str):
                continue
            if item.startswith("ref_msg_idx="):
                ref_msg_idx = item.removeprefix("ref_msg_idx=").strip()
            elif item.startswith("msg_idx="):
                msg_idx = item.removeprefix("msg_idx=").strip()
            elif item.startswith("refMsgIdx:"):
                ref_msg_idx = item.removeprefix("refMsgIdx:").strip()
            elif item.startswith("msgIdx:"):
                msg_idx = item.removeprefix("msgIdx:").strip()

    if message_type == MSG_TYPE_QUOTE:
        for element in msg_elements:
            element_idx = str(element.get("msg_idx", "") or "").strip()
            if element_idx:
                ref_msg_idx = element_idx
                break
    return msg_idx, ref_msg_idx


def _quote_media_from_elements(msg_elements: list[dict]) -> list[dict]:
    if not msg_elements:
        return []
    result = []
    for raw in msg_elements[0].get("attachments", []) or []:
        if not isinstance(raw, dict):
            continue
        att = _parse_attachment(raw)
        kind = "image" if att.is_image else "voice" if att.is_voice or att.content_type.startswith("audio/") else "file"
        result.append({"type": kind, "name": att.filename, "mime": att.content_type,
                       "text": att.asr_refer_text})
    return result


def _quote_from_elements(msg_elements: list[dict]) -> str:
    """Build a compact quote string from the platform-provided first element."""
    if not msg_elements:
        return ""
    element = msg_elements[0]
    parts: list[str] = []
    content = str(element.get("content", "") or "").strip()
    if content:
        parts.append(content)
    for raw in element.get("attachments", []) or []:
        if not isinstance(raw, dict):
            continue
        attachment = _parse_attachment(raw)
        content_type = attachment.content_type.lower()
        name = attachment.filename.strip()
        if attachment.is_voice or content_type.startswith("audio/"):
            label = (
                f"[语音：{attachment.asr_refer_text.strip()}]"
                if attachment.asr_refer_text.strip()
                else "[语音]"
            )
        elif content_type.startswith("image/"):
            label = f"[图片：{name}]" if name else "[图片]"
        elif content_type.startswith("video/"):
            label = f"[视频：{name}]" if name else "[视频]"
        else:
            label = f"[文件：{name}]" if name else "[文件]"
        parts.append(label)
    return "\n".join(parts)
