import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import ANY, Mock, patch

from pawzochat.image.base import ImageResponse
from pawzochat.llm.base import ContentBlock, LLMResponse, ToolCall
from pawzochat.mcp.builtin import image_generation
from pawzochat.services.chat import ChatService
from pawzochat.store.conversation import ConversationStore
from pawzochat.web.message_serialization import messages_for_api


class _Provider:
    def generate(self, prompt, **kwargs):
        return ImageResponse(image_data=b"image-data", mime_type="image/png")


class _ImageManager:
    def get_provider_for_model(self, provider, model):
        return _Provider()

    def get_model_type(self, provider, model):
        return "openai_image"


class _Store:
    def __init__(self):
        self.updated = threading.Event()
        self.replacement = None

    def replace_pending_image(self, persona_id, task_id, replacement):
        self.replacement = replacement
        self.updated.set()
        return {
            "role": "assistant",
            "content": [replacement],
            "source": "llm",
            "_seq": 2,
        }


class _LLMManager:
    def __init__(self, provider):
        self.provider = provider

    def get_provider(self, name):
        return self.provider


class AsyncImageGenerationTests(unittest.TestCase):
    def test_image_guidance_requires_natural_text_before_tool_call(self):
        service = ChatService(
            None,
            None,
            _LLMManager(Mock()),
            image_manager=_ImageManager(),
        )
        persona = SimpleNamespace(image_generation={
            "enabled": True,
            "provider": "test-provider",
            "model": "test-model",
            "ref_mode": "none",
        })

        guidance = service._build_image_tool_guidance(
            persona,
            active_tool_names={"generate_image"},
        )

        self.assertIn("严格只输出一句", guidance)
        self.assertIn("禁止只调用工具", guidance)
        self.assertIn("反斜线或换行拆成多句", guidance)
        self.assertIn("调用 `generate_image` 后本轮立即结束", guidance)
        self.assertIn("不要提及『生成图片』", guidance)

    def test_tool_loop_stops_after_lead_in_and_async_image(self):
        provider = Mock()
        provider.chat.return_value = LLMResponse(
            text="等我一下，我拍给你看。",
            finish_reason="tool_use",
            tool_calls=[ToolCall(
                id="call-1",
                name="generate_image",
                arguments={"prompt": "sunny room"},
            )],
        )
        service = ChatService(None, None, _LLMManager(provider))

        def queue_image(_tool_call, **kwargs):
            kwargs["generated_images"].append({
                "status": "pending",
                "task_id": "job-1",
            })
            return [ContentBlock(type="text", text="任务已受理")]

        service._execute_tool = queue_image
        persona = SimpleNamespace(
            id="cat",
            name="猫",
            llm_provider="test",
            llm_model="chat-model",
            temperature=0.8,
            max_tokens=1000,
            tool_policy={"max_iterations": 3, "timeout_seconds": 30},
        )
        generated = []
        reply_events = []

        response = service._run_tool_loop(
            persona=persona,
            persona_id="cat",
            llm_messages=[{"role": "user", "content": "拍张照片"}],
            tools=[{"name": "generate_image"}],
            pending_images={},
            pending_files={},
            generated_images=generated,
            async_image_delivery=True,
            reply_events=reply_events,
        )

        self.assertEqual(response.text, "等我一下，我拍给你看。")
        self.assertEqual(provider.chat.call_count, 1)
        self.assertEqual(generated[0]["status"], "pending")
        self.assertEqual(
            [event["type"] for event in reply_events],
            ["text", "image"],
        )
        self.assertEqual(reply_events[0]["text"], "等我一下，我拍给你看。")

    def test_async_handler_returns_placeholder_before_background_result(self):
        store = _Store()
        app = SimpleNamespace(
            image_manager=_ImageManager(),
            conversation_store=store,
        )
        persona = SimpleNamespace(image_generation={
            "enabled": True,
            "provider": "test-provider",
            "model": "test-model",
            "ref_mode": "none",
        })
        generated = []

        with tempfile.TemporaryDirectory() as temporary, patch.object(
            image_generation, "CHATS_DIR", Path(temporary),
        ), patch.object(image_generation, "broadcast") as broadcast:
            result = image_generation.make_handler(app)(
                {"prompt": "a cat"},
                {
                    "persona": persona,
                    "persona_id": "cat",
                    "generated_images": generated,
                    "async_image_delivery": True,
                    "image_task_id": "0123456789abcdef",
                },
            )
            self.assertEqual(generated[0]["status"], "pending")
            self.assertEqual(generated[0]["task_id"], "0123456789abcdef")
            self.assertEqual(generated[0]["retry_arguments"], {"prompt": "a cat"})
            self.assertIn("后台加载队列", result[0].text)
            self.assertIn("无需继续回复", result[0].text)
            self.assertTrue(store.updated.wait(1))
            self.assertEqual(store.replacement["type"], "image")
            self.assertTrue(Path(store.replacement["path"]).is_file())
            broadcast.assert_any_call(
                "assistant_message_updated",
                persona_id="cat",
                message=ANY,
            )

    def test_store_replaces_placeholder_without_changing_message_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = ConversationStore(Path(temporary))
            store.ensure_conversation("cat")
            original = store.add_message(
                "cat",
                "assistant",
                [{"type": "image", "status": "pending", "task_id": "job-1"}],
                "llm",
            )

            updated = store.replace_pending_image(
                "cat",
                "job-1",
                {"type": "image", "path": "/tmp/cat.png", "mime": "image/png"},
            )

            self.assertIsNotNone(updated)
            self.assertEqual(updated["_seq"], original["_seq"])
            self.assertEqual(updated["timestamp"], original["timestamp"])
            self.assertEqual(updated["content"][0]["path"], "/tmp/cat.png")

    def test_store_claims_failed_image_retry_only_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = ConversationStore(Path(temporary))
            store.ensure_conversation("cat")
            original = store.add_message(
                "cat",
                "assistant",
                [{
                    "type": "image",
                    "status": "failed",
                    "task_id": "0123456789abcdef",
                    "error": "provider unavailable",
                    "retry_arguments": {"prompt": "a cat"},
                }],
                "llm",
            )

            status, arguments, updated = store.claim_failed_image_retry(
                "cat", "0123456789abcdef",
            )
            duplicate_status, _, _ = store.claim_failed_image_retry(
                "cat", "0123456789abcdef",
            )

            self.assertEqual(status, "ok")
            self.assertEqual(arguments, {"prompt": "a cat"})
            self.assertEqual(updated["_seq"], original["_seq"])
            self.assertEqual(updated["content"][0], {
                "type": "image",
                "status": "pending",
                "task_id": "0123456789abcdef",
                "retry_arguments": {"prompt": "a cat"},
            })
            self.assertEqual(duplicate_status, "pending")

    def test_store_recovers_pending_images_after_restart(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = ConversationStore(Path(temporary))
            store.ensure_conversation("cat")
            store.add_message(
                "cat",
                "assistant",
                [
                    {
                        "type": "image",
                        "status": "pending",
                        "task_id": "0123456789abcdef",
                        "retry_arguments": {"prompt": "a cat"},
                    },
                    {
                        "type": "image",
                        "status": "pending",
                        "task_id": "fedcba9876543210",
                    },
                ],
                "llm",
            )

            recovered = store.recover_interrupted_image_tasks()
            messages, _ = store.get_messages("cat")
            replayable, legacy = messages[-1]["content"]

            self.assertEqual(recovered, 2)
            self.assertEqual(replayable["status"], "failed")
            self.assertEqual(replayable["retry_arguments"], {"prompt": "a cat"})
            self.assertEqual(legacy["status"], "failed")
            self.assertNotIn("retry_arguments", legacy)
            self.assertEqual(store.recover_interrupted_image_tasks(), 0)

    def test_api_marks_only_replayable_failures_for_retry(self):
        messages = [{
            "role": "assistant",
            "content": [
                {
                    "type": "image",
                    "status": "failed",
                    "task_id": "0123456789abcdef",
                    "retry_arguments": {"prompt": "a cat"},
                },
                {
                    "type": "image",
                    "status": "failed",
                    "task_id": "fedcba9876543210",
                },
                {
                    "type": "image",
                    "status": "pending",
                    "task_id": "0011223344556677",
                    "retry_arguments": {"prompt": "hidden"},
                },
            ],
        }]

        public_messages = messages_for_api(messages)
        replayable, legacy, pending = public_messages[0]["content"]

        self.assertTrue(replayable["retryable"])
        self.assertFalse(legacy["retryable"])
        self.assertNotIn("retry_arguments", replayable)
        self.assertNotIn("retry_arguments", pending)
        self.assertNotIn("retryable", pending)
        self.assertIn("retry_arguments", messages[0]["content"][0])


if __name__ == "__main__":
    unittest.main()