import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Flask

from pawzochat.services.chat import ChatService
from pawzochat.utils.location import InvalidLocation, sanitize_location
from pawzochat.web.routes.api_conversations import api_conversations_bp


class LocationValidationTests(unittest.TestCase):
    def test_city_location_is_coarsened_and_drops_accuracy(self):
        location = sanitize_location({
            "precision": "city",
            "latitude": 31.230416,
            "longitude": 121.473701,
            "accuracy_m": 8,
        })

        self.assertEqual(location, {
            "type": "location",
            "precision": "city",
            "latitude": 31.2,
            "longitude": 121.5,
        })

    def test_precise_location_preserves_sanitized_place_text(self):
        location = sanitize_location({
            "precision": "precise",
            "latitude": 31.2304164,
            "longitude": 121.4737012,
            "name": "  人民 广场  ",
            "address": "上海市\n黄浦区 人民大道",
        })

        self.assertEqual(location["latitude"], 31.230416)
        self.assertEqual(location["longitude"], 121.473701)
        self.assertEqual(location["name"], "人民 广场")
        self.assertEqual(location["address"], "上海市 黄浦区 人民大道")

    def test_rejects_invalid_coordinates(self):
        with self.assertRaises(InvalidLocation):
            sanitize_location({
                "precision": "precise",
                "latitude": 91,
                "longitude": 121.4,
            })


class LocationMessageApiTests(unittest.TestCase):
    def setUp(self):
        self.queue = Mock()
        self.queue.accept_message.return_value = (
            "cat",
            {
                "role": "user",
                "content": [{
                    "type": "location",
                    "precision": "city",
                    "latitude": 31.2,
                    "longitude": 121.5,
                }],
                "source": "web",
            },
        )
        pawzo_app = SimpleNamespace(
            conversation_store=SimpleNamespace(
                get_conversation=lambda persona_id: {"persona_id": persona_id}
            ),
            message_queue=self.queue,
        )
        flask_app = Flask(__name__)
        flask_app.config["PAWZOCHAT_APP"] = pawzo_app
        flask_app.register_blueprint(api_conversations_bp, url_prefix="/api/conversations")
        self.client = flask_app.test_client()

    @patch("pawzochat.web.routes.api_conversations.search_places")
    def test_searches_locations_for_picker(self, search_places_mock):
        search_places_mock.return_value = [{
            "name": "人民广场",
            "address": "上海市黄浦区人民大道",
            "latitude": 31.2304,
            "longitude": 121.4737,
        }]

        response = self.client.get("/api/conversations/locations/search?q=人民广场")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["places"][0]["name"], "人民广场")
        search_places_mock.assert_called_once_with("人民广场")

    @patch("pawzochat.web.routes.api_conversations.reverse_place")
    def test_reverse_geocodes_selected_point(self, reverse_place_mock):
        reverse_place_mock.return_value = {
            "name": "人民广场",
            "address": "上海市黄浦区人民大道",
            "latitude": 31.2304,
            "longitude": 121.4737,
        }

        response = self.client.get(
            "/api/conversations/locations/reverse?latitude=31.2304&longitude=121.4737"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["place"]["name"], "人民广场")
        reverse_place_mock.assert_called_once_with(31.2304, 121.4737)

    def test_accepts_location_only_message_and_coarsens_city_payload(self):
        response = self.client.post("/api/conversations/cat/messages", json={
            "location": {
                "precision": "city",
                "latitude": 31.230416,
                "longitude": 121.473701,
                "accuracy_m": 8,
            }
        })

        self.assertEqual(response.status_code, 202)
        locations = self.queue.accept_message.call_args.kwargs["locations"]
        self.assertEqual(locations, [{
            "type": "location",
            "precision": "city",
            "latitude": 31.2,
            "longitude": 121.5,
        }])

    def test_rejects_invalid_location(self):
        response = self.client.post("/api/conversations/cat/messages", json={
            "location": {
                "precision": "precise",
                "latitude": "31.2",
                "longitude": 121.5,
            }
        })

        self.assertEqual(response.status_code, 400)
        self.queue.accept_message.assert_not_called()


class LocationLlmContextTests(unittest.TestCase):
    def test_location_block_becomes_actionable_model_context(self):
        service = ChatService(None, None, None)
        persona = SimpleNamespace(prompt="")
        messages = service._build_llm_messages(
            persona,
            "cat",
            [{
                "role": "user",
                "timestamp": "2026-08-25T10:00:00+08:00",
                "content": [{
                    "type": "location",
                    "precision": "city",
                    "latitude": 31.2,
                    "longitude": 121.5,
                }],
            }],
            None,
            None,
            [],
        )

        self.assertEqual(messages[-1]["role"], "user")
        self.assertIn("仅城市级", messages[-1]["content"])
        self.assertIn("查询天气、规划行程或推荐周边", messages[-1]["content"])
        self.assertIn("31.2", messages[-1]["content"])


if __name__ == "__main__":
    unittest.main()