# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

"""Persistent Web Push subscriptions and asynchronous notification delivery."""

from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import WebPushException, webpush

from pawzochat.paths import (
    CHATS_DIR,
    PUSH_DIR,
    PUSH_SUBSCRIPTIONS_PATH,
    PUSH_VAPID_PRIVATE_KEY_PATH,
)

logger = logging.getLogger(__name__)

_MAX_SUBSCRIPTIONS = 20
_PUSH_TTL_SECONDS = 24 * 60 * 60
_PUSH_TIMEOUT_SECONDS = 10


def _urlsafe_b64decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def _normalize_subscription(value: object) -> dict:
    if not isinstance(value, dict):
        raise ValueError("订阅数据格式无效")

    endpoint = str(value.get("endpoint") or "").strip()
    parsed = urlsplit(endpoint)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError("订阅地址必须是 HTTPS URL")

    keys = value.get("keys")
    if not isinstance(keys, dict):
        raise ValueError("订阅密钥缺失")
    p256dh = str(keys.get("p256dh") or "").strip()
    auth = str(keys.get("auth") or "").strip()
    try:
        receiver_key = _urlsafe_b64decode(p256dh)
        auth_key = _urlsafe_b64decode(auth)
    except (ValueError, UnicodeEncodeError, binascii.Error) as exc:
        raise ValueError("订阅密钥格式无效") from exc
    if len(receiver_key) != 65 or receiver_key[0] != 4 or len(auth_key) != 16:
        raise ValueError("订阅密钥长度无效")

    return {
        "endpoint": endpoint,
        "keys": {"p256dh": p256dh, "auth": auth},
    }


def _notification_body(message: dict) -> str:
    blocks = message.get("content") if isinstance(message, dict) else []
    blocks = blocks if isinstance(blocks, list) else []
    text = "\n".join(
        str(block.get("text") or "").strip()
        for block in blocks
        if isinstance(block, dict) and block.get("type") == "text" and block.get("text")
    ).strip()
    if text:
        return f"{text[:157]}…" if len(text) > 160 else text
    if any(isinstance(block, dict) and block.get("type") == "image" for block in blocks):
        return "[图片]"
    if any(
        isinstance(block, dict) and block.get("type") in {"voice", "audio"}
        for block in blocks
    ):
        return "[语音]"
    if any(isinstance(block, dict) and block.get("type") == "emoji" for block in blocks):
        return "[表情]"
    return "收到一条新消息"


def _avatar_version(persona_id: str) -> str:
    try:
        return str((CHATS_DIR / persona_id / "avatar.png").stat().st_mtime_ns)
    except OSError:
        return ""


def _ensure_private_key(path: Path) -> ec.EllipticCurvePrivateKey:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        key = serialization.load_pem_private_key(path.read_bytes(), password=None)
        if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(
            key.curve, ec.SECP256R1
        ):
            raise ValueError("VAPID 私钥不是 P-256 密钥")
        return key

    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    fd, temporary = tempfile.mkstemp(dir=str(path.parent), prefix=".vapid_", suffix=".pem")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(pem)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = ""
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    return key


def _public_key_base64(key: ec.EllipticCurvePrivateKey) -> str:
    raw = key.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


