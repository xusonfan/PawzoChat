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

"""Tolerant JSON extraction for LLM responses.

LLMs frequently wrap JSON in markdown code fences, prefix it with explanatory
text, or emit string literals containing raw newlines / tabs / stray
backslashes that vanilla json.loads rejects. parse_llm_json walks through a
sequence of progressively more aggressive recovery strategies and returns the
first dict that decodes successfully, or None.
"""

from __future__ import annotations

import json
import re

__all__ = ["parse_llm_json"]


def parse_llm_json(text: str | None) -> dict | None:
    """Extract a top-level JSON object from an LLM response.

    Tolerates:
      - surrounding markdown code fences (```json ... ``` / ``` ... ```)
      - leading/trailing explanatory text
      - unescaped newlines/tabs and stray backslashes inside string literals

    Returns the decoded dict, or None if no recoverable JSON object is found.
    Non-dict top-level values (lists, scalars) are also reported as None so
    callers can use a single ``if not result`` guard.
    """
    if not text:
        return None
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()

    # 1) Fast path: the whole response is valid JSON.
    result = _try_loads_dict(text)
    if result is not None:
        return result

    # 2) Strip markdown fence and retry.
    unfenced = _strip_markdown_fence(text)
    if unfenced != text:
        result = _try_loads_dict(unfenced)
        if result is not None:
            return result
        text = unfenced

    # 3) Remove leading reasoning blocks and retry. Reasoning models may emit
    # <think>...</think> before the JSON, and braces inside that block confuse
    # the balanced-object extractor below.
    without_think = _strip_leading_think_block(text)
    if without_think != text:
        result = _try_loads_dict(without_think)
        if result is not None:
            return result
        text = without_think

    # 4) Extract the first balanced {...} object.
    candidate = _extract_first_object(text)
    if not candidate:
        return None
    result = _try_loads_dict(candidate)
    if result is not None:
        return result

    # 5) Sanitize escape problems and try once more.
    return _try_loads_dict(_sanitize_string_literals(candidate))


_TRAILING_COMMA = re.compile(r",\s*([}\]])")


def _try_loads_dict(text: str) -> dict | None:
    try:
        obj = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        # Retry after stripping trailing commas: {"k": "v",} -> {"k": "v"}
        try:
            obj = json.loads(_TRAILING_COMMA.sub(r"\1", text))
        except (json.JSONDecodeError, ValueError):
            return None
    return obj if isinstance(obj, dict) else None


_FENCE_FULL = re.compile(
    r"^```[ \t]*[A-Za-z0-9_+-]*[ \t]*\n(.*?)\n?```[ \t]*$", re.DOTALL
)
_FENCE_OPEN = re.compile(
    r"^```[ \t]*[A-Za-z0-9_+-]*[ \t]*\n(.*)$", re.DOTALL
)
_FENCE_TAIL = re.compile(r"\n?```[ \t]*$")


def _strip_markdown_fence(text: str) -> str:
    """Remove an outer ```lang ... ``` / ``` ... ``` fence if present."""
    m = _FENCE_FULL.match(text)
    if m:
        return m.group(1).strip()
    m = _FENCE_OPEN.match(text)
    if m:
        return _FENCE_TAIL.sub("", m.group(1)).strip()
    return text


_LEADING_THINK_BLOCK = re.compile(
    r"^\s*<think\b[^>]*>.*?</think>\s*", re.DOTALL | re.IGNORECASE
)
_THINK_CLOSE = re.compile(r"</think>", re.IGNORECASE)


def _strip_leading_think_block(text: str) -> str:
    """Remove leading reasoning traces before JSON extraction."""
    stripped = text
    while True:
        next_text = _LEADING_THINK_BLOCK.sub("", stripped, count=1)
        if next_text == stripped:
            break
        stripped = next_text

    # Some compatible endpoints return a dangling closing tag or truncate the
    # opening tag; strip it only when the tail looks like the actual payload.
    m = _THINK_CLOSE.search(stripped)
    if m:
        tail = stripped[m.end():].lstrip()
        if tail.startswith("{") or tail.startswith("```"):
            stripped = tail
    return stripped.strip()


def _extract_first_object(text: str) -> str | None:
    """Return the first balanced ``{...}`` substring.

    Walks character by character tracking string literal state and backslash
    escapes so braces inside string values don't affect depth. If braces never
    balance (truncated response) returns the tail from the first '{' as a
    best-effort candidate for downstream sanitization.
    """
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return text[start:]


_VALID_ESCAPES = set('"\\/bfnrtu')


def _sanitize_string_literals(text: str) -> str:
    """Fix common escape problems inside JSON string literals.

    While inside a string:
      - replace raw newline / carriage return / tab with their escaped forms
      - if a backslash is not followed by a valid JSON escape char
        ("\\/bfnrtu), double it to ``\\\\``
    Outside strings, characters pass through unchanged so structural
    whitespace and separators stay intact.
    """
    out: list[str] = []
    in_string = False
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if not in_string:
            if ch == '"':
                in_string = True
            out.append(ch)
            i += 1
            continue
        # inside a string literal
        if ch == '"':
            in_string = False
            out.append(ch)
            i += 1
            continue
        if ch == '\\':
            nxt = text[i + 1] if i + 1 < n else ''
            if nxt in _VALID_ESCAPES:
                out.append(ch)
                out.append(nxt)
                i += 2
            else:
                out.append('\\\\')
                i += 1
            continue
        if ch == '\n':
            out.append('\\n')
        elif ch == '\r':
            out.append('\\r')
        elif ch == '\t':
            out.append('\\t')
        else:
            out.append(ch)
        i += 1
    return ''.join(out)
