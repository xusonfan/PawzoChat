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

"""REST API for plugin discovery and management.

All endpoints are local-only — public access returns 403.
"""

from __future__ import annotations

import mimetypes

from flask import Blueprint, jsonify, request, send_from_directory

from pawzochat.web.routes import get_app

api_plugins_bp = Blueprint("api_plugins", __name__)


@api_plugins_bp.before_request
def _require_local():
    if request.environ.get("pawzochat.is_public", False):
        return jsonify({"error": "插件管理仅限本地访问"}), 403


@api_plugins_bp.route("", methods=["GET"])
def list_plugins():
    app = get_app()
    return jsonify({"plugins": app.extension_manager.list_plugins()})


@api_plugins_bp.route("/refresh", methods=["POST"])
def refresh_plugins():
    app = get_app()
    app.extension_manager.refresh()
    return jsonify({"ok": True, "plugins": app.extension_manager.list_plugins()})


@api_plugins_bp.route("/<plugin_id>", methods=["GET"])
def get_plugin(plugin_id: str):
    app = get_app()
    detail = app.extension_manager.get_plugin(plugin_id)
    if not detail:
        return jsonify({"error": "Plugin not found"}), 404
    detail["provided_tools"] = app.extension_manager.get_provided_tools(plugin_id)
    return jsonify(detail)


@api_plugins_bp.route("/<plugin_id>/enable", methods=["POST"])
def enable_plugin(plugin_id: str):
    app = get_app()
    try:
        app.extension_manager.set_enabled(plugin_id, True)
    except KeyError:
        return jsonify({"error": "Plugin not found"}), 404
    return jsonify({"ok": True, "plugin": app.extension_manager.get_plugin(plugin_id)})


@api_plugins_bp.route("/<plugin_id>/disable", methods=["POST"])
def disable_plugin(plugin_id: str):
    app = get_app()
    try:
        app.extension_manager.set_enabled(plugin_id, False)
    except KeyError:
        return jsonify({"error": "Plugin not found"}), 404
    return jsonify({"ok": True, "plugin": app.extension_manager.get_plugin(plugin_id)})


@api_plugins_bp.route("/<plugin_id>/reload", methods=["POST"])
def reload_plugin(plugin_id: str):
    app = get_app()
    try:
        app.extension_manager.reload_plugin(plugin_id)
    except KeyError:
        return jsonify({"error": "Plugin not found"}), 404
    return jsonify({"ok": True, "plugin": app.extension_manager.get_plugin(plugin_id)})


@api_plugins_bp.route("/<plugin_id>/config", methods=["PATCH"])
def update_plugin_config(plugin_id: str):
    app = get_app()
    data = request.get_json(force=True)
    settings = data.get("settings", {})
    if not isinstance(settings, dict):
        return jsonify({"error": "settings must be an object"}), 400
    try:
        saved = app.extension_manager.update_settings(plugin_id, settings)
    except KeyError:
        return jsonify({"error": "Plugin not found"}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True, "settings": saved, "plugin": app.extension_manager.get_plugin(plugin_id)})


@api_plugins_bp.route("/<plugin_id>/ui/<path:filename>", methods=["GET"])
def plugin_ui_asset(plugin_id: str, filename: str):
    """Serve a plugin's custom config UI assets from ``<plugin_root>/ui/``.

    Local-only (gated by the blueprint-level ``_require_local`` hook).
    Refuses to serve unless the plugin's manifest explicitly declares
    ``config_ui``. The plugin's actual root directory is looked up via
    ``ExtensionManager`` rather than derived from the URL — manifest ``id``
    and directory name are independent and we trust the manager's view.
    """
    app = get_app()
    ui_root = app.extension_manager.get_plugin_ui_root(plugin_id)
    if ui_root is None:
        return jsonify({"error": "Plugin not found or config_ui not declared"}), 404

    ui_root = ui_root.resolve()
    try:
        target = (ui_root / filename).resolve()
    except (OSError, ValueError):
        return jsonify({"error": "Invalid path"}), 400
    # send_from_directory rejects ``..`` traversal already, but we check
    # the resolved path is contained under ui_root as defence-in-depth
    # (catches symlink escapes too).
    if ui_root not in target.parents:
        return jsonify({"error": "Invalid path"}), 400
    if not target.is_file():
        return jsonify({"error": "Asset not found"}), 404

    resp = send_from_directory(
        str(ui_root),
        filename,
        conditional=False,
        etag=False,
        max_age=0,
    )
    # Force fresh fetches so plugin reloads aren't masked by the cache.
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    # Override the global X-Frame-Options: DENY so the management UI can embed
    # this asset in a same-origin sandboxed iframe. Route is local-only.
    resp.headers["X-Frame-Options"] = "SAMEORIGIN"
    if not resp.headers.get("Content-Type"):
        guessed, _ = mimetypes.guess_type(filename)
        if guessed:
            resp.headers["Content-Type"] = guessed
    return resp
