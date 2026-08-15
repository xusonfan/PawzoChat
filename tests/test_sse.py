# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

import json

from pawzochat.web import sse


def setup_function():
    with sse._clients_lock:
        sse._clients.clear()
        sse._event_history.clear()
        sse._event_sequence = 0


def test_stream_emits_heartbeat_and_unregisters_client():
    stream = sse.sse_stream(heartbeat_seconds=0.001)

    assert next(stream) == ": keep-alive\n\n"
    assert len(sse._clients) == 1

    stream.close()
    assert sse._clients == []


def test_stream_replays_events_after_last_event_id():
    sse.broadcast("assistant_message", persona_id="cat", message={"_seq": 1})
    first_id = sse._event_sequence
    sse.broadcast("conversation_updated", persona_id="cat")
    stream = sse.sse_stream(last_event_id=first_id, heartbeat_seconds=1)

    frame = next(stream)
    lines = frame.strip().splitlines()
    assert lines[0] == f"id: {first_id + 1}"
    payload = json.loads(lines[1].removeprefix("data: "))
    assert payload == {"type": "conversation_updated", "persona_id": "cat"}

    stream.close()