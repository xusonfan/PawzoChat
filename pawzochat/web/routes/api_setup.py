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

"""REST API for quick setup (PawAPI one-click configuration)."""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

from flask import Blueprint, jsonify, request

from pawzochat.image.manager import IMAGE_PRESET_MODELS
from pawzochat.llm.manager import PRESET_MODELS, ensure_models_list
from pawzochat.paths import APP_HOME, INVITATION_CODE_PATH
from pawzochat.voice.manager import VOICE_PRESET_MODELS
from pawzochat.web.routes import get_app

logger = logging.getLogger(__name__)

api_setup_bp = Blueprint("api_setup", __name__)

_BUILTIN_MCP_SERVER_DIRS = {
    "web_search_pawapi": "web_search_pawapi",
    "image_recognition_pawapi": "image_recognition_pawapi",
}

_CAPABILITY_ADAPTERS = {
    "recognize_image": {
        "description": "识别并描述图片内容，当收到 [图片 ID:xxx] 时使用此工具",
        "mcp_server": "image_recognition_pawapi",
        "mcp_tool": "recognize_image",
        "parameters": {
            "image_id": {
                "type": "string",
                "description": "图片ID，即消息中 [图片 ID:xxx] 里的 xxx 部分",
            },
            "query": {
                "type": "string",
                "description": "关于图片的具体问题",
                "default": "请详细描述这张图片的内容",
            },
        },
        "inject_fields": {
            "image_data": "$image_data(image_id)",
        },
    },
}


def _read_invitation_code() -> str:
    if not INVITATION_CODE_PATH.exists():
        return ""

    raw = INVITATION_CODE_PATH.read_bytes()
    for encoding in ("utf-8-sig", "utf-16", "gb18030"):
        try:
            return raw.decode(encoding).strip()
        except UnicodeError:
            continue

    logger.warning("邀请码文件编码无法识别，已忽略: %s", INVITATION_CODE_PATH)
    return ""


def _resolve_builtin_entry(relative_path: str) -> Path:
    return (APP_HOME / relative_path).resolve()


def _script_stdio_config(server_dir: str) -> dict | None:
    script_path = f"data/mcp_servers/{server_dir}/server.py"
    expected = _resolve_builtin_entry(script_path)
    if not expected.is_file():
        return None
    return {
        "transport": "stdio",
        "command": "python",
        "args": [script_path],
        "enabled": True,
    }


def _packaged_stdio_config(server_dir: str) -> dict | None:
    executable_name = "server.exe" if os.name == "nt" else "server"
    command = f"data/mcp_servers/{server_dir}/{executable_name}"
    expected = _resolve_builtin_entry(command)
    if not expected.is_file():
        return None
    return {
        "transport": "stdio",
        "command": command,
        "args": [],
        "enabled": True,
    }


def _builtin_stdio_config(server_dir: str) -> dict:
    if getattr(sys, "frozen", False):
        packaged = _packaged_stdio_config(server_dir)
        if packaged:
            return packaged
        script = _script_stdio_config(server_dir)
        if script:
            logger.warning(
                "内置 MCP 打包产物缺失，快速配置将回退到脚本模式: %s",
                server_dir,
            )
            return script
        executable_name = "server.exe" if os.name == "nt" else "server"
        raise FileNotFoundError(
            f"内置 MCP 文件缺失: {APP_HOME / 'data' / 'mcp_servers' / server_dir / executable_name}"
        )

    script = _script_stdio_config(server_dir)
    if script:
        return script
    raise FileNotFoundError(
        f"内置 MCP 脚本缺失: {APP_HOME / 'data' / 'mcp_servers' / server_dir / 'server.py'}"
    )


def _build_builtin_mcp_servers() -> dict[str, dict]:
    return {
        name: _builtin_stdio_config(server_dir)
        for name, server_dir in _BUILTIN_MCP_SERVER_DIRS.items()
    }


def _reinit_llm(app):
    app.llm_manager._providers.clear()
    app.llm_manager.init_from_config(app.config.get("llm_providers", default={}))


def _reinit_image(app):
    app.image_manager.init_from_config(
        app.config.get("image_providers", default={})
    )


def _reinit_voice(app):
    app.voice_manager.init_from_config(
        app.config.get("voice_providers", default={})
    )


@api_setup_bp.route("/status", methods=["GET"])
def setup_status():
    app = get_app()
    try:
        code = _read_invitation_code()
    except OSError:
        logger.warning("读取邀请码文件失败，已忽略: %s", INVITATION_CODE_PATH, exc_info=True)
        code = ""
    return jsonify({
        "needs_setup": app.config.fresh_install,
        "invitation_code": code,
    })


@api_setup_bp.route("/quick", methods=["POST"])
def quick_setup():
    app = get_app()
    data = request.get_json(force=True)
    api_key = data.get("api_key", "").strip()
    if not api_key:
        return jsonify({"error": "API Key 不能为空"}), 400

    try:
        builtin_mcp_servers = _build_builtin_mcp_servers()
    except FileNotFoundError as exc:
        logger.error("快速配置失败，内置 MCP 文件缺失: %s", exc)
        return jsonify({"error": str(exc)}), 500

    providers = app.config._data.setdefault("llm_providers", {})
    provider_name = "PawAPI"
    if provider_name in providers:
        providers[provider_name]["api_key"] = api_key
    else:
        providers[provider_name] = {
            "preset": "pawapi",
            "api_key": api_key,
            "models": ensure_models_list(
                {"preset": "pawapi", "models": PRESET_MODELS.get("pawapi", [])}
            ),
        }

    image_providers = app.config._data.setdefault("image_providers", {})
    image_provider_name = "PawAPI"
    if image_provider_name in image_providers:
        image_providers[image_provider_name]["api_key"] = api_key
    else:
        image_providers[image_provider_name] = {
            "preset": "pawapi",
            "api_key": api_key,
            "models": [dict(m) for m in IMAGE_PRESET_MODELS.get("pawapi", [])],
        }

    voice_providers = app.config._data.setdefault("voice_providers", {})
    voice_provider_name = "PawAPI"
    if voice_provider_name in voice_providers:
        voice_providers[voice_provider_name]["api_key"] = api_key
    else:
        voice_providers[voice_provider_name] = {
            "preset": "pawapi",
            "api_key": api_key,
            "models": [dict(m) for m in VOICE_PRESET_MODELS.get("pawapi", [])],
        }

    servers = app.config._data.setdefault("mcp_servers", {})
    new_servers = []
    for name, cfg in builtin_mcp_servers.items():
        if name not in servers:
            servers[name] = dict(cfg)
            new_servers.append(name)

    adapters = app.config._data.setdefault("capability_adapters", {})
    for name, cfg in _CAPABILITY_ADAPTERS.items():
        if name not in adapters:
            adapters[name] = dict(cfg)

    app.config.save()

    _reinit_llm(app)
    _reinit_image(app)
    _reinit_voice(app)

    for name in new_servers:
        cfg = servers[name]
        if cfg.get("enabled", True):
            try:
                app.mcp_manager.add_server(name, cfg)
            except Exception:
                logger.exception("快速配置：MCP Server '%s' 启动失败", name)

    if app.capability_registry:
        app.capability_registry.reload(
            app.config.get("capability_adapters", default={})
        )

    return jsonify({"ok": True}), 201


@api_setup_bp.route("/skip", methods=["POST"])
def skip_setup():
    app = get_app()
    app.config.mark_setup_done()
    return jsonify({"ok": True})
