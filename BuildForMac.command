#!/usr/bin/env bash
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

# PawzoChat PyInstaller build helper for macOS (mirror of BuildForWin.bat).

set -o pipefail

cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"

DIST_APP_DIR="$ROOT/dist/PawzoChat"
DIST_DATA_DIR="$DIST_APP_DIR/data"
RELEASE_DIR="$ROOT/dist/release"

PYTHON=""
MCP_NAMES=()
MCP_SCRIPTS=()
SELECTED_MCP_INDEX=""
APP_VERSION=""
PLATFORM_TAG=""
RELEASE_NAME=""
RELEASE_ZIP=""

pause() {
    echo
    read -r -p "按回车继续..." _
}

# --- environment ------------------------------------------------------------

resolve_python() {
    if [ -x "$ROOT/.venv/bin/python" ]; then
        PYTHON="$ROOT/.venv/bin/python"
    elif command -v python3 >/dev/null 2>&1; then
        PYTHON="$(command -v python3)"
    elif command -v python >/dev/null 2>&1; then
        PYTHON="$(command -v python)"
    else
        echo "Python was not found."
        echo "Install Python or create .venv first."
        return 1
    fi
}

check_pyinstaller() {
    if ! "$PYTHON" -m PyInstaller --version >/dev/null 2>&1; then
        echo "PyInstaller is not available in the selected Python environment."
        echo "Run: $PYTHON -m pip install pyinstaller"
        return 1
    fi
}

check_main_build_env() {
    "$PYTHON" - <<'PY'
import importlib, sys

mods = [
    "yaml", "flask", "cheroot", "Crypto", "qrcode", "PIL", "openai", "anyio",
    "httpx", "httpcore", "cryptography", "mcp", "anthropic", "google.genai",
]
bad = []
for m in mods:
    try:
        importlib.import_module(m)
    except Exception as e:  # noqa: BLE001
        bad.append(f"{m}: {e}")

if bad:
    print("Main app build environment is incomplete or broken.")
    print()
    print("Dependency check failed:")
    for item in bad:
        print("  - " + item)
    sys.exit(1)
PY
    local rc=$?
    if [ $rc -ne 0 ]; then
        echo
        echo "Suggested fix:"
        echo "  $PYTHON -m pip install --upgrade pip"
        echo "  $PYTHON -m pip install --force-reinstall --no-cache-dir anyio openai httpx httpcore"
        echo "  $PYTHON -m pip install -r requirements.txt"
        echo "  $PYTHON -m pip install pyinstaller"
        return 1
    fi
}

# --- MCP discovery ----------------------------------------------------------

