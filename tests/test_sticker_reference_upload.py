import io
import unittest

from PIL import Image

try:
    from flask import Flask
    from pawzochat.web.routes.api_sticker_maker import _uploaded_reference_image
except ModuleNotFoundError:
    Flask = None
    _uploaded_reference_image = None


@unittest.skipIf(Flask is None, "宿主机未安装 Web 运行依赖 Flask")
class StickerReferenceUploadTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)

    @staticmethod
    def _png_bytes() -> bytes:
        output = io.BytesIO()
        Image.new("RGB", (16, 16), "#ef5350").save(output, format="PNG")
        return output.getvalue()

    def test_missing_upload_does_not_fall_back_to_persona(self):
        with self.app.test_request_context(
            "/api/emoji/generate",
            method="POST",
            data={"persona_id": "legacy-persona"},
        ):
            references, error = _uploaded_reference_image()

        self.assertEqual(references, [])
        self.assertIsNone(error)

    def test_uploaded_image_is_normalized_to_png(self):
        with self.app.test_request_context(
            "/api/emoji/generate",
            method="POST",
            data={
                "reference": (
                    io.BytesIO(self._png_bytes()),
                    "reference.png",
                ),
            },
        ):
            references, error = _uploaded_reference_image()

        self.assertIsNone(error)
        self.assertEqual(len(references), 1)
        image_data, mime_type = references[0]
        self.assertEqual(mime_type, "image/png")
        self.assertTrue(image_data.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_invalid_upload_is_rejected(self):
        with self.app.test_request_context(
            "/api/emoji/generate",
            method="POST",
            data={
                "reference": (
                    io.BytesIO(b"not-an-image"),
                    "reference.png",
                ),
            },
        ):
            references, error = _uploaded_reference_image()

        self.assertEqual(references, [])
        self.assertEqual(error, "参考图格式无效")


if __name__ == "__main__":
    unittest.main()