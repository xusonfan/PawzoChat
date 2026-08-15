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

"""REST API for conversations — list, create, messages, wechat-link, images."""

from __future__ import annotations

import secrets
from pathlib import Path

from flask import Blueprint, jsonify, request

from pawzochat.paths import CHATS_DIR, EMOJI_DIR
from pawzochat.web.routes import get_app
from pawzochat.web.sse import broadcast

api_conversations_bp = Blueprint("api_conversations", __name__)

def _images_dir(persona_id: str) -> Path:
    return CHATS_DIR / persona_id / "images"


def _files_dir(persona_id: str) -> Path:
    return CHATS_DIR / persona_id / "files"


def _persona_name(app, persona_id: str) -> str:
    personas = app.config.load_personas()
    p = personas.get(persona_id)
    return p.name if p else persona_id


def _extract_text_update(data: dict) -> str | None:
    text = data.get("text")
    if isinstance(text, str):
        return text

    content = data.get("content")
    if not isinstance(content, list):
        return None

    text_parts: list[str] = []
    has_text_block = False
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "text":
            continue
        has_text_block = True
        text_parts.append(block.get("text", ""))
    if not has_text_block:
        return None
    return "\n".join(text_parts)


@api_conversations_bp.route("", methods=["GET"])
def list_conversations():
    app = get_app()
    summaries = app.conversation_store.list_conversations()
    for s in summaries:
        s["persona_name"] = _persona_name(app, s["persona_id"])
    return jsonify({"conversations": summaries})


@api_conversations_bp.route("", methods=["POST"])
def create_conversation():
    app = get_app()
    data = request.get_json(force=True)
    persona_id = data.get("persona_id", "").strip()
    if not persona_id:
        return jsonify({"error": "persona_id is required"}), 400

    personas = app.config.load_personas()
    if persona_id not in personas:
        return jsonify({"error": f"Persona not found: {persona_id}"}), 404

    try:
        conv = app.conversation_store.create_conversation(persona_id)
    except ValueError:
        return jsonify({"error": "Conversation already exists"}), 409

    return jsonify({
        "persona_id": conv["persona_id"],
        "persona_name": _persona_name(app, persona_id),
        "created_at": conv["created_at"],
        "updated_at": conv["updated_at"],
        "wechat_linked": False,
        "unread_count": 0,
        "last_message": None,
    }), 201


@api_conversations_bp.route("/<persona_id>/read", methods=["POST"])
def mark_conversation_read(persona_id: str):
    app = get_app()
    if not app.conversation_store.mark_read(persona_id):
        return jsonify({"error": "Conversation not found"}), 404
    broadcast("conversation_updated", persona_id=persona_id)
    return jsonify({"ok": True, "unread_count": 0})


@api_conversations_bp.route("/<persona_id>/messages/dates", methods=["GET"])
def get_message_dates(persona_id: str):
    app = get_app()
    conv = app.conversation_store.get_conversation(persona_id)
    if conv is None:
        return jsonify({"error": "Conversation not found"}), 404
    dates = app.conversation_store.get_message_dates(persona_id)
    return jsonify({"dates": dates})


@api_conversations_bp.route("/<persona_id>/messages", methods=["GET"])
def get_messages(persona_id: str):
    app = get_app()
    conv = app.conversation_store.get_conversation(persona_id)
    if conv is None:
        return jsonify({"error": "Conversation not found"}), 404

    date_filter = request.args.get("date")
    if date_filter:
        messages = app.conversation_store.get_messages_by_date(
            persona_id, date_filter
        )
        return jsonify({
            "persona_id": persona_id,
            "date": date_filter,
            "messages": messages,
        })

    rounds = request.args.get("rounds", 10, type=int)
    messages, has_more = app.conversation_store.get_messages(
        persona_id, rounds=rounds
    )

    link = app.conversation_store.channel_link(persona_id)
    link_info = None
    if link:
        link_info = {
            "account_id": link.get("account_id", ""),
            "linked_at": link.get("linked_at", ""),
            "channel": link.get("channel", "wechat"),
        }

    return jsonify({
        "persona_id": persona_id,
        # Key kept as wechat_link for frontend back-compat; carries the channel.
        "wechat_link": link_info,
        "messages": messages,
        "has_more": has_more,
    })


