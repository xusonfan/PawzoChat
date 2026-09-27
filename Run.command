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

# PawzoChat launcher for macOS (mirror of Run.bat).

set -o pipefail

cd "$(dirname "$0")" || exit 1

pause_and_exit() {
    local code=${1:-0}
    echo
    read -r -p "按回车退出..." _
    exit "$code"
}

echo "======================================================"
echo "  PawzoChat - 拟人感 · 多功能 · 可扩展的 AI 伙伴引擎"
echo "======================================================"
echo

if command -v python3 >/dev/null 2>&1; then
    PYTHON_CMD=python3
elif command -v python >/dev/null 2>&1; then
    PYTHON_CMD=python
else
    echo "[错误] 未检测到 Python，请先安装 Python 3.10+"
    echo "  推荐: brew install python@3.11  或  https://www.python.org/downloads/macos/"
    pause_and_exit 1
fi

if ! "$PYTHON_CMD" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
    echo "[错误] Python 版本过低，需要 3.10+"
    "$PYTHON_CMD" --version
    pause_and_exit 1
fi

if [ ! -d ".venv" ]; then
    echo "[初始化] 创建虚拟环境..."
    if ! "$PYTHON_CMD" -m venv .venv; then
        echo "[错误] 虚拟环境创建失败"
        pause_and_exit 1
    fi
fi

echo "[启动] 激活虚拟环境..."
# shellcheck disable=SC1091
source .venv/bin/activate

VENV_PY=".venv/bin/python"

echo "[检查] 检测可用 pip 镜像源..."

SOURCE_URL=""
TRUSTED_HOST=""

try_upgrade_pip() {
    local url=$1
    local host=$2
    if [ -n "$host" ]; then
        "$VENV_PY" -m pip install --upgrade pip --index-url "$url" --trusted-host "$host"
    else
        "$VENV_PY" -m pip install --upgrade pip --index-url "$url"
    fi
}

if try_upgrade_pip "https://mirrors.aliyun.com/pypi/simple/" "mirrors.aliyun.com"; then
    SOURCE_URL="https://mirrors.aliyun.com/pypi/simple/"
    TRUSTED_HOST="mirrors.aliyun.com"
    echo "[镜像] 使用阿里源"
elif try_upgrade_pip "https://pypi.tuna.tsinghua.edu.cn/simple" "pypi.tuna.tsinghua.edu.cn"; then
    SOURCE_URL="https://pypi.tuna.tsinghua.edu.cn/simple"
    TRUSTED_HOST="pypi.tuna.tsinghua.edu.cn"
    echo "[镜像] 使用清华源"
elif try_upgrade_pip "https://pypi.org/simple" ""; then
    SOURCE_URL="https://pypi.org/simple"
    TRUSTED_HOST=""
    echo "[镜像] 使用官方源"
else
    echo "[错误] 无可用镜像源，请检查网络"
    pause_and_exit 1
fi

echo "[检查] 安装依赖..."
if [ -n "$TRUSTED_HOST" ]; then
    "$VENV_PY" -m pip install -r requirements.txt \
        --index-url "$SOURCE_URL" --trusted-host "$TRUSTED_HOST"
else
    "$VENV_PY" -m pip install -r requirements.txt --index-url "$SOURCE_URL"
fi

if [ $? -ne 0 ]; then
    echo "[错误] 依赖安装失败，请检查网络或关闭占用 .venv 的程序后重试"
    pause_and_exit 1
fi

clear
echo
echo "[启动] PawzoChat 启动中..."
echo
"$VENV_PY" main.py
rc=$?

pause_and_exit "$rc"
