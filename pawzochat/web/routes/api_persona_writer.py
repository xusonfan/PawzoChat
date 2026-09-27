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

"""REST API for the 人设编写助手 (Persona Writing Assistant).

One endpoint that turns a one-line request into a draft persona by reusing the
normal chat AI pipeline (``ChatService.generate_persona_draft``), so the
generation transparently gains MCP tools such as 联网搜索. The generation
guidance prompt is a fixed internal constant — it is never exposed to or edited
by the client.
"""

from __future__ import annotations

import json
import logging
import re

from flask import Blueprint, jsonify, request

from pawzochat.llm.manager import ensure_models_list
from pawzochat.web.routes import get_app

logger = logging.getLogger(__name__)

api_persona_writer_bp = Blueprint("api_persona_writer", __name__)

MAX_REQUEST_LEN = 2000

# Internal, hidden generation-guidance prompt. The user never sees or edits
# this — the only "system prompt" the user can edit on the page is the created
# persona's own [系统指令] section. The model is asked to emit a single JSON
# object; ``_parse_persona_draft`` parses it (with a marker-split fallback).
DEFAULT_PERSONA_WRITER_PROMPT = (
    "你是一名专业的角色人设编写助手，服务于一个角色扮演聊天应用。"
    "用户会用一句话描述想要的角色，你需要据此产出一份详尽、准确、可直接用于扮演的人设。\n\n"
    "工作要求：\n"
    "1. 若你具备联网搜索工具，请先搜索查证该作品/游戏/角色的准确信息"
    "（姓名、身份、背景设定、性格、人际关系、口头禅、说话风格等），不要凭空杜撰；"
    "若没有搜索工具、查不到，亦或者搜索工具调用失败，则直接基于你已有的知识合理创作。\n"
    "2. 全部使用中文。\n"
    "3. 最终只输出一个 json 对象，不要输出任何额外文字、说明或前言，"
    "也不要用 Markdown 代码块（``` ）包裹。该 json 对象结构如下：\n"
    "{\n"
    '  "name": "建议的角色名称（简短，例如「雷电将军」）",\n'
    '  "character_prompt": "详尽的人设设定（中文）：姓名、身份、年龄、外貌、性格、'
    '成长背景、价值观、人际关系、兴趣爱好、典型行为与说话风格等，尽量丰富立体",\n'
    '  "output_examples": ["该角色平时说话的示例", "至少 5 条", "……"]\n'
    "}\n\n"
    "其中 output_examples 的硬性要求：必须是字符串数组，至少包含 5 条；"
    "每一条都用反斜线（\\）分隔其中的短句或短语；"
    "不要使用句号、逗号等标点，不要用括号描写动作或心理，只写角色会说出口的话，"
    "并贴合该角色的语气与口吻。例如其中一条可以是 \"你已觉悟\\无需多言\"。"
)

_CHAR_MARKERS = ("[人设设定]", "【人设设定】")
_EXAMPLE_MARKERS = ("[输出示例]", "【输出示例】")


def _payload_text(data: dict, key: str) -> str:
    """Read a request field as stripped text, accepting strings only."""
    value = data.get(key)
    return value.strip() if isinstance(value, str) else ""


def _configured_model_exists(app, provider: str, model: str) -> bool:
    """Return whether *model* is configured under *provider*.

    The front end only offers configured models, but the API must enforce the
    same boundary so a crafted request cannot spend the user's provider key on
    an arbitrary model name.
    """
    providers_cfg = app.config.get("llm_providers", default={}) or {}
    provider_cfg = providers_cfg.get(provider)
    if not isinstance(provider_cfg, dict):
        return False
    return any(m.get("id") == model for m in ensure_models_list(provider_cfg))


def _split_sections(text: str) -> tuple[str, str]:
    """Split raw model text into ``(character_prompt, output_examples)``.

    Locates the 输出示例 marker, takes everything before it (minus a leading
    人设设定 marker) as the character prompt and everything after as the
    examples. Falls back to putting the whole text into ``character_prompt``
    when no 输出示例 marker is present.
    """
    raw = (text or "").strip()
    if not raw:
        return "", ""

    ex_idx = -1
    ex_marker = ""
    for marker in _EXAMPLE_MARKERS:
        i = raw.find(marker)
        if i != -1 and (ex_idx == -1 or i < ex_idx):
            ex_idx, ex_marker = i, marker

    if ex_idx == -1:
        char_part, ex_part = raw, ""
    else:
        char_part = raw[:ex_idx]
        ex_part = raw[ex_idx + len(ex_marker):]

    char_part = char_part.strip()
    for marker in _CHAR_MARKERS:
        if char_part.startswith(marker):
            char_part = char_part[len(marker):].strip()
            break

    return char_part.strip(), ex_part.strip()


def _loose_json_loads(s: str):
    """``json.loads`` tolerant of two common LLM mistakes:

    1. raw control characters (newlines/tabs) inside string values —
       handled by ``strict=False``;
    2. lone backslashes the model writes as separators but does not escape —
       our desired ``output_examples`` format itself uses ``\\``, so the model
       naturally emits invalid JSON like ``"你已觉悟\\无需多言"``. We escape any
       backslash not already starting a valid JSON escape, then re-parse.

    Returns the parsed value or ``None``.
    """
    try:
        return json.loads(s, strict=False)
    except Exception:
        pass
    # Walk the string: keep valid escape sequences (\", \\, \n, \uXXXX, …)
    # intact and double every *other* lone backslash. Matching valid escapes
    # atomically avoids corrupting an already-escaped "\\" that precedes a
    # non-escape char.
    repaired = re.sub(
        r'\\(["\\/bfnrtu])|\\',
        lambda m: m.group(0) if m.group(1) else "\\\\",
        s,
    )
    try:
        return json.loads(repaired, strict=False)
    except Exception:
        return None


