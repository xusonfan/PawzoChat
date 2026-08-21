import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from pawzochat.llm.base import LLMResponse
from pawzochat.services.chat import ChatService


class _LLMManager:
    def __init__(self, provider):
        self.provider = provider

    def get_provider(self, name):
        return self.provider


class EmptyReplyRetryTests(unittest.TestCase):
    def setUp(self):
        self.provider = Mock()
        self.service = ChatService(None, None, _LLMManager(self.provider))
        self.persona = SimpleNamespace(
            id="cat",
            name="猫",
            llm_provider="test",
            llm_model="chat-model",
            temperature=0.8,
            max_tokens=1000,
            tool_policy={"max_iterations": 3, "timeout_seconds": 30},
        )

    def _run_tool_loop(self):
        return self.service._run_tool_loop(
            persona=self.persona,
            persona_id="cat",
            llm_messages=[{"role": "user", "content": "你好"}],
            tools=None,
            pending_images={},
            pending_files={},
            generated_images=[],
        )

    def test_retries_empty_reply_five_times_then_returns_sixth_response(self):
        self.provider.chat.side_effect = [
            LLMResponse(text=""),
            LLMResponse(text="   "),
            LLMResponse(text="<think>思考</think>"),
            LLMResponse(text="$\\"),
            LLMResponse(text="\n"),
            LLMResponse(text="终于回复了"),
        ]

        response = self._run_tool_loop()

        self.assertEqual(response.text, "终于回复了")
        self.assertEqual(self.provider.chat.call_count, 6)

    def test_raises_reply_failure_after_five_empty_retries(self):
        self.provider.chat.return_value = LLMResponse(text="")

        with self.assertRaisesRegex(RuntimeError, "^回复失败$"):
            self._run_tool_loop()

        self.assertEqual(self.provider.chat.call_count, 6)


if __name__ == "__main__":
    unittest.main()