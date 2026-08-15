# PawzoChat - Multi-platform LLM-powered chatbot
# Copyright (C) 2026  iwyxdxl
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

from pypinyin import lazy_pinyin


def persona_sort_metadata(name: str) -> tuple[str, str]:
    """Return a stable pinyin sort key and an A-Z index letter."""
    sort_key = "".join(lazy_pinyin(name or "")).casefold()
    first = sort_key[:1].upper()
    initial = first if "A" <= first <= "Z" else "#"
    return sort_key, initial