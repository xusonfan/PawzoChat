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

"""Release TCP listen ports by terminating the owning process (single-instance UX)."""

from __future__ import annotations

import logging
import os
import re
import signal
import socket
import subprocess
import sys
import time

logger = logging.getLogger(__name__)


def _can_bind(host: str, port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        try:
            s.close()
        except OSError:
            pass


def _pids_listening_on_port(port: int) -> set[int]:
    pids: set[int] = set()
    suffix = f":{port}"
    if sys.platform == "win32":
        r = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
        )
        if r.returncode != 0 or not r.stdout:
            return pids
        for line in r.stdout.splitlines():
            parts = line.split()
            if len(parts) < 5:
                continue
            if parts[3] != "LISTENING":
                continue
            local = parts[1]
            if not local.endswith(suffix):
                continue
            try:
                pids.add(int(parts[-1]))
            except ValueError:
                continue
        return pids

    # POSIX: prefer lsof
    r = subprocess.run(
        ["lsof", "-iTCP:%d" % port, "-sTCP:LISTEN", "-t", "-n", "-P"],
        capture_output=True,
        text=True,
    )
    if r.returncode == 0 and r.stdout.strip():
        for line in r.stdout.strip().splitlines():
            try:
                pids.add(int(line.strip()))
            except ValueError:
                continue
        return pids

    # Fallback: parse `ss -lntp` (Linux)
    r = subprocess.run(
        ["ss", "-lntp"],
        capture_output=True,
        text=True,
        errors="replace",
    )
    if r.returncode != 0 or not r.stdout:
        return pids
    # users:(("python",pid=12345,fd=3))
    pat = re.compile(r"pid=(\d+)")
    for line in r.stdout.splitlines():
        if f":{port} " not in line and not line.rstrip().endswith(f":{port}"):
            continue
        for m in pat.finditer(line):
            try:
                pids.add(int(m.group(1)))
            except ValueError:
                pass
    return pids


def _kill_pid(pid: int) -> bool:
    if pid == os.getpid():
        return False
    if sys.platform == "win32":
        r = subprocess.run(
            ["taskkill", "/PID", str(pid), "/F"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
        )
        return r.returncode == 0
    try:
        os.kill(pid, signal.SIGTERM)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        logger.warning("无权限结束进程 PID %s", pid)
        return False


def ensure_listen_port_free(port: int, host: str = "127.0.0.1", *, label: str = "") -> None:
    """
    If *port* is not bindable on *host*, try to terminate other processes listening on *port*,
    then verify bind succeeds. Raises OSError if the port remains unavailable.
    """
    if _can_bind(host, port):
        return

    pids = _pids_listening_on_port(port) - {os.getpid()}
    if not pids:
        # Still occupied (e.g. TIME_WAIT or different interface); surface bind error
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind((host, port))
        finally:
            s.close()
        return

    tag = f" ({label})" if label else ""
    for pid in sorted(pids):
        logger.info("端口 %s%s 已被占用，正在结束旧进程 PID %s…", port, tag, pid)
        _kill_pid(pid)

    time.sleep(0.6)

    if _can_bind(host, port):
        return

    # One more slow release on Windows
    time.sleep(0.5)
    if _can_bind(host, port):
        return

    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((host, port))
    finally:
        s.close()
