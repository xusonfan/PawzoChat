import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from flask import Flask
from PIL import Image

from pawzochat.image.base import ImageGenerationError, ImageResponse
from pawzochat.store.image_gallery import ImageGalleryStore
from pawzochat.web.routes.api_image_gallery import api_image_gallery_bp


class ImageGalleryApiTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.store = ImageGalleryStore(
            store_path=root / "gallery.json",
            images_dir=root / "images",
        )
        app = Flask(__name__)
        self.image_manager = SimpleNamespace(
            model_supports_reference_images=lambda provider, model: False,
        )
        app.config["PAWZOCHAT_APP"] = SimpleNamespace(
            image_manager=self.image_manager,
        )
        app.register_blueprint(api_image_gallery_bp, url_prefix="/api/image-gallery")
        self.client = app.test_client()
        self.store_patch = patch(
            "pawzochat.web.routes.api_image_gallery._store",
            self.store,
        )
        self.store_patch.start()
        self.addCleanup(self.store_patch.stop)

    def reference_png(self):
        output = BytesIO()
        Image.new("RGB", (4, 4), (255, 128, 0)).save(output, format="PNG")
        output.seek(0)
        return output

    def test_generate_saves_and_lists_image(self):
        response = ImageResponse(
            image_data=b"png-data",
            mime_type="image/png",
            seed_used=7,
        )
        with patch(
            "pawzochat.web.routes.api_image_gallery.generate_configured_image",
            return_value=response,
        ) as generate:
            result = self.client.post("/api/image-gallery/generate", json={
                "provider": "PawAPI",
                "model": "image-model",
                "prompt": "夜空中的鲸鱼",
            })

        self.assertEqual(result.status_code, 201)
        item = result.get_json()["image"]
        self.assertEqual(item["prompt"], "夜空中的鲸鱼")
        self.assertEqual(item["seed_used"], 7)
        self.assertNotIn("filename", item)
        self.assertRegex(item["image_url"], rf"/{item['id']}/{item['id']}\.png$")
        generate.assert_called_once()

        listed = self.client.get("/api/image-gallery").get_json()["images"]
        self.assertEqual([image["id"] for image in listed], [item["id"]])
        image_response = self.client.get(item["image_url"])
        self.assertEqual(image_response.data, b"png-data")
        image_response.close()

    def test_generate_normalizes_and_passes_supported_reference_image(self):
        self.image_manager.model_supports_reference_images = lambda provider, model: True
        response = ImageResponse(image_data=b"generated", mime_type="image/png")
        with patch(
            "pawzochat.web.routes.api_image_gallery.generate_configured_image",
            return_value=response,
        ) as generate:
            result = self.client.post(
                "/api/image-gallery/generate",
                data={
                    "provider": "PawAPI",
                    "model": "image-model",
                    "prompt": "保持参考图主体特征",
                    "reference": (self.reference_png(), "reference.png"),
                },
                content_type="multipart/form-data",
            )

        self.assertEqual(result.status_code, 201)
        self.assertTrue(result.get_json()["used_reference_image"])
        references = generate.call_args.kwargs["reference_images"]
        self.assertEqual(len(references), 1)
        self.assertEqual(references[0][1], "image/png")
        self.assertTrue(references[0][0].startswith(b"\x89PNG"))

    def test_rejects_reference_for_unsupported_model(self):
        with patch(
            "pawzochat.web.routes.api_image_gallery.generate_configured_image",
        ) as generate:
            result = self.client.post(
                "/api/image-gallery/generate",
                data={
                    "provider": "PawAPI",
                    "model": "text-only-image-model",
                    "prompt": "测试",
                    "reference": (self.reference_png(), "reference.png"),
                },
                content_type="multipart/form-data",
            )

        self.assertEqual(result.status_code, 400)
        self.assertEqual(result.get_json()["error"], "当前生图模型不支持参考图")
        generate.assert_not_called()

    def test_upstream_failure_does_not_create_gallery_entry(self):
        error = ImageGenerationError("openai_image", "额度不足", status_code=429)
        with patch(
            "pawzochat.web.routes.api_image_gallery.generate_configured_image",
            side_effect=error,
        ):
            result = self.client.post("/api/image-gallery/generate", json={
                "provider": "PawAPI",
                "model": "image-model",
                "prompt": "测试",
            })

        self.assertEqual(result.status_code, 429)
        self.assertEqual(result.get_json()["error"], "额度不足")
        self.assertEqual(self.store.list_images(), [])

    def test_single_and_batch_delete(self):
        first = self.store.add_image(
            image_data=b"first",
            mime_type="image/png",
            prompt="第一张",
            provider="PawAPI",
            model="image-model",
        )
        second = self.store.add_image(
            image_data=b"second",
            mime_type="image/webp",
            prompt="第二张",
            provider="PawAPI",
            model="image-model",
        )

        single = self.client.delete(f"/api/image-gallery/{first['id']}")
        batch = self.client.post("/api/image-gallery/batch-delete", json={
            "ids": [second["id"]],
        })

        self.assertEqual(single.status_code, 200)
        self.assertEqual(batch.get_json()["deleted_count"], 1)
        self.assertEqual(self.store.list_images(), [])

    def test_rejects_invalid_batch_ids(self):
        result = self.client.post("/api/image-gallery/batch-delete", json={
            "ids": ["../escape"],
        })

        self.assertEqual(result.status_code, 400)
        self.assertEqual(result.get_json()["error"], "图片 ID 无效")


if __name__ == "__main__":
    unittest.main()