import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from pawzochat.services import image_cache


class ExternalImageCacheTests(unittest.TestCase):
    @staticmethod
    def _png_bytes() -> bytes:
        output = io.BytesIO()
        Image.new("RGB", (2, 2), "red").save(output, format="PNG")
        return output.getvalue()

    def test_markdown_image_is_persisted_as_image_block(self):
        with tempfile.TemporaryDirectory() as temporary:
            chats_dir = Path(temporary)
            raw = self._png_bytes()
            with (
                patch.object(image_cache, "CHATS_DIR", chats_dir),
                patch.object(
                    image_cache,
                    "_download_image",
                    return_value=(raw, "image/png", "png"),
                ),
            ):
                content = image_cache.cache_external_images(
                    "persona-a",
                    [{"type": "text", "text": "前文 ![示例](https://cdn.example/a.png) 后文"}],
                )

            self.assertEqual(content[0], {"type": "text", "text": "前文 "})
            self.assertEqual(content[1]["type"], "image")
            self.assertEqual(content[1]["mime"], "image/png")
            self.assertEqual(content[1]["original_url"], "https://cdn.example/a.png")
            self.assertEqual(content[2], {"type": "text", "text": " 后文"})
            saved_path = Path(content[1]["path"])
            self.assertTrue(saved_path.is_file())
            self.assertEqual(saved_path.read_bytes(), raw)

    def test_same_url_is_downloaded_once_and_reused(self):
        raw = self._png_bytes()
        with tempfile.TemporaryDirectory() as temporary:
            with (
                patch.object(image_cache, "CHATS_DIR", Path(temporary)),
                patch.object(
                    image_cache,
                    "_download_image",
                    return_value=(raw, "image/png", "png"),
                ) as download,
            ):
                content = image_cache.cache_external_images(
                    "persona-a",
                    [{
                        "type": "text",
                        "text": "![一](https://cdn.example/a.png) ![二](https://cdn.example/a.png)",
                    }],
                )

            self.assertEqual(download.call_count, 1)
            images = [block for block in content if block["type"] == "image"]
            self.assertEqual(len(images), 2)
            self.assertEqual(images[0]["path"], images[1]["path"])

    def test_prepare_external_images_returns_remote_url_without_downloading(self):
        with (
            patch.object(image_cache, "_cached_remote_image", return_value=None),
            patch.object(image_cache, "_download_image") as download,
            patch.object(image_cache.secrets, "token_hex", return_value="0123456789abcdef"),
        ):
            content, jobs = image_cache.prepare_external_images(
                "persona-a",
                [{"type": "text", "text": "前文 ![示例](https://cdn.example/a.png) 后文"}],
            )

        download.assert_not_called()
        self.assertEqual(content[0], {"type": "text", "text": "前文 "})
        self.assertEqual(content[1], {
            "type": "image",
            "url": "https://cdn.example/a.png",
            "original_url": "https://cdn.example/a.png",
            "task_id": "0123456789abcdef",
        })
        self.assertEqual(content[2], {"type": "text", "text": " 后文"})
        self.assertEqual(jobs, [("0123456789abcdef", "https://cdn.example/a.png")])

    def test_url_keyed_file_skips_repeated_download(self):
        url = "https://cdn.example/a.png"
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            digest = image_cache.hashlib.sha256(url.encode("utf-8")).hexdigest()[:24]
            cached_path = directory / f"remote_url_{digest}.png"
            cached_path.write_bytes(self._png_bytes())
            with (
                patch.object(image_cache, "_images_dir", return_value=directory),
                patch.object(image_cache, "_download_image") as download,
            ):
                result = image_cache.cache_external_image("persona-a", url)

        download.assert_not_called()
        self.assertEqual(result["path"], str(cached_path))
        self.assertEqual(result["mime"], "image/png")
        self.assertEqual(result["original_url"], url)

    def test_failed_download_preserves_original_text(self):
        original = [{
            "type": "text",
            "text": "图片 ![示例](https://cdn.example/missing.png)",
        }]
        with patch.object(image_cache, "_save_remote_image", return_value=None):
            content = image_cache.cache_external_images("persona-a", original)
        self.assertEqual(content, original)

    def test_remote_image_block_is_replaced_but_keeps_source_url(self):
        cached = {
            "type": "image",
            "path": "/data/chats/persona-a/images/remote_hash.png",
            "mime": "image/png",
            "original_url": "https://cdn.example/a.png",
        }
        with patch.object(image_cache, "_save_remote_image", return_value=cached):
            content = image_cache.cache_external_images(
                "persona-a",
                [{"type": "image", "url": "https://cdn.example/a.png"}],
            )
        self.assertEqual(content, [cached])

    def test_proxy_fake_ip_destination_is_allowed(self):
        with patch.object(
            image_cache.socket,
            "getaddrinfo",
            return_value=[(2, 1, 6, "", ("198.18.5.115", 443))],
        ):
            self.assertTrue(image_cache._is_public_http_url("https://cdn.example/a.png"))

    def test_private_destination_is_rejected(self):
        with patch.object(
            image_cache.socket,
            "getaddrinfo",
            return_value=[(2, 1, 6, "", ("127.0.0.1", 80))],
        ):
            self.assertFalse(image_cache._is_public_http_url("http://example.test/a.png"))
        self.assertFalse(image_cache._is_public_http_url("http://localhost/a.png"))
        self.assertFalse(image_cache._is_public_http_url("file:///tmp/a.png"))


if __name__ == "__main__":
    unittest.main()