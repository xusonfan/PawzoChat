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

"""REST API for global settings — read / partial update."""

from __future__ import annotations

import copy
import random
import re
import secrets
import socket

from flask import Blueprint, jsonify, request, session

from pawzochat.paths import THEME_DIR
from pawzochat.utils.crypto import hash_password
from pawzochat.web.routes import get_app

api_settings_bp = Blueprint("api_settings", __name__)

EXPOSED_SECTIONS = [
    "chat", "reply", "web", "theme", "admin",
]


def _clean_active_themes(names) -> list[str]:
    """Drop any names that don't correspond to an existing theme directory."""
    if not isinstance(names, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for x in names:
        if not isinstance(x, str) or not x or x in seen:
            continue
        if ".." in x or "/" in x or "\\" in x:
            continue
        if (THEME_DIR / x / "style.css").is_file():
            out.append(x)
            seen.add(x)
    return out

_PASSWORD_RE = re.compile(r"^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$")


def _validate_password(pw: str) -> str | None:
    """Return an error string if *pw* doesn't meet complexity rules, else None."""
    if len(pw) < 8:
        return "密码长度至少 8 位"
    if not _PASSWORD_RE.match(pw):
        return "密码需要同时包含大写字母、小写字母和数字"
    return None


def _generate_port() -> int:
    """Pick a random port in 10000-60000 that is currently available."""
    for _ in range(50):
        port = random.randint(10000, 60000)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return random.randint(10000, 60000)


def _generate_secret() -> str:
    return secrets.token_urlsafe(12)


@api_settings_bp.route("", methods=["GET"])
def get_settings():
    app = get_app()
    is_public = request.environ.get("pawzochat.is_public", False)
    result = {}
    for key in EXPOSED_SECTIONS:
        if key == "web" and is_public:
            continue
        result[key] = copy.deepcopy(app.config.get(key, default=None))
    if "web" in result and result["web"]:
        result["web"]["has_password"] = bool(result["web"].get("password"))
        result["web"].pop("password", None)
    if "admin" in result:
        result["admin"] = {
            "has_password": bool((result.get("admin") or {}).get("password")),
        }
    result["is_public"] = is_public
    return jsonify(result)


@api_settings_bp.route("", methods=["PATCH"])
def update_settings():
    app = get_app()
    data = request.get_json(force=True)
    is_public = request.environ.get("pawzochat.is_public", False)

    if "admin" in data:
        if is_public:
            return jsonify({"error": "管理员密码仅限本地访问修改"}), 403
        admin_patch = data["admin"] or {}
        if "password" in admin_patch:
            pw = str(admin_patch["password"] or "")
            if pw:
                err = _validate_password(pw)
                if err:
                    return jsonify({"error": err}), 400
                app.config._data.setdefault("admin", {})["password"] = hash_password(pw)
            else:
                app.config._data.setdefault("admin", {})["password"] = ""
            session.pop("admin_authenticated", None)
        data = {k: v for k, v in data.items() if k != "admin"}

    if "web" in data:
        if is_public:
            return jsonify({"error": "网络设置仅限本地访问修改"}), 403

        web_patch = data["web"]

        if "password" in web_patch:
            pw = web_patch["password"]
            web_cfg = app.config._data.setdefault("web", {})
            if pw:
                err = _validate_password(pw)
                if err:
                    return jsonify({"error": err}), 400
                web_cfg["password"] = hash_password(pw)
            else:
                web_cfg["password"] = ""
                web_cfg["public_enabled"] = False

        if "public_enabled" in web_patch:
            want_public = bool(web_patch["public_enabled"])
            if want_public and not app.config.get("web", "password", default=""):
                return jsonify({"error": "请先设置访问密码"}), 400
            app.config._data.setdefault("web", {})["public_enabled"] = want_public
            if want_public:
                web_cfg = app.config._data["web"]
                if not web_cfg.get("public_port"):
                    web_cfg["public_port"] = _generate_port()
                if not web_cfg.get("public_secret"):
                    web_cfg["public_secret"] = _generate_secret()

        data = {k: v for k, v in data.items() if k != "web"}

    for key, value in data.items():
        if key not in EXPOSED_SECTIONS:
            continue
        if key == "theme" and isinstance(value, dict):
            theme_cfg = app.config._data.setdefault("theme", {})
            if "mode" in value and value["mode"] in ("light", "dark", "auto"):
                theme_cfg["mode"] = value["mode"]
            if "active" in value:
                theme_cfg["active"] = _clean_active_themes(value["active"])
            continue
        if isinstance(value, dict) and isinstance(app.config._data.get(key), dict):
            app.config._data[key].update(value)
        else:
            app.config._data[key] = value

    app.config.save()

    result = {
        "ok": True,
        "admin": {
            "has_password": bool(app.config.get("admin", "password", default="")),
        },
    }
    if not is_public:
        web_out = copy.deepcopy(app.config.get("web", default={}))
        web_out["has_password"] = bool(web_out.get("password"))
        web_out.pop("password", None)
        result["web"] = web_out
    return jsonify(result)


@api_settings_bp.route("/regenerate-public", methods=["POST"])
def regenerate_public():
    if request.environ.get("pawzochat.is_public", False):
        return jsonify({"error": "网络设置仅限本地访问修改"}), 403
    app = get_app()
    web_cfg = app.config._data.setdefault("web", {})
    web_cfg["public_port"] = _generate_port()
    web_cfg["public_secret"] = _generate_secret()
    app.config.save()

    web_out = copy.deepcopy(web_cfg)
    web_out["has_password"] = bool(web_out.get("password"))
    web_out.pop("password", None)
    return jsonify({"ok": True, "web": web_out})
