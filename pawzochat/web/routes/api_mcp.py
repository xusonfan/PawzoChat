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

"""REST API for MCP server and capability adapter management."""

from __future__ import annotations

import asyncio
import logging
import re

from flask import Blueprint, jsonify, request

from pawzochat.web.routes import get_app

logger = logging.getLogger(__name__)

api_mcp_bp = Blueprint("api_mcp", __name__)

_NAME_RE = re.compile(
    r"^[a-zA-Z0-9\u4e00-\u9fff][a-zA-Z0-9\u4e00-\u9fff_\-]*$"
)


def _require_local():
    """Return an error response if the request comes from public access."""
    if request.environ.get("pawzochat.is_public", False):
        return jsonify({"error": "MCP 配置仅限本地访问修改"}), 403
    return None


def _validate_name(name: str) -> str | None:
    if not name:
        return "名称不能为空"
    if len(name) > 30:
        return "名称不能超过 30 个字符"
    if not _NAME_RE.match(name):
        return "名称只能包含字母、数字、中文、下划线和连字符"
    return None


_TIMEOUT_MAX_SECONDS = 600


def _parse_timeout_seconds(value) -> int | None:
    """Parse per-server tool-call timeout; None means unset (default 30s)."""
    if value is None or isinstance(value, bool) or value == "":
        return None
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        return None
    return seconds if seconds > 0 else None


def _server_summary(name: str, cfg: dict, runtime: dict | None) -> dict:
    """Build a JSON-safe summary for one MCP server."""
    transport = cfg.get("transport", "stdio")
    out: dict = {
        "name": name,
        "transport": transport,
        "enabled": cfg.get("enabled", True),
        "connected": False,
        "tool_count": 0,
    }

    timeout_seconds = _parse_timeout_seconds(cfg.get("timeout_seconds"))
    if timeout_seconds is not None:
        out["timeout_seconds"] = timeout_seconds

    if transport == "stdio":
        out["command"] = cfg.get("command", "")
        out["args"] = list(cfg.get("args", []))
        env = cfg.get("env") or {}
        out["env_keys"] = list(env.keys())
        out["env_has_value"] = {k: bool(v) for k, v in env.items()}
    elif transport in ("streamable_http", "sse"):
        out["url"] = cfg.get("url", "")

    if runtime:
        out["connected"] = runtime.get("connected", False)
        out["tool_count"] = runtime.get("tool_count", 0)

    return out


# ---------------------------------------------------------------------------
# Server list / CRUD
# ---------------------------------------------------------------------------

@api_mcp_bp.route("/servers", methods=["GET"])
def list_servers():
    app = get_app()
    servers_cfg = app.config.get("mcp_servers", default={}) or {}
    runtime = app.mcp_manager.get_server_status()
    is_public = request.environ.get("pawzochat.is_public", False)

    servers = [
        _server_summary(name, cfg, runtime.get(name))
        for name, cfg in servers_cfg.items()
    ]
    return jsonify({"servers": servers, "is_public": is_public})


@api_mcp_bp.route("/servers", methods=["POST"])
def create_server():
    blocked = _require_local()
    if blocked:
        return blocked

    app = get_app()
    data = request.get_json(force=True)
    name = data.get("name", "").strip()

    err = _validate_name(name)
    if err:
        return jsonify({"error": err}), 400

    servers = app.config._data.setdefault("mcp_servers", {})
    if name in servers:
        return jsonify({"error": f"MCP Server '{name}' 已存在"}), 409

    transport = data.get("transport", "stdio")
    entry: dict = {
        "transport": transport,
        "enabled": data.get("enabled", True),
    }

    timeout_seconds = _parse_timeout_seconds(data.get("timeout_seconds"))
    if timeout_seconds is not None:
        entry["timeout_seconds"] = min(timeout_seconds, _TIMEOUT_MAX_SECONDS)

    if transport == "stdio":
        entry["command"] = data.get("command", "")
        entry["args"] = list(data.get("args", []))
        env = data.get("env") or {}
        entry["env"] = {k: v for k, v in env.items() if k}
    elif transport in ("streamable_http", "sse"):
        entry["url"] = data.get("url", "")

    servers[name] = entry
    app.config.save()

    if entry.get("enabled", True):
        try:
            app.mcp_manager.add_server(name, entry)
        except Exception:
            logger.exception("MCP Server '%s' 添加后连接失败", name)

    runtime = app.mcp_manager.get_server_status()
    return jsonify({
        "ok": True,
        "server": _server_summary(name, entry, runtime.get(name)),
    }), 201