class WebPushService:
    """Own VAPID identity, subscriptions, and non-blocking push delivery."""

    def __init__(self, *, send_fn=webpush):
        PUSH_DIR.mkdir(parents=True, exist_ok=True)
        private_key = _ensure_private_key(PUSH_VAPID_PRIVATE_KEY_PATH)
        self.public_key = _public_key_base64(private_key)
        self._send_fn = send_fn
        self._lock = threading.RLock()
        self._subscriptions = self._load_subscriptions()
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="web-push")
        self._closed = False

    def _load_subscriptions(self) -> list[dict]:
        if not PUSH_SUBSCRIPTIONS_PATH.is_file():
            return []
        try:
            raw = json.loads(PUSH_SUBSCRIPTIONS_PATH.read_text(encoding="utf-8"))
            items = raw.get("subscriptions", []) if isinstance(raw, dict) else []
            subscriptions = []
            for item in items:
                try:
                    normalized = _normalize_subscription(item)
                except ValueError:
                    continue
                if not any(existing["endpoint"] == normalized["endpoint"] for existing in subscriptions):
                    subscriptions.append(normalized)
            return subscriptions[-_MAX_SUBSCRIPTIONS:]
        except (OSError, json.JSONDecodeError):
            logger.exception("读取 Web Push 订阅失败，将使用空订阅列表")
            return []

    def _save_locked(self) -> None:
        PUSH_SUBSCRIPTIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary: str | None = None
        try:
            fd, temporary = tempfile.mkstemp(
                dir=str(PUSH_SUBSCRIPTIONS_PATH.parent),
                prefix=".subscriptions_",
                suffix=".json",
            )
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(
                    {"subscriptions": self._subscriptions},
                    stream,
                    ensure_ascii=False,
                    indent=2,
                )
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, PUSH_SUBSCRIPTIONS_PATH)
            temporary = None
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)

    @property
    def subscription_count(self) -> int:
        with self._lock:
            return len(self._subscriptions)

    def subscribe(self, value: object) -> dict:
        subscription = _normalize_subscription(value)
        with self._lock:
            existing = next(
                (
                    index
                    for index, item in enumerate(self._subscriptions)
                    if item["endpoint"] == subscription["endpoint"]
                ),
                None,
            )
            if existing is not None:
                self._subscriptions[existing] = subscription
            else:
                self._subscriptions.append(subscription)
                self._subscriptions = self._subscriptions[-_MAX_SUBSCRIPTIONS:]
            self._save_locked()
            return {"ok": True, "subscription_count": len(self._subscriptions)}

    def unsubscribe(self, endpoint: str) -> dict:
        endpoint = str(endpoint or "").strip()
        with self._lock:
            self._subscriptions = [
                item for item in self._subscriptions if item["endpoint"] != endpoint
            ]
            self._save_locked()
            return {"ok": True, "subscription_count": len(self._subscriptions)}

    def send_assistant_message(
        self,
        *,
        persona_id: str,
        persona_name: str,
        message: dict,
    ) -> None:
        if self._closed:
            return
        sequence = message.get("_seq")
        message_key = f"{persona_id}:{sequence}" if sequence is not None else ""
        payload = {
            "type": "assistant_message",
            "title": persona_name or "PawzoChat",
            "body": _notification_body(message),
            "personaId": persona_id,
            "avatarVersion": _avatar_version(persona_id),
            "messageKey": message_key,
        }
        with self._lock:
            subscriptions = [dict(item, keys=dict(item["keys"])) for item in self._subscriptions]
        if not subscriptions:
            return
        try:
            self._executor.submit(self._deliver, subscriptions, payload)
        except RuntimeError:
            return

    def _deliver(self, subscriptions: list[dict], payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        expired: set[str] = set()
        for subscription in subscriptions:
            try:
                self._send_fn(
                    subscription_info=subscription,
                    data=data,
                    vapid_private_key=str(PUSH_VAPID_PRIVATE_KEY_PATH),
                    vapid_claims={"sub": "mailto:push@pawzochat.local"},
                    ttl=_PUSH_TTL_SECONDS,
                    timeout=_PUSH_TIMEOUT_SECONDS,
                    headers={"Urgency": "normal"},
                )
            except WebPushException as exc:
                status = getattr(exc.response, "status_code", None)
                if status in {404, 410}:
                    expired.add(subscription["endpoint"])
                else:
                    logger.warning(
                        "Web Push 投递失败 endpoint=%s status=%s",
                        urlsplit(subscription["endpoint"]).netloc,
                        status or "unknown",
                    )
            except Exception:
                logger.exception(
                    "Web Push 投递异常 endpoint=%s",
                    urlsplit(subscription["endpoint"]).netloc,
                )
        if expired:
            with self._lock:
                self._subscriptions = [
                    item for item in self._subscriptions if item["endpoint"] not in expired
                ]
                self._save_locked()

    def close(self) -> None:
        self._closed = True
        self._executor.shutdown(wait=False, cancel_futures=True)