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

# -*- mode: python ; coding: utf-8 -*-

import re
import sys
from pathlib import Path


project_root = Path.cwd().resolve()


def _resolve_icon() -> str | None:
    """Pick a platform-appropriate icon if one is available."""
    if sys.platform == "darwin":
        candidate = project_root / "logo.icns"
    elif sys.platform == "win32":
        candidate = project_root / "logo.ico"
    else:
        candidate = None
    return str(candidate) if candidate and candidate.exists() else None


def _read_project_version() -> str:
    project_file = project_root / "pyproject.toml"
    match = re.search(
        r'^version\s*=\s*"(.+?)"',
        project_file.read_text(encoding="utf-8"),
        re.MULTILINE,
    )
    return match.group(1) if match else "0.0.0"


def _resolve_windows_version_info():
    if sys.platform != "win32":
        return None

    from PyInstaller.utils.win32.versioninfo import (
        FixedFileInfo,
        StringFileInfo,
        StringStruct,
        StringTable,
        VarFileInfo,
        VarStruct,
        VSVersionInfo,
    )

    version = _read_project_version()
    numeric_parts = [int(part) if part.isdigit() else 0 for part in version.split(".")[:4]]
    numeric_parts.extend([0] * (4 - len(numeric_parts)))
    version_tuple = tuple(numeric_parts)

    return VSVersionInfo(
        ffi=FixedFileInfo(
            filevers=version_tuple,
            prodvers=version_tuple,
            mask=0x3F,
            flags=0x0,
            OS=0x40004,
            fileType=0x1,
            subtype=0x0,
            date=(0, 0),
        ),
        kids=[
            StringFileInfo([
                StringTable(
                    "040904B0",
                    [
                        StringStruct("CompanyName", "iwyxdxl"),
                        StringStruct("FileDescription", "PawzoChat"),
                        StringStruct("FileVersion", version),
                        StringStruct("InternalName", "PawzoChat"),
                        StringStruct(
                            "LegalCopyright",
                            "Copyright (C) 2026 iwyxdxl",
                        ),
                        StringStruct("OriginalFilename", "PawzoChat.exe"),
                        StringStruct("ProductName", "PawzoChat"),
                        StringStruct("ProductVersion", version),
                    ],
                ),
            ]),
            VarFileInfo([VarStruct("Translation", [1033, 1200])]),
        ],
    )


_icon = _resolve_icon()
_version_info = _resolve_windows_version_info()

datas = [
    (str(project_root / "pyproject.toml"), "."),
    (str(project_root / "LICENSE"), "."),
    (str(project_root / "NOTICE.md"), "."),
    (str(project_root / "pawzochat" / "web" / "templates"), "pawzochat/web/templates"),
    (str(project_root / "pawzochat" / "web" / "static"), "pawzochat/web/static"),
    (str(project_root / "data" / "emoji" / "default"), "data/emoji/default"),
    (str(project_root / "data" / "mcp_servers"), "data/mcp_servers"),
]

hiddenimports = [
    "cheroot.wsgi",
    "cheroot.ssl.builtin",
    "qrcode.image.pil",
    "websocket",
    "miniaudio",
    "_cffi_backend",
    "pysilk",
]

a = Analysis(
    [str(project_root / "main.py")],
    pathex=[str(project_root)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="PawzoChat",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    icon=_icon,
    version=_version_info,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="PawzoChat",
)
