"""Tests for the images stage node."""

import json
from unittest.mock import AsyncMock, patch

import pytest
from src.pipeline.stages.images import _parse_manifest, images_node
from src.services.llm import LLMResponse


@pytest.fixture
def sample_state():
    return {
        "post_id": "test-123",
        "slug": "test-post",
        "topic": "Best Python Frameworks",
        "word_count": 2000,
        "output_format": "both",
        "final_md": "# Blog\n\nSome content...",
        "image_style": "photorealistic",
        "image_brand_colors": ["#1a1a2e"],
        "image_exclude": ["text overlay"],
        "stage_settings": {"images": "review"},
        "stage_status": {"edit": "complete"},
    }


@pytest.fixture
def mock_manifest():
    return {
        "style_brief": {"overall_style": "photorealistic"},
        "images": [
            {
                "placement": "featured",
                "prompt": "A photorealistic image of Python code",
                "alt_text": "Python frameworks comparison",
                "aspect_ratio": "16:9",
            },
            {
                "placement": "content",
                "prompt": "Django logo in a clean design",
                "alt_text": "Django framework",
            },
        ],
    }


@pytest.fixture
def mock_claude_response(mock_manifest):
    return LLMResponse(
        content=json.dumps(mock_manifest),
        model="claude-opus-4-6",
        tokens_in=1000,
        tokens_out=2000,
    )


class TestImagesNode:
    @pytest.mark.asyncio
    async def test_generates_manifest_and_images(
        self, sample_state, mock_claude_response
    ):
        with (
            patch("src.pipeline.stages.images.ClaudeClient") as MockClaude,
            patch("src.pipeline.stages.images.GeminiClient") as MockGemini,
        ):
            claude = MockClaude.return_value
            claude.chat = AsyncMock(return_value=mock_claude_response)
            claude.close = AsyncMock()

            gemini = MockGemini.return_value
            gemini.generate_image = AsyncMock(return_value=b"\x89PNG" * 100)

            result = await images_node(sample_state)

        manifest = result["image_manifest"]
        assert manifest["total_generated"] == 2
        assert manifest["total_failed"] == 0
        assert len(manifest["images"]) == 2

    @pytest.mark.asyncio
    async def test_handles_image_generation_failure(
        self, sample_state, mock_claude_response
    ):
        with (
            patch("src.pipeline.stages.images.ClaudeClient") as MockClaude,
            patch("src.pipeline.stages.images.GeminiClient") as MockGemini,
        ):
            claude = MockClaude.return_value
            claude.chat = AsyncMock(return_value=mock_claude_response)
            claude.close = AsyncMock()

            gemini = MockGemini.return_value
            # First image succeeds, second fails
            gemini.generate_image = AsyncMock(
                side_effect=[
                    b"\x89PNG" * 100,
                    RuntimeError("Generation failed"),
                ]
            )

            result = await images_node(sample_state)

        manifest = result["image_manifest"]
        assert manifest["total_generated"] == 1
        assert manifest["total_failed"] == 1

    @pytest.mark.asyncio
    async def test_featured_image_uses_2k(self, sample_state, mock_claude_response):
        with (
            patch("src.pipeline.stages.images.ClaudeClient") as MockClaude,
            patch("src.pipeline.stages.images.GeminiClient") as MockGemini,
        ):
            claude = MockClaude.return_value
            claude.chat = AsyncMock(return_value=mock_claude_response)
            claude.close = AsyncMock()

            gemini = MockGemini.return_value
            gemini.generate_image = AsyncMock(return_value=b"\x89PNG" * 100)

            await images_node(sample_state)

            # First call is featured image
            first_call = gemini.generate_image.call_args_list[0]
            assert first_call.kwargs["image_size"] == "2K"


class TestParseManifest:
    def test_parses_valid_json(self):
        data = {"images": [{"prompt": "test"}]}
        result = _parse_manifest(json.dumps(data))
        assert result == data

    def test_strips_code_fences(self):
        data = {"images": []}
        raw = f"```json\n{json.dumps(data)}\n```"
        result = _parse_manifest(raw)
        assert result == data

    def test_handles_invalid_json(self):
        result = _parse_manifest("not json at all")
        assert "error" in result
        assert result["images"] == []

    def test_handles_empty_string(self):
        result = _parse_manifest("")
        assert "error" in result
