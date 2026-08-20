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

import logging
import re
import secrets
from pathlib import Path

from flask import Blueprint, jsonify, request

from pawzochat.paths import CHATS_DIR, EMOJI_DIR
from pawzochat.web.message_serialization import messages_for_api
from pawzochat.web.routes import get_app
from pawzochat.web.sse import broadcast

api_conversations_bp = Blueprint("api_conversations", __name__)
logger = logging.getLogger(__name__)
_IMAGE_TASK_ID_RE = re.compile(r"^[0-9a-f]{16}$")


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
        "pinned": False,
        "hidden_at": None,
        "unread_count": 0,
        "last_message": None,
    }), 201


@api_conversations_bp.route("/<persona_id>/pinned", methods=["PUT"])
def set_conversation_pinned(persona_id: str):
    app = get_app()
    data = request.get_json(force=True)
    pinned = data.get("pinned")
    if not isinstance(pinned, bool):
        return jsonify({"error": "pinned must be a boolean"}), 400
    if not app.conversation_store.set_pinned(persona_id, pinned):
        return jsonify({"error": "Conversation not found"}), 404
    broadcast("conversation_updated", persona_id=persona_id)
    return jsonify({"ok": True, "pinned": pinned})


@api_conversations_bp.route("/<persona_id>/visibility", methods=["PUT"])
def set_conversation_visibility(persona_id: str):
    app = get_app()
    data = request.get_json(force=True)
    hidden = data.get("hidden")
    if not isinstance(hidden, bool):
        return jsonify({"error": "hidden must be a boolean"}), 400
    action = (
        app.conversation_store.hide_conversation
        if hidden else app.conversation_store.restore_hidden
    )
    if not action(persona_id):
        return jsonify({"error": "Conversation not found"}), 404
    broadcast("conversation_updated", persona_id=persona_id)
    return jsonify({"ok": True, "hidden": hidden})


@api_conversations_bp.route("/<persona_id>/read", methods=["POST"])
def mark_conversation_read(persona_id: str):
    app = get_app()
    data = request.get_json(silent=True) or {}
    through_seq = data.get("through_seq")
    if through_seq is None:
        logger.warning(
            "忽略缺少消息序号的已读请求 persona=%s remote=%s ua=%s",
            persona_id,
            request.remote_addr or "",
            str(request.user_agent)[:160],
        )
        unread_count = app.conversation_store.unread_count(persona_id)
        if unread_count is None:
            return jsonify({"error": "Conversation not found"}), 404
        return jsonify({
            "ok": True,
            "ignored": True,
            "unread_count": unread_count,
        })
    if not isinstance(through_seq, int) or isinstance(through_seq, bool) or through_seq < 0:
        return jsonify({"error": "through_seq must be a non-negative integer"}), 400

    conversation = app.conversation_store.get_conversation(persona_id)
    if conversation is None:
        return jsonify({"error": "Conversation not found"}), 404
    previous_seq = conversation.get("last_read_message_seq", 0)
    latest_seq = conversation.get("next_message_seq", 1) - 1

    if not app.conversation_store.mark_read(persona_id, through_seq=through_seq):
        return jsonify({"error": "Conversation not found"}), 404
    logger.info(
        "已读请求 persona=%s through=%s previous=%s latest=%s client=%s page=%s remote=%s ua=%s",
        persona_id,
        through_seq,
        previous_seq,
        latest_seq,
        str(data.get("client_id", ""))[:64],
        str(data.get("page_id", ""))[:64],
        request.remote_addr or "",
        str(request.user_agent)[:160],
    )
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
            "messages": messages_for_api(messages),
        })

    rounds = min(max(request.args.get("rounds", 10, type=int) or 10, 1), 50)
    before_seq = request.args.get("before_seq", type=int)
    if before_seq is not None and before_seq <= 0:
        return jsonify({"error": "before_seq must be a positive integer"}), 400
    messages, has_more = app.conversation_store.get_messages(
        persona_id,
        rounds=rounds,
        before_seq=before_seq,
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
        "messages": messages_for_api(messages),
        "has_more": has_more,
        "next_before_seq": messages[0].get("_seq") if has_more and messages else None,
    })


