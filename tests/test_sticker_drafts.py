import io
import os
import tempfile
import time
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

from pawzochat.image.sticker_drafts import (
    StickerDraftNotFound,
    claim_sticker_draft,
    cleanup_expired_drafts,
    create_sticker_draft,
    discard_sticker_draft,
    release_sticker_draft,
    sticker_draft_asset_path,
)
from pawzochat.image.sticker_sheet import (
    STICKER_EMOTIONS,
    process_sticker_sheet,
    save_sticker_pack,
)


class StickerDraftTests(unittest.TestCase):
    @staticmethod
    def _processed_sheet():
        image = Image.new("RGB", (400, 400), "white")
        draw = ImageDraw.Draw(image)
        for index in range(16):
            row, column = divmod(index, 4)
            left = column * 100 + 20
            top = row * 100 + 20
            draw.ellipse((left, top, left + 60, top + 60), fill="#ef5350")
        output = io.BytesIO()
        image.save(output, format="PNG")
        return process_sticker_sheet(output.getvalue())

    def test_draft_assets_exist_without_creating_a_pack(self):
        processed = self._processed_sheet()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "drafts"
            emoji_dir = Path(temporary) / "emoji"
            token = create_sticker_draft(processed, draft_root=root)

            self.assertTrue(sticker_draft_asset_path(token, "sheet.png", draft_root=root).is_file())
            self.assertTrue(
                sticker_draft_asset_path(
                    token,
                    f"{STICKER_EMOTIONS[0]}/1.png",
                    draft_root=root,
                ).is_file(),
            )
            self.assertFalse(emoji_dir.exists())
            with self.assertRaises(StickerDraftNotFound):
                sticker_draft_asset_path(token, "../sheet.png", draft_root=root)

    def test_claim_can_be_released_then_saved_once(self):
        processed = self._processed_sheet()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "drafts"
            emoji_dir = Path(temporary) / "emoji"
            token = create_sticker_draft(processed, draft_root=root)

            claim = claim_sticker_draft(token, draft_root=root)
            with self.assertRaises(StickerDraftNotFound):
                claim_sticker_draft(token, draft_root=root)
            release_sticker_draft(claim, draft_root=root)

            claim = claim_sticker_draft(token, draft_root=root)
            saved = save_sticker_pack(emoji_dir, "手动保存", claim.processed)
            discard_sticker_draft(claim)

            self.assertTrue((saved / "sheet.png").is_file())
            self.assertFalse((root / token).exists())
            with self.assertRaises(StickerDraftNotFound):
                claim_sticker_draft(token, draft_root=root)

    def test_expired_drafts_are_removed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "drafts"
            token = create_sticker_draft(self._processed_sheet(), draft_root=root)
            expired_at = time.time() - 3600
            os.utime(root / token, (expired_at, expired_at))

            removed = cleanup_expired_drafts(
                draft_root=root,
                now=time.time(),
                ttl_seconds=60,
            )

            self.assertEqual(removed, 1)
            self.assertFalse((root / token).exists())


if __name__ == "__main__":
    unittest.main()