import json
import tempfile
import unittest
from pathlib import Path

from pawzochat.store.conversation import ConversationStore


def _text(value):
    return [{"type": "text", "text": value}]


class ConversationUnreadTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)

    def tearDown(self):
        self.tempdir.cleanup()

    def test_counts_exclude_user_messages_and_mark_read(self):
        store = ConversationStore(self.root)
        store.create_conversation("cat")
        store.add_message("cat", "user", _text("hello"), "web")
        store.add_message("cat", "assistant", _text("one"), "llm")
        store.add_message("cat", "assistant", _text("two"), "llm")

        summaries = store.list_conversations()
        self.assertEqual(summaries[0]["unread_count"], 2)
        self.assertEqual(summaries[0]["latest_message_seq"], 3)
        self.assertEqual(store.unread_count("cat"), 2)
        self.assertTrue(store.mark_read("cat"))
        self.assertEqual(store.list_conversations()[0]["unread_count"], 0)
        self.assertEqual(store.unread_count("cat"), 0)

        store.add_message("cat", "user", _text("again"), "web")
        self.assertEqual(store.list_conversations()[0]["unread_count"], 0)
        store.add_message("cat", "assistant", _text("three"), "llm")
        self.assertEqual(store.list_conversations()[0]["unread_count"], 1)

    def test_read_marker_only_advances_through_displayed_message(self):
        store = ConversationStore(self.root)
        store.create_conversation("cat")
        first = store.add_message("cat", "assistant", _text("one"), "llm")
        store.add_message("cat", "assistant", _text("two"), "llm")

        self.assertTrue(store.mark_read("cat", through_seq=first["_seq"]))
        self.assertEqual(store.unread_count("cat"), 1)

        store.add_message("cat", "assistant", _text("three"), "llm")
        self.assertTrue(store.mark_read("cat", through_seq=first["_seq"]))
        self.assertEqual(store.unread_count("cat"), 2)

    def test_future_read_marker_is_ignored_instead_of_clamped(self):
        store = ConversationStore(self.root)
        store.create_conversation("cat")
        store.add_message("cat", "assistant", _text("one"), "llm")
        store.add_message("cat", "assistant", _text("two"), "llm")

        self.assertTrue(store.mark_read("cat", through_seq=999))
        self.assertEqual(store.unread_count("cat"), 2)
        self.assertEqual(
            store.get_conversation("cat")["last_read_message_seq"],
            0,
        )

    def test_read_marker_survives_refresh(self):
        store = ConversationStore(self.root)
        store.create_conversation("cat")
        store.add_message("cat", "assistant", _text("one"), "llm")
        store.mark_read("cat")

        reloaded = ConversationStore(self.root)
        self.assertEqual(reloaded.list_conversations()[0]["unread_count"], 0)
        reloaded.add_message("cat", "assistant", _text("two"), "llm")
        self.assertEqual(
            ConversationStore(self.root).list_conversations()[0]["unread_count"],
            1,
        )

    def test_legacy_history_is_migrated_as_read(self):
        folder = self.root / "legacy"
        folder.mkdir()
        path = folder / "legacy.json"
        path.write_text(json.dumps({
            "persona_id": "legacy",
            "created_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-01T00:00:00+00:00",
            "messages": [{
                "role": "assistant",
                "content": _text("old"),
                "source": "llm",
                "timestamp": "2026-01-01T00:00:00+00:00",
            }],
        }), encoding="utf-8")

        store = ConversationStore(self.root)
        self.assertEqual(store.list_conversations()[0]["unread_count"], 0)
        persisted = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(persisted["last_read_message_seq"], 1)
        self.assertEqual(persisted["next_message_seq"], 2)


if __name__ == "__main__":
    unittest.main()