scan_mcp_servers() {
    MCP_NAMES=()
    MCP_SCRIPTS=()
    local d
    if [ -d "$ROOT/data/mcp_servers" ]; then
        for d in "$ROOT/data/mcp_servers"/*/; do
            [ -d "$d" ] || continue
            if [ -f "${d}server.py" ]; then
                MCP_NAMES+=("$(basename "$d")")
                MCP_SCRIPTS+=("${d}server.py")
            fi
        done
    fi
    if [ ${#MCP_NAMES[@]} -eq 0 ]; then
        echo "No MCP server.py files were found under data/mcp_servers."
        return 1
    fi
}

select_mcp() {
    SELECTED_MCP_INDEX=""
    clear
    echo "========================================"
    echo "  Select MCP Server"
    echo "========================================"
    echo
    local i
    for i in "${!MCP_NAMES[@]}"; do
        printf "%d. %s\n" "$((i + 1))" "${MCP_NAMES[i]}"
    done
    echo "0. Back"
    echo
    read -r -p "Enter MCP number: " selection

    if [ -z "$selection" ] || [ "$selection" = "0" ]; then
        return 0
    fi
    if ! [[ "$selection" =~ ^[0-9]+$ ]]; then
        echo "Invalid number."
        pause
        return 0
    fi
    if [ "$selection" -lt 1 ] || [ "$selection" -gt "${#MCP_NAMES[@]}" ]; then
        echo "Invalid number."
        pause
        return 0
    fi
    SELECTED_MCP_INDEX="$selection"
}

# --- build ------------------------------------------------------------------

build_main() {
    if [ ! -f "$ROOT/PawzoChat.spec" ]; then
        echo "PawzoChat.spec was not found."
        return 1
    fi
    check_main_build_env || return 1
    echo
    echo "[build] main app"
    if ! "$PYTHON" -m PyInstaller --noconfirm --clean "$ROOT/PawzoChat.spec"; then
        return $?
    fi
    sync_release_data
}

build_mcp_by_index() {
    local idx=$(( $1 - 1 ))
    if [ "$idx" -lt 0 ] || [ "$idx" -ge "${#MCP_SCRIPTS[@]}" ]; then
        echo "Invalid MCP index: $1"
        return 1
    fi
    local script_path="${MCP_SCRIPTS[idx]}"
    local server_name="${MCP_NAMES[idx]}"
    local dist_dir
    dist_dir="$(dirname "$script_path")"
    local work_dir="$ROOT/build/builtin_mcp/$server_name/work"
    local spec_dir="$ROOT/build/builtin_mcp/$server_name/spec"

    echo
    echo "[build] $server_name"
    "$PYTHON" -m PyInstaller \
        --noconfirm \
        --clean \
        --onefile \
        --name server \
        --distpath "$dist_dir" \
        --workpath "$work_dir" \
        --specpath "$spec_dir" \
        --hidden-import yaml \
        --hidden-import mcp.types \
        --hidden-import mcp.server.fastmcp \
        --collect-submodules mcp.server \
        --collect-submodules mcp.shared \
        --hidden-import openai \
        "$script_path"
}

build_all_mcp() {
    local rc=0
    local i
    for i in "${!MCP_NAMES[@]}"; do
        if ! build_mcp_by_index "$((i + 1))"; then
            rc=1
        fi
    done
    return $rc
}

# --- release ----------------------------------------------------------------

resolve_release_meta() {
    APP_VERSION="$(
        "$PYTHON" -c "import pathlib,tomllib; data=tomllib.loads(pathlib.Path('pyproject.toml').read_text(encoding='utf-8')); print(data.get('project', {}).get('version', '0.0.0'))" 2>/dev/null
    )"
    if [ -z "$APP_VERSION" ]; then
        echo "Failed to resolve project version from pyproject.toml."
        return 1
    fi

    PLATFORM_TAG="$(
        "$PYTHON" -c "import platform; machine=platform.machine().lower(); arch={'x86_64':'amd64','amd64':'amd64','aarch64':'arm64','arm64':'arm64'}.get(machine, machine); print(f'mac-{arch}')" 2>/dev/null
    )"
    if [ -z "$PLATFORM_TAG" ]; then
        echo "Failed to resolve platform tag."
        return 1
    fi

    RELEASE_NAME="PawzoChat-v${APP_VERSION}-${PLATFORM_TAG}"
    RELEASE_ZIP="$RELEASE_DIR/$RELEASE_NAME.zip"
}

sync_release_data() {
    if [ ! -x "$DIST_APP_DIR/PawzoChat" ]; then
        echo "Main app output was not found: $DIST_APP_DIR"
        echo "Build the main app first."
        return 1
    fi
    if [ ! -d "$ROOT/data/emoji/default" ]; then
        echo "Required directory was not found: $ROOT/data/emoji/default"
        return 1
    fi
    if [ ! -d "$ROOT/data/emoji/default2" ]; then
        echo "Required directory was not found: $ROOT/data/emoji/default2"
        return 1
    fi
    if [ ! -d "$ROOT/data/mcp_servers" ]; then
        echo "Required directory was not found: $ROOT/data/mcp_servers"
        return 1
    fi

    echo "[sync] release notices"
    cp "$ROOT/LICENSE" "$DIST_APP_DIR/LICENSE" || return 1
    cp "$ROOT/NOTICE.md" "$DIST_APP_DIR/NOTICE.md" || return 1

    echo "[clean] release data"
    rm -rf "$DIST_DATA_DIR"
    if [ -e "$DIST_DATA_DIR" ]; then
        echo "Failed to clean release data directory: $DIST_DATA_DIR"
        return 1
    fi
    mkdir -p "$DIST_DATA_DIR"

    echo "[sync] data/emoji/default"
    mkdir -p "$DIST_DATA_DIR/emoji/default"
    if ! rsync -a --delete \
        "$ROOT/data/emoji/default/" "$DIST_DATA_DIR/emoji/default/"; then
        echo "Failed to sync data/emoji/default"
        return 1
    fi

    echo "[sync] data/emoji/default2"
    mkdir -p "$DIST_DATA_DIR/emoji/default2"
    if ! rsync -a --delete \
        "$ROOT/data/emoji/default2/" "$DIST_DATA_DIR/emoji/default2/"; then
        echo "Failed to sync data/emoji/default2"
        return 1
    fi

    if [ -d "$ROOT/data/theme" ]; then
        echo "[sync] data/theme"
        mkdir -p "$DIST_DATA_DIR/theme"
        if ! rsync -a --delete \
            "$ROOT/data/theme/" "$DIST_DATA_DIR/theme/"; then
            echo "Failed to sync data/theme"
            return 1
        fi
    fi

    echo "[sync] data/mcp_servers"
    mkdir -p "$DIST_DATA_DIR/mcp_servers"
    if ! rsync -a --delete \
        --exclude '__pycache__' \
        --exclude '*.pyc' \
        "$ROOT/data/mcp_servers/" "$DIST_DATA_DIR/mcp_servers/"; then
        echo "Failed to sync data/mcp_servers"
        return 1
    fi

    local missing=0
    local d
    for d in "$DIST_DATA_DIR/mcp_servers"/*/; do
        [ -d "$d" ] || continue
        if [ -f "${d}server.py" ] && [ ! -x "${d}server" ]; then
            if [ $missing -eq 0 ]; then
                echo "[warn] Some builtin MCP servers do not have a 'server' binary yet."
            fi
            echo "[warn] Missing packaged MCP executable: $(basename "$d")/server"
            missing=1
        fi
    done
    if [ $missing -eq 1 ]; then
        echo "[warn] Build all MCP servers before generating the release zip."
    fi
}

