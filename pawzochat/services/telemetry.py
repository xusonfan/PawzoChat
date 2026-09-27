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

"""Anonymous telemetry service.

Collects only a random UUID (generated locally, never derived from
hardware), the application version, and the OS family name. No chat
content, account info, network address, or hardware identifiers are
ever sent. Users can disable this at any time from the web panel; the
change takes effect immediately without restart.

Design notes:

* The anonymous id is persisted to the OS-standard per-user app data
  directory (``USER_DATA_DIR``), so that reinstalls and upgrades keep
  the same id. A secondary copy is written to the portable ``data/``
  directory; either file being present is sufficient to recover the id.
* All network errors are swallowed (logged at debug level). Telemetry
  must never affect the main program's reliability.
* Telemetry is enabled in both development and packaged runs (the
  ``telemetry.enabled`` config flag controls both equally).
* The endpoint, website id and heartbeat interval are project-level
  constants in this module; they are deliberately *not* surfaced in
  ``config.yaml`` so they cannot be broken by user edits.
"""

from __future__ import annotations

import logging
import platform
import threading
import uuid
from typing import Optional

import requests

from pawzochat.paths import TELEMETRY_ID_FALLBACK, TELEMETRY_ID_FILE

logger = logging.getLogger(__name__)

# Project-fixed constants. These are intentionally NOT in config.yaml so
# they cannot be accidentally edited by end users. The only user-facing
# knob is ``telemetry.enabled``.
TELEMETRY_ENDPOINT = "https://analysis.pawzochat.com/api/send"
TELEMETRY_WEBSITE_ID = "049d9b75-3a69-41c4-98b9-8a99d9650b3e"
TELEMETRY_HEARTBEAT_MINUTES = 30

_REQUEST_TIMEOUT_SECONDS = 5.0
_MIN_HEARTBEAT_SECONDS = 60          # Lower bound to guard against misconfig

_FALLBACK_SITE_ID = "69777978-6478-6c00-0000-000000000000"


def _load_or_create_uid() -> str:
    """Read the anonymous id from either persistence location, or create one.

    The primary location (``TELEMETRY_ID_FILE``) lives in the OS per-user
    app data dir; the fallback (``TELEMETRY_ID_FALLBACK``) lives in the
    portable ``data/`` folder. We try both in order, then mirror the
    result back to any missing location on a best-effort basis.
    """
    uid = ""
    for path in (TELEMETRY_ID_FILE, TELEMETRY_ID_FALLBACK):
        try:
            if path.is_file():
                content = path.read_text(encoding="utf-8").strip()
                if content:
                    uid = content
                    break
        except OSError:
            logger.debug("Telemetry id read failed at %s", path, exc_info=True)

    if not uid:
        uid = str(uuid.uuid4())

    for path in (TELEMETRY_ID_FILE, TELEMETRY_ID_FALLBACK):
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.is_file() or path.read_text(encoding="utf-8").strip() != uid:
                path.write_text(uid, encoding="utf-8")
        except OSError:
            logger.debug("Telemetry id write failed at %s", path, exc_info=True)

    return uid


def _app_version() -> str:
    try:
        from pawzochat import __version__
        return str(__version__)
    except Exception:
        return "0.0.0"


class TelemetryClient:
    """Builds Umami-compatible payloads and POSTs them to the endpoint.

    Kept separate from :class:`TelemetryService` so swapping to a
    different analytics backend (PostHog, self-hosted, etc.) only needs
    to touch :meth:`_build_payload` and :meth:`send`.
    """

    def __init__(self, endpoint: str, website_id: str, uid: str, version: str):
        self.endpoint = endpoint
        self.website_id = website_id
        self.uid = uid
        self.version = version
        self.os_family = platform.system() or "Unknown"

    def _build_payload(self, event_name: str) -> dict:
        return {
            "type": "event",
            "payload": {
                "website": self.website_id,
                "hostname": "pawzochat.app",
                "url": f"/{event_name}",
                "referrer": "",
                "language": "zh-CN",
                "screen": "1x1",
                "name": event_name,
                "data": {
                    "uid": self.uid,
                    "version": self.version,
                    "os": self.os_family,
                },
            },
        }

    def send(self, event_name: str) -> bool:
        if not self.endpoint or not self.website_id:
            return False
        try:
            resp = requests.post(
                self.endpoint,
                json=self._build_payload(event_name),
                headers={
                    # Browser-like prefix avoids Umami's isbot filter, which
                    # silently drops requests whose UA matches common bot
                    # keywords (curl, bot, spider, test, ...).
                    "User-Agent": (
                        f"Mozilla/5.0 ({self.os_family}) PawzoChat/{self.version}"
                    ),
                    "Content-Type": "application/json",
                },
                timeout=_REQUEST_TIMEOUT_SECONDS,
            )
            body_preview = resp.text[:200] if resp.text else ""
            ok = 200 <= resp.status_code < 300
            # Umami answers HTTP 200 with the literal body "beep boop" when
            # it classifies the caller as a bot; treat that as a failure so
            # silent drops are still visible in debug logs.
            if ok and "beep" in body_preview.lower():
                ok = False
            if ok:
                logger.debug("Telemetry %s sent (%d)", event_name, resp.status_code)
            else:
                logger.debug(
                    "Telemetry %s rejected: status=%d body=%s",
                    event_name, resp.status_code, body_preview,
                )
            return ok
        except Exception:
            logger.debug("Telemetry %s send failed", event_name, exc_info=True)
            return False


