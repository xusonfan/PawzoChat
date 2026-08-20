# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Transactional persona administration primitives shared by admin APIs."""

from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import shutil
import uuid
from pathlib import Path
from typing import Any

from PIL import Image

from pawzochat.core.config import DEFAULT_SYSTEM_INSTRUCTIONS
from pawzochat.image.reference import (
    CUSTOM_REFERENCE_DIRNAME,
    CUSTOM_REFERENCE_FILENAME,
    save_custom_reference_image,
)
from pawzochat.paths import CHATS_DIR, PROMPT_TEMPLATES_PATH
from pawzochat.services import bundle as bundle_mod
from pawzochat.services import card_parser, persona_card
from pawzochat.transport.models import (
    PROACTIVE_DEFAULTS,
    normalize_image_generation,
    normalize_voice_generation,
)

PROMPT_FIELDS = frozenset({
    "character_prompt", "output_examples", "system_instructions",
})
PROMPT_MODES = frozenset({"overwrite", "prepend", "append", "replace", "template"})
TOOL_POLICY_MODES = frozenset({"all", "none", "whitelist", "blacklist"})

TOP_LEVEL_FIELDS = frozenset({
    "enabled", "name", "signature", "llm_provider", "llm_model",
    "temperature", "max_tokens", "emoji_enabled",
    "emoji_send_probability", "emoji_group",
})
NESTED_FIELDS = {
    "tool_policy": frozenset({"mode", "list", "max_iterations", "timeout_seconds"}),
    "memory": frozenset({
        "enabled", "max_memories", "include_in_prompt", "trigger_rounds", "trigger_mode",
    }),
    "proactive": frozenset({
        "enabled", "min_idle_hours", "max_idle_hours", "max_consecutive", "prompt",
        "quiet_hours.enabled", "quiet_hours.start", "quiet_hours.end",
    }),
    "image_generation": frozenset({
        "enabled", "provider", "model", "style_prefix", "art_style",
        "negative_prompt", "negative_enabled", "ref_mode",
    }),
    "voice_generation": frozenset({"enabled", "provider", "model", "voice", "speed"}),
}


class PersonaManagementError(ValueError):
    """A user-facing validation or optimistic-concurrency error."""

    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def persona_is_enabled(config, persona_id: str) -> bool:
    raw = (config.get("personas", default={}) or {}).get(persona_id)
    return bool(raw is not None and raw.get("enabled", True))


def _deep_get(data: dict, path: str, default=None):
    node: Any = data
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return default
        node = node[part]
    return node


def _deep_set(data: dict, path: str, value: Any) -> None:
    parts = path.split(".")
    node = data
    for part in parts[:-1]:
        child = node.get(part)
        if not isinstance(child, dict):
            child = {}
            node[part] = child
        node = child
    node[parts[-1]] = value


def _json_clone(value):
    return copy.deepcopy(value)


def _config_version(personas: dict, prompts: dict[str, dict], moments: dict) -> str:
    payload = json.dumps(
        {"personas": personas, "prompts": prompts, "moments": moments},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:20]


def _prompt_transform(current: str, operation: dict, persona: dict, persona_id: str) -> str:
    mode = str(operation.get("mode") or "")
    if mode not in PROMPT_MODES:
        raise PersonaManagementError(f"不支持的提示词操作：{mode}")
    value = str(operation.get("value") or "")
    if mode == "replace":
        needle = str(operation.get("find") or "")
        if not needle:
            raise PersonaManagementError("查找替换必须填写查找内容")
        return current.replace(needle, value)
    if mode == "prepend":
        separator = str(operation.get("separator", "\n") or "")
        return value + (separator if value and current else "") + current
    if mode == "append":
        separator = str(operation.get("separator", "\n") or "")
        return current + (separator if value and current else "") + value
    if mode == "template":
        variables = {
            "{{id}}": persona_id,
            "{{name}}": str(persona.get("name") or persona_id),
            "{{signature}}": str(persona.get("signature") or ""),
        }
        for marker, replacement in variables.items():
            value = value.replace(marker, replacement)
    return value


def _coerce_scalar(path: str, value: Any) -> Any:
    boolean_fields = {
        "enabled", "emoji_enabled", "memory.enabled", "memory.include_in_prompt",
        "proactive.enabled", "proactive.quiet_hours.enabled", "image_generation.enabled",
        "image_generation.negative_enabled", "voice_generation.enabled",
    }
    integer_fields = {
        "max_tokens", "emoji_send_probability", "memory.max_memories",
        "memory.trigger_rounds", "proactive.max_consecutive",
        "tool_policy.max_iterations", "tool_policy.timeout_seconds",
    }
    float_fields = {"temperature", "proactive.min_idle_hours", "proactive.max_idle_hours", "voice_generation.speed"}
    list_fields = {"tool_policy.list"}
    if path in boolean_fields:
        if isinstance(value, bool):
            return value
        if value in (1, "1", "true", "True"):
            return True
        if value in (0, "0", "false", "False"):
            return False
        raise PersonaManagementError(f"字段 {path} 必须是布尔值")
    try:
        if path in integer_fields:
            return int(value)
        if path in float_fields:
            return float(value)
    except (TypeError, ValueError) as exc:
        raise PersonaManagementError(f"字段 {path} 的数值无效") from exc
    if path in list_fields:
        if not isinstance(value, list):
            raise PersonaManagementError(f"字段 {path} 必须是列表")
        return [str(item) for item in value if str(item).strip()]
    return str(value or "")


