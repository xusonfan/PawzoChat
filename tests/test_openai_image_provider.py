import base64
import unittest
from unittest.mock import patch

from pawzochat.image.base import ImageGenerationError
from pawzochat.image.providers.openai_image import OpenAIImageProvider


class _Response:
    def __init__(self, *, ok=True, status_code=200, payload=None, text=""):
        self.ok = ok
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


class OpenAIImageProviderTests(unittest.TestCase):
    def setUp(self):
        self.provider = OpenAIImageProvider(
            base_url="https://image.example/v1",
            api_key="test-key",
        )
        self.image_bytes = b"generated-png"
        self.success = _Response(payload={
            "data": [{
                "b64_json": base64.b64encode(self.image_bytes).decode("ascii"),
            }],
        })

    @patch("pawzochat.image.providers.openai_image.requests.post")
    def test_text_only_request_uses_generations_json(self, post):
        post.return_value = self.success

        result = self.provider.generate("draw a cat", model="gpt-image-2")

        self.assertEqual(result.image_data, self.image_bytes)
        self.assertEqual(post.call_args.args[0], "https://image.example/v1/images/generations")
        self.assertEqual(post.call_args.kwargs["json"]["prompt"], "draw a cat")
        self.assertNotIn("files", post.call_args.kwargs)
        self.assertEqual(
            post.call_args.kwargs["headers"]["Content-Type"],
            "application/json",
        )

    @patch("pawzochat.image.providers.openai_image.requests.post")
    def test_reference_images_use_edits_multipart(self, post):
        post.return_value = self.success

        result = self.provider.generate(
            "keep this character",
            model="gpt-image-2",
            reference_images=[
                (b"png-reference", "image/png"),
                (b"jpeg-reference", "image/jpeg"),
            ],
        )

        self.assertEqual(result.image_data, self.image_bytes)
        self.assertEqual(post.call_args.args[0], "https://image.example/v1/images/edits")
        self.assertEqual(post.call_args.kwargs["data"]["model"], "gpt-image-2")
        self.assertNotIn("input_fidelity", post.call_args.kwargs["data"])
        files = post.call_args.kwargs["files"]
        self.assertEqual([field for field, _ in files], ["image[]", "image[]"])
        self.assertEqual(files[0][1], ("reference-1.png", b"png-reference", "image/png"))
        self.assertEqual(files[1][1], ("reference-2.jpg", b"jpeg-reference", "image/jpeg"))
        self.assertNotIn("Content-Type", post.call_args.kwargs["headers"])

    @patch("pawzochat.image.providers.openai_image.requests.post")
    def test_edits_retry_without_response_format(self, post):
        post.side_effect = [
            _Response(
                ok=False,
                status_code=400,
                text="Unknown parameter: response_format",
            ),
            self.success,
        ]

        result = self.provider.generate(
            "keep this character",
            model="gpt-image-2",
            reference_images=[(b"reference", "image/png")],
        )

        self.assertEqual(result.image_data, self.image_bytes)
        self.assertEqual(post.call_count, 2)
        self.assertIn("response_format", post.call_args_list[0].kwargs["data"])
        self.assertNotIn("response_format", post.call_args_list[1].kwargs["data"])
        self.assertEqual(
            post.call_args_list[0].kwargs["files"],
            post.call_args_list[1].kwargs["files"],
        )

    @patch("pawzochat.image.providers.openai_image.requests.post")
    def test_non_gpt_image_model_ignores_references(self, post):
        post.return_value = self.success

        self.provider.generate(
            "draw a cat",
            model="dall-e-3",
            reference_images=[(b"reference", "image/png")],
        )

        self.assertEqual(post.call_args.args[0], "https://image.example/v1/images/generations")
        self.assertNotIn("files", post.call_args.kwargs)

    @patch("pawzochat.image.providers.openai_image.requests.post")
    def test_explicit_capability_supports_custom_relay_model(self, post):
        post.return_value = self.success
        provider = OpenAIImageProvider(
            base_url="https://relay.example/v1",
            api_key="test-key",
            supports_reference_images=True,
        )

        provider.generate(
            "use reference",
            model="relay-image-model",
            reference_images=[(b"reference", "image/png")],
        )

        self.assertEqual(post.call_args.args[0], "https://relay.example/v1/images/edits")

    @patch("pawzochat.image.providers.openai_image.requests.post")
    def test_rejects_more_than_sixteen_references(self, post):
        with self.assertRaisesRegex(ImageGenerationError, "不能超过 16 张"):
            self.provider.generate(
                "use references",
                model="gpt-image-2",
                reference_images=[(b"reference", "image/png")] * 17,
            )

        post.assert_not_called()


if __name__ == "__main__":
    unittest.main()