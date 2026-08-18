import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pawzochat.store.image_gallery import ImageGalleryStore


class ImageGalleryStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.store_path = root / "gallery.json"
        self.images_dir = root / "images"
        self.store = ImageGalleryStore(
            store_path=self.store_path,
            images_dir=self.images_dir,
        )

    def tearDown(self):
        self.temporary.cleanup()

    def add_image(self, prompt="一只白猫"):
        return self.store.add_image(
            image_data=b"generated-image",
            mime_type="image/png",
            prompt=prompt,
            provider="PawAPI",
            model="image-model",
            seed_used=42,
        )

    def test_add_list_and_reload_persist_metadata_and_file(self):
        first = self.add_image("第一张")
        second = self.add_image("第二张")

        reloaded = ImageGalleryStore(
            store_path=self.store_path,
            images_dir=self.images_dir,
        )
        images = reloaded.list_images()

        self.assertEqual([image["id"] for image in images], [second["id"], first["id"]])
        self.assertEqual(images[0]["prompt"], "第二张")
        self.assertEqual(reloaded.image_path(first["id"]).read_bytes(), b"generated-image")

    def test_delete_one_and_batch_remove_metadata_and_files(self):
        first = self.add_image("第一张")
        second = self.add_image("第二张")
        first_path = self.store.image_path(first["id"])
        second_path = self.store.image_path(second["id"])

        self.assertTrue(self.store.delete_image(first["id"]))
        self.assertEqual(self.store.delete_images([second["id"]]), 1)

        self.assertFalse(first_path.exists())
        self.assertFalse(second_path.exists())
        self.assertEqual(self.store.list_images(), [])

    def test_rejects_invalid_ids_without_touching_gallery(self):
        image = self.add_image()

        with self.assertRaisesRegex(ValueError, "图片 ID 无效"):
            self.store.delete_images(["../gallery.json"])

        self.assertEqual(self.store.list_images()[0]["id"], image["id"])
        self.assertIsNone(self.store.image_path("../gallery.json"))

    def test_metadata_failure_cleans_new_image_file(self):
        with patch.object(self.store, "_write", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.add_image()

        self.assertEqual(list(self.images_dir.iterdir()), [])
        self.assertEqual(self.store.list_images(), [])


if __name__ == "__main__":
    unittest.main()