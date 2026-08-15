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

"""Server-Sent Events broadcast for real-time frontend updates."""

from __future__ import annotations

import json
import queue
import threading
from collections import deque

MAX_SSE_CLIENTS = 20
SSE_HEARTBEAT_SECONDS = 15.0
SSE_REPLAY_LIMIT = 200

_clients: list[queue.Queue] = []
_clients_lock = threading.Lock()
_event_history: deque[tuple[int, str]] = deque(maxlen=SSE_REPLAY_LIMIT)
_event_sequence = 0


def _event_frame(event_id: int, data: str) -> str:
    return f"id: {event_id}\ndata: {data}\n\n"


def sse_stream(
    last_event_id: int | None = None,
    *,
    heartbeat_seconds: float = SSE_HEARTBEAT_SECONDS,
):
    """Yield SSE events, heartbeats, and buffered events missed after disconnect."""
    q: queue.Queue = queue.Queue(maxsize=100)
    rejected = False
    with _clients_lock:
        if len(_clients) >= MAX_SSE_CLIENTS:
            rejected = True
            replay = []
        else:
            replay = [
                item
                for item in _event_history
                if last_event_id is not None and item[0] > last_event_id
            ]
            _clients.append(q)

    if rejected:
        err = json.dumps({"type": "error", "message": "too_many_connections"})
        yield f"data: {err}\n\n"
        return

    try:
        for event_id, data in replay:
            yield _event_frame(event_id, data)
        while True:
            try:
                event_id, data = q.get(timeout=heartbeat_seconds)
                yield _event_frame(event_id, data)
            except queue.Empty:
                yield ": keep-alive\n\n"
    finally:
        with _clients_lock:
            if q in _clients:
                _clients.remove(q)


def broadcast(event_type: str, **payload):
    """Push an event to connected clients and retain a bounded replay window."""
    global _event_sequence

    message = json.dumps({"type": event_type, **payload}, ensure_ascii=False)
    with _clients_lock:
        _event_sequence += 1
        event = (_event_sequence, message)
        _event_history.append(event)
        for q in list(_clients):
            try:
                q.put_nowait(event)
            except queue.Full:
                pass