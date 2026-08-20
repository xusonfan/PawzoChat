import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from pawzochat.services.message_queue import MessageQueue
from pawzochat.services.reply_dispatcher import ReplyDispatcher


class _ConversationStore:
    def __init__(self):
        self.messages = []
        self._lock = threading.Lock()

    def add_message(
        self,
        persona_id,
        role,
        content,
        source,
        timestamp=None,
        quote="",
    ):
        with self._lock:
            message = {
                "role": role,
                "content": list(content),
                "source": source,
                "timestamp": timestamp or "2026-08-20T10:00:00+08:00",
                "_seq": len(self.messages) + 1,
            }
            if quote:
                message["quote"] = quote
            self.messages.append(message)
            return message

    def get_conversation(self, persona_id):
        with self._lock:
            return {"messages": list(self.messages)}

    def text_history(self):
        with self._lock:
            return [
                block.get("text", "")
                for message in self.messages
                if message.get("role") == "user"
                for block in message.get("content", [])
                if block.get("type") == "text"
            ]


class _ChatService:
    def __init__(self, store, *, block_first=False):
        self.store = store
        self.block_first = block_first
        self.first_started = threading.Event()
        self.release_first = threading.Event()
        self.histories = []

    def process_round(self, persona_id, **kwargs):
        self.histories.append(self.store.text_history())
        call_number = len(self.histories)
        if self.block_first and call_number == 1:
            self.first_started.set()
            if not self.release_first.wait(2):
                raise TimeoutError("测试中的首轮回复未被释放")
        text = "旧回复" if call_number == 1 else "新回复"
        return [{
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
            "source": "llm",
        }]


class _RecordingDispatcher:
    def __init__(self):
        self.replies = []

    def deliver_messages(
        self,
        persona_id,
        messages,
        reply_ctx=None,
        before_first_message=None,
    ):
        if before_first_message is not None and not before_first_message():
            return []
        self.replies.extend(messages)
        return list(messages)


class _BlockingDispatcher(_RecordingDispatcher):
    def __init__(self):
        super().__init__()
        self.reply_started = threading.Event()
        self.release_reply = threading.Event()

    def deliver_messages(
        self,
        persona_id,
        messages,
        reply_ctx=None,
        before_first_message=None,
    ):
        if before_first_message is not None and not before_first_message():
            return []
        self.reply_started.set()
        if not self.release_reply.wait(2):
            raise TimeoutError("测试中的已提交回复未被释放")
        self.replies.extend(messages)
        return list(messages)


def _make_queue(*, block_first=False, dispatcher=None):
    store = _ConversationStore()
    chat_service = _ChatService(store, block_first=block_first)
    reply_dispatcher = dispatcher or _RecordingDispatcher()
    extension_manager = SimpleNamespace(
        dispatch_message_stored=Mock(),
        dispatch_reply_compose=Mock(),
    )
    app = SimpleNamespace(
        conversation_store=store,
        extension_manager=extension_manager,
        chat_service=chat_service,
        emoji_service=None,
        reply_dispatcher=reply_dispatcher,
        memory_service=None,
    )
    return MessageQueue(app), store, chat_service, reply_dispatcher


def _start_process(queue, persona_id="cat"):
    with queue._lock:
        persona_queue = queue._queues[persona_id]
        persona_queue.processing = True
        persona_queue.reply_started = False
    thread = threading.Thread(target=queue._process, args=(persona_id,))
    thread.start()
    return thread


class MessageQueueSupersedeTests(unittest.TestCase):
    def test_new_message_replaces_reply_before_first_assistant_message(self):
        queue, store, chat_service, dispatcher = _make_queue(block_first=True)
        queue.enqueue("cat", "第一条", "web", reply_ctx={"channel": "web"})
        queue.enqueue("cat", "第二条", "web", reply_ctx={"channel": "web"})

        first_process = _start_process(queue)
        self.assertTrue(chat_service.first_started.wait(1))
        queue.enqueue("cat", "第三条", "web", reply_ctx={"channel": "web"})

        with queue._lock:
            persona_queue = queue._queues["cat"]
            self.assertEqual(persona_queue.last_message_time, 0.0)
            self.assertEqual(len(persona_queue.pending_messages), 1)

        chat_service.release_first.set()
        first_process.join(2)
        self.assertFalse(first_process.is_alive())
        self.assertEqual(dispatcher.replies, [])

        second_process = _start_process(queue)
        second_process.join(2)
        self.assertFalse(second_process.is_alive())
        self.assertEqual(
            chat_service.histories,
            [["第一条", "第二条"], ["第一条", "第二条", "第三条"]],
        )
        self.assertEqual(store.text_history(), ["第一条", "第二条", "第三条"])
        self.assertEqual(
            dispatcher.replies[0]["content"][0]["text"],
            "新回复",
        )

    def test_new_message_does_not_replace_reply_after_first_message_commits(self):
        dispatcher = _BlockingDispatcher()
        queue, _, _, _ = _make_queue(dispatcher=dispatcher)
        queue.enqueue("cat", "第一条", "web", reply_ctx={"channel": "web"})

        process = _start_process(queue)
        self.assertTrue(dispatcher.reply_started.wait(1))
        before_enqueue = time.time()
        queue.enqueue("cat", "第二条", "web", reply_ctx={"channel": "web"})

        with queue._lock:
            persona_queue = queue._queues["cat"]
            self.assertGreaterEqual(persona_queue.last_message_time, before_enqueue)
            self.assertTrue(persona_queue.reply_started)

        dispatcher.release_reply.set()
        process.join(2)
        self.assertFalse(process.is_alive())
        self.assertEqual(
            dispatcher.replies[0]["content"][0]["text"],
            "旧回复",
        )


class ReplyDispatcherSupersedeTests(unittest.TestCase):
    @patch("pawzochat.services.reply_dispatcher.broadcast")
    def test_rejected_first_message_is_not_persisted_or_broadcast(self, broadcast):
        app = SimpleNamespace(
            extension_manager=SimpleNamespace(dispatch_reply_pre_send=Mock()),
            conversation_store=SimpleNamespace(add_message=Mock()),
            channel_registry=SimpleNamespace(get=Mock()),
            web_push_service=None,
        )
        dispatcher = ReplyDispatcher.__new__(ReplyDispatcher)
        dispatcher._app = app
        dispatcher._image_cache_queue = Mock()

        delivered = dispatcher.deliver_messages(
            "cat",
            [{
                "role": "assistant",
                "content": [{"type": "text", "text": "不应出现"}],
                "source": "llm",
            }],
            reply_ctx={"channel": "web"},
            before_first_message=lambda: False,
        )

        self.assertEqual(delivered, [])
        app.conversation_store.add_message.assert_not_called()
        app.channel_registry.get.assert_not_called()
        broadcast.assert_not_called()


if __name__ == "__main__":
    unittest.main()