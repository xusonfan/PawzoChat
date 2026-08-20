import unittest

from pawzochat.image.manager import (
    ImageManager,
    ensure_image_models_list,
    model_supports_reference_images,
    model_type_supports_reference_images,
)


class ImageModelCapabilityTests(unittest.TestCase):
    def test_model_types_declare_reference_image_support(self):
        self.assertTrue(model_type_supports_reference_images("gemini_image"))
        self.assertTrue(model_type_supports_reference_images("gemini_chat_image"))
        self.assertTrue(model_type_supports_reference_images("novelai_image"))
        self.assertTrue(model_type_supports_reference_images("openai_image"))
        self.assertFalse(model_type_supports_reference_images("unknown"))

    def test_openai_reference_support_is_open_by_default(self):
        provider_cfg = {"preset": "custom"}
        self.assertTrue(model_supports_reference_images(
            provider_cfg,
            {"id": "gpt-image-2", "type": "openai_image"},
        ))
        self.assertTrue(model_supports_reference_images(
            provider_cfg,
            {"id": "gpt-image-1.5", "type": "openai_image"},
        ))
        self.assertTrue(model_supports_reference_images(
            provider_cfg,
            {"id": "gpt-image-2-2026-04-21", "type": "openai_image"},
        ))
        self.assertTrue(model_supports_reference_images(
            provider_cfg,
            {"id": "chatgpt-image-latest", "type": "openai_image"},
        ))
        self.assertTrue(model_supports_reference_images(
            provider_cfg,
            {"id": "grok-imagine-image", "type": "openai_image"},
        ))
        self.assertTrue(model_supports_reference_images(
            provider_cfg,
            {"id": "grok-imagine-image-quality", "type": "openai_image"},
        ))
        self.assertTrue(model_supports_reference_images(
            provider_cfg,
            {"id": "dall-e-3", "type": "openai_image"},
        ))
        self.assertTrue(model_supports_reference_images(
            provider_cfg,
            {
                "id": "relay-image-model",
                "type": "openai_image",
                "supports_reference_images": True,
            },
        ))
        self.assertFalse(model_supports_reference_images(
            provider_cfg,
            {
                "id": "gpt-image-2",
                "type": "openai_image",
                "supports_reference_images": False,
            },
        ))

    def test_official_openai_preset_uses_verified_capabilities(self):
        provider_cfg = {"preset": "openai"}
        self.assertTrue(model_supports_reference_images(
            provider_cfg,
            {"id": "gpt-image-2", "type": "openai_image"},
        ))
        self.assertFalse(model_supports_reference_images(
            provider_cfg,
            {"id": "dall-e-3", "type": "openai_image"},
        ))
        self.assertFalse(model_supports_reference_images(
            provider_cfg,
            {"id": "dall-e-2", "type": "openai_image"},
        ))
        self.assertFalse(model_supports_reference_images(
            provider_cfg,
            {"id": "unverified-official-model", "type": "openai_image"},
        ))

    def test_model_summaries_expose_capability(self):
        models = ensure_image_models_list({
            "preset": "custom",
            "models": [
                {"id": "text-only", "type": "openai_image"},
                {"id": "gpt-image-2", "type": "openai_image"},
                {"id": "disabled-ref", "type": "gemini_chat_image", "supports_reference_images": False},
            ],
        })

        self.assertTrue(models[0]["supports_reference_images"])
        self.assertTrue(models[1]["supports_reference_images"])
        self.assertFalse(models[2]["supports_reference_images"])

    def test_manager_resolves_capability_per_model(self):
        manager = ImageManager()
        manager.init_from_config({
            "mixed": {
                "preset": "custom",
                "api_key": "test",
                "models": [
                    {"id": "plain", "type": "openai_image"},
                    {"id": "disabled", "type": "openai_image", "supports_reference_images": False},
                    {"id": "reference", "type": "gemini_image"},
                ],
            },
        })

        self.assertTrue(manager.model_supports_reference_images("mixed", "plain"))
        self.assertFalse(manager.model_supports_reference_images("mixed", "disabled"))
        self.assertTrue(manager.model_supports_reference_images("mixed", "reference"))
        self.assertFalse(manager.model_supports_reference_images("mixed", "missing"))


if __name__ == "__main__":
    unittest.main()