@api_mcp_bp.route("/servers/<name>", methods=["PUT"])
def update_server(name: str):
    blocked = _require_local()
    if blocked:
        return blocked

    app = get_app()
    servers = app.config._data.get("mcp_servers", {})
    if name not in servers:
        return jsonify({"error": "MCP Server 不存在"}), 404

    data = request.get_json(force=True)
    old_cfg = servers[name]
    transport = data.get("transport", old_cfg.get("transport", "stdio"))

    entry: dict = {
        "transport": transport,
        "enabled": data.get("enabled", old_cfg.get("enabled", True)),
    }

    raw_timeout = (
        data["timeout_seconds"] if "timeout_seconds" in data
        else old_cfg.get("timeout_seconds")
    )
    timeout_seconds = _parse_timeout_seconds(raw_timeout)
    if timeout_seconds is not None:
        entry["timeout_seconds"] = min(timeout_seconds, _TIMEOUT_MAX_SECONDS)

    if transport == "stdio":
        entry["command"] = data.get("command", old_cfg.get("command", ""))
        entry["args"] = list(data.get("args", old_cfg.get("args", [])))
        old_env = old_cfg.get("env") or {}
        new_env = data.get("env")
        if new_env is not None:
            merged: dict = {}
            for k, v in new_env.items():
                if not k:
                    continue
                if v == "" and k in old_env:
                    merged[k] = old_env[k]
                else:
                    merged[k] = v
            entry["env"] = merged
        else:
            entry["env"] = dict(old_env)
    elif transport in ("streamable_http", "sse"):
        entry["url"] = data.get("url", old_cfg.get("url", ""))

    servers[name] = entry
    app.config.save()

    app.mcp_manager.remove_server(name)
    if entry.get("enabled", True):
        try:
            app.mcp_manager.add_server(name, entry)
        except Exception:
            logger.exception("MCP Server '%s' 更新后重连失败", name)

    runtime = app.mcp_manager.get_server_status()
    return jsonify({
        "ok": True,
        "server": _server_summary(name, entry, runtime.get(name)),
    })


@api_mcp_bp.route("/servers/<name>", methods=["DELETE"])
def delete_server(name: str):
    blocked = _require_local()
    if blocked:
        return blocked

    app = get_app()
    servers = app.config._data.get("mcp_servers", {})
    if name not in servers:
        return jsonify({"error": "MCP Server 不存在"}), 404

    app.mcp_manager.remove_server(name)

    del servers[name]

    adapters = app.config._data.get("capability_adapters", {})
    removed_adapters = [
        k for k, v in adapters.items() if v.get("mcp_server") == name
    ]
    for k in removed_adapters:
        del adapters[k]

    app.config.save()

    if removed_adapters and app.capability_registry:
        app.capability_registry.reload(
            app.config.get("capability_adapters", default={})
        )

    return jsonify({"ok": True, "removed_adapters": removed_adapters})


def _infer_transport(cfg: dict) -> str:
    """Infer transport type from a raw server config dict (e.g. pasted JSON)."""
    if cfg.get("command"):
        return "stdio"
    url = cfg.get("url", "")
    if url:
        try:
            from urllib.parse import urlparse
            path = urlparse(url).path.rstrip("/")
            if path.endswith("/sse"):
                return "sse"
        except Exception:
            pass
        return "streamable_http"
    return "stdio"


