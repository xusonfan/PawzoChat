# PawzoChat - Multi-platform LLM-powered chatbot
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

"""Abstract chat-channel interface shared by WeChat, QQ, web, and plugins."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pawzochat.app import App
    from pawzochat.transport.models import Account


class Channel(ABC):
    """A bidirectional chat channel bound to zero or more accounts.

    A channel owns its own transport: it receives inbound messages (feeding
    them into ``app.message_queue``) and delivers outbound assistant replies.
    The core message queue, chat service, and reply dispatcher stay
    channel-agnostic — they route by the ``channel`` field of a ``reply_ctx``
    and call :meth:`deliver_message` on the matching channel.

    Subclasses set ``channel_type`` (the routing key, e.g. ``"wechat"``,
    ``"qq"``, ``"plugin:<id>"``) and ``display_name`` (shown in the
    add-account UI).
    """

    channel_type: str = ""
    display_name: str = ""

    def __init__(self, app: App):
        self._app = app

    # ---- Per-account lifecycle ----

    def start_account(self, account: Account) -> None:
        """Bring an account online (spin up its receive loop + send transport)."""

    def stop_account(self, account_id: str) -> None:
        """Tear down a single account's transport (used on account delete)."""

    def notify_offline(self) -> None:
        """Best-effort, fire-and-forget "going offline" notification.

        Called early in app shutdown — before receive loops are stopped — so a
        channel that must tell its server it's offline (WeChat) gets maximum
        wall-clock before the process exits. Default: no-op.
        """

    def shutdown(self) -> None:
        """Tear down every account for this channel (used on app shutdown)."""

    def is_online(self, account_id: str) -> bool:
        """Whether the account's receive loop is currently running."""
        return False

    # ---- Outbound delivery ----

    @abstractmethod
    def deliver_message(
        self,
        persona_id: str,
        message: dict,
        reply_ctx: dict | None = None,
        *,
        is_first: bool = False,
        is_last: bool = False,
    ) -> bool:
        """Deliver one assistant message draft. Return ``True`` iff accepted."""

    # ---- Account creation metadata (for the add-account UI) ----

    def account_form(self) -> dict:
        """Describe how an account of this channel is added.

        Returns a dict like ``{"method": "qr"|"form"|"none", "fields": [...]}``.
        Each field is ``{"key", "label", "type"?, "secret"?, "required"?,
        "placeholder"?}``. ``method == "none"`` means the channel is not
        user-addable (e.g. the web channel).
        """
        return {"method": "none", "fields": []}

    def validate_and_create(self, fields: dict) -> Account:
        """Build and validate an :class:`Account` from submitted form fields.

        Only meaningful for ``method == "form"`` channels. Raise ``ValueError``
        with a user-facing message on invalid input.
        """
        raise NotImplementedError(
            f"Channel {self.channel_type!r} does not support form-based add",
        )

    # ---- Proactive / active-push policy ----

    def reply_ctx_from_link(self, channel_link: dict) -> dict:
        """Build a reply_ctx for a proactive/plugin send from a stored link.

        Default maps the generic link fields onto reply_ctx; channels whose
        ``deliver_message`` reads a differently-named key (WeChat's
        ``context_token``) override this.
        """
        return {
            "channel": self.channel_type,
            "account_id": channel_link.get("account_id", ""),
            "user_id": channel_link.get("peer_id", ""),
            "reply_target": channel_link.get("reply_target", ""),
        }

    def can_push_now(
        self,
        channel_link: dict,
        last_user_at: float,
        messages: list[dict],
    ) -> bool:
        """Whether a proactive (non-reply) message may be pushed right now.

        ``last_user_at`` is the epoch seconds of the most recent inbound user
        message; ``messages`` is the persona's stored conversation history.
        Default: allow (suits the web preview). WeChat overrides with its 23h
        openclaw window plus the 10-replies-per-context quota; QQ disables the
        proactive service.
        """
        return True
