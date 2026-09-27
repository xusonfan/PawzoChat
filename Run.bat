REM PawzoChat - Human-like, versatile, extensible AI companion engine
REM Copyright (C) 2026  iwyxdxl
REM
REM This program is free software: you can redistribute it and/or modify
REM it under the terms of the GNU Affero General Public License as published
REM by the Free Software Foundation, either version 3 of the License, or
REM (at your option) any later version.
REM
REM This program is distributed in the hope that it will be useful,
REM but WITHOUT ANY WARRANTY; without even the implied warranty of
REM MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
REM GNU Affero General Public License for more details.
REM
REM You should have received a copy of the GNU Affero General Public License
REM along with this program.  If not, see <https://www.gnu.org/licenses/>.

@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title PawzoChat

echo ======================================================
echo   PawzoChat - 拟人感 · 多功能 · 可扩展的 AI 伙伴引擎
echo ======================================================
echo.

where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Python，请先安装 Python 3.10+
    pause
    exit /b 1
)

if not exist ".venv" (
    echo [初始化] 创建虚拟环境...
    python -m venv .venv
)

echo [启动] 激活虚拟环境...
call .venv\Scripts\activate.bat

echo [检查] 检测可用 pip 镜像源...

:: 阿里源
python -m pip install --upgrade pip --index-url https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com
if !errorlevel! equ 0 (
    set "SOURCE_URL=https://mirrors.aliyun.com/pypi/simple/"
    set "TRUSTED_HOST=mirrors.aliyun.com"
    echo [镜像] 使用阿里源
    goto :INSTALL_DEPS
)

:: 清华源
python -m pip install --upgrade pip --index-url https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn
if !errorlevel! equ 0 (
    set "SOURCE_URL=https://pypi.tuna.tsinghua.edu.cn/simple"
    set "TRUSTED_HOST=pypi.tuna.tsinghua.edu.cn"
    echo [镜像] 使用清华源
    goto :INSTALL_DEPS
)

:: 官方源
python -m pip install --upgrade pip --index-url https://pypi.org/simple
if !errorlevel! equ 0 (
    set "SOURCE_URL=https://pypi.org/simple"
    set "TRUSTED_HOST="
    echo [镜像] 使用官方源
    goto :INSTALL_DEPS
)

echo [错误] 无可用镜像源，请检查网络
pause
exit /b 1

:INSTALL_DEPS
echo [检查] 安装依赖...
if "!TRUSTED_HOST!"=="" (
    python -m pip install -r requirements.txt --index-url !SOURCE_URL!
) else (
    python -m pip install -r requirements.txt --index-url !SOURCE_URL! --trusted-host !TRUSTED_HOST!
)
if !errorlevel! neq 0 (
    echo [错误] 依赖安装失败，请检查网络或关闭占用 .venv 的程序后重试
    pause
    exit /b 1
)

cls
echo.
echo [启动] PawzoChat 启动中...
echo.
python main.py

pause
