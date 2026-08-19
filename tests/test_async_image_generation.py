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

        self.assertIn("先输出一句", guidance)
        self.assertIn("禁止只调用工具而不输出台词", guidance)
        self.assertIn("不要重复调用前的台词", guidance)
        self.assertIn("不要提及『生成图片』", guidance)

    def test_tool_loop_preserves_pre_tool_text_and_appends_continuation(self):
        provider = Mock()
        provider.chat.side_effect = [
            LLMResponse(
                text="等我一下，我拍给你看。",
                finish_reason="tool_use",
                tool_calls=[ToolCall(
                    id="call-1",
                    name="generate_image",
                    arguments={"prompt": "sunny room"},
                )],
            ),
            LLMResponse(
                text="今天窗边的光线特别好。",
                finish_reason="stop",
            ),
        ]
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

        self.assertEqual(
            response.text,
            "等我一下，我拍给你看。\\今天窗边的光线特别好。",
        )
        self.assertEqual(provider.chat.call_count, 2)
        self.assertEqual(generated[0]["status"], "pending")
        self.assertEqual(
            [event["type"] for event in reply_events],
            ["text", "image", "text"],
        )
        self.assertEqual(reply_events[0]["text"], "等我一下，我拍给你看。")
        self.assertEqual(reply_events[2]["text"], "今天窗边的光线特别好。")

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
                },
            )
            self.assertEqual(generated[0]["status"], "pending")
            self.assertTrue(generated[0]["task_id"])
            self.assertIn("后台", result[0].text)
            self.assertIn("剩余内容", result[0].text)
            self.assertIn("不要重复", result[0].text)
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


if __name__ == "__main__":
    unittest.main()