@api_conversations_bp.route("/<persona_id>/messages", methods=["POST"])
def send_message(persona_id: str):
    app = get_app()
    conv = app.conversation_store.get_conversation(persona_id)
    if conv is None:
        return jsonify({"error": "Conversation not found"}), 404

    images: list[dict] | None = None
    files: list[dict] | None = None
    quote = ""

    if request.content_type and "multipart/form-data" in request.content_type:
        text = request.form.get("text", "").strip()
        quote = request.form.get("quote", "").strip()
        uploaded_images = request.files.getlist("images")
        if uploaded_images:
            img_dir = _images_dir(persona_id)
            img_dir.mkdir(parents=True, exist_ok=True)
            images = []
            for f in uploaded_images:
                data = f.read()
                if data:
                    mime = f.mimetype or "image/jpeg"
                    img_id = f"img_{secrets.token_hex(4)}"
                    ext = _ext_from_mime(mime)
                    save_path = img_dir / f"{img_id}{ext}"
                    save_path.write_bytes(data)
                    images.append({"data": data, "mime": mime, "path": str(save_path)})
        uploaded_files = request.files.getlist("files")
        if uploaded_files:
            f_dir = _files_dir(persona_id)
            f_dir.mkdir(parents=True, exist_ok=True)
            files = []
            for f in uploaded_files:
                data = f.read()
                if data:
                    original_name = f.filename or "file"
                    mime = f.mimetype or "application/octet-stream"
                    file_id = f"file_{secrets.token_hex(4)}"
                    ext = _ext_from_name(original_name)
                    save_path = f_dir / f"{file_id}{ext}"
                    save_path.write_bytes(data)
                    files.append({"path": str(save_path), "name": original_name, "mime": mime})
    else:
        data = request.get_json(force=True)
        text = data.get("text", "").strip()
        raw_quote = data.get("quote", "")
        quote = raw_quote.strip() if isinstance(raw_quote, str) else ""

        sticker_url = data.get("sticker_url", "").strip()
        if sticker_url:
            sticker_path = _resolve_sticker_path(sticker_url)
            if sticker_path is None:
                return jsonify({"error": "Invalid sticker path"}), 400
            sticker_data = sticker_path.read_bytes()
            ext = sticker_path.suffix.lower()
            mime = {
                ".png": "image/png", ".gif": "image/gif",
                ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                ".webp": "image/webp",
            }.get(ext, "image/png")
            img_dir = _images_dir(persona_id)
            img_dir.mkdir(parents=True, exist_ok=True)
            img_id = f"img_{secrets.token_hex(4)}"
            save_path = img_dir / f"{img_id}{ext}"
            save_path.write_bytes(sticker_data)
            images = [{"data": sticker_data, "mime": mime, "path": str(save_path)}]

    if not text and not images and not files:
        return jsonify({"error": "text, images or files required"}), 400

    accepted = app.message_queue.accept_message(
        persona_id,
        text or "",
        source="web",
        reply_ctx={"channel": "web"},
        images=images,
        files=files,
        quote=quote,
    )
    if not accepted:
        return jsonify({"queued": False, "cancelled": True}), 202

    actual_persona_id, msg = accepted
    return jsonify({
        "queued": True,
        "persona_id": actual_persona_id,
        "message": msg,
    }), 202


def _resolve_sticker_path(sticker_url: str) -> Path | None:
    """Resolve a ``/emoji-static/...`` URL to a validated file path inside EMOJI_DIR."""
    prefix = "/emoji-static/"
    if not sticker_url.startswith(prefix):
        return None
    relative = sticker_url[len(prefix):]
    if not relative or ".." in relative:
        return None
    target = (EMOJI_DIR / relative).resolve()
    try:
        target.relative_to(EMOJI_DIR.resolve())
    except ValueError:
        return None
    if not target.is_file():
        return None
    return target


def _ext_from_mime(mime: str) -> str:
    mapping = {
        "image/jpeg": ".jpg", "image/jpg": ".jpg",
        "image/png": ".png", "image/gif": ".gif",
        "image/webp": ".webp",
    }
    return mapping.get(mime.lower(), ".jpg")


def _ext_from_name(filename: str) -> str:
    idx = filename.rfind(".")
    return filename[idx:].lower() if idx >= 0 else ""


