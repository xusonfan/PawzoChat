# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

"""Convert persisted conversation messages into their public API shape."""

from __future__ import annotations


def messages_for_api(messages: list[dict]) -> list[dict]:
    """Expose retry capability without leaking internal generation arguments."""
    public_messages = []
    for message in messages:
        public_message = dict(message)
        content = message.get("content", [])
        if not isinstance(content, list):
            public_messages.append(public_message)
            continue
        public_content = []
        for block in content:
            if not isinstance(block, dict):
                public_content.append(block)
                continue
            public_block = dict(block)
            retry_arguments = public_block.pop("retry_arguments", None)
            if public_block.get("type") == "image" and public_block.get("status") == "failed":
                public_block["retryable"] = isinstance(retry_arguments, dict)
            public_content.append(public_block)
        public_message["content"] = public_content
        public_messages.append(public_message)
    return public_messages