@api_mcp_bp.route("/servers/batch", methods=["POST"])
def batch_create_servers():
    """Import multiple MCP servers at once from pasted JSON config."""
    blocked = _require_local()
    if blocked:
        return blocked

    app = get_app()
    data = request.get_json(force=True)
    servers_map = data.get("servers") or {}
    if not isinstance(servers_map, dict):
        return jsonify({"error": "servers 必须是一个对象"}), 400

    existing = app.config._data.setdefault("mcp_servers", {})

    created = []
    skipped = []
    errors = []

    for name, cfg in servers_map.items():
        name = name.strip()
        err = _validate_name(name)
        if err:
            errors.append({"name": name, "error": err})
            continue

        if name in existing:
            skipped.append(name)
            continue

        if not isinstance(cfg, dict):
            errors.append({"name": name, "error": "配置必须是一个对象"})
            continue

        transport = _infer_transport(cfg)
        entry: dict = {
            "transport": transport,
            "enabled": cfg.get("enabled", True),
        }

        timeout_seconds = _parse_timeout_seconds(cfg.get("timeout_seconds"))
        if timeout_seconds is not None:
            entry["timeout_seconds"] = min(timeout_seconds, _TIMEOUT_MAX_SECONDS)

        if transport == "stdio":
            entry["command"] = cfg.get("command", "")
            entry["args"] = list(cfg.get("args", []))
            env = cfg.get("env") or {}
            entry["env"] = {k: v for k, v in env.items() if k}
        elif transport in ("streamable_http", "sse"):
            entry["url"] = cfg.get("url", "")

        existing[name] = entry
        created.append(name)

        if entry.get("enabled", True):
            try:
                app.mcp_manager.add_server(name, entry)
            except Exception:
                logger.exception("MCP Server '%s' 批量导入后连接失败", name)

    if created:
        app.config.save()

    return jsonify({
        "ok": True,
        "created": created,
        "skipped": skipped,
        "errors": errors,
    }), 201 if created else 200


# ---------------------------------------------------------------------------
# Server actions
# ---------------------------------------------------------------------------

@api_mcp_bp.route("/servers/<name>/connect", methods=["POST"])
def connect_server(name: str):
    blocked = _require_local()
    if blocked:
        return blocked

    app = get_app()
    servers_cfg = app.config.get("mcp_servers", default={}) or {}
    cfg = servers_cfg.get(name)
    if not cfg:
        return jsonify({"error": "MCP Server 不存在"}), 404

    if app.mcp_manager.is_connected(name):
        return jsonify({"ok": True, "message": "已连接"})

    try:
        app.mcp_manager.connect_server(name, cfg)
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500

    runtime = app.mcp_manager.get_server_status()
    info = runtime.get(name, {})
    connected = info.get("connected", False)
    return jsonify({
        "ok": connected,
        "connected": connected,
        "tool_count": info.get("tool_count", 0),
        **({"error": "连接失败"} if not connected else {}),
    }), 200 if connected else 502


@api_mcp_bp.route("/servers/<name>/disconnect", methods=["POST"])
def disconnect_server(name: str):
    blocked = _require_local()
    if blocked:
        return blocked

    app = get_app()
    app.mcp_manager.disconnect_server(name)
    return jsonify({"ok": True})


@api_mcp_bp.route("/servers/<name>/test", methods=["POST"])
def test_server(name: str):
    """Temporarily connect to validate configuration without affecting
    the running manager state."""
    blocked = _require_local()
    if blocked:
        return blocked

    app = get_app()
    data = request.get_json(force=True) if request.is_json else {}

    servers_cfg = app.config.get("mcp_servers", default={}) or {}
    cfg = servers_cfg.get(name)
    if not cfg and not data:
        return jsonify({"ok": False, "error": "MCP Server 不存在"}), 404

    test_cfg = data if data else dict(cfg)

    from pawzochat.mcp.client import MCPClient

    loop = asyncio.new_event_loop()

    async def _test():
        client = MCPClient(name, test_cfg)
        try:
            await client.connect()
            tool_count = len(client.get_tools())
            await client.disconnect()
            return {"ok": True, "tool_count": tool_count}
        except Exception as exc:
            try:
                await client.disconnect()
            except Exception:
                pass
            return {"ok": False, "error": str(exc)}

    try:
        result = loop.run_until_complete(_test())
    except Exception as exc:
        result = {"ok": False, "error": str(exc)}
    finally:
        loop.close()

    status = 200 if result["ok"] else 500
    return jsonify(result), status


