# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

"""Speech-to-text proxy for OpenAI-compatible ASR services."""

from __future__ import annotations

import logging
from urllib.parse import urlsplit

import requests
from flask import Blueprint, jsonify, request
from werkzeug.utils import secure_filename

from pawzochat.web.routes import get_app

api_asr_bp = Blueprint("api_asr", __name__)
logger = logging.getLogger(__name__)

_MAX_AUDIO_BYTES = 25 * 1024 * 1024
_DEFAULT_FILENAME = "recording.webm"


def _transcriptions_url(base_url: str) -> str:
    base = (base_url or "").strip().rstrip("/")
    if base.endswith("/audio/transcriptions"):
        return base
    if not base.endswith("/v1"):
        base += "/v1"
    return base + "/audio/transcriptions"


def _public_config(config: dict | None, *, minimal: bool = False) -> dict:
    value = dict(config or {})
    if minimal:
        return {"enabled": bool(value.get("enabled", False))}
    value["has_api_key"] = bool(value.get("api_key"))
    value.pop("api_key", None)
    return value


def _validate_config_patch(value) -> tuple[dict | None, str | None]:
    if not isinstance(value, dict):
        return None, "ASR 配置格式无效"

    patch = {}
    if "enabled" in value:
        patch["enabled"] = bool(value["enabled"])
    if "base_url" in value:
        base_url = str(value["base_url"] or "").strip().rstrip("/")
        parsed = urlsplit(base_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return None, "ASR 服务地址必须是有效的 HTTP(S) URL"
        patch["base_url"] = base_url
    if "model" in value:
        model = str(value["model"] or "").strip()
        if not model or len(model) > 100:
            return None, "ASR 模型名称无效"
        patch["model"] = model
    if "api_key" in value:
        patch["api_key"] = str(value["api_key"] or "").strip()
    return patch, None


@api_asr_bp.route("/settings", methods=["GET", "PATCH"])
def asr_settings():
    app = get_app()
    is_public = request.environ.get("pawzochat.is_public", False)
    if request.method == "GET":
        return jsonify(_public_config(
            app.config.get("asr", default={}),
            minimal=is_public,
        ))
    if is_public:
        return jsonify({"error": "ASR 设置仅限本地访问修改"}), 403

    patch, error = _validate_config_patch(request.get_json(force=True))
    if error:
        return jsonify({"error": error}), 400
    app.config._data.setdefault("asr", {}).update(patch or {})
    app.config.save()
    return jsonify({"ok": True, **_public_config(app.config.get("asr", default={}))})


@api_asr_bp.route("/transcriptions", methods=["POST"])
def transcribe_audio():
    app = get_app()
    config = app.config.get("asr", default={}) or {}
    if not config.get("enabled", False):
        return jsonify({"error": "ASR 服务未启用"}), 503

    audio = request.files.get("file")
    if audio is None or not audio.filename:
        return jsonify({"error": "未收到录音文件"}), 400

    payload = audio.read(_MAX_AUDIO_BYTES + 1)
    if not payload:
        return jsonify({"error": "录音内容为空"}), 400
    if len(payload) > _MAX_AUDIO_BYTES:
        return jsonify({"error": "录音文件不能超过 25 MB"}), 413

    filename = secure_filename(audio.filename) or _DEFAULT_FILENAME
    base_url = str(config.get("base_url") or "").strip()
    if not base_url:
        return jsonify({"error": "ASR 服务地址未配置"}), 503

    headers = {}
    api_key = str(config.get("api_key") or "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    try:
        response = requests.post(
            _transcriptions_url(base_url),
            headers=headers,
            data={"model": config.get("model") or "qwen3-asr:itn"},
            files={"file": (filename, payload, audio.mimetype or "application/octet-stream")},
            timeout=max(10, min(int(config.get("timeout_seconds") or 300), 600)),
        )
    except requests.Timeout:
        return jsonify({"error": "ASR 识别超时"}), 504
    except requests.RequestException as exc:
        logger.warning("ASR 服务连接失败: %s", exc)
        return jsonify({"error": "无法连接 ASR 服务，请检查服务地址"}), 502

    try:
        result = response.json()
    except ValueError:
        logger.warning("ASR 服务返回非 JSON 响应，状态码=%s", response.status_code)
        return jsonify({"error": "ASR 服务返回了无效响应"}), 502

    if not response.ok:
        error = result.get("error") if isinstance(result, dict) else None
        return jsonify({"error": str(error or f"ASR 识别失败 ({response.status_code})")}), 502

    text = result.get("text") if isinstance(result, dict) else None
    if not isinstance(text, str):
        return jsonify({"error": "ASR 响应缺少识别文本"}), 502
    return jsonify({"text": text.strip(), "lang": result.get("lang")})