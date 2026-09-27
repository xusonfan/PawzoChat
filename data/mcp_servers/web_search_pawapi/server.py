# PawzoChat - Human-like, versatile, extensible AI companion engine
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

"""PawzoChat MCP Server — 联网搜索 (net-gpt-4o-mini)

通过调用具有联网搜索能力的 net-gpt-4o-mini 模型，为 PawzoChat 主 LLM
提供 web_search 工具。

API Key 解析优先级:
  1. 环境变量 PAWAPI_KEY（由 mcp_servers 配置的 env 字段注入）
  2. 回退读取 data/config/config.yaml 中 preset=pawapi 的 provider api_key
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from openai import AsyncOpenAI

BASE_URL = "https://paw.v1chat.cc/v1"
MODEL = os.environ.get("WEB_SEARCH_MODEL", "") or "net-gpt-4o-mini"
DATA_DIR = Path(
    sys.executable if getattr(sys, "frozen", False) else __file__
).resolve().parent.parent.parent

server = FastMCP("web-search")


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


SYSTEM_PROMPT = (
    "你是一个联网搜索助手。根据用户的查询搜索互联网，"
    "返回准确、详实、最新的信息。只返回搜索到的事实内容，不要添加无关寒暄。"
)


@server.tool()
async def web_search(query: str) -> str:
    """搜索互联网获取最新信息。当需要查询时事新闻、实时数据、最新事件或需要验证的事实时使用此工具。

    Args:
        query: 搜索关键词或问题
    """
    api_key = _resolve_api_key()
    if not api_key:
        return (
            "错误: 未找到 API Key。请在 mcp_servers 配置中设置 env.PAWAPI_KEY，"
            "或确保 config.yaml 中存在 preset=pawapi 的 provider 配置。"
        )

    client = AsyncOpenAI(base_url=BASE_URL, api_key=api_key, timeout=60.0)
    try:
        response = await client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": query},
            ],
            temperature=0.3,
            max_tokens=4096,
        )
        return response.choices[0].message.content or "搜索未返回结果。"
    except Exception as exc:
        return f"联网搜索出错: {exc}"


if __name__ == "__main__":
    server.run(transport="stdio")
