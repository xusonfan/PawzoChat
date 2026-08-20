import tempfile
import unittest
from pathlib import Path

from pawzochat.store.conversation import ConversationStore


def _text(value: str) -> list[dict]:
    return [{"type": "text", "text": value}]


class ConversationPaginationTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.store = ConversationStore(Path(self.tempdir.name))
        self.store.create_conversation("cat")
        for index in range(1, 7):
            self.store.add_message("cat", "user", _text(f"问{index}"), "web")
            self.store.add_message("cat", "assistant", _text(f"答{index}"), "llm")

    def tearDown(self):
        self.tempdir.cleanup()

    def test_pages_backward_by_exclusive_message_sequence(self):
        latest, has_more = self.store.get_messages("cat", rounds=2)
        self.assertEqual([message["_seq"] for message in latest], [9, 10, 11, 12])
        self.assertTrue(has_more)

        middle, has_more = self.store.get_messages(
            "cat", rounds=2, before_seq=latest[0]["_seq"]
        )
        self.assertEqual([message["_seq"] for message in middle], [5, 6, 7, 8])
        self.assertTrue(has_more)

        oldest, has_more = self.store.get_messages(
            "cat", rounds=2, before_seq=middle[0]["_seq"]
        )
        self.assertEqual([message["_seq"] for message in oldest], [1, 2, 3, 4])
        self.assertFalse(has_more)

    def test_cursor_excludes_its_message_without_duplicates(self):
        page, _ = self.store.get_messages("cat", rounds=2, before_seq=9)
        self.assertNotIn(9, [message["_seq"] for message in page])
        self.assertEqual([message["_seq"] for message in page], [5, 6, 7, 8])


if __name__ == "__main__":
    unittest.main()