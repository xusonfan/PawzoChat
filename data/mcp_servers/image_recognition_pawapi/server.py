# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""PawzoChat MCP Server — 图像识别 (GPT-4o via PawAPI)

为不支持多模态的模型（如 DeepSeek）提供图像识别能力。
接收 base64 编码的图片数据，调用 GPT-4o 进行识别并返回描述。

注意：此 MCP Server 需配合 capability_adapter 使用，由适配器
通过 $image_data(image_id) 注入 base64 图片数据。

API Key 解析优先级:
  1. 环境变量 PAWAPI_KEY（由 mcp_servers 配置的 env 字段注入）
  2. 回退读取 data/config/config.yaml 中 preset=pawapi 的 provider api_key
"""

from __future__ import annotations

import base64
import os
import sys
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from openai import AsyncOpenAI

BASE_URL = os.environ.get("IMAGE_RECOGNITION_BASE_URL", "https://paw.v1chat.cc/v1")
MODEL = os.environ.get("IMAGE_RECOGNITION_MODEL", "") or "gpt-4o"
DATA_DIR = Path(
    sys.executable if getattr(sys, "frozen", False) else __file__
).resolve().parent.parent.parent

server = FastMCP("image-recognition")


def _resolve_api_key() -> str:
    key = os.environ.get("PAWAPI_KEY", "")
    if key:
        return key

    try:
        import yaml  # noqa: PLC0415

        config_path = DATA_DIR / "config" / "config.yaml"
        if not config_path.exists():
            return ""
        with open(config_path, encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
        for _name, pcfg in cfg.get("llm_providers", {}).items():
            if pcfg.get("preset") == "pawapi":
                found = pcfg.get("api_key", "")
                if found:
                    return found
    except Exception:
        pass

    return ""


def _detect_mime(b64: str) -> str:
    """Detect image MIME type from base64 magic bytes."""
    try:
        header = base64.b64decode(b64[:32])
        if header[:8] == b"\x89PNG\r\n\x1a\n":
            return "image/png"
        if header[:2] == b"\xff\xd8":
            return "image/jpeg"
        if header[:4] == b"GIF8":
            return "image/gif"
        if header[:4] == b"RIFF" and header[8:12] == b"WEBP":
            return "image/webp"
    except Exception:
        pass
    return "image/jpeg"


SYSTEM_PROMPT = "你是一个图像识别助手。准确、详细地描述用户提供的图片内容。"


@server.tool()
async def recognize_image(
    image_data: str,
    image_id: str = "",
    query: str = "请详细描述这张图片的内容",
) -> str:
    """识别并描述图片内容。接收 base64 编码的图片数据，返回文字描述。

    Args:
        image_data: base64 编码的图片数据（由 capability_adapter 注入）
        image_id: 图片 ID（仅供参考）
        query: 关于图片的具体问题
    """
    if not image_data:
        return "错误: 未收到图片数据。请确保 capability_adapter 配置了 $image_data 注入。"

    api_key = _resolve_api_key()
    if not api_key:
        return (
            "错误: 未找到 API Key。请在 mcp_servers 配置中设置 env.PAWAPI_KEY，"
            "或确保 config.yaml 中存在 preset=pawapi 的 provider 配置。"
        )

    mime = _detect_mime(image_data)
    data_uri = f"data:{mime};base64,{image_data}"

    client = AsyncOpenAI(base_url=BASE_URL, api_key=api_key, timeout=60.0)
    try:
        response = await client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": query},
                        {"type": "image_url", "image_url": {"url": data_uri}},
                    ],
                },
            ],
            max_tokens=2048,
        )
        return response.choices[0].message.content or "图像识别未返回结果。"
    except Exception as exc:
        return f"图像识别出错: {exc}"


if __name__ == "__main__":
    server.run(transport="stdio")