def _extract_json_object(text: str):
    """Best-effort extraction of a JSON object from a model reply.

    Tolerates ```json fences and leading/trailing prose by falling back to the
    outermost ``{ … }`` span. Returns the parsed object or ``None``.
    """
    s = (text or "").strip()
    if not s:
        return None
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z0-9_]*\s*", "", s)
        s = re.sub(r"\s*```$", "", s).strip()
    obj = _loose_json_loads(s)
    if obj is not None:
        return obj
    start, end = s.find("{"), s.rfind("}")
    if 0 <= start < end:
        return _loose_json_loads(s[start:end + 1])
    return None


def _parse_persona_draft(raw: str) -> tuple[str, str, str]:
    """Parse the model output into ``(name, character_prompt, output_examples)``.

    JSON-first: the generation prompt asks the model to emit a single JSON
    object ``{name, character_prompt, output_examples[]}``. If JSON parsing
    fails entirely we fall back to the ``[人设设定]`` / ``[输出示例]`` marker
    split so a stray non-JSON reply never hard-fails the assistant.
    """
    obj = _extract_json_object(raw)
    if isinstance(obj, dict):
        # JSON parsed → trust string fields only. Coerce anything else the
        # model slips in (a list/dict for name/prompt, a dict as an example)
        # to empty so a Python repr like "['x']" never leaks into the persona.
        # Cap the suggested name to the persona-name limit so it prefills cleanly.
        name_val = obj.get("name")
        name = name_val.strip()[:100] if isinstance(name_val, str) else ""
        cp_val = obj.get("character_prompt")
        character_prompt = cp_val.strip() if isinstance(cp_val, str) else ""
        examples = obj.get("output_examples")
        if isinstance(examples, list):
            lines = []
            for item in examples:
                # Each example may be a "短句\短句" string or a list of phrases
                # we join with "\" ourselves (lets the model avoid backslashes).
                if isinstance(item, list):
                    phrases = [p.strip() for p in item if isinstance(p, str) and p.strip()]
                    if phrases:
                        lines.append("\\".join(phrases))
                elif isinstance(item, str) and item.strip():
                    lines.append(item.strip())
            output_examples = "\n".join(lines)
        else:
            output_examples = examples.strip() if isinstance(examples, str) else ""
        return name, character_prompt, output_examples

    # JSON parsing failed entirely → legacy ``[人设设定]`` / ``[输出示例]`` split.
    # The prompt asks for pure JSON, so reaching here means the model misbehaved
    # and the draft may be degraded — log it so operators can spot bad models.
    logger.warning(
        "人设编写助手：模型未返回有效 JSON，回退到标记分段解析（raw 前120字=%r）",
        (raw or "")[:120],
    )
    character_prompt, output_examples = _split_sections(raw)
    return "", character_prompt, output_examples


@api_persona_writer_bp.route("/generate", methods=["POST"])
def generate():
    app = get_app()
    payload = request.get_json(force=True, silent=True)
    data = payload if isinstance(payload, dict) else {}
    provider = _payload_text(data, "provider")
    model = _payload_text(data, "model")
    user_request = _payload_text(data, "request")

    if not provider or not model:
        return jsonify({"error": "请先选择服务商与模型"}), 400
    if not user_request:
        return jsonify({"error": "请输入生成需求"}), 400
    if len(user_request) > MAX_REQUEST_LEN:
        return jsonify({"error": f"需求描述过长（最多 {MAX_REQUEST_LEN} 字）"}), 400
    if app.chat_service is None:
        return jsonify({"error": "对话服务尚未就绪"}), 503
    if app.llm_manager.get_provider(provider) is None:
        return jsonify({
            "error": f"服务商「{provider}」不可用，请检查服务商配置与 API Key",
        }), 400
    if not _configured_model_exists(app, provider, model):
        return jsonify({
            "error": f"模型「{model}」不在服务商「{provider}」的已配置模型列表中",
        }), 400

    try:
        raw = app.chat_service.generate_persona_draft(
            provider=provider,
            model=model,
            system_prompt=DEFAULT_PERSONA_WRITER_PROMPT,
            user_request=user_request,
        )
    except Exception:  # model not configured / provider unavailable / tool loop limit exceeded, etc.
        logger.exception(
            "人设编写助手生成失败 provider=%s model=%s", provider, model,
        )
        # Don't echo the raw exception text back to the client (it may contain
        # internal paths/provider details); the details are already logged, so
        # this only gives an actionable generic hint.
        return jsonify({"error": "生成失败，请检查所选模型与服务商配置后重试"}), 500

    if not (raw or "").strip():
        return jsonify({"error": "模型未返回内容，请重试或更换模型"}), 502

    name, character_prompt, output_examples = _parse_persona_draft(raw)
    return jsonify({
        "ok": True,
        "name": name,
        "character_prompt": character_prompt,
        "output_examples": output_examples,
    })