@api_mcp_bp.route("/servers/<name>/refresh", methods=["POST"])
def refresh_server(name: str):
    blocked = _require_local()
    if blocked:
        return blocked

    app = get_app()
    if not app.mcp_manager.is_connected(name):
        return jsonify({"error": "Server 未连接，无法刷新"}), 400

    app.mcp_manager.refresh_tools()
    tools = app.mcp_manager.get_server_tools(name)
    return jsonify({"ok": True, "tool_count": len(tools)})


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@api_mcp_bp.route("/tools", methods=["GET"])
def list_tools():
    """List every tool exposed to the LLM, tagged with its origin.

    Each item carries an ``owner`` field:
      * ``"builtin"``        — program-internal capability adapter
      * ``"plugin:<id>"``    — registered by a runtime plugin
      * ``"mcp:<server>"``   — exposed by a configured MCP server
      * ``""``               — from ``capability_adapters`` config

    The frontend uses ``owner`` to lock edit/delete on tools it can't
    manage from this page (plugin tools have to be toggled by enabling /
    disabling their owning plugin).
    """
    app = get_app()
    out: list[dict] = []
    if app.capability_registry:
        for t in app.capability_registry.get_tool_definitions():
            out.append({
                "name": t.get("name", ""),
                "description": t.get("description", ""),
                "inputSchema": t.get("inputSchema", {}),
                "owner": t.get("_owner", ""),
            })
    for t in app.mcp_manager.get_all_tools():
        server = t.get("_server", "")
        out.append({
            "name": t.get("name", ""),
            "description": t.get("description", ""),
            "inputSchema": t.get("inputSchema", {}),
            "owner": f"mcp:{server}" if server else "",
        })
    return jsonify({"tools": out})


@api_mcp_bp.route("/servers/<name>/tools", methods=["GET"])
def server_tools(name: str):
    app = get_app()
    tools = app.mcp_manager.get_server_tools(name)
    return jsonify({"tools": tools})


# ---------------------------------------------------------------------------
# Capability adapters
# ---------------------------------------------------------------------------

@api_mcp_bp.route("/adapters", methods=["GET"])
def list_adapters():
    app = get_app()
    adapters_cfg = app.config.get("capability_adapters", default={}) or {}

    servers_cfg = app.config.get("mcp_servers", default={}) or {}
    available_servers = list(servers_cfg.keys())

    available_tools: dict[str, list[str]] = {}
    for srv_name in available_servers:
        srv_tools = app.mcp_manager.get_server_tools(srv_name)
        available_tools[srv_name] = [
            t.get("_original_name", t["name"]) for t in srv_tools
        ]

    return jsonify({
        "adapters": adapters_cfg,
        "available_servers": available_servers,
        "available_tools": available_tools,
    })


@api_mcp_bp.route("/adapters", methods=["POST"])
def create_adapter():
    blocked = _require_local()
    if blocked:
        return blocked

    app = get_app()
    data = request.get_json(force=True)
    name = data.get("name", "").strip()

    err = _validate_name(name)
    if err:
        return jsonify({"error": err}), 400

    adapters = app.config._data.setdefault("capability_adapters", {})
    if name in adapters:
        return jsonify({"error": f"适配器 '{name}' 已存在"}), 409

    entry = _adapter_entry_from_request(data)
    adapters[name] = entry
    app.config.save()

    if app.capability_registry:
        app.capability_registry.reload(
            app.config.get("capability_adapters", default={})
        )

    return jsonify({"ok": True}), 201


@api_mcp_bp.route("/adapters/<name>", methods=["PUT"])
def update_adapter(name: str):
    blocked = _require_local()
    if blocked:
        return blocked

    app = get_app()
    adapters = app.config._data.get("capability_adapters", {})
    if name not in adapters:
        return jsonify({"error": "适配器不存在"}), 404

    data = request.get_json(force=True)
    entry = _adapter_entry_from_request(data)
    adapters[name] = entry
    app.config.save()

    if app.capability_registry:
        app.capability_registry.reload(
            app.config.get("capability_adapters", default={})
        )

    return jsonify({"ok": True})


@api_mcp_bp.route("/adapters/<name>", methods=["DELETE"])
def delete_adapter(name: str):
    blocked = _require_local()
    if blocked:
        return blocked

    app = get_app()
    adapters = app.config._data.get("capability_adapters", {})
    if name not in adapters:
        return jsonify({"error": "适配器不存在"}), 404

    del adapters[name]
    app.config.save()

    if app.capability_registry:
        app.capability_registry.reload(
            app.config.get("capability_adapters", default={})
        )

    return jsonify({"ok": True})


def _adapter_entry_from_request(data: dict) -> dict:
    entry: dict = {
        "mcp_server": data.get("mcp_server", ""),
        "mcp_tool": data.get("mcp_tool", ""),
    }
    if data.get("description"):
        entry["description"] = data["description"]
    if data.get("parameters"):
        entry["parameters"] = data["parameters"]
    if data.get("param_mapping"):
        entry["param_mapping"] = data["param_mapping"]
    if data.get("inject_fields"):
        entry["inject_fields"] = data["inject_fields"]
    return entry
