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
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1

set "ROOT=%~dp0"
set "DIST_APP_DIR=%ROOT%dist\PawzoChat"
set "DIST_DATA_DIR=%DIST_APP_DIR%\data"
set "RELEASE_DIR=%ROOT%dist\release"
cd /d "%ROOT%"

goto :main

:resolve_python
set "PYTHON="
if exist "%ROOT%.venv\Scripts\python.exe" (
    set "PYTHON=%ROOT%.venv\Scripts\python.exe"
) else (
    where python >nul 2>&1
    if errorlevel 1 (
        echo Python was not found.
        echo Install Python or create .venv first.
        exit /b 1
    )
    set "PYTHON=python"
)
exit /b 0

:check_pyinstaller
"%PYTHON%" -m PyInstaller --version >nul 2>&1
if errorlevel 1 (
    echo PyInstaller is not available in the selected Python environment.
    echo Run: %PYTHON% -m pip install pyinstaller
    pause
    exit /b 1
)
exit /b 0

:check_main_build_env
"%PYTHON%" -c "import importlib,sys;mods=['yaml','flask','cheroot','Crypto','qrcode','PIL','openai','anyio','httpx','httpcore','cryptography','mcp','anthropic','google.genai'];ns={'importlib':importlib,'mods':mods,'bad':[]};exec('for m in mods:\n    try:\n        importlib.import_module(m)\n    except Exception as e:\n        bad.append(f\"{m}: {e}\")',ns);bad=ns['bad'];print('Main app build environment is incomplete or broken.') if bad else None;print() if bad else None;print('Dependency check failed:') if bad else None;[print('  - '+item) for item in bad];sys.exit(1 if bad else 0)"
if errorlevel 1 (
    echo.
    echo Suggested fix:
    echo   %PYTHON% -m pip install --upgrade pip
    echo   %PYTHON% -m pip install --force-reinstall --no-cache-dir anyio openai httpx httpcore
    echo   %PYTHON% -m pip install -r requirements.txt
    echo   %PYTHON% -m pip install pyinstaller
    exit /b 1
)
exit /b 0

:scan_mcp_servers
set "MCP_COUNT=0"
for /d %%D in ("%ROOT%data\mcp_servers\*") do (
    if exist "%%~fD\server.py" (
        set /a MCP_COUNT+=1
        set "MCP_SCRIPT[!MCP_COUNT!]=%%~fD\server.py"
        set "MCP_NAME[!MCP_COUNT!]=%%~nxD"
    )
)

if "%MCP_COUNT%"=="0" (
    echo No MCP server.py files were found under data\mcp_servers.
    exit /b 1
)
exit /b 0

:select_mcp
cls
echo ========================================
echo   Select MCP Server
echo ========================================
echo.
for /l %%I in (1,1,%MCP_COUNT%) do (
    echo %%I. !MCP_NAME[%%I]!
)
echo 0. Back
echo.
set "SELECTED_MCP_INDEX="
set "selection="
set /p "selection=Enter MCP number: "

if "%selection%"=="0" exit /b 0

for /f "delims=0123456789" %%A in ("%selection%") do (
    echo Invalid number.
    pause
    exit /b 0
)

if "%selection%"=="" (
    echo Invalid number.
    pause
    exit /b 0
)

if %selection% LSS 1 (
    echo Invalid number.
    pause
    exit /b 0
)
if %selection% GTR %MCP_COUNT% (
    echo Invalid number.
    pause
    exit /b 0
)

set "SELECTED_MCP_INDEX=%selection%"
exit /b 0

:build_main
if not exist "%ROOT%PawzoChat.spec" (
    echo PawzoChat.spec was not found.
    exit /b 1
)
call :check_main_build_env
if errorlevel 1 exit /b 1
echo.
echo [build] main app
"%PYTHON%" -m PyInstaller --noconfirm --clean "%ROOT%PawzoChat.spec"
if errorlevel 1 exit /b %errorlevel%
call :sync_release_data
exit /b %errorlevel%

:build_all_mcp
set "BUILD_ERROR=0"
for /l %%I in (1,1,%MCP_COUNT%) do (
    call :build_mcp_by_index %%I
    if errorlevel 1 set "BUILD_ERROR=1"
)
exit /b %BUILD_ERROR%

:build_mcp_by_index
set "INDEX=%~1"
set "SCRIPT_PATH=!MCP_SCRIPT[%INDEX%]!"
set "SERVER_NAME=!MCP_NAME[%INDEX%]!"

