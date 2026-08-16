# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

"""Turn a generated 4x4 sticker sheet into a PawzoChat emoji pack."""

from __future__ import annotations

import io
import shutil
import tempfile
from collections import deque
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageFilter, UnidentifiedImageError


STICKER_EMOTIONS: tuple[str, ...] = (
    "打招呼",
    "开心",
    "喜欢",
    "大笑",
    "生气",
    "难过",
    "哭泣",
    "惊讶",
    "疑惑",
    "思考",
    "害怕",
    "疲惫",
    "慌张",
    "回避",
    "感谢",
    "道歉",
)
GRID_COLUMNS = 4
GRID_ROWS = 4
WHITE_THRESHOLD = 240
MIN_CONTENT_PIXELS = 64
MIN_CONTENT_RATIO = 0.08
STROKE_WIDTH = 6


class StickerSheetError(ValueError):
    """Raised when model output cannot be converted into a complete pack."""


@dataclass(frozen=True)
class StickerAsset:
    emotion: str
    image_data: bytes
    width: int
    height: int


@dataclass(frozen=True)
class ProcessedStickerSheet:
    source_png: bytes
    stickers: tuple[StickerAsset, ...]


def build_sticker_prompt(style: str = "", *, has_reference: bool = True) -> str:
    """Build the strict layout prompt for reference or text-only generation."""
    style_text = style.strip() or "可爱的卡通二头身角色，适合日常聊天"
    emotions = "、".join(STICKER_EMOTIONS)
    subject_instruction = (
        "请根据参考图中的同一个角色，生成一张完整的聊天表情贴纸表。"
        if has_reference
        else "请根据画面风格和角色描述，设计同一个角色并生成一张完整的聊天表情贴纸表。"
    )
    return (
        f"{subject_instruction}\n"
        "画布必须是正方形，严格排列为 4 列 × 4 行，共 16 格；每格只能有一个完整角色，"
        "角色不能越过格子边界，格子之间保留明显空白，不要绘制网格线。\n"
        f"按从左到右、从上到下的顺序依次表现：{emotions}。\n"
        "背景必须是纯白色 #FFFFFF，不要背景图案、阴影、边框、水印或标题。"
        "每个贴纸主体四周必须留足纯白间距。允许少量简体中文短句，但文字必须留在对应格内。\n"
        f"画面风格：{style_text}。"
    )


def _png_bytes(image: Image.Image) -> bytes:
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    return output.getvalue()


def _is_background(pixel: tuple[int, int, int, int]) -> bool:
    red, green, blue, alpha = pixel
    return alpha < 20 or (
        red > WHITE_THRESHOLD
        and green > WHITE_THRESHOLD
        and blue > WHITE_THRESHOLD
    )


def _remove_exterior_background(image: Image.Image) -> Image.Image:
    """Clear only white pixels connected to a cell edge."""
    rgba = image.convert("RGBA")
    width, height = rgba.size
    pixels = rgba.load()
    exterior = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()

    def enqueue_background(x: int, y: int) -> None:
        index = y * width + x
        if exterior[index] or not _is_background(pixels[x, y]):
            return
        exterior[index] = 1
        queue.append((x, y))

    for x in range(width):
        enqueue_background(x, 0)
        if height > 1:
            enqueue_background(x, height - 1)
    for y in range(1, height - 1):
        enqueue_background(0, y)
        if width > 1:
            enqueue_background(width - 1, y)

    while queue:
        x, y = queue.popleft()
        if x > 0:
            enqueue_background(x - 1, y)
        if x + 1 < width:
            enqueue_background(x + 1, y)
        if y > 0:
            enqueue_background(x, y - 1)
        if y + 1 < height:
            enqueue_background(x, y + 1)

    for index, is_exterior in enumerate(exterior):
        if not is_exterior:
            continue
        x = index % width
        y = index // width
        red, green, blue, _ = pixels[x, y]
        pixels[x, y] = (red, green, blue, 0)
    return rgba


def _with_white_stroke(image: Image.Image, width: int = STROKE_WIDTH) -> Image.Image:
    alpha = image.getchannel("A")
    expanded_size = (image.width + width * 2, image.height + width * 2)
    centered_alpha = Image.new("L", expanded_size, 0)
    centered_alpha.paste(alpha, (width, width))
    outline_alpha = centered_alpha.filter(ImageFilter.MaxFilter(width * 2 + 1))

    result = Image.new("RGBA", expanded_size, (0, 0, 0, 0))
    result.paste(Image.new("RGBA", expanded_size, "white"), mask=outline_alpha)
    result.alpha_composite(image, (width, width))
    return result


def _extract_cell(source: Image.Image, box: tuple[int, int, int, int], emotion: str) -> StickerAsset:
    cell = _remove_exterior_background(source.crop(box))
    alpha = cell.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        raise StickerSheetError(f"模型生成结果中的「{emotion}」格为空")

    content_width = bbox[2] - bbox[0]
    content_height = bbox[3] - bbox[1]
    content_pixels = sum(alpha.histogram()[21:])
    if (
        content_pixels < MIN_CONTENT_PIXELS
        or content_width < cell.width * MIN_CONTENT_RATIO
        or content_height < cell.height * MIN_CONTENT_RATIO
    ):
        raise StickerSheetError(f"模型生成结果中的「{emotion}」格内容过少")

    sticker = _with_white_stroke(cell.crop(bbox))
    return StickerAsset(
        emotion=emotion,
        image_data=_png_bytes(sticker),
        width=sticker.width,
        height=sticker.height,
    )


def process_sticker_sheet(image_data: bytes) -> ProcessedStickerSheet:
    """Decode and split a strict row-major 4x4 sheet into transparent PNGs."""
    try:
        with Image.open(io.BytesIO(image_data)) as opened:
            opened.load()
            source = opened.convert("RGBA")
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise StickerSheetError("模型返回的图片无法读取") from exc

    if source.width < 256 or source.height < 256:
        raise StickerSheetError("模型返回的图片尺寸过小")
    ratio = source.width / source.height
    if not 0.9 <= ratio <= 1.1:
        raise StickerSheetError("模型返回的图片不是正方形表情表")

    stickers: list[StickerAsset] = []
    for index, emotion in enumerate(STICKER_EMOTIONS):
        row, column = divmod(index, GRID_COLUMNS)
        left = round(column * source.width / GRID_COLUMNS)
        top = round(row * source.height / GRID_ROWS)
        right = round((column + 1) * source.width / GRID_COLUMNS)
        bottom = round((row + 1) * source.height / GRID_ROWS)
        stickers.append(_extract_cell(source, (left, top, right, bottom), emotion))

    return ProcessedStickerSheet(
        source_png=_png_bytes(source),
        stickers=tuple(stickers),
    )


def save_sticker_pack(
    emoji_dir: Path,
    group_name: str,
    processed: ProcessedStickerSheet,
) -> Path:
    """Write a complete pack through a sibling temporary directory."""
    emoji_dir.mkdir(parents=True, exist_ok=True)
    final_dir = emoji_dir / group_name
    if final_dir.exists():
        raise FileExistsError(group_name)

    temp_dir = Path(tempfile.mkdtemp(prefix=f".{group_name}.tmp_", dir=emoji_dir))
    try:
        (temp_dir / "sheet.png").write_bytes(processed.source_png)
        for sticker in processed.stickers:
            emotion_dir = temp_dir / sticker.emotion
            emotion_dir.mkdir(parents=True, exist_ok=True)
            (emotion_dir / "1.png").write_bytes(sticker.image_data)
        temp_dir.rename(final_dir)
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise
    return final_dir