def _validate_path(path: str) -> None:
    if path in TOP_LEVEL_FIELDS:
        return
    root, _, nested = path.partition(".")
    if root in NESTED_FIELDS and nested in NESTED_FIELDS[root]:
        return
    raise PersonaManagementError(f"不允许批量修改字段：{path}")


def _validate_persona(app, persona_id: str, cfg: dict, all_personas: dict) -> None:
    name = str(cfg.get("name") or "").strip()
    if not name:
        raise PersonaManagementError(f"人物 {persona_id} 的名称不能为空")
    if len(name) > 100:
        raise PersonaManagementError(f"人物「{name[:20]}」的名称超过 100 个字符")
    signature = str(cfg.get("signature") or "").strip()
    if len(signature) > 100:
        raise PersonaManagementError(f"人物「{name}」的签名超过 100 个字符")
    cfg["name"] = name
    cfg["signature"] = signature

    try:
        temperature = float(cfg.get("temperature", 1.0))
        max_tokens = int(cfg.get("max_tokens", 2000))
        probability = int(cfg.get("emoji_send_probability", 25))
    except (TypeError, ValueError) as exc:
        raise PersonaManagementError(f"人物「{name}」的模型或表情参数无效") from exc
    if not 0 <= temperature <= 2:
        raise PersonaManagementError(f"人物「{name}」的温度必须在 0 到 2 之间")
    if not 1 <= max_tokens <= 1_000_000:
        raise PersonaManagementError(f"人物「{name}」的最大令牌数无效")
    if not 0 <= probability <= 100:
        raise PersonaManagementError(f"人物「{name}」的表情发送概率必须在 0 到 100 之间")
    cfg.update(temperature=temperature, max_tokens=max_tokens, emoji_send_probability=probability)

    provider_name = str(cfg.get("llm_provider") or "")
    model_name = str(cfg.get("llm_model") or "")
    providers = app.config.get("llm_providers", default={}) or {}
    if provider_name and provider_name not in providers:
        raise PersonaManagementError(f"人物「{name}」引用了不存在的 LLM 服务商")
    if provider_name and model_name:
        model_ids = {
            str(model.get("id") or "") for model in providers[provider_name].get("models", [])
            if isinstance(model, dict)
        }
        if model_ids and model_name not in model_ids:
            raise PersonaManagementError(f"人物「{name}」引用了不存在的 LLM 模型")

    memory = cfg.setdefault("memory", {})
    trigger_mode = memory.get("trigger_mode", "remind")
    if trigger_mode not in ("remind", "summarize"):
        raise PersonaManagementError(f"人物「{name}」的记忆触发模式无效")
    memory["max_memories"] = max(1, int(memory.get("max_memories", 50)))
    memory["trigger_rounds"] = max(0, int(memory.get("trigger_rounds", 10)))

    proactive = cfg.setdefault("proactive", copy.deepcopy(PROACTIVE_DEFAULTS))
    minimum = float(proactive.get("min_idle_hours", 1.0))
    maximum = float(proactive.get("max_idle_hours", 3.0))
    if minimum < 0 or maximum < minimum:
        raise PersonaManagementError(f"人物「{name}」的主动消息时间范围无效")
    proactive["min_idle_hours"] = minimum
    proactive["max_idle_hours"] = maximum
    proactive["max_consecutive"] = max(1, int(proactive.get("max_consecutive", 3)))

    tool_policy = cfg.setdefault("tool_policy", {})
    if tool_policy.get("mode", "all") not in TOOL_POLICY_MODES:
        raise PersonaManagementError(f"人物「{name}」的工具策略无效")
    tool_policy["max_iterations"] = max(1, int(tool_policy.get("max_iterations", 10)))
    tool_policy["timeout_seconds"] = max(1, int(tool_policy.get("timeout_seconds", 30)))
    tool_policy["list"] = list(tool_policy.get("list") or [])

    image_cfg = normalize_image_generation(cfg.get("image_generation"))
    if image_cfg["enabled"]:
        image_providers = app.config.get("image_providers", default={}) or {}
        provider = image_providers.get(image_cfg["provider"])
        if not provider:
            raise PersonaManagementError(f"人物「{name}」的生图服务商无效")
        model_ids = {str(model.get("id") or "") for model in provider.get("models", []) if isinstance(model, dict)}
        if not image_cfg["model"] or (model_ids and image_cfg["model"] not in model_ids):
            raise PersonaManagementError(f"人物「{name}」的生图模型无效")
    cfg["image_generation"] = image_cfg

    voice_cfg = normalize_voice_generation(cfg.get("voice_generation"))
    if voice_cfg["enabled"]:
        voice_providers = app.config.get("voice_providers", default={}) or {}
        provider = voice_providers.get(voice_cfg["provider"])
        if not provider:
            raise PersonaManagementError(f"人物「{name}」的语音服务商无效")
        model_ids = {str(model.get("id") or "") for model in provider.get("models", []) if isinstance(model, dict)}
        if not voice_cfg["model"] or (model_ids and voice_cfg["model"] not in model_ids):
            raise PersonaManagementError(f"人物「{name}」的语音模型无效")
    cfg["voice_generation"] = voice_cfg

    books = cfg.get("bound_worldbooks") or []
    if not isinstance(books, list):
        raise PersonaManagementError(f"人物「{name}」的世界书绑定必须是列表")
    existing_books = {str(book.get("name") or "") for book in app.worldbook_service.list_books()}
    unknown = [book for book in books if book not in existing_books]
    if unknown:
        raise PersonaManagementError(f"人物「{name}」绑定了不存在的世界书：{'、'.join(unknown)}")
    cfg["bound_worldbooks"] = list(dict.fromkeys(str(book) for book in books))

    duplicate = [pid for pid, other in all_personas.items() if pid != persona_id and other.get("name") == name]
    if duplicate:
        raise PersonaManagementError(f"人物名称「{name}」重复")


