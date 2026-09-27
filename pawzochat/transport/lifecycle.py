"""Per-connection admission and persisted WeChat credential cooldown."""

from __future__ import annotations

import logging
from contextlib import contextmanager
import threading
import time
import uuid


class ConnectionInactive(RuntimeError):
    pass


class WeChatConnection:
    def __init__(self, account, auth_manager):
        self.account = account
        self.auth_manager = auth_manager
        self.generation = uuid.uuid4().hex
        self.lock = threading.RLock()
        self.active = True

    @property
    def cooldown_until(self) -> float:
        try:
            return float((self.account.extra or {}).get("cooldown_until", 0) or 0)
        except (TypeError, ValueError):
            return 0

    def check(self, generation=None):
        with self.lock:
            if not self.active or (generation is not None and generation != self.generation):
                raise ConnectionInactive("微信连接已停止，回复仅保存在本地")
            if self.cooldown_until > time.time():
                raise ConnectionInactive("微信凭据冷却中，回复仅保存在本地")

    @contextmanager
    def admit(self):
        with self.lock:
            self.check()
            yield

    def stale(self):
        with self.lock:
            if not self.active:
                return
            self.account.extra = {**(self.account.extra or {}), "cooldown_until": time.time() + 3600}
            try:
                self.auth_manager.update_account(self.account)
            except Exception:
                logging.getLogger(__name__).warning("微信冷却状态保存失败，本次运行仍保持冷却", exc_info=True)

    def stop(self):
        with self.lock:
            self.active = False
