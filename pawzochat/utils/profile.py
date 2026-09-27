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

"""User profile helpers shared across services and routes."""

from __future__ import annotations

import json

from pawzochat.paths import PROFILE_DIR


def load_profile_name() -> str:
    """Return the user's display name from ``data/profile/profile.json``.

    Falls back to ``"我"`` when the file is missing, unreadable, or the
    ``name`` field is empty.
    """
    path = PROFILE_DIR / "profile.json"
    if not path.is_file():
        return "我"
    try:
        with open(path, "r", encoding="utf-8") as f:
            name = json.load(f).get("name", "我")
    except (json.JSONDecodeError, OSError):
        return "我"
    name = (name or "").strip()
    return name or "我"
