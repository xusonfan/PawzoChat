import unittest

from pawzochat.services.message_queue import _public_error_message


class MessageErrorFeedbackTests(unittest.TestCase):
    def test_preserves_specific_upstream_error(self):
        error = RuntimeError("HTTP 503: upstream unavailable")
        self.assertEqual(
            _public_error_message(error),
            "HTTP 503: upstream unavailable",
        )

    def test_caps_unbounded_upstream_error_payload(self):
        message = "x" * 5000
        public = _public_error_message(RuntimeError(message))
        self.assertEqual(len(public), 4001)
        self.assertTrue(public.endswith("…"))


if __name__ == "__main__":
    unittest.main()