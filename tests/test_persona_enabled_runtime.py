from __future__ import annotations

import copy
import unittest
from types import SimpleNamespace

from pawzochat.core.config import ConfigManager, DEFAULTS
from pawzochat.services.chat import ChatService
from pawzochat.services.message_queue import MessageQueue
from pawzochat.services.proactive import ProactiveService


class PersonaEnabledRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.config = ConfigManager()
        self.config._data = copy.deepcopy(DEFAULTS)
        self.config._data["personas"] = {
            "paused": {"name": "停用人物", "enabled": False},
            "active": {"name": "启用人物", "enabled": True},
        }

    def test_chat_service_rejects_disabled_persona(self):
        service = ChatService(None, self.config, None)
        with self.assertRaisesRegex(ValueError, "人物已停用"):
            service._resolve_persona("paused")
        self.assertEqual(service._resolve_persona("active").name, "启用人物")

    def test_proactive_service_skips_disabled_persona(self):
        service = ProactiveService(SimpleNamespace(config=self.config))
        self.assertIsNone(service._persona_proactive_cfg("paused"))

    def test_retry_and_regenerate_reject_disabled_persona_before_loading_conversation(self):
        app = SimpleNamespace(config=self.config)
        queue = MessageQueue(app)
        self.assertEqual(queue.retry_reply("paused", 1), "disabled")
        self.assertEqual(queue.regenerate_reply("paused", 1), "disabled")

    def test_retry_rejects_missing_persona_when_config_is_available(self):
        app = SimpleNamespace(config=self.config)
        queue = MessageQueue(app)
        self.assertEqual(queue.retry_reply("missing", 1), "disabled")
        self.assertEqual(queue.regenerate_reply("missing", 1), "disabled")


if __name__ == "__main__":
    unittest.main()