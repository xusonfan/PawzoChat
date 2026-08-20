import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from pawzochat.services.message_queue import MessageQueue, _public_error_message


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

    @patch("pawzochat.services.message_queue.broadcast")
    def test_llm_failure_emits_retryable_error_without_assistant_fallback(self, broadcast):
        stored_message = {
            "role": "user",
            "content": [{"type": "text", "text": "测试消息"}],
            "source": "web",
            "timestamp": "2026-08-20T10:00:00+08:00",
            "_seq": 7,
        }
        store = SimpleNamespace(
            add_message=Mock(return_value=stored_message),
        )
        extension_manager = SimpleNamespace(
            dispatch_message_stored=Mock(),
        )
        app = SimpleNamespace(
            conversation_store=store,
            extension_manager=extension_manager,
            chat_service=SimpleNamespace(
                process_round=Mock(side_effect=RuntimeError("HTTP 503")),
            ),
            emoji_service=None,
            reply_dispatcher=SimpleNamespace(deliver_messages=Mock()),
            memory_service=None,
        )
        queue = MessageQueue(app)
        queue.enqueue(
            "cat",
            "测试消息",
            "web",
            reply_ctx={"channel": "web"},
        )

        queue._process("cat")

        app.reply_dispatcher.deliver_messages.assert_not_called()
        broadcast.assert_any_call(
            "operation_error",
            persona_id="cat",
            title="消息回复失败",
            message="HTTP 503",
            retry_message_seq=7,
        )


if __name__ == "__main__":
    unittest.main()