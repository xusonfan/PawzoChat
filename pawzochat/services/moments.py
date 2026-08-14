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

"""Moments (朋友圈) orchestrator.

Single-worker design: only one moment workflow runs at a time.

A workflow consists of (1) optionally generating a new moment via LLM and
(2) iterating eligible reply personas in random order and **serially**
calling the LLM for each — never in parallel. This is deliberate: some
LLM providers don't support concurrent requests, and stacking them risks
rate-limit errors mid-workflow.

The ``is_generating`` flag is in-memory only; on process restart it resets
to ``False`` so the UI's refresh/publish buttons are never stuck disabled.
"""

from __future__ import annotations

import logging
import mimetypes
import queue
import random
import re
import threading
from pathlib import Path
from typing import TYPE_CHECKING

from pawzochat.utils.profile import load_profile_name
from pawzochat.web.sse import broadcast

if TYPE_CHECKING:
    from pawzochat.app import App
    from pawzochat.core.config import ConfigManager
    from pawzochat.services.chat import ChatService
    from pawzochat.store.moments import MomentsStore

logger = logging.getLogger(__name__)


MAX_PUBLISH_IMAGES = 9


DEFAULT_POST_PROMPT = (
    "现在请以你的人设发一条朋友圈动态。\n"
    "- 写一段 30-100 字的第一人称朋友圈正文，可适当使用 emoji。\n"
    "- 内容可以是日常、心情、感慨、吐槽、随手写写，但不要写成对话格式。\n"
    "- 直接输出朋友圈正文，不要包含任何解释、引号、标题或前后缀。\n"
    "- 如果你启用了生图能力，并且这条朋友圈适合配一张图，可以调用 generate_image 工具生成一张配图（最多一张）。"
)

DEFAULT_REPLY_PROMPT = (
    "你正在浏览朋友圈。「{author}」发了这样一条动态：\n"
    "---\n"
    "{text}\n"
    "---\n"
    "请以你的人设和你与「{author}」的关系，给这条动态写一条简短评论（30 字以内）。\n"
    "- 只写一条评论，直接输出评论正文，不要复述对方内容。\n"
    "- 调侃、附和、安慰、回怼都可以，关键是符合你的人设。"
)

DEFAULT_COUNTER_REPLY_PROMPT = (
    "你正在朋友圈评论区里和「{user_name}」对话。「{moment_author}」发了一条动态：\n"
    "---\n"
    "{moment_text}\n"
    "---\n"
    "你们之前在这条评论下的对话（按时间顺序）：\n"
    "{thread}\n"
    "「{user_name}」刚刚对你说：\n"
    "---\n"
    "{user_reply}\n"
    "---\n"
    "请以你的人设和你与「{user_name}」的关系，回一条 30 字以内的回应。\n"
    "- 只写一条，直接输出正文，不要包含解释、引号或前后缀。"
)


def _render_template(template: str, **kwargs) -> str:
    """Safe single-pass placeholder substitution.

    We avoid ``str.format`` because user-edited prompt templates may contain
    stray braces that would otherwise raise ``KeyError``.
    """
    result = template
    for k, v in kwargs.items():
        result = result.replace("{" + k + "}", str(v))
    return result


_MOMENTS_SEP_RE = re.compile(r"[\\$]+")
_WS_RUN_RE = re.compile(r"[ \t]{2,}")

_MEMORY_EXCERPT_MAX = 120


def _excerpt(text: str, limit: int = _MEMORY_EXCERPT_MAX) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "…"


def _clean_moments_text(text: str) -> str:
    """Strip the chat-mode segment separators (``\\`` and ``$``) from LLM output.

    The persona's regular chat prompt instructs the LLM to emit
    ``\\``/``$``-delimited message segments; even though Moments calls
    skip those system sections, some personas hard-code separators in
    ``character_prompt``. Replace runs of them with a single space so the
    moment reads as one continuous post instead of disjoint fragments.
    """
    if not text:
        return ""
    cleaned = _MOMENTS_SEP_RE.sub(" ", text)
    cleaned = _WS_RUN_RE.sub(" ", cleaned)
    return cleaned.strip()