if not defined SCRIPT_PATH (
    echo Invalid MCP index: %INDEX%
    exit /b 1
)

for %%P in ("!SCRIPT_PATH!") do set "DIST_DIR=%%~dpP"
if "!DIST_DIR:~-1!"=="\" set "DIST_DIR=!DIST_DIR:~0,-1!"
set "WORK_DIR=%ROOT%build\builtin_mcp\!SERVER_NAME!\work"
set "SPEC_DIR=%ROOT%build\builtin_mcp\!SERVER_NAME!\spec"

echo.
echo [build] !SERVER_NAME!
"%PYTHON%" -m PyInstaller ^
    --noconfirm ^
    --clean ^
    --onefile ^
    --name server ^
    --distpath "!DIST_DIR!" ^
    --workpath "!WORK_DIR!" ^
    --specpath "!SPEC_DIR!" ^
    --hidden-import yaml ^
    --hidden-import mcp.types ^
    --hidden-import mcp.server.fastmcp ^
    --collect-submodules mcp.server ^
    --collect-submodules mcp.shared ^
    --hidden-import openai ^
    "!SCRIPT_PATH!"
exit /b %errorlevel%

:resolve_release_meta
set "APP_VERSION="
"%PYTHON%" -c "import pathlib,tomllib; data=tomllib.loads(pathlib.Path('pyproject.toml').read_text(encoding='utf-8')); print(data.get('project', {}).get('version', '0.0.0'))" > "%TEMP%\_pawzo_ver.txt" 2>nul
if errorlevel 1 (
    echo Failed to resolve project version from pyproject.toml.
    del "%TEMP%\_pawzo_ver.txt" 2>nul
    exit /b 1
)
set /p APP_VERSION=<"%TEMP%\_pawzo_ver.txt"
del "%TEMP%\_pawzo_ver.txt" 2>nul
if not defined APP_VERSION (
    echo Failed to resolve project version from pyproject.toml.
    exit /b 1
)

set "PLATFORM_TAG="
"%PYTHON%" -c "import platform; machine=platform.machine().lower(); arch={'x86_64':'amd64','amd64':'amd64','aarch64':'arm64','arm64':'arm64'}.get(machine, machine); print(f'win-{arch}')" > "%TEMP%\_pawzo_tag.txt" 2>nul
if errorlevel 1 (
    echo Failed to resolve platform tag.
    del "%TEMP%\_pawzo_tag.txt" 2>nul
    exit /b 1
)
set /p PLATFORM_TAG=<"%TEMP%\_pawzo_tag.txt"
del "%TEMP%\_pawzo_tag.txt" 2>nul
if not defined PLATFORM_TAG (
    echo Failed to resolve platform tag.
    exit /b 1
)

set "RELEASE_NAME=PawzoChat-v%APP_VERSION%-%PLATFORM_TAG%"
set "RELEASE_ZIP=%RELEASE_DIR%\%RELEASE_NAME%.zip"
exit /b 0

:sync_release_data
if not exist "%DIST_APP_DIR%\PawzoChat.exe" (
    echo Main app output was not found: %DIST_APP_DIR%
    echo Build the main app first.
    exit /b 1
)
if not exist "%ROOT%data\emoji\default" (
    echo Required directory was not found: %ROOT%data\emoji\default
    exit /b 1
)
if not exist "%ROOT%data\emoji\default2" (
    echo Required directory was not found: %ROOT%data\emoji\default2
    exit /b 1
)
if not exist "%ROOT%data\mcp_servers" (
    echo Required directory was not found: %ROOT%data\mcp_servers
    exit /b 1
)

echo [sync] release notices
copy /y "%ROOT%LICENSE" "%DIST_APP_DIR%\LICENSE" >nul
if errorlevel 1 exit /b 1
copy /y "%ROOT%NOTICE.md" "%DIST_APP_DIR%\NOTICE.md" >nul
if errorlevel 1 exit /b 1

echo [clean] release data
if exist "%DIST_DATA_DIR%" (
    rmdir /s /q "%DIST_DATA_DIR%"
    if exist "%DIST_DATA_DIR%" (
        echo Failed to clean release data directory: %DIST_DATA_DIR%
        exit /b 1
    )
)
mkdir "%DIST_DATA_DIR%" >nul 2>&1

echo [sync] data\emoji\default
robocopy "%ROOT%data\emoji\default" "%DIST_DATA_DIR%\emoji\default" /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
    echo Failed to sync data\emoji\default
    exit /b 1
)

