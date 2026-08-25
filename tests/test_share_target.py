from __future__ import annotations

import copy
import json
import unittest
from types import SimpleNamespace

from pawzochat.core.config import ConfigManager, DEFAULTS
from pawzochat.web.app import create_app


class ShareTargetManifestTests(unittest.TestCase):
    def make_client(self):
        config = ConfigManager()
        config._data = copy.deepcopy(DEFAULTS)
        app = create_app(SimpleNamespace(config=config))
        app.config["TESTING"] = True
        return app.test_client()

    def test_manifest_declares_multipart_share_target(self):
        response = self.make_client().get(
            "/manifest.webmanifest",
            environ_overrides={"SCRIPT_NAME": "/secret"},
        )

        self.assertEqual(response.status_code, 200)
        manifest = json.loads(response.get_data(as_text=True))
        target = manifest["share_target"]
        self.assertEqual(target["action"], "/secret/share-target")
        self.assertEqual(target["method"], "POST")
        self.assertEqual(target["enctype"], "multipart/form-data")
        self.assertEqual(target["params"]["title"], "title")
        self.assertEqual(target["params"]["text"], "text")
        self.assertEqual(target["params"]["url"], "url")
        self.assertEqual(target["params"]["files"][0]["name"], "files")
        self.assertIn("*/*", target["params"]["files"][0]["accept"])
        self.assertIn("image/*", target["params"]["files"][0]["accept"])
        self.assertEqual(response.headers["Cache-Control"], "no-cache")

    def test_manifest_declares_prefixed_app_shortcuts(self):
        response = self.make_client().get(
            "/manifest.webmanifest",
            environ_overrides={"SCRIPT_NAME": "/secret"},
        )

        manifest = json.loads(response.get_data(as_text=True))
        shortcuts = manifest["shortcuts"]
        self.assertEqual(
            [(item["name"], item["url"]) for item in shortcuts],
            [
                ("雷达", "/secret/?shortcut=radar"),
                ("人设编写助手", "/secret/?shortcut=persona-writer"),
                ("朋友圈", "/secret/?shortcut=moments"),
                ("AI 图库", "/secret/?shortcut=gallery"),
            ],
        )
        self.assertEqual(
            [item["icons"][0]["src"] for item in shortcuts],
            [
                "/secret/static/pwa/shortcut-radar.png",
                "/secret/static/pwa/shortcut-persona-writer.png",
                "/secret/static/pwa/shortcut-moments.png",
                "/secret/static/pwa/shortcut-gallery.png",
            ],
        )
        for shortcut in shortcuts:
            self.assertEqual(shortcut["icons"][0]["sizes"], "192x192")


if __name__ == "__main__":
    unittest.main()