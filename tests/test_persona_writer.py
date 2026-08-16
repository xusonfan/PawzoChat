from __future__ import annotations

import json
import unittest

from pawzochat.web.routes.api_persona_writer import _parse_persona_draft


class TestPersonaWriterDraftParser(unittest.TestCase):
    def test_parses_complete_generated_profile(self):
        raw = json.dumps(
            {
                "name": "雷电将军",
                "signature": "此身即是尘世最为殊胜尊贵之身",
                "character_prompt": "稻妻的雷之神，追求永恒。",
                "output_examples": [
                    ["你已觉悟", "无需多言"],
                    r"此刻\便是永恒",
                ],
                "avatar_prompt": "紫色长发，和服胸像，纯净背景",
                "background_prompt": "横向构图，稻妻城与雷光，以景物为主",
            },
            ensure_ascii=False,
        )

        self.assertEqual(
            _parse_persona_draft(raw),
            (
                "雷电将军",
                "此身即是尘世最为殊胜尊贵之身",
                "稻妻的雷之神，追求永恒。",
                "你已觉悟\\无需多言\n此刻\\便是永恒",
                "紫色长发，和服胸像，纯净背景",
                "横向构图，稻妻城与雷光，以景物为主",
            ),
        )

    def test_limits_name_and_signature(self):
        raw = json.dumps({"name": "名" * 120, "signature": "签" * 120})
        name, signature, *_ = _parse_persona_draft(raw)
        self.assertEqual(len(name), 100)
        self.assertEqual(len(signature), 100)

    def test_legacy_markers_leave_new_fields_empty(self):
        result = _parse_persona_draft("[人设设定]\n角色设定\n[输出示例]\n你好\\再见")
        self.assertEqual(result, ("", "", "角色设定", "你好\\再见", "", ""))


if __name__ == "__main__":
    unittest.main()