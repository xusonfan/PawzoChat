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

"""Format converters between the unified internal message/tool format and
provider-specific wire formats (OpenAI, Anthropic, Gemini).

The internal format uses MCP-style ``inputSchema`` for tool definitions and
``ContentBlock`` for structured tool results.
"""

from __future__ import annotations

import json
from typing import Any

from pawzochat.llm.base import ContentBlock, ToolCall


# ---------------------------------------------------------------------------
# Tool definition converters  (MCP inputSchema → provider format)
# ---------------------------------------------------------------------------

def mcp_tools_to_openai(tools: list[dict]) -> list[dict]:
    """Convert MCP-style tool definitions to OpenAI function-calling format."""
    result = []
    for t in tools:
        result.append({
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t.get("description", ""),
                "parameters": t.get("inputSchema", {"type": "object", "properties": {}}),
            },
        })
    return result


def mcp_tools_to_anthropic(tools: list[dict]) -> list[dict]:
    """Convert MCP-style tool definitions to Anthropic tool format."""
    result = []
    for t in tools:
        result.append({
            "name": t["name"],
            "description": t.get("description", ""),
            "input_schema": t.get("inputSchema", {"type": "object", "properties": {}}),
        })
    return result


def mcp_tools_to_gemini(tools: list[dict]) -> list[dict]:
    """Convert MCP-style tool definitions to Gemini function declarations.

    Returns a list of dicts that can be passed to
    ``types.Tool(function_declarations=...)``.
    """
    result = []
    for t in tools:
        schema = t.get("inputSchema", {"type": "object", "properties": {}})
        result.append({
            "name": t["name"],
            "description": t.get("description", ""),
            "parameters": schema,
        })
    return result


# ---------------------------------------------------------------------------
# ContentBlock converters  (structured tool results → provider format)
# ---------------------------------------------------------------------------

def content_blocks_to_text(blocks: list[ContentBlock]) -> str:
    """Flatten ContentBlocks into a single text string.

    Image and resource blocks are represented as descriptive placeholders.
    Used by providers that only accept text in tool results (e.g. OpenAI).
    """
    parts: list[str] = []
    for b in blocks:
        if b.type == "text" and b.text:
            parts.append(b.text)
        elif b.type == "image":
            parts.append("[image data]")
        elif b.type == "resource" and b.uri:
            parts.append(f"[resource: {b.uri}]")
    return "\n".join(parts) if parts else ""


def content_blocks_to_anthropic(blocks: list[ContentBlock]) -> list[dict]:
    """Convert ContentBlocks to Anthropic content array."""
    result: list[dict] = []
    for b in blocks:
        if b.type == "text" and b.text:
            result.append({"type": "text", "text": b.text})
        elif b.type == "image" and b.data:
            result.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": b.mime_type or "image/jpeg",
                    "data": b.data,
                },
            })
    return result or [{"type": "text", "text": ""}]


# ---------------------------------------------------------------------------
# Message converters  (unified internal → provider wire format)
# ---------------------------------------------------------------------------

def _serialize_content_for_openai(content: Any) -> Any:
    """Translate internal content (str or list[dict]) for OpenAI API."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[dict] = []
        for block in content:
            if isinstance(block, dict):
                btype = block.get("type", "text")
                if btype == "text":
                    parts.append({"type": "text", "text": block.get("text", "")})
                elif btype == "image":
                    data_uri = f"data:{block.get('mime_type', 'image/jpeg')};base64,{block.get('data', '')}"
                    parts.append({"type": "image_url", "image_url": {"url": data_uri}})
        return parts or content
    return content


def messages_to_openai(
    messages: list[dict],
) -> list[dict]:
    """Convert unified internal messages to OpenAI Chat Completions format."""
    result: list[dict] = []
    for msg in messages:
        role = msg["role"]

        if role == "tool":
            result.append({
                "role": "tool",
                "tool_call_id": msg.get("tool_call_id", ""),
                "content": _tool_content_to_str(msg.get("content")),
            })
            continue

        if role == "assistant" and msg.get("tool_calls"):
            tc_list = []
            for tc in msg["tool_calls"]:
                tc_obj = tc if isinstance(tc, ToolCall) else ToolCall(**tc)
                tc_list.append({
                    "id": tc_obj.id,
                    "type": "function",
                    "function": {
                        "name": tc_obj.name,
                        "arguments": json.dumps(tc_obj.arguments, ensure_ascii=False),
                    },
                })
            api_msg: dict = {
                "role": "assistant",
                "content": None,
                "tool_calls": tc_list,
            }
            # Thinking-mode models reject the next-turn request unless the
            # previous assistant's reasoning_content is echoed back. Carried
            # from ChatService when present.
            reasoning = msg.get("reasoning_content")
            if isinstance(reasoning, str) and reasoning:
                api_msg["reasoning_content"] = reasoning
            result.append(api_msg)
            continue

        result.append({
            "role": role,
            "content": _serialize_content_for_openai(msg.get("content", "")),
        })

    return result


def messages_to_anthropic(
    messages: list[dict],
) -> tuple[str | None, list[dict]]:
    """Convert unified internal messages to Anthropic format.

    Returns ``(system_prompt, api_messages)``.
    """
    system_parts: list[str] = []
    api_messages: list[dict] = []

    for msg in messages:
        role = msg["role"]

        if role == "system":
            content = msg.get("content", "")
            text = content if isinstance(content, str) else str(content)
            if text:
                system_parts.append(text)
            continue

        if role == "tool":
            blocks = msg.get("content", [])
            if isinstance(blocks, list) and blocks and isinstance(blocks[0], ContentBlock):
                content = content_blocks_to_anthropic(blocks)
            elif isinstance(blocks, list) and blocks and isinstance(blocks[0], dict):
                content = content_blocks_to_anthropic(
                    [ContentBlock(**b) if isinstance(b, dict) else b for b in blocks]
                )
            else:
                content = [{"type": "text", "text": str(blocks)}]
            api_messages.append({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": msg.get("tool_call_id", ""),
                    "content": content,
                }],
            })
            continue

        if role == "assistant" and msg.get("tool_calls"):
            blocks: list[dict] = []
            if msg.get("content"):
                blocks.append({"type": "text", "text": msg["content"]})
            for tc in msg["tool_calls"]:
                tc_obj = tc if isinstance(tc, ToolCall) else ToolCall(**tc)
                blocks.append({
                    "type": "tool_use",
                    "id": tc_obj.id,
                    "name": tc_obj.name,
                    "input": tc_obj.arguments,
                })
            api_messages.append({"role": "assistant", "content": blocks})
            continue

        content = msg.get("content", "")
        if isinstance(content, list):
            api_content: list[dict] = []
            for block in content:
                if isinstance(block, dict):
                    btype = block.get("type", "text")
                    if btype == "text":
                        api_content.append({"type": "text", "text": block.get("text", "")})
                    elif btype == "image":
                        api_content.append({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": block.get("mime_type", "image/jpeg"),
                                "data": block.get("data", ""),
                            },
                        })
            api_messages.append({"role": role, "content": api_content or content})
        else:
            api_messages.append({"role": role, "content": content})

    system = "\n\n".join(system_parts) if system_parts else None
    return system, api_messages


def _tool_content_to_str(content: Any) -> str:
    """Serialize tool result content to a plain string for providers that
    only accept text (OpenAI)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        blocks = []
        for item in content:
            if isinstance(item, ContentBlock):
                blocks.append(item)
            elif isinstance(item, dict):
                blocks.append(ContentBlock(**item))
        return content_blocks_to_text(blocks)
    return str(content)
