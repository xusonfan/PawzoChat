# Regression tests for MomentsStore author filtering.
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class TestMomentsListAuthorFilter(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        moments_dir = root / "moments"
        moments_dir.mkdir()
        (moments_dir / "images").mkdir()
        store_path = moments_dir / "moments.json"
        payload = {
            "created_at": "2024-01-01T00:00:00+00:00",
            "updated_at": "2024-03-15T12:00:00+00:00",
            "moments": [
                {
                    "id": "mom_aaaaaaaaaaaa",
                    "author": "persona_a",
                    "timestamp": "2024-03-15T12:00:00+00:00",
                    "text": "a-new",
                    "images": [],
                    "likes": [],
                    "replies": [],
                },
                {
                    "id": "mom_bbbbbbbbbbbb",
                    "author": "persona_b",
                    "timestamp": "2024-03-14T12:00:00+00:00",
                    "text": "b-mid",
                    "images": ["x.png"],
                    "likes": [],
                    "replies": [],
                },
                {
                    "id": "mom_cccccccccccc",
                    "author": "persona_a",
                    "timestamp": "2024-02-01T12:00:00+00:00",
                    "text": "a-old",
                    "images": [],
                    "likes": [],
                    "replies": [],
                },
                {
                    "id": "mom_dddddddddddd",
                    "author": "user",
                    "timestamp": "2024-01-01T12:00:00+00:00",
                    "text": "user-post",
                    "images": [],
                    "likes": [],
                    "replies": [],
                },
            ],
        }
        store_path.write_text(json.dumps(payload), encoding="utf-8")
        self._patches = [
            patch("pawzochat.store.moments.MOMENTS_DIR", moments_dir),
            patch("pawzochat.store.moments.MOMENTS_IMAGES_DIR", moments_dir / "images"),
            patch("pawzochat.store.moments.MOMENTS_STORE_PATH", store_path),
        ]
        for p in self._patches:
            p.start()
        from pawzochat.store.moments import MomentsStore

        self.store = MomentsStore()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def test_filter_by_stable_author_id(self):
        items, has_more = self.store.list_moments(author="persona_a", limit=20)
        self.assertFalse(has_more)
        self.assertEqual([m["id"] for m in items], ["mom_aaaaaaaaaaaa", "mom_cccccccccccc"])
        self.assertTrue(all(m["author"] == "persona_a" for m in items))

    def test_filter_does_not_match_by_name_semantics(self):
        # Even if a display name collided, filtering is by stored author id only.
        items, _ = self.store.list_moments(author="a-new", limit=20)
        self.assertEqual(items, [])

    def test_filter_with_pagination_cursor(self):
        first, has_more = self.store.list_moments(author="persona_a", limit=1)
        self.assertTrue(has_more)
        self.assertEqual(len(first), 1)
        self.assertEqual(first[0]["id"], "mom_aaaaaaaaaaaa")
        second, has_more2 = self.store.list_moments(
            author="persona_a",
            limit=1,
            before=first[0]["timestamp"],
        )
        self.assertFalse(has_more2)
        self.assertEqual([m["id"] for m in second], ["mom_cccccccccccc"])

    def test_no_author_returns_all_newest_first(self):
        items, _ = self.store.list_moments(limit=10)
        self.assertEqual(
            [m["id"] for m in items],
            [
                "mom_aaaaaaaaaaaa",
                "mom_bbbbbbbbbbbb",
                "mom_cccccccccccc",
                "mom_dddddddddddd",
            ],
        )


if __name__ == "__main__":
    unittest.main()