from __future__ import annotations

import copy
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

from pawzochat.core import config as config_module
from pawzochat.core.config import ConfigManager, DEFAULTS
from pawzochat.services import bundle as bundle_mod
from pawzochat.services import persona_management as management_module
from pawzochat.services.persona_management import PersonaManagementError, PersonaManagementService
from pawzochat.transport.models import Persona


class _Worldbooks:
    def list_books(self):
        return [{"name": "共同设定"}]

    def get_book(self, name):
        return {"name": name, "content": {}} if name == "共同设定" else None


class PersonaManagementTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.patchers = [
            patch.object(config_module, "CONFIG_PATH", root / "config" / "config.yaml"),
            patch.object(config_module, "PROMPTS_DIR", root / "prompts"),
            patch.object(management_module, "CHATS_DIR", root / "chats"),
            patch.object(management_module, "PROMPT_TEMPLATES_PATH", root / "admin" / "templates.json"),
        ]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

        self.config = ConfigManager()
        self.config._data = copy.deepcopy(DEFAULTS)
        self.config._data["personas"] = {
            "alice": {
                "enabled": True,
                "name": "Alice",
                "signature": "测试人物",
                "llm_provider": "",
                "llm_model": "",
                "temperature": 1.0,
                "max_tokens": 2000,
                "bound_worldbooks": [],
            },
            "bob": {
                "enabled": True,
                "name": "Bob",
                "signature": "",
                "llm_provider": "",
                "llm_model": "",
                "temperature": 1.0,
                "max_tokens": 2000,
                "bound_worldbooks": [],
            },
        }
        self.config.save_prompt_parts("alice", "你好 {{name}}", "示例", "系统")
        self.config.save_prompt_parts("bob", "你好", "", "系统")
        self.app = SimpleNamespace(config=self.config, worldbook_service=_Worldbooks())
        self.service = PersonaManagementService(self.app)

    def test_preview_and_apply_are_versioned_and_atomic(self):
        operations = [
            {"kind": "set", "path": "enabled", "value": False},
            {"kind": "set", "path": "memory.enabled", "value": False},
            {"kind": "worldbooks", "mode": "append", "values": ["共同设定"]},
            {"kind": "prompt", "field": "character_prompt", "mode": "append", "value": "补充"},
        ]
        preview = self.service.preview_batch(["alice", "bob"], operations)
        self.assertEqual(preview["changed_count"], 2)

        result = self.service.apply_batch(["alice", "bob"], operations, preview["version"])

        self.assertEqual(result["updated_count"], 2)
        self.assertFalse(self.config._data["personas"]["alice"]["enabled"])
        self.assertFalse(self.config._data["personas"]["bob"]["memory"]["enabled"])
        self.assertEqual(self.config._read_prompt_file("alice")["character_prompt"], "你好 {{name}}\n补充")

    def test_rejects_stale_preview(self):
        operations = [{"kind": "set", "path": "enabled", "value": False}]
        preview = self.service.preview_batch(["alice"], operations)
        self.config._data["personas"]["alice"]["signature"] = "配置已变化"

        with self.assertRaisesRegex(PersonaManagementError, "重新预览"):
            self.service.apply_batch(["alice"], operations, preview["version"])

    def test_failed_save_rolls_back_prompt_and_memory_config(self):
        operations = [
            {"kind": "set", "path": "enabled", "value": False},
            {"kind": "prompt", "field": "character_prompt", "mode": "overwrite", "value": "新内容"},
        ]
        preview = self.service.preview_batch(["alice"], operations)
        before = copy.deepcopy(self.config._data)
        with patch.object(self.config, "save", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.service.apply_batch(["alice"], operations, preview["version"])
        self.assertEqual(self.config._data, before)
        self.assertEqual(self.config._read_prompt_file("alice")["character_prompt"], "你好 {{name}}")

    def test_template_variables_are_expanded_per_persona(self):
        operations = [{
            "kind": "prompt",
            "field": "system_instructions",
            "mode": "template",
            "value": "你是 {{name}}，编号 {{id}}，签名 {{signature}}",
        }]
        preview = self.service.preview_batch(["alice"], operations)
        self.service.apply_batch(["alice"], operations, preview["version"])

        prompt = self.config._read_prompt_file("alice")
        self.assertEqual(prompt["system_instructions"], "你是 Alice，编号 alice，签名 测试人物")

    def test_duplicate_names_fail_before_writing(self):
        before = copy.deepcopy(self.config._data)
        with self.assertRaisesRegex(PersonaManagementError, "重复"):
            self.service.preview_batch(
                ["alice"],
                [{"kind": "set", "path": "name", "value": "Bob"}],
            )
        self.assertEqual(self.config._data, before)

    def test_create_persona_persists_reviewed_draft(self):
        result = self.service.create_persona({
            "enabled": False,
            "name": "  新人物  ",
            "signature": " 新签名 ",
            "character_prompt": "完整人设",
            "output_examples": "你好\\再见",
            "system_instructions": "系统要求",
            "image_generation": {"style_prefix": "银发，蓝眼"},
        })

        persona_id = result["id"]
        stored = self.config._data["personas"][persona_id]
        prompt = self.config._read_prompt_file(persona_id)
        self.assertEqual(result["name"], "新人物")
        self.assertFalse(stored["enabled"])
        self.assertEqual(stored["signature"], "新签名")
        self.assertNotIn("style_prefix", stored["image_generation"])
        self.assertEqual(prompt["character_prompt"], "完整人设")
        self.assertEqual(prompt["image_style_prefix"], "银发，蓝眼")
        self.assertIn(persona_id, self.config._data["moments"]["publishers"])
        self.assertIn(persona_id, self.config._data["moments"]["repliers"])

    def test_create_persona_persists_generated_images(self):
        image = io.BytesIO()
        Image.new("RGB", (320, 180), "#123456").save(image, "PNG")

        result = self.service.create_persona(
            {"name": "带图片人物", "character_prompt": "人设"},
            avatar=image.getvalue(),
            moments_cover=image.getvalue(),
        )

        persona_dir = management_module.CHATS_DIR / result["id"]
        self.assertTrue((persona_dir / "avatar.png").is_file())
        self.assertTrue((persona_dir / "moments-cover.png").is_file())
        with Image.open(persona_dir / "avatar.png") as avatar:
            self.assertEqual(avatar.size, (256, 256))

    def test_create_persona_rolls_back_prompt_and_images_when_config_save_fails(self):
        image = io.BytesIO()
        Image.new("RGB", (320, 180), "#123456").save(image, "PNG")
        before = copy.deepcopy(self.config._data)
        persona_id = "created0"

        with (
            patch.object(
                management_module.uuid,
                "uuid4",
                return_value=SimpleNamespace(hex=f"{persona_id}000000000000000000000000"),
            ),
            patch.object(self.config, "save", side_effect=OSError("disk full")),
        ):
            with self.assertRaises(OSError):
                self.service.create_persona(
                    {"name": "事务回滚人物", "character_prompt": "人设"},
                    avatar=image.getvalue(),
                    moments_cover=image.getvalue(),
                )

        self.assertEqual(self.config._data, before)
        self.assertFalse(self.config.prompt_path(persona_id).exists())
        self.assertFalse((management_module.CHATS_DIR / persona_id).exists())

    def test_create_persona_rejects_duplicate_name_without_writing(self):
        before = copy.deepcopy(self.config._data)
        with self.assertRaisesRegex(PersonaManagementError, "重复") as context:
            self.service.create_persona({"name": "Alice", "character_prompt": "人设"})
        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(self.config._data, before)

    def test_clone_is_disabled_and_does_not_copy_history(self):
        source_dir = management_module.CHATS_DIR / "alice"
        source_dir.mkdir(parents=True)
        (source_dir / "conversation.json").write_text("{}", encoding="utf-8")
        created = self.service.clone_personas(["alice"])
        clone = created[0]
        self.assertFalse(self.config._data["personas"][clone["id"]]["enabled"])
        self.assertFalse((management_module.CHATS_DIR / clone["id"] / "conversation.json").exists())
        self.assertEqual(
            self.config._read_prompt_file(clone["id"])["character_prompt"],
            "你好 {{name}}",
        )

    def test_bundle_import_preserves_enabled_and_signature(self):
        package = bundle_mod.pack_persona(Persona(
            id="source", name="导入人物", signature="签名", enabled=False,
            character_prompt="设定", system_instructions="系统",
        ))
        result = self.service.import_persona(package, "persona.ppack")
        stored = self.config._data["personas"][result["id"]]
        self.assertFalse(stored["enabled"])
        self.assertEqual(stored["signature"], "签名")
        self.assertEqual(self.config._read_prompt_file(result["id"])["character_prompt"], "设定")


if __name__ == "__main__":
    unittest.main()