import base64
import json
import threading
from types import SimpleNamespace

import pytest
from pywebpush import WebPushException

from pawzochat.services import web_push


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _subscription(endpoint: str = "https://fcm.googleapis.com/push/one") -> dict:
    return {
        "endpoint": endpoint,
        "keys": {
            "p256dh": _b64(b"\x04" + b"p" * 64),
            "auth": _b64(b"a" * 16),
        },
    }


@pytest.fixture
def push_paths(tmp_path, monkeypatch):
    push_dir = tmp_path / "push"
    monkeypatch.setattr(web_push, "PUSH_DIR", push_dir)
    monkeypatch.setattr(web_push, "PUSH_SUBSCRIPTIONS_PATH", push_dir / "subscriptions.json")
    monkeypatch.setattr(web_push, "PUSH_VAPID_PRIVATE_KEY_PATH", push_dir / "vapid_private.pem")
    monkeypatch.setattr(web_push, "CHATS_DIR", tmp_path / "chats")
    return push_dir


def test_subscription_is_validated_persisted_and_deduplicated(push_paths):
    service = web_push.WebPushService(send_fn=lambda **_: None)
    try:
        raw_public_key = base64.urlsafe_b64decode(service.public_key + "==")
        assert len(raw_public_key) == 65
        assert raw_public_key[0] == 4
        assert (push_paths / "vapid_private.pem").is_file()

        subscription = _subscription()
        assert service.subscribe(subscription)["subscription_count"] == 1
        assert service.subscribe(subscription)["subscription_count"] == 1
        stored = json.loads((push_paths / "subscriptions.json").read_text("utf-8"))
        assert stored == {"subscriptions": [subscription]}

        assert service.unsubscribe(subscription["endpoint"])["subscription_count"] == 0
    finally:
        service.close()


@pytest.mark.parametrize(
    "subscription",
    [
        {"endpoint": "http://push.example.test/one", "keys": {}},
        {"endpoint": "https://push.example.test/one", "keys": {"p256dh": "x", "auth": "y"}},
    ],
)
def test_invalid_subscription_is_rejected(push_paths, subscription):
    service = web_push.WebPushService(send_fn=lambda **_: None)
    try:
        with pytest.raises(ValueError):
            service.subscribe(subscription)
    finally:
        service.close()


def test_assistant_message_is_delivered_as_compact_payload(push_paths):
    sent = []
    delivered = threading.Event()

    def fake_send(**kwargs):
        sent.append(kwargs)
        delivered.set()

    service = web_push.WebPushService(send_fn=fake_send)
    try:
        avatar = web_push.CHATS_DIR / "cat" / "avatar.png"
        avatar.parent.mkdir(parents=True)
        avatar.write_bytes(b"avatar")
        avatar_version = str(avatar.stat().st_mtime_ns)
        service.subscribe(_subscription())
        service.send_assistant_message(
            persona_id="cat",
            persona_name="小猫",
            message={
                "_seq": 7,
                "content": [{"type": "text", "text": "在吗"}],
            },
        )
        assert delivered.wait(2)
        payload = json.loads(sent[0]["data"])
        assert payload == {
            "type": "assistant_message",
            "title": "小猫",
            "body": "在吗",
            "personaId": "cat",
            "avatarVersion": avatar_version,
            "messageKey": "cat:7",
        }
        assert sent[0]["ttl"] == 86400
        assert sent[0]["timeout"] == 10
    finally:
        service.close()


def test_expired_subscription_is_removed(push_paths):
    def gone(**_):
        raise WebPushException(
            "gone",
            response=SimpleNamespace(status_code=410),
        )

    service = web_push.WebPushService(send_fn=gone)
    try:
        subscription = _subscription()
        service.subscribe(subscription)
        service._deliver(
            [subscription],
            {
                "title": "PawzoChat",
                "body": "消息",
                "personaId": "cat",
                "messageKey": "cat:8",
            },
        )
        assert service.subscription_count == 0
    finally:
        service.close()