@api_conversations_bp.route("/<persona_id>/messages", methods=["DELETE"])
def clear_messages(persona_id: str):
    app = get_app()
    ok = app.conversation_store.clear_messages(persona_id)
    if not ok:
        return jsonify({"error": "Conversation not found"}), 404
    broadcast("conversation_updated", persona_id=persona_id)
    return jsonify({"ok": True})


@api_conversations_bp.route("/<persona_id>/messages/<int:index>", methods=["PUT"])
def update_message(persona_id: str, index: int):
    app = get_app()
    data = request.get_json(force=True)
    text = _extract_text_update(data)
    if text is None:
        return jsonify({"error": "text is required"}), 400

    # ``quote`` absent -> None (leave untouched); present -> set/clear. Validate
    # type and strip, mirroring the send path, so a non-string (which would later
    # break LLM rounds) or whitespace-only value can never be persisted.
    quote = data.get("quote", None)
    if quote is not None:
        if not isinstance(quote, str):
            return jsonify({"error": "quote must be a string"}), 400
        quote = quote.strip()

    status = app.conversation_store.update_message(
        persona_id,
        index,
        text,
        expected_fingerprint=data.get("fingerprint", "").strip(),
        quote=quote,
    )
    if status == "not_found":
        return jsonify({"error": "Message not found"}), 404
    if status == "conflict":
        return jsonify({"error": "Message changed, reload and retry"}), 409
    if status == "not_editable":
        return jsonify({"error": "Message has no editable text"}), 409
    if status == "invalid":
        return jsonify({"error": "Message content is invalid"}), 409

    broadcast("conversation_updated", persona_id=persona_id)
    return jsonify({"ok": True})


@api_conversations_bp.route("/<persona_id>/messages/<int:index>", methods=["DELETE"])
def delete_message(persona_id: str, index: int):
    app = get_app()
    status = app.conversation_store.delete_message(
        persona_id,
        index,
        expected_fingerprint=request.args.get("fingerprint", "").strip(),
    )
    if status == "not_found":
        return jsonify({"error": "Message not found"}), 404
    if status == "conflict":
        return jsonify({"error": "Message changed, reload and retry"}), 409
    broadcast("conversation_updated", persona_id=persona_id)
    return jsonify({"ok": True})


@api_conversations_bp.route("/<persona_id>", methods=["DELETE"])
def delete_conversation(persona_id: str):
    app = get_app()
    ok = app.conversation_store.delete_conversation(persona_id)
    if not ok:
        return jsonify({"error": "Conversation not found"}), 404
    broadcast("conversation_updated", persona_id=persona_id)
    return jsonify({"ok": True})


# ---- Channel link (persona <-> account binding) ----
# Route path kept as /wechat-link for frontend back-compat; the channel is
# derived from the account being bound, so any channel works.

@api_conversations_bp.route("/<persona_id>/wechat-link", methods=["POST"])
def set_wechat_link(persona_id: str):
    app = get_app()
    data = request.get_json(force=True)
    account_id = data.get("account_id", "").strip()
    if not account_id:
        return jsonify({"error": "account_id is required"}), 400

    conv = app.conversation_store.get_conversation(persona_id)
    if conv is None:
        return jsonify({"error": "Conversation not found"}), 404

    acc = next((a for a in app.accounts if a.bot_id == account_id), None)
    channel_type = acc.channel_type if acc else "wechat"

    try:
        app.conversation_store.set_channel_link(
            persona_id, account_id, channel=channel_type,
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 409

    broadcast("conversation_updated", persona_id=persona_id)
    return jsonify({"ok": True})


@api_conversations_bp.route("/<persona_id>/wechat-link", methods=["DELETE"])
def remove_wechat_link(persona_id: str):
    app = get_app()
    ok = app.conversation_store.remove_channel_link(persona_id)
    if not ok:
        return jsonify({"error": "No link to remove"}), 404
    broadcast("conversation_updated", persona_id=persona_id)
    return jsonify({"ok": True})


# ---- Channel links overview ----

@api_conversations_bp.route("/wechat-links", methods=["GET"])
def get_wechat_links():
    app = get_app()
    link_map = app.conversation_store.get_link_map()
    links = []
    for account_id, persona_id in link_map.items():
        links.append({
            "account_id": account_id,
            "persona_id": persona_id,
            "persona_name": _persona_name(app, persona_id),
            "channel": app.conversation_store.get_link_channel(account_id),
        })
    return jsonify({"links": links})