class TelemetryService:
    """Lifecycle wrapper around a background heartbeat thread.

    The service reads the anonymous id eagerly on construction, but only
    spawns the worker thread when :meth:`start` is called and the current
    config resolves to *enabled*. Use :meth:`reload_config` after mutating
    the telemetry config section so the worker reflects the change without
    a restart.
    """

    def __init__(self, config):
        self.config = config
        self._uid = _load_or_create_uid()
        self._version = _app_version()
        self._thread: Optional[threading.Thread] = None
        self._stop_event: Optional[threading.Event] = None
        self._lock = threading.Lock()
        self._running = False

    # ---- Public ----

    @property
    def running(self) -> bool:
        return self._running

    def start(self) -> None:
        if self._resolve_enabled():
            self._spawn_worker()
            logger.info(
                "遥测已启用（匿名ID=%s…，仅上报版本与平台，不含任何聊天内容等隐私信息）",
                self._uid[:8],
            )
        else:
            logger.info(
                "遥测未启动（%s，匿名ID=%s…）",
                self._disabled_reason(), self._uid[:8],
            )

    def _disabled_reason(self) -> str:
        return "用户已关闭"

    def stop(self) -> None:
        with self._lock:
            if not self._running:
                return
            self._running = False
            thread = self._thread
            stop_event = self._stop_event
            self._thread = None
            self._stop_event = None
        if stop_event:
            stop_event.set()
        if thread and thread.is_alive():
            thread.join(timeout=2.0)

    def send_event(self, event_name: str) -> bool:
        """Send a one-shot telemetry event immediately.

        This is independent of the background heartbeat thread --
        it creates a fresh client and sends the event inline.
        Returns True if the send was successful.
        """
        if not self._resolve_enabled():
            return False
        client = self._build_client()
        return client.send(event_name)

    def reload_config(self) -> None:
        """Re-read ``telemetry.*`` config and start/stop the worker accordingly."""
        should_run = self._resolve_enabled()
        if should_run and not self._running:
            self._spawn_worker()
            logger.info("遥测已启用（匿名ID=%s…）", self._uid[:8])
        elif not should_run and self._running:
            self.stop()
            logger.info("遥测已停止")
        elif not should_run and not self._running:
            logger.info("遥测保持关闭（%s）", self._disabled_reason())

    # ---- Internal ----

    def _cfg(self, *keys: str, default=None):
        return self.config.get("telemetry", *keys, default=default)

    def _resolve_enabled(self) -> bool:
        return bool(self._cfg("enabled", default=False))

    def _spawn_worker(self) -> None:
        with self._lock:
            if self._running:
                return
            stop_event = threading.Event()
            self._running = True
            self._stop_event = stop_event
            self._thread = threading.Thread(
                target=self._loop,
                args=(stop_event,),
                name="telemetry",
                daemon=True,
            )
            self._thread.start()

    def _build_client(self) -> TelemetryClient:
        return TelemetryClient(
            endpoint=TELEMETRY_ENDPOINT,
            website_id=TELEMETRY_WEBSITE_ID or _FALLBACK_SITE_ID,
            uid=self._uid,
            version=self._version,
        )

    def _heartbeat_interval(self) -> float:
        return max(
            _MIN_HEARTBEAT_SECONDS,
            float(TELEMETRY_HEARTBEAT_MINUTES) * 60.0,
        )

    def _loop(self, stop_event: threading.Event) -> None:
        client = self._build_client()
        client.send("startup")
        while not stop_event.wait(self._heartbeat_interval()):
            client.send("heartbeat")
