from __future__ import annotations

import copy
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from pawzochat.core.config import ConfigManager, DEFAULTS
from pawzochat.utils.crypto import hash_password
from pawzochat.web.app import create_app


class AdminAuthTests(unittest.TestCase):
    def make_client(self, password: str = "", web_password: str = ""):
        config = ConfigManager()
        config._data = copy.deepcopy(DEFAULTS)
        config._data["admin"]["password"] = hash_password(password) if password else ""
        config._data["web"]["password"] = hash_password(web_password) if web_password else ""
        app = create_app(SimpleNamespace(config=config))
        app.config["TESTING"] = True
        return app.test_client()

    def test_admin_requires_configured_password(self):
        client = self.make_client()
        response = client.get("/admin")
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers["Location"].endswith("/admin/login"))

        api_response = client.get("/api/admin/dashboard")
        self.assertEqual(api_response.status_code, 503)
        self.assertEqual(api_response.get_json()["error"], "admin_password_not_configured")

    def test_admin_login_uses_separate_session(self):
        client = self.make_client("SecurePass1")
        login_page = client.get("/admin/login")
        self.assertEqual(login_page.status_code, 200)
        with client.session_transaction() as session:
            token = session["admin_csrf_token"]
            self.assertNotIn("admin_authenticated", session)

        response = client.post("/admin/login", data={
            "csrf_token": token,
            "password": "SecurePass1",
        })
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers["Location"].endswith("/admin"))
        with client.session_transaction() as session:
            self.assertTrue(session["admin_authenticated"])
            self.assertNotIn("authenticated", session)

        page = client.get("/admin")
        self.assertEqual(page.status_code, 200)
        self.assertIn("人物管理后台", page.get_data(as_text=True))

        dashboard = client.get("/api/admin/dashboard")
        self.assertEqual(dashboard.status_code, 200)
        self.assertEqual(dashboard.get_json()["total"], 0)

    def test_admin_write_requires_same_origin(self):
        client = self.make_client("SecurePass1")
        with client.session_transaction() as session:
            session["admin_authenticated"] = True
        rejected = client.post("/api/admin/batch/preview", json={"ids": [], "operations": []})
        self.assertEqual(rejected.status_code, 403)
        accepted = client.post(
            "/api/admin/batch/preview",
            json={"ids": [], "operations": []},
            headers={"Origin": "http://localhost"},
        )
        self.assertEqual(accepted.status_code, 400)
        self.assertEqual(accepted.get_json()["error"], "请至少选择一个人物")

    def test_admin_creation_endpoints_require_admin_session(self):
        client = self.make_client("SecurePass1")
        headers = {"Origin": "http://localhost"}
        for path in ("/api/admin/creation/generate", "/api/admin/creation/image"):
            response = client.post(path, json={}, headers=headers)
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.get_json()["error"], "admin_unauthorized")

    def test_public_admin_requires_panel_login_before_admin_login(self):
        client = self.make_client("SecurePass1", web_password="PanelPass1")
        public_request = {"environ_overrides": {"pawzochat.is_public": True}}

        response = client.get("/admin", **public_request)
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers["Location"].endswith("/login"))

        with client.session_transaction() as session:
            session["authenticated"] = True
        response = client.get("/admin", **public_request)
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers["Location"].endswith("/admin/login"))

    def test_local_settings_hash_and_redact_admin_password(self):
        client = self.make_client()
        config = client.application.config["PAWZOCHAT_APP"].config
        with patch.object(config, "save"):
            response = client.patch("/api/settings", json={
                "admin": {"password": "SecurePass1"},
            })
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["admin"]["has_password"])
        self.assertNotEqual(config.get("admin", "password"), "SecurePass1")
        exposed = client.get("/api/settings").get_json()["admin"]
        self.assertEqual(exposed, {"has_password": True})


if __name__ == "__main__":
    unittest.main()