def _serialize_persona(persona, raw: dict, moments: dict) -> dict:
    persona_id = persona.id
    return {
        "id": persona_id,
        "enabled": bool(raw.get("enabled", True)),
        "name": persona.name,
        "signature": persona.signature,
        "llm_provider": persona.llm_provider,
        "llm_model": persona.llm_model,
        "temperature": persona.temperature,
        "max_tokens": persona.max_tokens,
        "character_prompt": persona.character_prompt,
        "output_examples": persona.output_examples,
        "system_instructions": persona.system_instructions,
        "emoji_enabled": persona.emoji_enabled,
        "emoji_send_probability": persona.emoji_send_probability,
        "emoji_group": persona.emoji_group,
        "tool_policy": _json_clone(persona.tool_policy),
        "memory": _json_clone(persona.memory),
        "proactive": _json_clone(persona.proactive),
        "image_generation": _json_clone(persona.image_generation),
        "voice_generation": _json_clone(persona.voice_generation),
        "bound_worldbooks": list(persona.bound_worldbooks),
        "moments": {
            "publisher": persona_id in (moments.get("publishers") or []),
            "replier": persona_id in (moments.get("repliers") or []),
            "reply_probability": int((moments.get("reply_probabilities") or {}).get(persona_id, 50)),
            "memory_enabled": bool((moments.get("memory_enabled") or {}).get(persona_id, True)),
        },
    }


def _card_config(result, name: str) -> dict:
    memory = result.memory or {
        "enabled": True,
        "max_memories": 50,
        "include_in_prompt": True,
        "trigger_rounds": 10,
        "trigger_mode": "remind",
    }
    proactive = result.proactive or copy.deepcopy(PROACTIVE_DEFAULTS)
    image_generation = normalize_image_generation(result.image_generation)
    if result.reference_image_png is not None:
        image_generation["ref_mode"] = "custom"
        image_generation["custom_ref_filename"] = CUSTOM_REFERENCE_FILENAME
    return {
        "enabled": True,
        "name": name,
        "signature": "",
        "llm_provider": result.llm_provider,
        "llm_model": result.llm_model,
        "temperature": float(result.temperature),
        "max_tokens": int(result.max_tokens),
        "emoji_enabled": bool(result.emoji_enabled),
        "emoji_send_probability": int(result.emoji_send_probability),
        "emoji_group": result.emoji_group,
        "memory": memory,
        "proactive": proactive,
        "tool_policy": result.tool_policy or {
            "mode": "all", "list": [], "max_iterations": 10, "timeout_seconds": 30,
        },
        "image_generation": image_generation,
        "voice_generation": normalize_voice_generation({}),
        "bound_worldbooks": [],
    }


def _save_avatar(persona_id: str, raw: bytes) -> None:
    with Image.open(io.BytesIO(raw)) as image:
        image = image.convert("RGBA")
        width, height = image.size
        side = min(width, height)
        left = (width - side) // 2
        top = (height - side) // 2
        image = image.crop((left, top, left + side, top + side))
        image = image.resize((256, 256), Image.LANCZOS)
        target = CHATS_DIR / persona_id / "avatar.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        image.save(target, "PNG")


def _save_moments_cover(persona_id: str, raw: bytes) -> None:
    with Image.open(io.BytesIO(raw)) as image:
        image.load()
        image = image.convert("RGBA" if image.mode in ("RGBA", "LA") else "RGB")
        target = CHATS_DIR / persona_id / "moments-cover.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        image.save(target, "PNG")


