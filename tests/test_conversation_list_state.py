import json
import tempfile
import unittest
from pathlib import Path

from pawzochat.store.conversation import ConversationStore


def _text(value):
    return [{"type": "text", "text": value}]


class ConversationListStateTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.store = ConversationStore(self.root)

    def tearDown(self):
        self.tempdir.cleanup()

    def test_legacy_data_defaults_are_persisted(self):
        folder = self.root / "legacy"
        folder.mkdir()
        path = folder / "legacy.json"
        path.write_text(json.dumps({
            "persona_id": "legacy",
            "created_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-01T00:00:00+00:00",
            "messages": [],
        }), encoding="utf-8")

        store = ConversationStore(self.root)
        summary = store.list_conversations()[0]
        self.assertFalse(summary["pinned"])
        self.assertIsNone(summary["hidden_at"])
        persisted = json.loads(path.read_text(encoding="utf-8"))
        self.assertFalse(persisted["pinned"])
        self.assertIsNone(persisted["hidden_at"])

    def test_pinned_group_precedes_normal_and_each_group_uses_recency(self):
        for persona_id in ("old-pin", "new-pin", "new-normal", "old-normal"):
            self.store.create_conversation(persona_id)
        self.store.add_message(
            "old-pin", "user", _text("a"), "web",
            timestamp="2026-01-01T00:00:00+00:00",
        )
        self.store.add_message(
            "new-pin", "user", _text("b"), "web",
            timestamp="2026-01-02T00:00:00+00:00",
        )
        self.store.add_message(
            "old-normal", "user", _text("c"), "web",
            timestamp="2026-01-03T00:00:00+00:00",
        )
        self.store.add_message(
            "new-normal", "user", _text("d"), "web",
            timestamp="2026-01-04T00:00:00+00:00",
        )
        self.store.set_pinned("old-pin", True)
        self.store.set_pinned("new-pin", True)

        self.assertEqual(
            [item["persona_id"] for item in self.store.list_conversations()],
            ["new-pin", "old-pin", "new-normal", "old-normal"],
        )
        self.assertEqual(
            ConversationStore(self.root).list_conversations()[0]["persona_id"],
            "new-pin",
        )

    def test_hide_preserves_messages_role_and_unread_then_assistant_restores(self):
        self.store.create_conversation("cat")
        self.store.add_message("cat", "assistant", _text("one"), "llm")
        before = self.store.get_conversation("cat")
        self.assertTrue(self.store.hide_conversation("cat"))
        self.assertEqual(self.store.list_conversations(), [])

        hidden = self.store.list_conversations(include_hidden=True)[0]
        self.assertEqual(hidden["unread_count"], 1)
        self.assertIsNotNone(hidden["hidden_at"])
        data = self.store.get_conversation("cat")
        self.assertEqual(len(data["messages"]), len(before["messages"]))
        self.assertEqual(data["messages"][0]["role"], "assistant")

        self.store.add_message("cat", "assistant", _text("two"), "llm")
        visible = self.store.list_conversations()[0]
        self.assertIsNone(visible["hidden_at"])
        self.assertEqual(visible["unread_count"], 2)
        self.assertEqual(len(self.store.get_conversation("cat")["messages"]), 2)

    def test_user_active_restore_keeps_unread_and_pinned_state(self):
        self.store.create_conversation("cat")
        self.store.add_message("cat", "assistant", _text("one"), "llm")
        self.store.set_pinned("cat", True)
        self.store.hide_conversation("cat")

        self.assertTrue(self.store.restore_hidden("cat"))
        summary = self.store.list_conversations()[0]
        self.assertTrue(summary["pinned"])
        self.assertEqual(summary["unread_count"], 1)
        self.assertEqual(len(self.store.get_conversation("cat")["messages"]), 1)


if __name__ == "__main__":
    unittest.main()