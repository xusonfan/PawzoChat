import io
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

from pawzochat.image.sticker_sheet import (
    STICKER_EMOTIONS,
    StickerSheetError,
    build_sticker_prompt,
    process_sticker_sheet,
    save_sticker_pack,
)


class StickerSheetTests(unittest.TestCase):
    @staticmethod
    def _png_bytes(image: Image.Image) -> bytes:
        output = io.BytesIO()
        image.save(output, format="PNG")
        return output.getvalue()

    def _complete_sheet(self) -> bytes:
        image = Image.new("RGB", (400, 400), "white")
        draw = ImageDraw.Draw(image)
        colors = ("#ef5350", "#42a5f5", "#66bb6a", "#ab47bc")
        for index in range(16):
            row, column = divmod(index, 4)
            left = column * 100 + 20
            top = row * 100 + 20
            draw.rounded_rectangle(
                (left, top, left + 60, top + 60),
                radius=14,
                fill=colors[index % len(colors)],
            )

        # An enclosed white region belongs to the sticker and must not be
        # cleared together with the edge-connected white canvas.
        draw.ellipse((25, 25, 75, 75), fill="black")
        draw.ellipse((38, 38, 62, 62), fill="white")
        return self._png_bytes(image)

    def test_processes_sixteen_cells_in_semantic_order(self):
        processed = process_sticker_sheet(self._complete_sheet())

        self.assertEqual(
            [asset.emotion for asset in processed.stickers],
            list(STICKER_EMOTIONS),
        )
        self.assertEqual(len(processed.stickers), 16)
        for asset in processed.stickers:
            self.assertGreater(asset.width, 20)
            self.assertGreater(asset.height, 20)
            with Image.open(io.BytesIO(asset.image_data)) as image:
                self.assertEqual(image.mode, "RGBA")
                self.assertLess(image.getchannel("A").getextrema()[0], 255)

        with Image.open(io.BytesIO(processed.stickers[0].image_data)) as first:
            center = first.getpixel((first.width // 2, first.height // 2))
            self.assertEqual(center[:3], (255, 255, 255))
            self.assertEqual(center[3], 255)

    def test_rejects_sheet_with_an_empty_cell(self):
        image = Image.open(io.BytesIO(self._complete_sheet())).convert("RGB")
        ImageDraw.Draw(image).rectangle((300, 300, 399, 399), fill="white")

        with self.assertRaisesRegex(StickerSheetError, "道歉.*为空"):
            process_sticker_sheet(self._png_bytes(image))

    def test_rejects_non_square_output(self):
        image = Image.new("RGB", (640, 360), "white")
        with self.assertRaisesRegex(StickerSheetError, "不是正方形"):
            process_sticker_sheet(self._png_bytes(image))

    def test_saves_complete_pack_without_overwriting(self):
        processed = process_sticker_sheet(self._complete_sheet())
        with tempfile.TemporaryDirectory() as temporary:
            emoji_dir = Path(temporary)
            saved = save_sticker_pack(emoji_dir, "测试表情包", processed)

            self.assertTrue((saved / "sheet.png").is_file())
            for emotion in STICKER_EMOTIONS:
                self.assertTrue((saved / emotion / "1.png").is_file())
            with self.assertRaises(FileExistsError):
                save_sticker_pack(emoji_dir, "测试表情包", processed)

    def test_prompt_defines_layout_and_emotion_order(self):
        reference_prompt = build_sticker_prompt("像素艺术", has_reference=True)
        text_prompt = build_sticker_prompt("戴围巾的橘猫", has_reference=False)

        self.assertIn("4 列 × 4 行", reference_prompt)
        self.assertIn("像素艺术", reference_prompt)
        self.assertIn("参考图", reference_prompt)
        self.assertNotIn("参考图", text_prompt)
        self.assertIn("角色描述", text_prompt)
        self.assertLess(
            reference_prompt.index(STICKER_EMOTIONS[0]),
            reference_prompt.index(STICKER_EMOTIONS[-1]),
        )


if __name__ == "__main__":
    unittest.main()