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

"""Session-local QQ active-message pacing and automatic recovery.

One policy belongs to one QQClient generation. Passive replies do not use it.
"""
from __future__ import annotations

from collections import deque
from contextlib import contextmanager
import logging
import threading
import time

logger = logging.getLogger(__name__)
_COOLDOWN_SECONDS = 30 * 60
_DENIED_CODES = {40034105, 40054013, 40054004}


class ActivePushPolicy:
    def __init__(self, stopped, *, clock=None, wait=None):
        self._stopped = stopped
        self._clock = clock or time.monotonic
        self._wait = wait or stopped.wait
        self.is_online = lambda: True
        self._lock = threading.Lock()
        self._send_lock = threading.Lock()
        self._account = deque()
        self._peers = {}
        self._blocked = {}
        self._cooldown_until = 0.0

    def defer_reason(self, peer):
        if self._stopped.is_set():
            return "QQ 账号已停止"
        if not self.is_online():
            return "QQ 账号离线"
        with self._lock:
            if self._cooldown_until:
                if self._clock() < self._cooldown_until:
                    return "QQ 主动发送冷却中"
                self._cooldown_until = 0.0
                logger.info("[QQ] 主动发送冷却结束，恢复发送资格")
            return self._blocked.get(peer)

    def record_failure(self, peer, error):
        # Business denials take precedence over their HTTP status/retry flag.
        with self._lock:
            if self._stopped.is_set() or error._push_policy is self:
                return
            if error.biz_code in _DENIED_CODES:
                reason = f"QQ 主动发送暂停 (code={error.biz_code})，等待对方重新互动"
                if self._blocked.get(peer) != reason:
                    logger.info("[QQ] %s", reason)
                self._blocked[peer] = reason
                error.push_defer_reason = reason
            elif error.biz_code == 40034100 or error.retryable:
                if self._cooldown_until <= self._clock():
                    self._cooldown_until = self._clock() + _COOLDOWN_SECONDS
                    logger.info("[QQ] 主动发送暂时失败，冷却 30 分钟后自动再尝试 (code=%s)", error.biz_code)
                error.push_defer_reason = "QQ 主动发送冷却中"
            # An error unwinds through transport and channel handlers. Do not
            # apply the same failure again after an inbound message recovered
            # the recipient, and retain this round's original deferral reason.
            error._push_policy = self

    def clear(self):
        with self._lock:
            self._account.clear()
            self._peers.clear()
            self._blocked.clear()
            self._cooldown_until = 0.0

    def on_inbound(self, peer):
        with self._lock:
            if self._blocked.pop(peer, None):
                logger.info("[QQ] 收到对方消息，恢复该接收人的主动发送资格")
            # Incoming messages never clear an account's rate-limit cooldown.

    def _reserve_or_delay(self, peer):
        now = self._clock()
        with self._lock:
            if self._stopped.is_set():
                return 0.0
            while self._account and self._account[0] <= now - 60:
                self._account.popleft()
            for key, entries in list(self._peers.items()):
                while entries and entries[0] <= now - 60:
                    entries.popleft()
                if not entries:
                    del self._peers[key]
            entries = self._peers.setdefault(peer, deque())
            delays = [0.0]
            if len(self._account) >= 5:
                delays.append(self._account[-5] + 1 - now)
            if len(self._account) >= 30:
                delays.append(self._account[0] + 60 - now)
            if len(entries) >= 20:
                delays.append(entries[0] + 60 - now)
            delay = max(delays)
            if delay <= 0:
                self._account.append(now)
                entries.append(now)
            return delay

    @contextmanager
    def turn(self, peer):
        """Serialize actual HTTP sends, waiting without holding the state lock.

        Yield a deferral reason instead of sending when disconnected/blocked.
        Stop wakes waits immediately; short polls also notice gateway changes.
        """
        acquired = False
        try:
            while not acquired:
                reason = self.defer_reason(peer)
                if reason:
                    yield reason
                    return
                acquired = self._send_lock.acquire(timeout=0.1)
            while True:
                reason = self.defer_reason(peer)
                if reason:
                    yield reason
                    return
                delay = self._reserve_or_delay(peer)
                if delay <= 0:
                    yield None
                    return
                self._wait(min(delay, 0.25))
        finally:
            if acquired:
                self._send_lock.release()
