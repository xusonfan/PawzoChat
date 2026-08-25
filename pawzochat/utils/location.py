# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Validation and prompt formatting for one-time shared locations."""

from __future__ import annotations

import math


class InvalidLocation(ValueError):
    """Raised when a location payload cannot be safely persisted."""


def _coordinate(value: object, *, minimum: float, maximum: float, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise InvalidLocation(f"{name} must be a number")
    coordinate = float(value)
    if not math.isfinite(coordinate) or not minimum <= coordinate <= maximum:
        raise InvalidLocation(f"{name} is out of range")
    return coordinate


def sanitize_location(value: object) -> dict:
    """Return the canonical location block and enforce city-level coarsening."""
    if not isinstance(value, dict):
        raise InvalidLocation("location must be an object")

    precision = value.get("precision")
    if precision not in {"precise", "city"}:
        raise InvalidLocation("location precision must be precise or city")

    latitude = _coordinate(
        value.get("latitude"), minimum=-90, maximum=90, name="latitude"
    )
    longitude = _coordinate(
        value.get("longitude"), minimum=-180, maximum=180, name="longitude"
    )

    decimals = 6 if precision == "precise" else 1
    block = {
        "type": "location",
        "precision": precision,
        "latitude": round(latitude, decimals),
        "longitude": round(longitude, decimals),
    }
    if precision == "precise":
        accuracy = value.get("accuracy_m")
        if isinstance(accuracy, (int, float)) and not isinstance(accuracy, bool):
            accuracy = float(accuracy)
            if math.isfinite(accuracy) and 0 <= accuracy <= 100_000:
                block["accuracy_m"] = round(accuracy)
    for key, limit in (("name", 120), ("address", 300)):
        text = value.get(key)
        if isinstance(text, str) and text.strip():
            block[key] = " ".join(text.split())[:limit]
    return block


def format_location_for_llm(location: dict) -> str:
    """Convert a persisted location block into explicit LLM context."""
    precision = location.get("precision")
    latitude = location.get("latitude")
    longitude = location.get("longitude")
    if precision == "city":
        return (
            "[用户主动分享的一次性位置]\n"
            "范围：仅城市级（坐标已降精度，不能视为精确位置）\n"
            f"大致坐标：纬度 {latitude:.1f}，经度 {longitude:.1f}\n"
            "可按用户意图使用可用工具查询天气、规划行程或推荐周边。"
        )

    accuracy = location.get("accuracy_m")
    accuracy_line = f"\n定位精度：约 {accuracy} 米" if accuracy is not None else ""
    name_line = f"\n地点：{location['name']}" if location.get("name") else ""
    address_line = f"\n地址：{location['address']}" if location.get("address") else ""
    return (
        "[用户主动分享的一次性位置]\n"
        "范围：精确位置\n"
        f"坐标：纬度 {latitude:.6f}，经度 {longitude:.6f}"
        f"{accuracy_line}{name_line}{address_line}\n"
        "可按用户意图使用可用工具查询天气、规划行程或推荐周边。"
    )