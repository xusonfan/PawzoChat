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

"""Web preview channel — local delivery with typing-delay simulation.

The web UI receives assistant messages over SSE (broadcast by the reply
dispatcher), so this channel does no network I/O. It only reproduces the
human-like pacing between message bubbles using the shared delay estimator.
"""

from __future__ import annotations

import time

from pawzochat.channels.base import Channel
from pawzochat.transport.sender import MessageSender


class WebChannel(Channel):
    channel_type = "web"
    display_name = "网页"

    def deliver_message(
        self,
        persona_id: str,
        message: dict,
        reply_ctx: dict | None = None,
        *,
        is_first: bool = False,
        is_last: bool = False,
    ) -> bool:
        if not is_first:
            reply_cfg = self._app.config.get("reply", default={})
            delay = MessageSender.estimate_message_delay(message, reply_cfg)
            if delay:
                time.sleep(delay)
        return True
