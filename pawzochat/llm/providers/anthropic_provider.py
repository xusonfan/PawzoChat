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

"""Anthropic Messages API provider.

Supports Claude models via the official ``anthropic`` SDK.
"""

from __future__ import annotations

import logging

import anthropic

from pawzochat.llm.base import LLMProvider, LLMResponse, ToolCall
from pawzochat.llm.converter import (
    messages_to_anthropic,
    mcp_tools_to_anthropic,
)

logger = logging.getLogger(__name__)


class AnthropicProvider(LLMProvider):
    provider_type = "anthropic"

    def __init__(
        self,
        base_url: str,
        api_key: str,
        **kwargs,
    ):
        self.base_url = base_url
        self.api_key = api_key
        client_kwargs: dict = {"api_key": api_key}
        if base_url:
            client_kwargs["base_url"] = base_url
        self._client = anthropic.Anthropic(**client_kwargs)

    def chat(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        **kwargs,
    ) -> LLMResponse:
        model = kwargs.pop("model", None)
        if not model:
            raise ValueError("未指定模型，请在角色设置中选择一个模型")
        temperature = kwargs.pop("temperature", 1.0)
        max_tokens = kwargs.pop("max_tokens", 2000)
        json_mode = kwargs.pop("json_mode", False)

        system, api_messages = messages_to_anthropic(messages)
        json_prefill = json_mode and not tools
        if json_prefill:
            api_messages = list(api_messages)
            api_messages.append({"role": "assistant", "content": "{"})

        create_kwargs: dict = {
            "model": model,
            "messages": api_messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if system:
            create_kwargs["system"] = system
        if tools:
            create_kwargs["tools"] = mcp_tools_to_anthropic(tools)

        logger.info("Anthropic API 调用开始 (model=%s)", model)
        try:
            response = self._client.messages.create(**create_kwargs)
        except anthropic.APITimeoutError:
            logger.warning("Anthropic API 调用超时 (model=%s)", model, exc_info=True)
            raise
        except Exception:
            logger.exception("Anthropic API 调用失败 (model=%s)", model)
            raise

        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []

        for block in response.content:
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "tool_use":
                tool_calls.append(ToolCall(
                    id=block.id,
                    name=block.name,
                    arguments=block.input if isinstance(block.input, dict) else {},
                ))

        text = "\n".join(text_parts) if text_parts else ""
        if json_prefill and text and not text.lstrip().startswith("{"):
            text = "{" + text

        if tool_calls:
            return LLMResponse(
                text=text if text else None,
                tool_calls=tool_calls,
                finish_reason="tool_use",
            )

        return LLMResponse(
            text=text,
            finish_reason="stop",
        )
