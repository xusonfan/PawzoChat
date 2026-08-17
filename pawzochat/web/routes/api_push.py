# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

"""REST API for browser Web Push subscriptions."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from pawzochat.web.routes import get_app

api_push_bp = Blueprint("api_push", __name__)


def _service():
    return get_app().web_push_service


@api_push_bp.route("/public-key", methods=["GET"])
def public_key():
    service = _service()
    if service is None:
        return jsonify({"error": "Web Push 服务不可用"}), 503
    return jsonify({"public_key": service.public_key})


@api_push_bp.route("/subscriptions", methods=["POST"])
def subscribe():
    service = _service()
    if service is None:
        return jsonify({"error": "Web Push 服务不可用"}), 503
    data = request.get_json(silent=True) or {}
    try:
        result = service.subscribe(data.get("subscription"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(result)


@api_push_bp.route("/subscriptions", methods=["DELETE"])
def unsubscribe():
    service = _service()
    if service is None:
        return jsonify({"error": "Web Push 服务不可用"}), 503
    data = request.get_json(silent=True) or {}
    endpoint = str(data.get("endpoint") or "").strip()
    if not endpoint:
        return jsonify({"error": "订阅地址不能为空"}), 400
    return jsonify(service.unsubscribe(endpoint))