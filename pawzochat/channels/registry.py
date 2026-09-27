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

"""Registry mapping ``channel_type`` -> :class:`Channel` instance."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pawzochat.channels.base import Channel

logger = logging.getLogger(__name__)


class ChannelRegistry:
    """Lookup table the reply dispatcher and account lifecycle route through.

    Built-in channels (web, wechat, qq) register at startup; plugin channels
    register/unregister dynamically as plugins enable/disable.
    """

    def __init__(self):
        self._channels: dict[str, Channel] = {}

    def register(self, channel: Channel) -> None:
        ct = channel.channel_type
        if not ct:
            raise ValueError("Channel.channel_type must be set before register()")
        if ct in self._channels:
            logger.warning("通道 %s 已注册，覆盖旧实例", ct)
        self._channels[ct] = channel

    def unregister(self, channel_type: str) -> None:
        self._channels.pop(channel_type, None)

    def get(
        self, channel_type: str | None, *, default: str | None = "web"
    ) -> Channel | None:
        """Return the channel for ``channel_type``.

        Unknown/missing types fall back to the ``default`` channel (web) so the
        core never crashes on a stale or not-yet-loaded channel. Pass
        ``default=None`` (e.g. account startup) to detect an unregistered
        channel instead of silently routing to web.
        """
        if channel_type and channel_type in self._channels:
            return self._channels[channel_type]
        if default is not None:
            return self._channels.get(default)
        return None

    def has(self, channel_type: str) -> bool:
        return channel_type in self._channels

    def all(self) -> list[Channel]:
        return list(self._channels.values())
