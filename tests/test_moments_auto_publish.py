# Regression tests for automatic Moments publishing cadence.
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from pawzochat.services.moments import (
    _AUTO_PUBLISH_DAILY_LIMIT,
    _AUTO_PUBLISH_INITIAL_DELAY_SECONDS,
    _AUTO_PUBLISH_MAX_INTERVAL_SECONDS,
    MomentsService,
)


def _make_service(store: MagicMock) -> MomentsService:
    app = SimpleNamespace(
        moments_store=store,
        chat_service=MagicMock(),
        config=MagicMock(),
    )
    return MomentsService(app)


class TestAutoPublishSchedule(unittest.TestCase):
    def test_first_post_uses_short_random_delay(self):
        store = MagicMock()
        store.latest_timestamp_by_authors.return_value = None
        service = _make_service(store)

        with patch("pawzochat.services.moments.random.randint", return_value=123):
            delay, scheduled_from = service._next_auto_publish_delay(["alice"])

        self.assertEqual(delay, 123.0)
        self.assertIsNone(scheduled_from)
        store.latest_timestamp_by_authors.assert_called_once_with(["alice"])

    def test_recent_post_uses_six_to_twelve_hour_cadence(self):
        store = MagicMock()
        published_at = datetime.now(timezone.utc) - timedelta(hours=2)
        store.latest_timestamp_by_authors.return_value = published_at.isoformat()
        service = _make_service(store)

        with patch(
            "pawzochat.services.moments.random.randint",
            return_value=8 * 60 * 60,
        ):
            delay, scheduled_from = service._next_auto_publish_delay(["alice"])

        self.assertAlmostEqual(delay, 6 * 60 * 60, delta=2)
        self.assertEqual(scheduled_from, published_at.isoformat())

    def test_stale_post_is_replenished_after_short_delay(self):
        store = MagicMock()
        published_at = datetime.now(timezone.utc) - timedelta(
            seconds=_AUTO_PUBLISH_MAX_INTERVAL_SECONDS + 1,
        )
        store.latest_timestamp_by_authors.return_value = published_at.isoformat()
        service = _make_service(store)

        short_delay = _AUTO_PUBLISH_INITIAL_DELAY_SECONDS[0]
        with patch(
            "pawzochat.services.moments.random.randint",
            side_effect=[8 * 60 * 60, short_delay],
        ):
            delay, scheduled_from = service._next_auto_publish_delay(["alice"])

        self.assertEqual(delay, float(short_delay))
        self.assertEqual(scheduled_from, published_at.isoformat())

    def test_daily_count_uses_local_day_start(self):
        store = MagicMock()
        store.count_by_authors_since.return_value = _AUTO_PUBLISH_DAILY_LIMIT
        service = _make_service(store)
        now = datetime(2026, 8, 25, 15, 30, tzinfo=timezone.utc)

        count = service._daily_generated_count(["alice"], now=now)

        self.assertEqual(count, _AUTO_PUBLISH_DAILY_LIMIT)
        threshold = store.count_by_authors_since.call_args.args[1]
        self.assertEqual((threshold.hour, threshold.minute, threshold.second), (0, 0, 0))

    def test_manual_refresh_is_not_blocked_by_daily_auto_limit(self):
        store = MagicMock()
        store.count_by_authors_since.return_value = _AUTO_PUBLISH_DAILY_LIMIT
        service = _make_service(store)
        service._publishers = MagicMock(return_value=["alice"])
        service._begin_task = MagicMock(return_value=True)

        with patch("pawzochat.services.moments.threading.Thread") as thread_cls:
            result = service.refresh()

        self.assertTrue(result["started"])
        store.count_by_authors_since.assert_not_called()
        thread_cls.return_value.start.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()