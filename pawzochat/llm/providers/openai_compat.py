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

"""OpenAI-compatible Chat Completions provider.

Covers DeepSeek, OpenAI, SiliconFlow, vLLM, and any other service implementing
the OpenAI Chat Completions API.
"""

from __future__ import annotations

import json
import logging

from openai import APITimeoutError as OpenAITimeoutError, OpenAI

from pawzochat.llm.base import LLMProvider, LLMResponse, ToolCall
from pawzochat.llm.converter import (
    messages_to_openai,
    mcp_tools_to_openai,
)
from pawzochat.utils.llm_json import parse_llm_json

logger = logging.getLogger(__name__)


def _looks_like_sse_stream(text: str) -> bool:
    sample = text.lstrip()[:64]
    return sample.startswith("data:") or sample.startswith("event:")


def _parse_sse_completion(text: str) -> LLMResponse | None:
    """Reassemble an SSE Chat Completions stream into a single LLMResponse.

    Some OpenAI-compatible relays (notably certain grok proxies) emit
    text/event-stream chunks even when stream=False was requested; the OpenAI
    SDK then yields the raw body as a string. This walks ``data:`` lines,
    accumulates ``delta.content`` and ``delta.tool_calls`` across chunks, and
    returns a synthesized response.
    """
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    tool_calls_by_index: dict[int, dict] = {}
    finish_reason: str | None = None
    saw_any_chunk = False

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            chunk = json.loads(payload)
        except json.JSONDecodeError:
            continue
        choices = chunk.get("choices") or []
        for ch in choices:
            saw_any_chunk = True
            delta = ch.get("delta") or {}
            piece = delta.get("content")
            if isinstance(piece, str):
                content_parts.append(piece)
            reasoning_piece = delta.get("reasoning_content")
            if isinstance(reasoning_piece, str):
                reasoning_parts.append(reasoning_piece)
            for tc in delta.get("tool_calls") or []:
                idx = tc.get("index")
                if idx is None:
                    idx = len(tool_calls_by_index)
                slot = tool_calls_by_index.setdefault(idx, {
                    "id": "",
                    "name": "",
                    "arguments": "",
                })
                if tc.get("id"):
                    slot["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    slot["name"] = fn["name"]
                args_piece = fn.get("arguments")
                if isinstance(args_piece, str):
                    slot["arguments"] += args_piece
            if ch.get("finish_reason"):
                finish_reason = ch["finish_reason"]

    if not saw_any_chunk:
        return None

    parsed_tool_calls: list[ToolCall] = []
    for idx in sorted(tool_calls_by_index.keys()):
        slot = tool_calls_by_index[idx]
        if not slot["name"]:
            continue
        args = parse_llm_json(slot["arguments"]) or {}
        parsed_tool_calls.append(ToolCall(
            id=slot["id"] or "",
            name=slot["name"],
            arguments=args,
        ))

    text_out = "".join(content_parts) or None
    reasoning_out = "".join(reasoning_parts) or None
    if parsed_tool_calls:
        return LLMResponse(
            text=text_out,
            tool_calls=parsed_tool_calls,
            finish_reason="tool_use",
            reasoning_content=reasoning_out,
        )
    return LLMResponse(
        text=text_out or "",
        finish_reason=finish_reason or "stop",
        reasoning_content=reasoning_out,
    )


def _is_response_format_unsupported(exc: Exception) -> bool:
    message = str(exc).lower()
    if "response_format" not in message:
        return False
    markers = (
        "unsupported",
        "not support",
        "invalid",
        "unknown",
        "unrecognized",
        "not permitted",
        "不支持",
    )
    return any(marker in message for marker in markers)


def _response_preview(response: object, max_length: int = 1000) -> str:
    text = response if isinstance(response, str) else repr(response)
    if len(text) > max_length:
        return text[:max_length] + "...<truncated>"
    return text


class OpenAICompatProvider(LLMProvider):
    provider_type = "openai_compatible"

    def __init__(
        self,
        base_url: str,
        api_key: str,
        append_chat_path: bool = True,
        **kwargs,
    ):
        self.base_url = base_url
        self.api_key = api_key

        effective_url = base_url
        if not append_chat_path and effective_url.rstrip("/").endswith("/chat/completions"):
            effective_url = effective_url.rstrip("/").removesuffix("/chat/completions")

        self._client = OpenAI(base_url=effective_url, api_key=api_key)

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

        api_messages = messages_to_openai(messages)

        create_kwargs: dict = {
            "model": model,
            "messages": api_messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if json_mode:
            create_kwargs["response_format"] = {"type": "json_object"}

        if tools:
            create_kwargs["tools"] = mcp_tools_to_openai(tools)

        logger.info("OpenAI 兼容 API 调用开始 (model=%s)", model)
        try:
            response = self._client.chat.completions.create(**create_kwargs)
        except OpenAITimeoutError:
            logger.warning("OpenAI 兼容 API 调用超时 (model=%s)", model, exc_info=True)
            raise
        except Exception as exc:
            if json_mode and _is_response_format_unsupported(exc):
                logger.warning(
                    "OpenAI 兼容 API 不支持 response_format，已降级普通调用 (model=%s): %s",
                    model, exc,
                )
                create_kwargs.pop("response_format", None)
                try:
                    response = self._client.chat.completions.create(**create_kwargs)
                except OpenAITimeoutError:
                    logger.warning("OpenAI 兼容 API 调用超时 (model=%s)", model, exc_info=True)
                    raise
                except Exception:
                    logger.exception("OpenAI 兼容 API 调用失败 (model=%s)", model)
                    raise
            else:
                logger.exception("OpenAI 兼容 API 调用失败 (model=%s)", model)
                raise

        if isinstance(response, str) or not hasattr(response, "choices"):
            if isinstance(response, str) and _looks_like_sse_stream(response):
                parsed = _parse_sse_completion(response)
                if parsed is not None:
                    logger.warning(
                        "OpenAI 兼容 API 在非流式请求下返回了 SSE 流，已在本地重组 (model=%s)",
                        model,
                    )
                    return parsed
            logger.error(
                "OpenAI 兼容 API 返回格式异常 (model=%s, type=%s): %s",
                model,
                type(response).__name__,
                _response_preview(response),
            )
            raise RuntimeError("OpenAI 兼容 API 返回格式异常：缺少 choices")

        if not response.choices:
            logger.error(
                "OpenAI 兼容 API 返回空 choices (model=%s): %s",
                model,
                _response_preview(response),
            )
            raise RuntimeError("OpenAI 兼容 API 返回格式异常：choices 为空")

        choice = response.choices[0]
        msg = choice.message

        # Thinking-mode models (DeepSeek v4, some o1-compat proxies) attach a
        # ``reasoning_content`` field next to ``content``. The upstream API
        # rejects the next tool_use iteration unless this is replayed on the
        # assistant message, so capture it here for ChatService to carry.
        reasoning = getattr(msg, "reasoning_content", None)
        if reasoning is not None and not isinstance(reasoning, str):
            reasoning = str(reasoning)

        if msg.tool_calls:
            parsed_calls = []
            for tc in msg.tool_calls:
                args = parse_llm_json(tc.function.arguments) or {}
                parsed_calls.append(ToolCall(
                    id=tc.id,
                    name=tc.function.name,
                    arguments=args,
                ))
            return LLMResponse(
                text=msg.content,
                tool_calls=parsed_calls,
                finish_reason="tool_use",
                reasoning_content=reasoning,
            )

        return LLMResponse(
            text=msg.content or "",
            finish_reason="stop",
            reasoning_content=reasoning,
        )