class PersonaManagementService:
    def __init__(self, app):
        self.app = app

    def version(self) -> str:
        with self.app.config.lock:
            personas = _json_clone(self.app.config.get("personas", default={}) or {})
            prompts = {pid: self.app.config._read_prompt_file(pid) for pid in personas}
            moments = _json_clone(self.app.config.get("moments", default={}) or {})
            return _config_version(personas, prompts, moments)

    def list_personas(self) -> list[dict]:
        raw_personas = self.app.config.get("personas", default={}) or {}
        moments = self.app.config.get("moments", default={}) or {}
        result = []
        for persona_id, persona in self.app.config.load_personas().items():
            raw = raw_personas.get(persona_id, {})
            result.append({
                "id": persona_id,
                "enabled": bool(raw.get("enabled", True)),
                "name": persona.name,
                "signature": persona.signature,
                "llm_provider": persona.llm_provider,
                "llm_model": persona.llm_model,
                "memory_enabled": bool(persona.memory.get("enabled", True)),
                "emoji_enabled": persona.emoji_enabled,
                "image_enabled": bool(persona.image_generation.get("enabled")),
                "voice_enabled": bool(persona.voice_generation.get("enabled")),
                "proactive_enabled": bool(persona.proactive.get("enabled")),
                "bound_worldbooks": list(persona.bound_worldbooks),
                "moments_publisher": persona_id in (moments.get("publishers") or []),
                "moments_replier": persona_id in (moments.get("repliers") or []),
                "has_avatar": (CHATS_DIR / persona_id / "avatar.png").is_file(),
            })
        return sorted(result, key=lambda item: (item["name"].casefold(), item["id"]))

    def get_persona(self, persona_id: str) -> dict:
        personas = self.app.config.load_personas()
        persona = personas.get(persona_id)
        if persona is None:
            raise PersonaManagementError("人物不存在", status_code=404)
        raw = (self.app.config.get("personas", default={}) or {}).get(persona_id, {})
        moments = self.app.config.get("moments", default={}) or {}
        return _serialize_persona(persona, raw, moments)

    def catalogs(self) -> dict:
        def providers(section: str) -> list[dict]:
            output = []
            for name, cfg in (self.app.config.get(section, default={}) or {}).items():
                output.append({
                    "name": name,
                    "models": [
                        {key: model.get(key) for key in ("id", "name", "voices") if key in model}
                        for model in (cfg.get("models") or []) if isinstance(model, dict)
                    ],
                })
            return output

        return {
            "llm_providers": providers("llm_providers"),
            "image_providers": providers("image_providers"),
            "voice_providers": providers("voice_providers"),
            "worldbooks": [book.get("name", "") for book in self.app.worldbook_service.list_books()],
            "default_system_instructions": DEFAULT_SYSTEM_INSTRUCTIONS,
        }

    def create_persona(
        self,
        data: dict,
        *,
        avatar: bytes | None = None,
        moments_cover: bytes | None = None,
    ) -> dict:
        """Validate and persist a new persona as one configuration transaction."""
        if not isinstance(data, dict):
            raise PersonaManagementError("人物数据必须是对象")

        memory_input = data.get("memory") if isinstance(data.get("memory"), dict) else {}
        proactive_input = data.get("proactive") if isinstance(data.get("proactive"), dict) else {}
        quiet_input = (
            proactive_input.get("quiet_hours")
            if isinstance(proactive_input.get("quiet_hours"), dict)
            else {}
        )
        tool_input = data.get("tool_policy") if isinstance(data.get("tool_policy"), dict) else {}
        image_cfg = normalize_image_generation(data.get("image_generation"))
        voice_cfg = normalize_voice_generation(data.get("voice_generation"))
        worldbooks = data.get("bound_worldbooks", [])
        if not isinstance(worldbooks, list):
            raise PersonaManagementError("世界书绑定必须是列表")

        config = {
            "enabled": _coerce_scalar("enabled", data.get("enabled", True)),
            "name": str(data.get("name") or ""),
            "signature": str(data.get("signature") or ""),
            "llm_provider": str(data.get("llm_provider") or ""),
            "llm_model": str(data.get("llm_model") or ""),
            "temperature": data.get("temperature", 1.0),
            "max_tokens": data.get("max_tokens", 2000),
            "emoji_enabled": _coerce_scalar("emoji_enabled", data.get("emoji_enabled", False)),
            "emoji_send_probability": data.get("emoji_send_probability", 25),
            "emoji_group": str(data.get("emoji_group") or ""),
            "tool_policy": {
                "mode": tool_input.get("mode", "all"),
                "list": list(tool_input.get("list") or []),
                "max_iterations": tool_input.get("max_iterations", 10),
                "timeout_seconds": tool_input.get("timeout_seconds", 30),
            },
            "memory": {
                "enabled": memory_input.get("enabled", True),
                "max_memories": memory_input.get("max_memories", 50),
                "include_in_prompt": memory_input.get("include_in_prompt", True),
                "trigger_rounds": memory_input.get("trigger_rounds", 10),
                "trigger_mode": memory_input.get("trigger_mode", "remind"),
            },
            "proactive": {
                "enabled": proactive_input.get("enabled", PROACTIVE_DEFAULTS["enabled"]),
                "min_idle_hours": proactive_input.get("min_idle_hours", PROACTIVE_DEFAULTS["min_idle_hours"]),
                "max_idle_hours": proactive_input.get("max_idle_hours", PROACTIVE_DEFAULTS["max_idle_hours"]),
                "max_consecutive": proactive_input.get("max_consecutive", PROACTIVE_DEFAULTS["max_consecutive"]),
                "prompt": proactive_input.get("prompt", PROACTIVE_DEFAULTS["prompt"]),
                "quiet_hours": {
                    "enabled": quiet_input.get("enabled", PROACTIVE_DEFAULTS["quiet_hours"]["enabled"]),
                    "start": quiet_input.get("start", PROACTIVE_DEFAULTS["quiet_hours"]["start"]),
                    "end": quiet_input.get("end", PROACTIVE_DEFAULTS["quiet_hours"]["end"]),
                },
            },
            "image_generation": image_cfg,
            "voice_generation": voice_cfg,
            "bound_worldbooks": [str(name) for name in worldbooks],
        }
        prompts = {
            "character_prompt": str(data.get("character_prompt") or ""),
            "output_examples": str(data.get("output_examples") or ""),
            "system_instructions": str(data.get("system_instructions") or DEFAULT_SYSTEM_INSTRUCTIONS),
        }

        with self.app.config.lock:
            personas = _json_clone(self.app.config.get("personas", default={}) or {})
            persona_id = uuid.uuid4().hex[:8]
            while persona_id in personas:
                persona_id = uuid.uuid4().hex[:8]
            personas[persona_id] = config
            try:
                _validate_persona(self.app, persona_id, config, personas)
            except PersonaManagementError as exc:
                if "名称「" in str(exc) and "重复" in str(exc):
                    exc.status_code = 409
                raise

            persisted_image_cfg = config["image_generation"]
            prompts.update({
                "image_style_prefix": persisted_image_cfg.get("style_prefix", ""),
                "image_art_style": persisted_image_cfg.get("art_style", ""),
                "image_negative_prompt": persisted_image_cfg.get("negative_prompt", ""),
            })
            for key in ("style_prefix", "art_style", "negative_prompt"):
                persisted_image_cfg.pop(key, None)

            old_config = _json_clone(self.app.config._data)
            prompt_path = self.app.config.prompt_path(persona_id)
            try:
                self.app.config._atomic_write_prompt_file(persona_id, prompts)
                if avatar:
                    _save_avatar(persona_id, avatar)
                if moments_cover:
                    _save_moments_cover(persona_id, moments_cover)
                self.app.config._data["personas"] = personas
                moments = self.app.config._data.setdefault("moments", {})
                for key in ("publishers", "repliers"):
                    members = moments.setdefault(key, [])
                    if persona_id not in members:
                        members.append(persona_id)
                self.app.config.save()
            except Exception:
                self.app.config._data = old_config
                if prompt_path.is_file():
                    prompt_path.unlink()
                shutil.rmtree(CHATS_DIR / persona_id, ignore_errors=True)
                raise

        return {"ok": True, "id": persona_id, "name": config["name"]}

    def _build_batch(self, persona_ids: list[str], operations: list[dict]) -> dict:
        if not persona_ids:
            raise PersonaManagementError("请至少选择一个人物")
        if not operations:
            raise PersonaManagementError("请至少添加一个批量操作")
        ids = list(dict.fromkeys(str(pid) for pid in persona_ids))
        personas = _json_clone(self.app.config.get("personas", default={}) or {})
        missing = [pid for pid in ids if pid not in personas]
        if missing:
            raise PersonaManagementError(f"人物不存在：{'、'.join(missing)}", status_code=404)
        prompts = {pid: self.app.config._read_prompt_file(pid) for pid in personas}
        moments = _json_clone(self.app.config.get("moments", default={}) or {})
        version = _config_version(personas, prompts, moments)
        for persona_id in ids:
            image_cfg = dict(personas[persona_id].get("image_generation") or {})
            image_cfg.update(self.app.config._load_image_prompt_overrides(persona_id))
            personas[persona_id]["image_generation"] = image_cfg
        before_personas = _json_clone(personas)
        before_prompts = _json_clone(prompts)
        before_moments = _json_clone(moments)

        for operation in operations:
            kind = str(operation.get("kind") or "")
            if kind == "set":
                path = str(operation.get("path") or "")
                _validate_path(path)
                value = _coerce_scalar(path, operation.get("value"))
                for persona_id in ids:
                    _deep_set(personas[persona_id], path, _json_clone(value))
            elif kind == "name_affix":
                prefix = str(operation.get("prefix") or "")
                suffix = str(operation.get("suffix") or "")
                for persona_id in ids:
                    current = str(personas[persona_id].get("name") or persona_id)
                    personas[persona_id]["name"] = prefix + current + suffix
            elif kind == "prompt":
                field = str(operation.get("field") or "")
                if field not in PROMPT_FIELDS:
                    raise PersonaManagementError(f"不允许修改提示词字段：{field}")
                for persona_id in ids:
                    current = str(prompts[persona_id].get(field) or "")
                    prompts[persona_id][field] = _prompt_transform(
                        current, operation, personas[persona_id], persona_id,
                    )
            elif kind == "worldbooks":
                mode = str(operation.get("mode") or "replace")
                values = list(dict.fromkeys(str(value) for value in (operation.get("values") or [])))
                if mode not in ("replace", "append", "remove"):
                    raise PersonaManagementError(f"不支持的世界书操作：{mode}")
                for persona_id in ids:
                    current = list(personas[persona_id].get("bound_worldbooks") or [])
                    if mode == "replace":
                        current = values
                    elif mode == "append":
                        current = list(dict.fromkeys(current + values))
                    else:
                        current = [name for name in current if name not in values]
                    personas[persona_id]["bound_worldbooks"] = current
            elif kind == "moments":
                field = str(operation.get("field") or "")
                value = operation.get("value")
                if field in ("publisher", "replier"):
                    key = "publishers" if field == "publisher" else "repliers"
                    current = list(moments.get(key) or [])
                    for persona_id in ids:
                        if bool(value) and persona_id not in current:
                            current.append(persona_id)
                        if not bool(value) and persona_id in current:
                            current.remove(persona_id)
                    moments[key] = current
                elif field == "reply_probability":
                    number = int(value)
                    if not 0 <= number <= 100:
                        raise PersonaManagementError("朋友圈回复概率必须在 0 到 100 之间")
                    target = moments.setdefault("reply_probabilities", {})
                    for persona_id in ids:
                        target[persona_id] = number
                elif field == "memory_enabled":
                    target = moments.setdefault("memory_enabled", {})
                    for persona_id in ids:
                        target[persona_id] = bool(value)
                else:
                    raise PersonaManagementError(f"不允许修改朋友圈字段：{field}")
            else:
                raise PersonaManagementError(f"不支持的批量操作：{kind}")

        for persona_id in ids:
            _validate_persona(self.app, persona_id, personas[persona_id], personas)

        changes = []
        for persona_id in ids:
            fields = []
            for field in TOP_LEVEL_FIELDS | set(NESTED_FIELDS):
                old = before_personas[persona_id].get(field)
                new = personas[persona_id].get(field)
                if old != new:
                    fields.append({"field": field, "before": old, "after": new})
            for field in PROMPT_FIELDS:
                old = before_prompts[persona_id].get(field, "")
                new = prompts[persona_id].get(field, "")
                if old != new:
                    fields.append({"field": field, "before": old, "after": new})
            for key in ("publishers", "repliers", "reply_probabilities", "memory_enabled"):
                old = before_moments.get(key)
                new = moments.get(key)
                if old != new:
                    fields.append({"field": f"moments.{key}", "before": old, "after": new})
            changes.append({
                "id": persona_id,
                "name": personas[persona_id].get("name", persona_id),
                "fields": fields,
            })

        return {
            "version": version,
            "personas": personas,
            "prompts": prompts,
            "moments": moments,
            "changes": changes,
            "selected_ids": ids,
        }

    def preview_batch(self, persona_ids: list[str], operations: list[dict]) -> dict:
        with self.app.config.lock:
            built = self._build_batch(persona_ids, operations)
        return {
            "version": built["version"],
            "selected_count": len(built["selected_ids"]),
            "changed_count": sum(bool(item["fields"]) for item in built["changes"]),
            "changes": built["changes"],
        }

    def apply_batch(self, persona_ids: list[str], operations: list[dict], version: str) -> dict:
        with self.app.config.lock:
            built = self._build_batch(persona_ids, operations)
            if not version or version != built["version"]:
                raise PersonaManagementError("人物配置已变化，请重新预览后再提交", status_code=409)

            old_config = _json_clone(self.app.config._data)
            prompt_paths = {pid: self.app.config.prompt_path(pid) for pid in built["selected_ids"]}
            old_prompt_bytes = {
                pid: path.read_bytes() if path.is_file() else None
                for pid, path in prompt_paths.items()
            }
            try:
                for persona_id in built["selected_ids"]:
                    self.app.config._atomic_write_prompt_file(
                        persona_id, built["prompts"][persona_id],
                    )
                    image_cfg = normalize_image_generation(
                        built["personas"][persona_id].get("image_generation"),
                    )
                    self.app.config.save_image_prompt_parts(
                        persona_id,
                        image_cfg.get("style_prefix", ""),
                        image_cfg.get("art_style", ""),
                        image_cfg.get("negative_prompt", ""),
                    )
                    for key in ("style_prefix", "art_style", "negative_prompt"):
                        image_cfg.pop(key, None)
                    built["personas"][persona_id]["image_generation"] = image_cfg
                self.app.config._data["personas"] = built["personas"]
                self.app.config._data["moments"] = built["moments"]
                self.app.config.save()
            except Exception:
                self.app.config._data = old_config
                for persona_id, path in prompt_paths.items():
                    previous = old_prompt_bytes[persona_id]
                    if previous is None:
                        if path.is_file():
                            path.unlink()
                    else:
                        path.parent.mkdir(parents=True, exist_ok=True)
                        tmp = path.with_suffix(".json.rollback.tmp")
                        tmp.write_bytes(previous)
                        os.replace(tmp, path)
                raise

        return {
            "ok": True,
            "updated_count": len(built["selected_ids"]),
            "version": self.version(),
        }

    def update_persona(self, persona_id: str, data: dict) -> dict:
        operations: list[dict] = []
        for key, value in data.items():
            if key in TOP_LEVEL_FIELDS:
                operations.append({"kind": "set", "path": key, "value": value})
            elif key in NESTED_FIELDS and isinstance(value, dict):
                for nested_key, nested_value in value.items():
                    if isinstance(nested_value, dict):
                        for child_key, child_value in nested_value.items():
                            operations.append({
                                "kind": "set",
                                "path": f"{key}.{nested_key}.{child_key}",
                                "value": child_value,
                            })
                    else:
                        operations.append({
                            "kind": "set", "path": f"{key}.{nested_key}", "value": nested_value,
                        })
            elif key in PROMPT_FIELDS:
                operations.append({"kind": "prompt", "field": key, "mode": "overwrite", "value": value})
            elif key == "bound_worldbooks":
                operations.append({"kind": "worldbooks", "mode": "replace", "values": value})
            elif key == "moments" and isinstance(value, dict):
                for field, field_value in value.items():
                    operations.append({"kind": "moments", "field": field, "value": field_value})
        preview = self.preview_batch([persona_id], operations)
        return self.apply_batch([persona_id], operations, preview["version"])

    def import_persona(self, raw: bytes, filename: str, *, include_worldbooks: bool = True) -> dict:
        fmt = card_parser.detect_format(raw, filename)
        warnings: list[str] = []
        books: list[dict] = []
        avatar: bytes | None = None
        reference: bytes | None = None

        if fmt == "pawzo_bundle":
            result = bundle_mod.unpack_persona(raw)
            cfg = _json_clone(result.persona_config)
            name = result.name
            character_prompt = result.character_prompt
            output_examples = result.output_examples
            system_instructions = result.system_instructions or DEFAULT_SYSTEM_INSTRUCTIONS
            avatar = result.avatar_png
            reference = result.reference_image_png
            warnings.extend(result.warnings)
            if include_worldbooks:
                books = list(result.books)
        elif fmt in ("png_card", "json_card"):
            card = card_parser.read_png_card(raw) if fmt == "png_card" else card_parser.parse_json_card(raw)
            if not card:
                raise PersonaManagementError("角色卡中未检测到有效数据")
            result = persona_card.card_to_persona(card)
            name = result.name
            cfg = _card_config(result, name)
            character_prompt = result.character_prompt
            output_examples = result.output_examples
            system_instructions = result.system_instructions or DEFAULT_SYSTEM_INSTRUCTIONS
            avatar = raw if fmt == "png_card" else None
            reference = result.reference_image_png
            warnings.extend(result.warnings)
            if include_worldbooks and result.embedded_book:
                books = [persona_card.character_book_to_worldbook(result.embedded_book, fallback_name=name)]
        else:
            raise PersonaManagementError("无法识别文件格式（仅支持 PNG、JSON、ZIP/PPACK）")

        name = str(name or "").strip()
        if not name:
            raise PersonaManagementError("角色名称不能为空")
        if len(name) > 100:
            raise PersonaManagementError("角色名称过长（最多 100 个字符）")

        created_books: list[str] = []
        persona_id = ""
        try:
            with self.app.config.lock:
                personas = self.app.config._data.setdefault("personas", {})
                base_name = name
                existing_names = {str(item.get("name") or "") for item in personas.values()}
                suffix = 2
                while name in existing_names:
                    name = f"{base_name}_{suffix}"
                    suffix += 1
                persona_id = uuid.uuid4().hex[:8]
                while persona_id in personas:
                    persona_id = uuid.uuid4().hex[:8]

                saved_book_names: list[str] = []
                for book in books:
                    base_book_name = str(book.get("name") or name).strip() or name
                    final_book_name = base_book_name
                    suffix = 2
                    while self.app.worldbook_service.get_book(final_book_name) is not None:
                        final_book_name = f"{base_book_name}_{suffix}"
                        suffix += 1
                    try:
                        self.app.worldbook_service.save_book(
                            final_book_name,
                            scope=book.get("scope", {"range": "selected", "keyword_filter": False}),
                            keywords=book.get("keywords", []),
                            content=book.get("content", {}),
                            extras=book.get("extras"),
                            section_meta=book.get("section_meta"),
                        )
                    except ValueError as exc:
                        warnings.append(f"世界书「{base_book_name}」导入失败：{exc}")
                        continue
                    created_books.append(final_book_name)
                    saved_book_names.append(final_book_name)

                cfg = _json_clone(cfg)
                cfg.setdefault("enabled", True)
                cfg["name"] = name
                cfg["bound_worldbooks"] = saved_book_names
                image_cfg = normalize_image_generation(cfg.get("image_generation"))
                self.app.config.save_prompt_parts(
                    persona_id, character_prompt, output_examples, system_instructions,
                )
                self.app.config.save_image_prompt_parts(
                    persona_id,
                    image_cfg.get("style_prefix", ""),
                    image_cfg.get("art_style", ""),
                    image_cfg.get("negative_prompt", ""),
                )
                for key in ("style_prefix", "art_style", "negative_prompt"):
                    image_cfg.pop(key, None)
                cfg["image_generation"] = image_cfg
                cfg["voice_generation"] = normalize_voice_generation(cfg.get("voice_generation"))
                personas[persona_id] = cfg

                moments = self.app.config._data.setdefault("moments", {})
                for key in ("publishers", "repliers"):
                    values = moments.setdefault(key, [])
                    if persona_id not in values:
                        values.append(persona_id)
                if avatar:
                    _save_avatar(persona_id, avatar)
                if reference:
                    save_custom_reference_image(persona_id, reference)
                self.app.config.save()
        except Exception:
            if persona_id:
                self.app.config._data.setdefault("personas", {}).pop(persona_id, None)
                prompt_path = self.app.config.prompt_path(persona_id)
                if prompt_path.is_file():
                    prompt_path.unlink()
                shutil.rmtree(CHATS_DIR / persona_id, ignore_errors=True)
            for book_name in created_books:
                try:
                    self.app.worldbook_service.delete_book(book_name)
                except Exception:
                    pass
            raise
        return {"id": persona_id, "name": name, "warnings": warnings}

    def clone_personas(self, persona_ids: list[str]) -> list[dict]:
        created: list[dict] = []
        with self.app.config.lock:
            personas = self.app.config._data.setdefault("personas", {})
            existing_names = {str(cfg.get("name") or "") for cfg in personas.values()}
            for source_id in list(dict.fromkeys(persona_ids)):
                source = personas.get(source_id)
                if source is None:
                    raise PersonaManagementError(f"人物不存在：{source_id}", status_code=404)
                new_id = uuid.uuid4().hex[:8]
                while new_id in personas:
                    new_id = uuid.uuid4().hex[:8]
                base_name = f"{source.get('name', source_id)} 副本"
                name = base_name
                counter = 2
                while name in existing_names:
                    name = f"{base_name} {counter}"
                    counter += 1
                existing_names.add(name)
                cloned = _json_clone(source)
                cloned.update(name=name, enabled=False)
                personas[new_id] = cloned
                self.app.config._atomic_write_prompt_file(
                    new_id, self.app.config._read_prompt_file(source_id),
                )
                source_dir = CHATS_DIR / source_id
                target_dir = CHATS_DIR / new_id
                for relative in (Path("avatar.png"), Path(CUSTOM_REFERENCE_DIRNAME) / "ref.png"):
                    source_file = source_dir / relative
                    if source_file.is_file():
                        destination = target_dir / relative
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(source_file, destination)
                created.append({"id": new_id, "name": name})
            self.app.config.save()
        return created

    def delete_personas(self, persona_ids: list[str], *, delete_conversations: bool) -> int:
        ids = list(dict.fromkeys(persona_ids))
        with self.app.config.lock:
            personas = self.app.config._data.setdefault("personas", {})
            missing = [pid for pid in ids if pid not in personas]
            if missing:
                raise PersonaManagementError(f"人物不存在：{'、'.join(missing)}", status_code=404)
            moments = self.app.config._data.setdefault("moments", {})
            for key in ("publishers", "repliers"):
                moments[key] = [pid for pid in (moments.get(key) or []) if pid not in ids]
            for key in ("reply_probabilities", "memory_enabled"):
                values = moments.setdefault(key, {})
                for persona_id in ids:
                    values.pop(persona_id, None)
            for persona_id in ids:
                personas.pop(persona_id, None)
            self.app.config.save()

        for persona_id in ids:
            prompt_path = self.app.config.prompt_path(persona_id)
            if prompt_path.is_file():
                prompt_path.unlink()
            try:
                self.app.moments_service.delete_moments_by_author(persona_id)
            except Exception:
                pass
            if delete_conversations:
                self.app.conversation_store.delete_conversation(persona_id)
            else:
                persona_dir = CHATS_DIR / persona_id
                for relative in (Path("avatar.png"), Path(CUSTOM_REFERENCE_DIRNAME) / "ref.png"):
                    target = persona_dir / relative
                    if target.is_file():
                        target.unlink()
        return len(ids)


def load_prompt_templates() -> list[dict]:
    if not PROMPT_TEMPLATES_PATH.is_file():
        return []
    try:
        raw = json.loads(PROMPT_TEMPLATES_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return raw if isinstance(raw, list) else []


def save_prompt_templates(templates: list[dict]) -> None:
    PROMPT_TEMPLATES_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = PROMPT_TEMPLATES_PATH.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(templates, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, PROMPT_TEMPLATES_PATH)