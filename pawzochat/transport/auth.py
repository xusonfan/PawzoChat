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

"""Channel account credential load, save, and removal (WeChat, QQ, plugins)."""

from __future__ import annotations

import os
import tempfile
import threading
from functools import wraps
import json
import logging

from pawzochat.paths import CREDENTIALS_PATH
from pawzochat.transport.models import Account

logger = logging.getLogger(__name__)


def _locked(method):
    @wraps(method)
    def wrapped(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)
    return wrapped


class AuthManager:
    """Loads, saves, and removes channel account credentials.

    Channel-agnostic: each account carries a ``channel_type`` and an ``extra``
    dict for channel-specific fields. The QR-login flow only populates the
    WeChat-shaped fields; QQ / plugin accounts store their creds in ``extra``.
    """

    def __init__(self):
        self._lock = threading.RLock()

    @_locked
    def load_accounts(self) -> list[Account]:
        if not CREDENTIALS_PATH.exists():
            return []
        try:
            text = CREDENTIALS_PATH.read_text(encoding="utf-8").strip()
            if not text:
                return []
            data = json.loads(text)
            accounts = []
            for _bid, ainfo in data.get("accounts", {}).items():
                bid = ainfo.get("bot_id", "") or _bid
                if not bid:
                    continue
                extra = ainfo.get("extra", {})
                accounts.append(Account(
                    bot_id=bid,
                    bot_token=ainfo.get("bot_token", ""),
                    ilink_user_id=ainfo.get("ilink_user_id", ""),
                    get_updates_buf=ainfo.get("get_updates_buf", ""),
                    created_at=ainfo.get("created_at", ""),
                    note=ainfo.get("note", ""),
                    # Legacy entries predate channel_type — default to wechat.
                    channel_type=ainfo.get("channel_type", "wechat"),
                    extra=extra if isinstance(extra, dict) else {},
                ))
            return accounts
        except Exception:
            logger.exception("加载凭证文件失败")
            return []

    @_locked
    def save_accounts(self, accounts: list[Account]):
        CREDENTIALS_PATH.parent.mkdir(parents=True, exist_ok=True)
        data = {"accounts": {}}
        for acc in accounts:
            data["accounts"][acc.bot_id] = {
                "bot_id": acc.bot_id,
                "bot_token": acc.bot_token,
                "ilink_user_id": acc.ilink_user_id,
                "get_updates_buf": acc.get_updates_buf,
                "created_at": acc.created_at,
                "note": acc.note,
                "channel_type": acc.channel_type,
                # Channel-specific creds (QQ app_id/app_secret, plugin tokens).
                # Preserved verbatim so e.g. a note edit never wipes secrets.
                "extra": acc.extra,
            }
        fd, temp = tempfile.mkstemp(dir=CREDENTIALS_PATH.parent, prefix=".accounts-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(temp, CREDENTIALS_PATH)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)

    @_locked
    def _add_and_save(self, new_account: Account):
        accounts = self.load_accounts()
        accounts = [a for a in accounts if a.bot_id != new_account.bot_id]
        accounts.append(new_account)
        self.save_accounts(accounts)

    @_locked
    def remove_account(self, bot_id: str):
        accounts = self.load_accounts()
        accounts = [a for a in accounts if a.bot_id != bot_id]
        self.save_accounts(accounts)

    @_locked
    def update_account(self, account: Account):
        """Persist updated fields (e.g. get_updates_buf) for an existing account."""
        accounts = self.load_accounts()
        for i, a in enumerate(accounts):
            if a.bot_id == account.bot_id:
                accounts[i] = account
                break
        else:
            return  # A stale connection must never resurrect a deleted account.
        self.save_accounts(accounts)
