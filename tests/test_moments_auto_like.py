# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
#
# Regression tests for persona auto-like semantics in Moments.

"""作者角色自动互动不得自赞；非作者角色仍可自动点赞。"""

from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from pawzochat.services.moments import MomentsService


def _make_service(*, store=None, chat=None, config=None) -> MomentsService:
    app = SimpleNamespace(
        moments_store=store or MagicMock(),
        chat_service=chat or MagicMock(),
        config=config or MagicMock(),
    )
    return MomentsService(app)


class TestAutoLikeMomentHelper(unittest.TestCase):
    """最低层级：``_auto_like_moment`` 集中表达自动点赞边界。"""

    @patch("pawzochat.services.moments.broadcast")
    def test_skips_when_persona_is_author(self, mock_broadcast):
        store = MagicMock()
        store.get_moment.return_value = {
            "id": "m1", "author": "alice", "likes": [],
        }
        svc = _make_service(store=store)

        ok = svc._auto_like_moment("m1", "alice")

        self.assertFalse(ok)
        store.add_like.assert_not_called()
        mock_broadcast.assert_not_called()

    @patch("pawzochat.services.moments.broadcast")
    def test_likes_when_persona_is_not_author(self, mock_broadcast):
        store = MagicMock()
        store.get_moment.return_value = {
            "id": "m1", "author": "alice", "likes": [],
        }
        store.add_like.return_value = True
        svc = _make_service(store=store)

        ok = svc._auto_like_moment("m1", "bob")

        self.assertTrue(ok)
        store.add_like.assert_called_once_with("m1", "bob")
        mock_broadcast.assert_called_once_with(
            "moments_updated", action="like_changed", moment_id="m1",
        )

    @patch("pawzochat.services.moments.broadcast")
    def test_known_author_skips_without_store_lookup(self, mock_broadcast):
        store = MagicMock()
        svc = _make_service(store=store)

        ok = svc._auto_like_moment("m1", "alice", author="alice")

        self.assertFalse(ok)
        store.get_moment.assert_not_called()
        store.add_like.assert_not_called()
        mock_broadcast.assert_not_called()

    @patch("pawzochat.services.moments.broadcast")
    def test_manual_like_path_still_allows_author_self_like(self, mock_broadcast):
        """用户手动点赞走 ``like()`` → store，不经过自动点赞边界。"""
        store = MagicMock()
        store.add_like.return_value = True
        svc = _make_service(store=store)

        ok = svc.like("m1", "alice")

        self.assertTrue(ok)
        store.add_like.assert_called_once_with("m1", "alice")
        mock_broadcast.assert_called_once()


class TestCounterReplyAutoLike(unittest.TestCase):
    """关键路径：反向回复后的自动点赞行为。"""

    def _personas(self):
        return {
            "alice": SimpleNamespace(name="Alice"),
            "bob": SimpleNamespace(name="Bob"),
        }

    def _config(self):
        config = MagicMock()
        config.load_personas.return_value = self._personas()
        config.get.return_value = ""
        return config

    def _store_for_author(self, author: str):
        store = MagicMock()
        store.get_moment.return_value = {
            "id": "m1",
            "author": author,
            "text": "今天天气不错",
            "images": [],
            "likes": [],
            "replies": [
                {
                    "id": "r_user",
                    "author": "user",
                    "text": "哈哈",
                    "reply_to": None,
                },
            ],
        }
        store.get_reply.return_value = {
            "id": "r_user",
            "author": "user",
            "text": "哈哈",
            "reply_to": None,
        }
        store.add_reply.return_value = {
            "id": "r_ai",
            "author": "placeholder",
            "text": "谢谢",
        }
        store.add_like.return_value = True
        return store

    @patch("pawzochat.services.moments.broadcast")
    @patch("pawzochat.services.moments.load_profile_name", return_value="用户")
    def test_author_counter_reply_does_not_self_like(
        self, _mock_name, mock_broadcast,
    ):
        store = self._store_for_author("alice")
        chat = MagicMock()
        chat.run_oneshot.return_value = ("谢谢你呀", None)
        svc = _make_service(store=store, chat=chat, config=self._config())
        svc._write_moment_memory = MagicMock()

        svc._generate_counter_reply("m1", "alice", "r_user")

        store.add_reply.assert_called_once()
        store.add_like.assert_not_called()
        for call in mock_broadcast.call_args_list:
            self.assertNotEqual(call.kwargs.get("action"), "like_changed")

    @patch("pawzochat.services.moments.broadcast")
    @patch("pawzochat.services.moments.load_profile_name", return_value="用户")
    def test_non_author_counter_reply_auto_likes(
        self, _mock_name, mock_broadcast,
    ):
        store = self._store_for_author("alice")
        chat = MagicMock()
        chat.run_oneshot.return_value = ("说得对", None)
        svc = _make_service(store=store, chat=chat, config=self._config())
        svc._write_moment_memory = MagicMock()

        svc._generate_counter_reply("m1", "bob", "r_user")

        store.add_reply.assert_called_once()
        store.add_like.assert_called_once_with("m1", "bob")
        mock_broadcast.assert_any_call(
            "moments_updated", action="like_changed", moment_id="m1",
        )


if __name__ == "__main__":
    unittest.main()