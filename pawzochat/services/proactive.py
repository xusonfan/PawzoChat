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

"""Proactive message service — periodically nudges idle conversations.

This service runs a daemon thread that scans every persona with
``proactive.enabled`` set, and fires an LLM-generated proactive message
when the user has been silent long enough. It cooperates with
:class:`pawzochat.services.message_queue.MessageQueue` via the
``try_begin_proactive`` / ``end_proactive`` mutex to avoid races.

Delivery depends on the persona's channel link (``channel_link``):

- **Channel-bound**: send through that channel, subject to the channel's
  own push policy (``Channel.can_push_now``). WeChat enforces a 23h safety
  window under openclaw's 24h context_token TTL, a 10-replies-per-context
  quota, and skips group chats; QQ is passive-reply only (never proactively
  pushed).
- **Not bound**: send through the web panel SSE channel directly. Web
  delivery has no TTL.

Bound personas without a backfilled ``peer_id`` are skipped. A proactive
fire always requires at least one historical user message to anchor the
idle timer on.

Repeated send failures suspend the persona's proactive cycle. Failure
state (streak, cooldown, suspension) is held in memory only — never
written to disk — so a restart always starts clean; the suspension also
lifts on the next inbound user message, the same event that resets
WeChat's push quota. Configuration is never rewritten on failure.
"""

from __future__ import annotations

import json
import logging
import os
import random
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from pawzochat.paths import CHATS_DIR
from pawzochat.transport.models import PROACTIVE_DEFAULTS

if TYPE_CHECKING:
    from pawzochat.app import App

logger = logging.getLogger(__name__)

# Scheduler constants
_CHECK_INTERVAL_SECONDS = 30              # Scan cadence of the background loop
_JITTER_BASE = 27768
_JITTER = _JITTER_BASE % 3               # 0 — keeps loop intervals from aligning

# Failure handling
_FAIL_COOLDOWN_SECONDS = 30 * 60          # 30 min back-off after a failed send
_SUSPEND_FAIL_THRESHOLD = 3               # Suspend after N consecutive fails;
                                          # lifted on the next user message.


def _parse_hhmm(value: str):
    """Parse ``HH:MM`` into a ``datetime.time``; return ``None`` on error."""
    try:
        return datetime.strptime(value, "%H:%M").time()
    except (ValueError, TypeError):
        return None


def _is_in_quiet_window(now_time, start_time, end_time) -> bool:
    """Return ``True`` if *now_time* falls inside the [start, end] window.

    Handles same-day windows (start <= end) and cross-midnight windows
    (start > end). Mirrors the semantics from
    ``ref/WeChatBot_WXAUTO_SE/bot.py``'s ``is_quiet_time``.
    """
    if start_time is None or end_time is None:
        return False
    if start_time <= end_time:
        return start_time <= now_time <= end_time
    return now_time >= start_time or now_time <= end_time


def scan_last_user_at(messages: list[dict]) -> float:
    """Return epoch seconds of the most recent ``role=user`` message.

    Returns ``0.0`` if no user message exists. Scans from the end so it
    is O(1) for typical conversations. Public so the plugin
    :class:`MessagingFacade` can reuse the same WeChat 23h window logic.
    """
    for msg in reversed(messages):
        if msg.get("role") != "user":
            continue
        ts = msg.get("timestamp", "")
        if not ts:
            continue
        try:
            dt = datetime.fromisoformat(ts)
            return dt.timestamp()
        except (ValueError, TypeError):
            continue
    return 0.0