echo [sync] data\emoji\default2
robocopy "%ROOT%data\emoji\default2" "%DIST_DATA_DIR%\emoji\default2" /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
    echo Failed to sync data\emoji\default2
    exit /b 1
)

echo [sync] data\theme
robocopy "%ROOT%data\theme" "%DIST_DATA_DIR%\theme" /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
    echo Failed to sync data\theme
    exit /b 1
)

echo [sync] data\mcp_servers
robocopy "%ROOT%data\mcp_servers" "%DIST_DATA_DIR%\mcp_servers" /MIR /XD __pycache__ /XF *.pyc /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
    echo Failed to sync data\mcp_servers
    exit /b 1
)

set "MISSING_PACKAGED_MCP=0"
for /d %%D in ("%DIST_DATA_DIR%\mcp_servers\*") do (
    if exist "%%~fD\server.py" if not exist "%%~fD\server.exe" (
        if "!MISSING_PACKAGED_MCP!"=="0" echo [warn] Some builtin MCP servers do not have server.exe yet.
        echo [warn] Missing packaged MCP executable: %%~nxD\server.exe
        set "MISSING_PACKAGED_MCP=1"
    )
)
if "!MISSING_PACKAGED_MCP!"=="1" (
    echo [warn] Build all MCP servers before generating the release zip.
)
exit /b 0

:package_release_zip
call :resolve_release_meta
if errorlevel 1 exit /b 1

call :sync_release_data
if errorlevel 1 exit /b 1

if not exist "%RELEASE_DIR%" mkdir "%RELEASE_DIR%"

echo.
echo [package] %RELEASE_NAME%
powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -LiteralPath '%DIST_APP_DIR%' -DestinationPath '%RELEASE_ZIP%' -Force"
if errorlevel 1 (
    echo Failed to create release zip.
    exit /b 1
)

echo Release zip created:
echo   %RELEASE_ZIP%
exit /b 0

:main
call :resolve_python
if errorlevel 1 exit /b 1

call :check_pyinstaller
if errorlevel 1 exit /b 1

:menu
cls
echo ========================================
echo   PawzoChat Windows Build Menu
echo ========================================
echo.
echo Python: %PYTHON%
echo.
echo 1. Build main app
echo 2. Build all MCP servers
echo 3. Build one MCP server
echo 4. Build main app and all MCP servers
echo 5. Package release zip
echo 6. Build main app, all MCP servers, and release zip
echo 7. Exit
echo.
set "choice="
set /p "choice=Enter choice: "

if "%choice%"=="1" goto build_main_menu
if "%choice%"=="2" goto build_all_mcp_menu
if "%choice%"=="3" goto build_one_mcp_menu
if "%choice%"=="4" goto build_all_menu
if "%choice%"=="5" goto package_release_menu
if "%choice%"=="6" goto build_release_menu
if "%choice%"=="7" goto end

echo.
echo Invalid choice.
pause
goto menu

:build_main_menu
call :build_main
pause
goto menu

:build_all_mcp_menu
call :scan_mcp_servers
if errorlevel 1 (
    pause
    goto menu
)
call :build_all_mcp
if not errorlevel 1 (
    if exist "%DIST_APP_DIR%\PawzoChat.exe" call :sync_release_data
)
pause
goto menu

:build_one_mcp_menu
call :scan_mcp_servers
if errorlevel 1 (
    pause
    goto menu
)
call :select_mcp
if not defined SELECTED_MCP_INDEX goto menu
call :build_mcp_by_index %SELECTED_MCP_INDEX%
if not errorlevel 1 (
    if exist "%DIST_APP_DIR%\PawzoChat.exe" call :sync_release_data
)
pause
goto menu

:build_all_menu
call :build_main
if errorlevel 1 (
    pause
    goto menu
)
call :scan_mcp_servers
if errorlevel 1 (
    pause
    goto menu
)
call :build_all_mcp
if errorlevel 1 (
    pause
    goto menu
)
call :sync_release_data
pause
goto menu

:package_release_menu
call :package_release_zip
pause
goto menu

:build_release_menu
call :build_main
if errorlevel 1 (
    pause
    goto menu
)
call :scan_mcp_servers
if errorlevel 1 (
    pause
    goto menu
)
call :build_all_mcp
if errorlevel 1 (
    pause
    goto menu
)
call :package_release_zip
pause
goto menu

:end
endlocal
exit /b 0
