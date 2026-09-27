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

"""Shared helpers for web route blueprints."""

from __future__ import annotations

import os
from urllib.parse import quote

from flask import Response, current_app


def get_app():
    """Return the PawzoChat App instance stored in Flask config."""
    return current_app.config["PAWZOCHAT_APP"]


def safe_download_stem(name: str) -> str:
    """Strip filesystem-unsafe characters for download filenames."""
    bad = '\\/:*?"<>|\r\n\t'
    return "".join(c for c in (name or "") if c not in bad).strip()[:100]


def _ascii_fallback(filename: str, default: str) -> str:
    """Build an ASCII-only fallback for Content-Disposition's legacy filename=."""
    out = []
    for c in filename or "":
        out.append(c if ord(c) < 128 and c not in '"\\' else "_")
    return "".join(out).strip() or default


def download_response(
    data: bytes,
    mimetype: str,
    filename: str,
    *,
    fallback_stem: str = "download",
) -> Response:
    """Wrap bytes as a browser download response with UTF-8 filename support."""
    ext = os.path.splitext(filename)[1] or ""
    ascii_name = _ascii_fallback(filename, f"{fallback_stem}{ext}")
    quoted = quote(filename, safe="")
    resp = Response(data, mimetype=mimetype)
    resp.headers["Content-Disposition"] = (
        f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quoted}'
    )
    resp.headers["Content-Length"] = str(len(data))
    return resp