@api_conversations_bp.route(
    "/<persona_id>/images/<task_id>/retry",
    methods=["POST"],
)
def retry_generated_image(persona_id: str, task_id: str):
    app = get_app()
    if not _IMAGE_TASK_ID_RE.fullmatch(task_id):
        return jsonify({"error": "Invalid image task ID"}), 400

    personas = app.config.load_personas()
    persona = personas.get(persona_id)
    if persona is None or app.conversation_store.get_conversation(persona_id) is None:
        return jsonify({"error": "Conversation not found"}), 404
    if not persona.enabled:
        return jsonify({"error": "人物已停用，无法重试图片生成"}), 409
    if app.capability_registry is None:
        return jsonify({"error": "Image generation is unavailable"}), 503

    status, arguments, pending_message = app.conversation_store.claim_failed_image_retry(
        persona_id, task_id,
    )
    if status == "not_found":
        return jsonify({"error": "Image task not found"}), 404
    if status == "pending":
        return jsonify({"error": "Image task is already loading"}), 409
    if status != "ok" or arguments is None or pending_message is None:
        return jsonify({"error": "Image task cannot be retried"}), 409

    broadcast(
        "assistant_message_updated",
        persona_id=persona_id,
        message=pending_message,
    )

    def fail_retry(error: str):
        failed_message = app.conversation_store.replace_pending_image(
            persona_id,
            task_id,
            {
                "type": "image",
                "status": "failed",
                "task_id": task_id,
                "error": error,
                "retry_arguments": arguments,
            },
        )
        if failed_message is not None:
            broadcast(
                "assistant_message_updated",
                persona_id=persona_id,
                message=failed_message,
            )
        return jsonify({"error": error}), 503

    generated_images: list[dict] = []
    try:
        result = app.capability_registry.execute(
            "generate_image",
            arguments,
            context={
                "persona": persona,
                "persona_id": persona_id,
                "generated_images": generated_images,
                "async_image_delivery": True,
                "image_task_id": task_id,
            },
        )
    except Exception:
        logger.exception("Failed to restart image task %s for %s", task_id, persona_id)
        return fail_retry("图片重试失败")

    started = any(
        image.get("status") == "pending" and image.get("task_id") == task_id
        for image in generated_images
    )
    if not started:
        error = next((block.text for block in result if block.text), "图片重试失败")
        return fail_retry(error)

    return jsonify({"ok": True, "task_id": task_id}), 202


@api_conversations_bp.route(
    "/<persona_id>/messages/<int:message_seq>/regenerate",
    methods=["POST"],
)
def regenerate_message_reply(persona_id: str, message_seq: int):
    if message_seq <= 0:
        return jsonify({"error": "Invalid message sequence"}), 400

    status = get_app().message_queue.regenerate_reply(persona_id, message_seq)
    if status == "not_found":
        return jsonify({"error": "Conversation not found"}), 404
    if status == "not_retryable":
        return jsonify({"error": "只能重新生成最后一条用户消息的回复"}), 409
    if status == "busy":
        return jsonify({"error": "正在处理其他消息，请稍后重试"}), 409
    if status == "disabled":
        return jsonify({"error": "人物已停用，无法重新生成回复"}), 409
    return jsonify({"ok": True}), 202


@api_conversations_bp.route(
    "/<persona_id>/messages/<int:message_seq>/retry",
    methods=["POST"],
)
def retry_message_reply(persona_id: str, message_seq: int):
    if message_seq <= 0:
        return jsonify({"error": "Invalid message sequence"}), 400

    status = get_app().message_queue.retry_reply(persona_id, message_seq)
    if status == "not_found":
        return jsonify({"error": "Conversation not found"}), 404
    if status == "not_retryable":
        return jsonify({"error": "该消息已收到回复或不是最新消息"}), 409
    if status == "busy":
        return jsonify({"error": "正在处理其他消息，请稍后重试"}), 409
    if status == "disabled":
        return jsonify({"error": "人物已停用，无法重试回复"}), 409
    return jsonify({"ok": True}), 202


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