class MomentsService:
    def __init__(self, app: "App"):
        self._app = app
        self._store: "MomentsStore" = app.moments_store
        self._chat: "ChatService" = app.chat_service  # type: ignore[assignment]
        self._config: "ConfigManager" = app.config
        self._stop_event = threading.Event()
        self._generating = False
        self._gen_lock = threading.Lock()
        # Cross-workflow mutex around every LLM call. The publish/refresh
        # worker and the counter-reply worker may both want to call
        # ``run_oneshot`` concurrently — this lock keeps them serial so we
        # never stack two requests at the same provider.
        self._llm_call_lock = threading.Lock()
        # Queue of user-triggered counter-reply tasks. Drained by a single
        # worker thread so any number of user replies are processed FIFO,
        # never in parallel.
        self._counter_reply_queue: "queue.Queue[tuple[str, str, str]]" = queue.Queue()
        self._counter_worker: threading.Thread | None = None

    # ---- Lifecycle ----

    def start(self) -> None:
        """Launch the counter-reply worker. publish/refresh still spawn
        their own ad-hoc threads — only counter-replies need a persistent
        single-consumer thread because they're triggered by the user at
        arbitrary times."""
        if self._counter_worker is None or not self._counter_worker.is_alive():
            self._counter_worker = threading.Thread(
                target=self._counter_reply_worker_loop,
                name="moments-counter",
                daemon=True,
            )
            self._counter_worker.start()

    def stop(self) -> None:
        """Signal background workers to exit. Does not block — daemon
        threads are torn down with the process within the shutdown
        watchdog window."""
        self._stop_event.set()

    def get_state(self) -> dict:
        return {"is_generating": self._generating}

    # ---- Public API ----

    def refresh(self) -> dict:
        publishers = self._publishers()
        if not publishers:
            raise ValueError("尚未配置可发布朋友圈的角色")
        if not self._begin_task():
            raise RuntimeError("已有朋友圈正在生成")
        persona_id = random.choice(publishers)
        threading.Thread(
            target=self._refresh_workflow,
            args=(persona_id,),
            name="moments-refresh",
            daemon=True,
        ).start()
        return {"started": True, "persona_id": persona_id}

    def publish(
        self,
        *,
        text: str,
        image_files: list[tuple[bytes, str]],
    ) -> str:
        """Persist a user-authored moment and trigger reply generation.

        ``image_files`` is a list of ``(bytes, ext)`` tuples — caller is
        responsible for size/type validation. ``text`` may be empty as long
        as at least one image is provided.

        Raises ``ValueError`` for empty content / too many images,
        ``RuntimeError`` when another workflow is already running.
        """
        text = (text or "").strip()
        if len(image_files) > MAX_PUBLISH_IMAGES:
            raise ValueError(f"最多只能上传 {MAX_PUBLISH_IMAGES} 张图片")
        if not text and not image_files:
            raise ValueError("朋友圈文案与图片不能同时为空")

        if not self._begin_task():
            raise RuntimeError("已有朋友圈正在生成")

        # Allocate id up front so images live under their final dir.
        from pawzochat.store.moments import _new_moment_id

        moment_id = _new_moment_id()
        filenames: list[str] = []
        try:
            for data, ext in image_files:
                filenames.append(self._store.save_image_bytes(moment_id, data, ext))
            self._store.add_moment(
                author="user",
                text=text,
                images=filenames,
                moment_id=moment_id,
            )
        except Exception:
            self._end_task()
            raise

        broadcast("moments_updated", action="added", moment_id=moment_id)

        threading.Thread(
            target=self._publish_workflow,
            args=(moment_id,),
            name="moments-publish",
            daemon=True,
        ).start()
        return moment_id

    def delete_moment(self, moment_id: str) -> bool:
        """Delete a moment (user-authored or persona-authored). Allowed at
        any time, including during reply generation — the workflow tolerates
        a deleted moment."""
        ok = self._store.delete_moment(moment_id)
        if ok:
            broadcast("moments_updated", action="deleted", moment_id=moment_id)
        return ok

    def delete_moments_by_author(self, author_id: str) -> int:
        """Delete all moments and replies authored by *author_id*.

        Broadcasts a ``moments_updated`` SSE event for each deleted moment.
        Returns the count of moments deleted.
        """
        count = self._store.delete_moments_by_author(author_id)
        if count:
            broadcast("moments_updated", action="author_deleted", author_id=author_id)
        return count

    def delete_reply(
        self, moment_id: str, reply_id: str,
    ) -> list[str] | None:
        """Delete one reply plus any descendants threaded under it. Does not
        re-trigger generation. Returns the list of deleted ids, ``[]`` when
        the reply was not found, or ``None`` when the moment doesn't exist."""
        deleted = self._store.delete_reply(moment_id, reply_id)
        if deleted:
            broadcast(
                "moments_updated",
                action="reply_deleted",
                moment_id=moment_id,
                reply_ids=deleted,
            )
        return deleted

    def update_moment_text(self, moment_id: str, *, text: str) -> bool:
        """Replace a moment's text. Pure data edit — does not call the LLM
        and does not write a memory entry. Returns False if the moment is
        gone."""
        ok = self._store.update_moment_text(moment_id, text)
        if ok:
            broadcast(
                "moments_updated", action="moment_edited", moment_id=moment_id,
            )
        return ok

    def update_reply_text(
        self, moment_id: str, reply_id: str, *, text: str,
    ) -> bool | None:
        """Replace a reply's text. Pure data edit — no LLM/memory side
        effects. See ``MomentsStore.update_reply_text`` for return semantics."""
        result = self._store.update_reply_text(moment_id, reply_id, text)
        if result is True:
            broadcast(
                "moments_updated",
                action="reply_edited",
                moment_id=moment_id,
                reply_id=reply_id,
            )
        return result

    def like(self, moment_id: str, who: str = "user") -> bool:
        ok = self._store.add_like(moment_id, who)
        if ok:
            broadcast("moments_updated", action="like_changed", moment_id=moment_id)
        return ok

    def unlike(self, moment_id: str, who: str = "user") -> bool:
        ok = self._store.remove_like(moment_id, who)
        if ok:
            broadcast("moments_updated", action="like_changed", moment_id=moment_id)
        return ok

    def user_reply(
        self,
        moment_id: str,
        *,
        text: str,
        reply_to: str | None = None,
    ) -> dict | None:
        """Persist a user reply synchronously; enqueue an AI counter-reply
        when the user is directly addressing a persona. Returns ``None`` if
        the moment doesn't exist.
        """
        text = (text or "").strip()
        if not text:
            raise ValueError("评论内容不能为空")
        moment = self._store.get_moment(moment_id)
        if moment is None:
            return None

        target_reply = None
        if reply_to:
            target_reply = self._store.get_reply(moment_id, reply_to)
            if target_reply is None:
                # Stale rid (e.g. parent reply was deleted) — treat as top-level.
                reply_to = None

        reply_id = self._store.add_reply(
            moment_id, author="user", text=text, reply_to=reply_to,
        )
        if reply_id is None:
            # moment vanished between get and add — race with delete
            return None
        broadcast("moments_updated", action="reply_added", moment_id=moment_id)

        # Determine counter-reply target persona:
        # - reply_to set => the author of that reply (only if a persona)
        # - reply_to null => the moment author (only if a persona)
        if target_reply is not None:
            target_author = target_reply.get("author", "")
        else:
            target_author = moment.get("author", "")

        counter_pending = False
        if target_author and target_author != "user":
            personas = self._config.load_personas()
            if target_author in personas:
                self._counter_reply_queue.put((moment_id, target_author, reply_id))
                counter_pending = True

        return {"reply_id": reply_id, "counter_reply_pending": counter_pending}

    # ---- Workflows (run on the worker thread) ----

    def _refresh_workflow(self, persona_id: str) -> None:
        try:
            self._do_refresh(persona_id)
        except Exception:
            logger.exception("生成朋友圈失败 persona=%s", persona_id)
        finally:
            self._end_task()

    def _publish_workflow(self, moment_id: str) -> None:
        try:
            self._reply_workflow(moment_id, exclude=None)
        except Exception:
            logger.exception("生成朋友圈回复失败 moment=%s", moment_id)
        finally:
            self._end_task()

    def _do_refresh(self, persona_id: str) -> None:
        from pawzochat.store.moments import _new_moment_id

        prompt_template = (
            (self._config.get("moments", "prompts", "post", default="") or "").strip()
            or DEFAULT_POST_PROMPT
        )
        personas = self._config.load_personas()
        persona = personas.get(persona_id)
        if persona is None:
            logger.info("朋友圈刷新候选角色已失效 persona=%s", persona_id)
            return
        persona_name = persona.name
        instruction = _render_template(prompt_template, persona_name=persona_name)

        with self._llm_call_lock:
            text, gen_images = self._chat.run_oneshot(
                persona_id,
                instruction=instruction,
                include_image_tool=True,
            )

        moment_id = _new_moment_id()
        filenames: list[str] = []
        for gi in gen_images:
            src_path = gi.get("path", "")
            if not src_path:
                continue
            src = Path(src_path)
            if not src.is_file():
                continue
            ext = src.suffix or ".png"
            try:
                filename = self._store.save_image_bytes(
                    moment_id, src.read_bytes(), ext,
                )
                filenames.append(filename)
            except Exception:
                logger.warning("拷贝生成的朋友圈图片失败: %s", src, exc_info=True)

        cleaned_text = _clean_moments_text(text)
        if not cleaned_text and not filenames:
            logger.info("朋友圈刷新结果为空，已跳过 persona=%s", persona_id)
            return

        self._store.add_moment(
            author=persona_id,
            text=cleaned_text,
            images=filenames,
            moment_id=moment_id,
        )
        broadcast("moments_updated", action="added", moment_id=moment_id)

        if cleaned_text and filenames:
            mem_summary = (
                f"我发布了一条朋友圈：「{_excerpt(cleaned_text)}」，"
                f"配了 {len(filenames)} 张图。"
            )
        elif cleaned_text:
            mem_summary = f"我发布了一条朋友圈：「{_excerpt(cleaned_text)}」。"
        else:
            mem_summary = f"我在朋友圈分享了 {len(filenames)} 张图。"
        self._write_moment_memory(persona_id, mem_summary)

        if self._stop_event.is_set():
            return
        self._reply_workflow(moment_id, exclude=persona_id)

    def _reply_workflow(self, moment_id: str, *, exclude: str | None) -> None:
        moment = self._store.get_moment(moment_id)
        if moment is None:
            return  # deleted during generation
        text = moment.get("text", "")
        image_filenames = moment.get("images", []) or []
        images_payload = self._load_images_for_llm(moment_id, image_filenames)

        repliers = list(self._repliers())
        prob_map = self._config.get(
            "moments", "reply_probabilities", default={},
        ) or {}
        prompt_template = (
            (self._config.get("moments", "prompts", "reply", default="") or "").strip()
            or DEFAULT_REPLY_PROMPT
        )

        personas = self._config.load_personas()
        author = moment.get("author", "")
        if author == "user":
            author_name = load_profile_name()
        else:
            ap = personas.get(author)
            author_name = ap.name if ap else author

        # Shuffle so reply order isn't deterministic — feels more organic.
        random.shuffle(repliers)

        for rid in repliers:
            if self._stop_event.is_set():
                break
            if exclude and rid == exclude:
                continue
            if rid == "user":
                continue
            try:
                prob = int(prob_map.get(rid, 50))
            except (TypeError, ValueError):
                prob = 50
            prob = max(0, min(100, prob))
            if random.randint(1, 100) > prob:
                continue
            replier = personas.get(rid)
            if not replier:
                continue
            instruction = _render_template(
                prompt_template,
                author=author_name,
                text=text or "（无文字）",
            )
            try:
                with self._llm_call_lock:
                    reply_text, _ = self._chat.run_oneshot(
                        rid,
                        instruction=instruction,
                        images=images_payload,
                        include_image_tool=False,
                    )
            except Exception:
                logger.exception(
                    "朋友圈回复生成失败 replier=%s moment=%s", rid, moment_id,
                )
                continue
            reply_text = _clean_moments_text(reply_text)
            if not reply_text:
                continue
            added = self._store.add_reply(
                moment_id, author=rid, text=reply_text,
            )
            if added is None:
                break  # moment was deleted mid-flight
            broadcast(
                "moments_updated",
                action="reply_added",
                moment_id=moment_id,
            )
            # Only record when commenting on the user's moment — not on other
            # personas' moments (scope limited per product decision).
            if author == "user":
                if text:
                    moment_part = f"对方发的是：「{_excerpt(text)}」。"
                else:
                    moment_part = (
                        f"对方只发了 {len(image_filenames)} 张图，没有文字。"
                    )
                mem_summary = (
                    f"我在「{author_name}」的朋友圈下评论："
                    f"「{_excerpt(reply_text)}」。{moment_part}"
                )
                self._write_moment_memory(rid, mem_summary)
            # Persona who commented also auto-likes the moment
            # (never self-likes — see ``_auto_like_moment``).
            self._auto_like_moment(moment_id, rid, author=author)

    # ---- Helpers ----

    def _publishers(self) -> list[str]:
        raw = self._config.get("moments", "publishers", default=[]) or []
        return self._eligible_persona_ids(raw)

    def _repliers(self) -> list[str]:
        raw = self._config.get("moments", "repliers", default=[]) or []
        return self._eligible_persona_ids(raw)

    def _eligible_persona_ids(self, raw: list[str]) -> list[str]:
        """Return unique persona ids that still exist and can run Moments.

        The config is user-editable and personas can be deleted while the app
        is running, so the runtime selection list needs to be defensive.
        """
        personas = self._config.load_personas()
        eligible: list[str] = []
        seen: set[str] = set()
        for pid in raw:
            if not isinstance(pid, str) or not pid or pid in seen:
                continue
            persona = personas.get(pid)
            if persona is None:
                continue
            if not persona.llm_provider or not persona.llm_model:
                continue
            if self._chat.llm_manager.get_provider(persona.llm_provider) is None:
                continue
            eligible.append(pid)
            seen.add(pid)
        return eligible

    def _load_images_for_llm(
        self,
        moment_id: str,
        filenames: list[str],
    ) -> list[dict]:
        out: list[dict] = []
        for fn in filenames:
            path = self._store.get_image_path(moment_id, fn)
            if path is None:
                continue
            mime = mimetypes.guess_type(str(path))[0] or "image/jpeg"
            try:
                out.append({"data": path.read_bytes(), "mime": mime})
            except OSError:
                logger.warning("朋友圈图片读取失败: %s", path, exc_info=True)
        return out

    def _write_moment_memory(self, persona_id: str, summary: str) -> None:
        """Append a moments-derived memory entry for ``persona_id``.

        Gated by the ``moments.memory_enabled[persona_id]`` toggle (default
        True). Independent of the persona's own ``memory.enabled``: the latter
        governs the conversation-side ``record_memory`` / ``update_memory``
        tools (which ``run_oneshot`` deliberately withholds from moments
        flows — this method is the only moments memory writer). Failures are
        logged and swallowed — the moments flow must never break because of a
        memory write error.
        """
        cfg = self._config.get("moments", "memory_enabled", default={}) or {}
        if not bool(cfg.get(persona_id, True)):
            return
        memory_service = getattr(self._app, "memory_service", None)
        if memory_service is None:
            return
        try:
            memory_service.add_memory(persona_id, summary, importance=2)
            # Chat-idle personas miss the round-end consolidation check in
            # MessageQueue, so trigger it here as a backstop. Runs in a
            # background thread with in-flight dedup.
            memory_service.maybe_consolidate(persona_id)
        except Exception:
            logger.warning(
                "写入朋友圈记忆失败 persona=%s", persona_id, exc_info=True,
            )

    def _begin_task(self) -> bool:
        with self._gen_lock:
            if self._generating:
                return False
            self._generating = True
        broadcast("moments_generating", is_generating=True)
        return True

    def _end_task(self) -> None:
        with self._gen_lock:
            self._generating = False
        broadcast("moments_generating", is_generating=False)

    # ---- Counter-reply worker ----

    def _counter_reply_worker_loop(self) -> None:
        """Single-consumer drain of ``_counter_reply_queue``.

        Each user reply that targets a persona enqueues exactly one task;
        the worker processes them one at a time. Errors are swallowed so a
        single bad task can't kill the worker for the rest of the session.
        """
        while not self._stop_event.is_set():
            try:
                task = self._counter_reply_queue.get(timeout=1.0)
            except queue.Empty:
                continue
            moment_id, persona_id, user_reply_id = task
            try:
                self._generate_counter_reply(moment_id, persona_id, user_reply_id)
            except Exception:
                logger.exception(
                    "朋友圈反向回复失败 moment=%s persona=%s",
                    moment_id, persona_id,
                )
            finally:
                try:
                    self._counter_reply_queue.task_done()
                except ValueError:
                    pass

    def _generate_counter_reply(
        self,
        moment_id: str,
        persona_id: str,
        user_reply_id: str,
    ) -> None:
        moment = self._store.get_moment(moment_id)
        if moment is None:
            return  # deleted in flight

        personas = self._config.load_personas()
        persona = personas.get(persona_id)
        if persona is None:
            return  # persona removed in flight

        user_reply = self._store.get_reply(moment_id, user_reply_id)
        if user_reply is None:
            return  # user reply gone

        moment_author = moment.get("author", "")
        if moment_author == "user":
            moment_author_label = load_profile_name()
        else:
            ap = personas.get(moment_author)
            moment_author_label = ap.name if ap else moment_author
        user_name = load_profile_name()

        thread_text = self._build_counter_reply_thread(
            moment, user_reply_id, user_name=user_name, personas=personas,
        )

        prompt_template = (
            (self._config.get("moments", "prompts", "counter_reply", default="") or "").strip()
            or DEFAULT_COUNTER_REPLY_PROMPT
        )
        instruction = _render_template(
            prompt_template,
            moment_author=moment_author_label,
            moment_text=moment.get("text", "") or "（无文字）",
            user_name=user_name,
            user_reply=user_reply.get("text", ""),
            thread=thread_text or "（无）",
        )

        image_filenames = moment.get("images", []) or []
        images_payload = self._load_images_for_llm(moment_id, image_filenames)

        try:
            with self._llm_call_lock:
                reply_text, _ = self._chat.run_oneshot(
                    persona_id,
                    instruction=instruction,
                    images=images_payload,
                    include_image_tool=False,
                )
        except Exception:
            logger.exception(
                "朋友圈反向回复 LLM 调用失败 moment=%s persona=%s",
                moment_id, persona_id,
            )
            return

        reply_text = _clean_moments_text(reply_text)
        if not reply_text:
            return

        added = self._store.add_reply(
            moment_id,
            author=persona_id,
            text=reply_text,
            reply_to=user_reply_id,
        )
        if added is None:
            return  # moment deleted mid-flight
        broadcast("moments_updated", action="reply_added", moment_id=moment_id)
        # Only record when the persona is replying under their own moment;
        # scope decision (not on other personas' moments).
        if moment_author == persona_id:
            mem_summary = (
                f"在我发的朋友圈下，「{user_name}」对我说："
                f"「{_excerpt(user_reply.get('text', ''))}」，"
                f"我回复了：「{_excerpt(reply_text)}」。"
            )
            self._write_moment_memory(persona_id, mem_summary)
        # Auto-like after counter-reply; never self-like own moment.
        self._auto_like_moment(moment_id, persona_id, author=moment_author)

    def _auto_like_moment(
        self,
        moment_id: str,
        persona_id: str,
        *,
        author: str | None = None,
    ) -> bool:
        """Record a persona auto-like after commenting / counter-replying.

        Central rule for automated engagement: a persona must never auto-like
        a moment they authored. Manual likes via :meth:`like` are unaffected
        and still go straight to the store.
        """
        if not persona_id or persona_id == "user":
            return False
        if author is None:
            moment = self._store.get_moment(moment_id)
            if moment is None:
                return False
            author = moment.get("author", "") or ""
        if persona_id == author:
            return False
        if self._store.add_like(moment_id, persona_id):
            broadcast(
                "moments_updated",
                action="like_changed",
                moment_id=moment_id,
            )
            return True
        return False

    def _build_counter_reply_thread(
        self,
        moment: dict,
        user_reply_id: str,
        *,
        user_name: str,
        personas: dict,
    ) -> str:
        """Walk back via ``reply_to`` from the user's latest reply to the
        thread's root, then render the chain in chronological order so the
        persona has context for its response. Excludes the latest user reply
        itself — that's passed as ``{user_reply}``."""
        replies = moment.get("replies", []) or []
        by_id = {r.get("id"): r for r in replies if r.get("id")}
        chain: list[dict] = []
        cur = by_id.get(user_reply_id)
        # Skip the latest user reply (it's the trigger, not history).
        if cur is not None:
            cur = by_id.get(cur.get("reply_to")) if cur.get("reply_to") else None
        while cur is not None and len(chain) < 12:
            chain.append(cur)
            parent_id = cur.get("reply_to")
            cur = by_id.get(parent_id) if parent_id else None
        chain.reverse()
        if not chain:
            return ""

        def label(author: str) -> str:
            if author == "user":
                return user_name
            p = personas.get(author)
            return p.name if p else author

        lines: list[str] = []
        for r in chain:
            who = label(r.get("author", ""))
            text = (r.get("text") or "").strip()
            lines.append(f"{who}：{text}")
        return "\n".join(lines)
