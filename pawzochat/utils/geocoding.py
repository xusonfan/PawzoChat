# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Small OpenStreetMap Nominatim client for the interactive location picker."""

from __future__ import annotations

import json
import threading
import time
from functools import lru_cache
from urllib.parse import urlencode
from urllib.request import Request, urlopen

_NOMINATIM_BASE = "https://nominatim.openstreetmap.org"
_USER_AGENT = "PawzoChat/1.0 (https://github.com/iwyxdxl/PawzoChat)"
_REQUEST_LOCK = threading.Lock()
_last_request_at = 0.0


def _get_json(path: str, params: dict[str, object]) -> object:
    global _last_request_at
    url = f"{_NOMINATIM_BASE}{path}?{urlencode(params)}"
    request = Request(url, headers={
        "Accept": "application/json",
        "User-Agent": _USER_AGENT,
    })
    with _REQUEST_LOCK:
        delay = 1.0 - (time.monotonic() - _last_request_at)
        if delay > 0:
            time.sleep(delay)
        try:
            with urlopen(request, timeout=8) as response:
                return json.load(response)
        finally:
            _last_request_at = time.monotonic()


def _place(value: dict) -> dict | None:
    try:
        latitude = float(value["lat"])
        longitude = float(value["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    address = value.get("address") if isinstance(value.get("address"), dict) else {}
    name = str(
        value.get("name")
        or address.get("amenity")
        or address.get("building")
        or address.get("road")
        or address.get("suburb")
        or address.get("city")
        or address.get("town")
        or address.get("county")
        or "所选位置"
    ).strip()[:120]
    display_name = str(value.get("display_name") or name).strip()[:300]
    return {
        "name": name,
        "address": display_name,
        "latitude": latitude,
        "longitude": longitude,
    }


@lru_cache(maxsize=128)
def search_places(query: str, *, limit: int = 6) -> list[dict]:
    payload = _get_json("/search", {
        "format": "jsonv2",
        "addressdetails": 1,
        "accept-language": "zh-CN,zh,en",
        "limit": max(1, min(limit, 8)),
        "q": query,
    })
    if not isinstance(payload, list):
        return []
    return [place for item in payload if isinstance(item, dict) if (place := _place(item))]


@lru_cache(maxsize=256)
def reverse_place(latitude: float, longitude: float) -> dict | None:
    payload = _get_json("/reverse", {
        "format": "jsonv2",
        "addressdetails": 1,
        "accept-language": "zh-CN,zh,en",
        "zoom": 18,
        "lat": latitude,
        "lon": longitude,
    })
    return _place(payload) if isinstance(payload, dict) else None