package_release_zip() {
    resolve_release_meta || return 1
    sync_release_data || return 1

    mkdir -p "$RELEASE_DIR"
    echo
    echo "[package] $RELEASE_NAME"
    rm -f "$RELEASE_ZIP"
    if ! ( cd "$ROOT/dist" && zip -qry "$RELEASE_ZIP" "PawzoChat" ); then
        echo "Failed to create release zip."
        return 1
    fi

    echo "Release zip created:"
    echo "  $RELEASE_ZIP"
}

# --- menu -------------------------------------------------------------------

menu() {
    while true; do
        clear
        echo "========================================"
        echo "  PawzoChat macOS Build Menu"
        echo "========================================"
        echo
        echo "Python: $PYTHON"
        echo
        echo "1. Build main app"
        echo "2. Build all MCP servers"
        echo "3. Build one MCP server"
        echo "4. Build main app and all MCP servers"
        echo "5. Package release zip"
        echo "6. Build main app, all MCP servers, and release zip"
        echo "7. Exit"
        echo
        read -r -p "Enter choice: " choice
        case "$choice" in
            1)
                build_main
                pause
                ;;
            2)
                if scan_mcp_servers; then
                    if build_all_mcp && [ -x "$DIST_APP_DIR/PawzoChat" ]; then
                        sync_release_data
                    fi
                fi
                pause
                ;;
            3)
                if scan_mcp_servers; then
                    select_mcp
                    if [ -n "$SELECTED_MCP_INDEX" ]; then
                        if build_mcp_by_index "$SELECTED_MCP_INDEX" \
                            && [ -x "$DIST_APP_DIR/PawzoChat" ]; then
                            sync_release_data
                        fi
                    fi
                fi
                pause
                ;;
            4)
                if build_main && scan_mcp_servers && build_all_mcp; then
                    sync_release_data
                fi
                pause
                ;;
            5)
                package_release_zip
                pause
                ;;
            6)
                if build_main && scan_mcp_servers && build_all_mcp; then
                    package_release_zip
                fi
                pause
                ;;
            7)
                exit 0
                ;;
            *)
                echo
                echo "Invalid choice."
                pause
                ;;
        esac
    done
}

main() {
    resolve_python || exit 1
    check_pyinstaller || exit 1
    menu
}

main "$@"
