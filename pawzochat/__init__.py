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

import re
import sys
from pathlib import Path


def _read_version() -> str:
    candidates = [
        Path(__file__).resolve().parent.parent / "pyproject.toml",
        Path(sys.executable).parent / "pyproject.toml",          # PyInstaller bundle
        Path(getattr(sys, "_MEIPASS", "")) / "pyproject.toml",   # PyInstaller --onefile
    ]
    for toml_path in candidates:
        if toml_path.exists():
            match = re.search(r'^version\s*=\s*"(.+?)"', toml_path.read_text(encoding="utf-8"), re.M)
            if match:
                return match.group(1)
    return "0.0.0-dev"


__version__ = _read_version()
__project__ = "PawzoChat"
__author__ = bytes.fromhex("6977797864786c").decode("ascii")
