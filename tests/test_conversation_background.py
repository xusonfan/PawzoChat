import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from flask import Flask
from PIL import Image

from pawzochat.store.conversation import ConversationStore
from pawzochat.web.routes.api_conversations import api_conversations_bp


class ConversationBackgroundApiTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.store = ConversationStore(self.root)
        self.store.create_conversation("cat")

        app = Flask(__name__)
        app.config["PAWZOCHAT_APP"] = SimpleNamespace(conversation_store=self.store)
        app.register_blueprint(api_conversations_bp, url_prefix="/api/conversations")
        self.client = app.test_client()
        self.path_patch = patch(
            "pawzochat.web.routes.api_conversations.CHATS_DIR",
            self.root,
        )
        self.broadcast_patch = patch(
            "pawzochat.web.routes.api_conversations.broadcast",
        )
        self.path_patch.start()
        self.broadcast = self.broadcast_patch.start()
        self.addCleanup(self.path_patch.stop)
        self.addCleanup(self.broadcast_patch.stop)

    @staticmethod
    def image_file(size=(2400, 1200), image_format="JPEG"):
        output = BytesIO()
        Image.new("RGB", size, (80, 140, 220)).save(output, format=image_format)
        output.seek(0)
        return output

    def test_upload_serves_and_deletes_background(self):
        uploaded = self.client.post(
            "/api/conversations/cat/background",
            data={"background": (self.image_file(), "wallpaper.jpg")},
            content_type="multipart/form-data",
        )

        self.assertEqual(uploaded.status_code, 200)
        version = uploaded.get_json()["background_version"]
        self.assertRegex(version, r"^[0-9a-f]{16}$")
        self.assertEqual(
            self.store.list_conversations()[0]["background_version"],
            version,
        )

        served = self.client.get(f"/api/conversations/cat/background?v={version}")
        self.assertEqual(served.status_code, 200)
        self.assertEqual(served.mimetype, "image/webp")
        self.assertIn("immutable", served.headers["Cache-Control"])
        image_data = served.data
        served.close()
        with Image.open(BytesIO(image_data)) as image:
            self.assertEqual(image.size, (1920, 960))

        deleted = self.client.delete("/api/conversations/cat/background")
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(self.store.list_conversations()[0]["background_version"], "")
        self.assertEqual(
            self.client.get("/api/conversations/cat/background").status_code,
            404,
        )
        self.assertEqual(self.broadcast.call_count, 2)

    def test_rejects_invalid_image_and_missing_conversation(self):
        invalid = self.client.post(
            "/api/conversations/cat/background",
            data={"background": (BytesIO(b"not-image"), "bad.png")},
            content_type="multipart/form-data",
        )
        missing = self.client.post(
            "/api/conversations/missing/background",
            data={"background": (self.image_file((10, 10)), "small.png")},
            content_type="multipart/form-data",
        )

        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.get_json()["error"], "无法识别该图片")
        self.assertEqual(missing.status_code, 404)


if __name__ == "__main__":
    unittest.main()