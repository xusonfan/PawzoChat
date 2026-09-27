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

"""REST API for anonymous telemetry — read state / toggle enabled flag."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from pawzochat.services.telemetry import TELEMETRY_ENDPOINT
from pawzochat.web.routes import get_app

api_telemetry_bp = Blueprint("api_telemetry", __name__)


def _current_state() -> dict:
    app = get_app()
    enabled = bool(app.config.get("telemetry", "enabled", default=False))
    running = bool(app.telemetry and app.telemetry.running)
    return {
        "enabled": enabled,
        "running": running,
        "endpoint": TELEMETRY_ENDPOINT,
    }


@api_telemetry_bp.route("/settings", methods=["GET"])
def get_telemetry_settings():
    return jsonify(_current_state())


@api_telemetry_bp.route("/settings", methods=["PATCH"])
def patch_telemetry_settings():
    app = get_app()
    data = request.get_json(force=True, silent=True) or {}
    if "enabled" not in data:
        return jsonify({"error": "缺少 enabled 字段"}), 400

    want_enabled = bool(data["enabled"])

    with app.config.lock:
        section = app.config._data.setdefault("telemetry", {})
        section["enabled"] = want_enabled
        app.config.save()

    if app.telemetry:
        app.telemetry.reload_config()

    return jsonify(_current_state())


@api_telemetry_bp.route("/send", methods=["POST"])
def send_telemetry_event():
    """Trigger a one-shot telemetry event immediately.

    Body: {"event": "quick_setup_complete"} (or any event name).
    Only sends if telemetry is enabled in config.
    """
    app = get_app()
    data = request.get_json(force=True, silent=True) or {}
    event_name = str(data.get("event", "")).strip()
    if not event_name:
        return jsonify({"error": "缺少 event 字段"}), 400
    if not app.telemetry:
        return jsonify({"sent": False, "reason": "遥测服务未就绪"})
    sent = app.telemetry.send_event(event_name)
    return jsonify({"sent": sent})