class _PersonaState:
    """Per-persona scheduling state, mirrored to ``proactive_state.json``.

    The failure fields (``fail_streak``, ``cooldown_until``, ``suspended``)
    are deliberately session-only: they are excluded from ``to_dict`` /
    ``load_from`` so a process restart always clears them.
    """

    __slots__ = (
        "wait_seconds", "anchor_at", "consecutive_count", "last_fired_at",
        "cooldown_until", "fail_streak", "suspended",
    )

    def __init__(self):
        self.wait_seconds: float = 0.0
        self.anchor_at: float = 0.0
        self.consecutive_count: int = 0
        self.last_fired_at: float = 0.0
        self.cooldown_until: float = 0.0
        self.fail_streak: int = 0
        self.suspended: bool = False

    def to_dict(self) -> dict:
        return {
            "wait_seconds": self.wait_seconds,
            "anchor_at": self.anchor_at,
            "consecutive_count": self.consecutive_count,
            "last_fired_at": self.last_fired_at,
        }

    def load_from(self, data: dict):
        self.wait_seconds = float(data.get("wait_seconds", 0.0))
        self.anchor_at = float(data.get("anchor_at", 0.0))
        self.consecutive_count = int(data.get("consecutive_count", 0))
        self.last_fired_at = float(data.get("last_fired_at", 0.0))


class ProactiveService:
    """Background scheduler that fires proactive messages on idle personas."""

    def __init__(self, app: App):
        self._app = app
        self._states: dict[str, _PersonaState] = {}
        self._states_lock = threading.Lock()
        self._running = False
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()

    # ---- Lifecycle --------------------------------------------------------

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._loop, name="proactive-loop", daemon=True,
        )
        self._thread.start()
        logger.info("ProactiveService 已启动")

    def stop(self) -> None:
        if not self._running:
            return
        self._running = False
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=3.0)
        logger.info("ProactiveService 已停止")

    # ---- State persistence ------------------------------------------------

    @staticmethod
    def _state_path(persona_id: str) -> Path:
        return CHATS_DIR / persona_id / "proactive_state.json"

    def _get_state(self, persona_id: str) -> _PersonaState:
        with self._states_lock:
            state = self._states.get(persona_id)
            if state is not None:
                return state
            state = _PersonaState()
            path = self._state_path(persona_id)
            if path.is_file():
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        state.load_from(json.load(f))
                except (json.JSONDecodeError, OSError):
                    logger.exception(
                        "读取 proactive_state.json 失败 persona=%s", persona_id,
                    )
            self._states[persona_id] = state
            return state

    def _save_state(self, persona_id: str, state: _PersonaState) -> None:
        path = self._state_path(persona_id)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp_fd, tmp_name = tempfile.mkstemp(
                prefix=".proactive_", suffix=".json", dir=str(path.parent),
            )
            try:
                with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
                    json.dump(state.to_dict(), f, ensure_ascii=False, indent=2)
                os.replace(tmp_name, path)
            finally:
                if os.path.exists(tmp_name):
                    try:
                        os.remove(tmp_name)
                    except OSError:
                        pass
        except OSError:
            logger.exception("写入 proactive_state.json 失败 persona=%s", persona_id)

    # ---- Public hook ------------------------------------------------------

    def on_user_message(self, persona_id: str) -> None:
        """Called by :class:`MessageQueue` after a user message is accepted.

        Resets the per-persona idle counter, consecutive-send counter, and
        failure state (including suspension) so the proactive cycle
        re-anchors on the new user activity.
        """
        cfg = self._persona_proactive_cfg(persona_id)
        if cfg is None:
            return
        state = self._get_state(persona_id)
        state.anchor_at = time.time()
        state.consecutive_count = 0
        state.fail_streak = 0
        state.cooldown_until = 0.0
        state.suspended = False
        state.wait_seconds = self._random_wait_seconds(cfg)
        self._save_state(persona_id, state)

    # ---- Main loop --------------------------------------------------------

    def _loop(self) -> None:
        while self._running:
            try:
                self._tick()
            except Exception:
                logger.exception("proactive 主循环异常")
            if self._stop_event.wait(_CHECK_INTERVAL_SECONDS + _JITTER):
                break

    def _tick(self) -> None:
        personas_cfg = self._app.config.get("personas", default={}) or {}
        for persona_id in list(personas_cfg.keys()):
            try:
                self._consider(persona_id)
            except Exception:
                logger.exception("proactive 检查角色失败 persona=%s", persona_id)

    # ---- Per-persona check & fire ----------------------------------------

    def _consider(self, persona_id: str) -> None:
        cfg = self._persona_proactive_cfg(persona_id)
        if cfg is None or not cfg.get("enabled", False):
            return

        now = time.time()
        state = self._get_state(persona_id)

        # Suspended after repeated failures — in-memory only, cleared by the
        # user's next message (via ``on_user_message``) or a process restart.
        if state.suspended:
            return

        # Quiet hours (per-persona)
        qh = cfg.get("quiet_hours") or {}
        if qh.get("enabled", True):
            if _is_in_quiet_window(
                datetime.now().time(),
                _parse_hhmm(qh.get("start", "22:00")),
                _parse_hhmm(qh.get("end", "08:00")),
            ):
                return

        # Failure cooldown
        if state.cooldown_until and now < state.cooldown_until:
            return

        conv = self._app.conversation_store.get_conversation(persona_id)
        if conv is None:
            return

        # Canonical channel link (or None for web-only personas).
        link = self._app.conversation_store.channel_link(persona_id)
        channel = None
        if link is not None:
            channel = self._app.channel_registry.get(
                link.get("channel", ""), default=None,
            )
            if channel is None:
                # Bound to a channel that isn't currently available.
                return
            # Bound personas without a backfilled peer_id can't be sent to.
            if not link.get("peer_id"):
                logger.debug(
                    "跳过 proactive：persona=%s 通道绑定缺 peer_id（待用户回消息后惰性回填）",
                    persona_id,
                )
                return

        messages = conv.get("messages", []) or []
        last_user_at = scan_last_user_at(messages)

        # Need at least one historical user message to anchor on, regardless
        # of channel — otherwise there is nobody to re-engage.
        if last_user_at <= 0:
            return

        # Per-channel push policy (WeChat 23h window, 10-reply quota, group-
        # skip; QQ passive-only; web unrestricted). Web-only personas (link is
        # None) always pass.
        if channel is not None and not channel.can_push_now(
            link, last_user_at, messages,
        ):
            logger.debug(
                "跳过 proactive：persona=%s 通道 %s 当前不允许主动推送",
                persona_id, link.get("channel", ""),
            )
            return

        max_consec = int(cfg.get("max_consecutive", 3))
        if state.consecutive_count >= max_consec:
            return

        # Initialize wait_seconds on first consideration after a fresh start
        if state.wait_seconds <= 0:
            state.wait_seconds = self._random_wait_seconds(cfg)
        if state.anchor_at <= 0:
            # Cold start: anchor on the user's last message so idle time
            # already elapsed counts toward ``due_at`` instead of being
            # reset to "now". ``last_user_at`` is guaranteed > 0 here.
            state.anchor_at = last_user_at

        anchor = max(last_user_at, state.last_fired_at, state.anchor_at)
        due_at = anchor + state.wait_seconds
        if now < due_at:
            return

        # Try to acquire the queue mutex
        mq = self._app.message_queue
        if mq is None or not mq.try_begin_proactive(persona_id):
            return

        try:
            self._fire_one(persona_id, cfg, link, channel, state)
        finally:
            mq.end_proactive(persona_id)

    def _fire_one(
        self,
        persona_id: str,
        cfg: dict,
        link: dict | None,
        channel,
        state: _PersonaState,
    ) -> None:
        prompt = cfg.get("prompt") or PROACTIVE_DEFAULTS["prompt"]
        max_consec = int(cfg.get("max_consecutive", 3))
        channel_label = channel.display_name if channel is not None else "网页端"

        logger.info(
            "触发主动消息 persona=%s 通道=%s（连续第 %d/%d 次，空闲 %.1f 分钟）",
            persona_id,
            channel_label,
            state.consecutive_count + 1,
            max_consec,
            state.wait_seconds / 60.0,
        )

        if channel is not None and link is not None:
            reply_ctx = channel.reply_ctx_from_link(link)
        else:
            reply_ctx = {"channel": "web"}

        try:
            drafts = self._app.chat_service.process_round(
                persona_id, extra_hint=prompt,
            )
        except Exception:
            logger.error(
                "主动消息生成失败（process_round 异常）persona=%s",
                persona_id, exc_info=True,
            )
            self._record_failure(persona_id, state)
            return

        if not drafts:
            logger.error(
                "主动消息生成失败（LLM 输出为空）persona=%s", persona_id,
            )
            self._record_failure(persona_id, state)
            return

        if self._app.emoji_service:
            try:
                drafts = self._app.emoji_service.compose(persona_id, drafts)
            except Exception:
                logger.error(
                    "主动消息表情包合成失败 persona=%s",
                    persona_id, exc_info=True,
                )

        try:
            delivered = self._app.reply_dispatcher.deliver_messages(
                persona_id, drafts, reply_ctx=reply_ctx,
            )
        except Exception:
            logger.error(
                "主动消息投递异常 persona=%s", persona_id, exc_info=True,
            )
            self._record_failure(persona_id, state)
            return

        if not delivered:
            logger.error(
                "主动消息投递失败（通道未接受任何消息）persona=%s", persona_id,
            )
            self._record_failure(persona_id, state)
            return

        # Success — reset cycle
        now = time.time()
        state.consecutive_count += 1
        state.last_fired_at = now
        state.anchor_at = now
        state.wait_seconds = self._random_wait_seconds(cfg)
        state.fail_streak = 0
        state.cooldown_until = 0.0
        self._save_state(persona_id, state)
        logger.info(
            "主动消息发送成功 persona=%s（连续 %d/%d，下次约 %.1f 分钟后）",
            persona_id, state.consecutive_count, max_consec,
            state.wait_seconds / 60.0,
        )

    def _record_failure(self, persona_id: str, state: _PersonaState) -> None:
        state.fail_streak += 1
        state.cooldown_until = time.time() + _FAIL_COOLDOWN_SECONDS
        if state.fail_streak >= _SUSPEND_FAIL_THRESHOLD:
            state.suspended = True
            logger.warning(
                "主动消息连续 %d 次失败已挂起 persona=%s，用户回复或重启程序后自动恢复",
                state.fail_streak, persona_id,
            )
        else:
            logger.error(
                "主动消息发送失败 persona=%s fail_streak=%d/%d，%.0f 分钟后重试",
                persona_id, state.fail_streak, _SUSPEND_FAIL_THRESHOLD,
                _FAIL_COOLDOWN_SECONDS / 60.0,
            )

    # ---- Helpers ----------------------------------------------------------

    def _persona_proactive_cfg(self, persona_id: str) -> dict | None:
        personas_cfg = self._app.config.get("personas", default={}) or {}
        pcfg = personas_cfg.get(persona_id)
        if not isinstance(pcfg, dict):
            return None
        raw = pcfg.get("proactive") or {}
        merged: dict = {
            "enabled": bool(raw.get("enabled", PROACTIVE_DEFAULTS["enabled"])),
            "min_idle_hours": float(
                raw.get("min_idle_hours", PROACTIVE_DEFAULTS["min_idle_hours"])
            ),
            "max_idle_hours": float(
                raw.get("max_idle_hours", PROACTIVE_DEFAULTS["max_idle_hours"])
            ),
            "max_consecutive": int(
                raw.get("max_consecutive", PROACTIVE_DEFAULTS["max_consecutive"])
            ),
            "prompt": raw.get("prompt", PROACTIVE_DEFAULTS["prompt"]),
        }
        qh_raw = raw.get("quiet_hours") or {}
        qh_def = PROACTIVE_DEFAULTS["quiet_hours"]
        merged["quiet_hours"] = {
            "enabled": bool(qh_raw.get("enabled", qh_def["enabled"])),
            "start": qh_raw.get("start", qh_def["start"]),
            "end": qh_raw.get("end", qh_def["end"]),
        }
        return merged

    @staticmethod
    def _random_wait_seconds(cfg: dict) -> float:
        lo = max(0.0, float(cfg.get("min_idle_hours", 1.0)))
        hi = max(lo, float(cfg.get("max_idle_hours", 3.0)))
        return random.uniform(lo, hi) * 3600.0
