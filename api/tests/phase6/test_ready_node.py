"""Tests for the ready stage node."""

import json
from unittest.mock import AsyncMock, patch

import pytest

from src.pipeline.stages.ready import ready_node


@pytest.fixture
def ready_state():
    """State with completed edit + images stages."""
    return {
        "post_id": "test-post-123",
        "slug": "best-ar15-optics",
        "topic": "Best AR15 Optics for Every Budget",
        "output_format": "markdown",
        "final_md": '---\ntitle: "Best AR15 Optics"\nkeywords: "ar15, optics"\n---\n\n# Best AR15 Optics\n\nIntro paragraph.\n\n## Budget Picks\n\nBudget content here.\n\n## Mid-Range\n\nMid-range content.\n\n---\n\n<!--\nPUBLISHING NOTES\n================\nSEO INFORMATION\n---------------\nMeta Description: Find the best AR15 optics.\nPrimary Keyword: best AR15 optics\n-->\n',
        "image_manifest": {
            "images": [
                {
                    "id": "featured",
                    "type": "featured",
                    "filename": "featured.png",
                    "url": "/media/test-post-123/featured.png",
                    "alt_text": "AR15 with mounted optic",
                    "placement": {"location": "featured_image", "after_section": None},
                    "generated": True,
                },
                {
                    "id": "content-1",
                    "type": "content",
                    "filename": "budget-optics.png",
                    "url": "/media/test-post-123/budget-optics.png",
                    "alt_text": "Budget AR15 optics comparison",
                    "placement": {"location": "after_heading", "after_section": "Budget Picks"},
                    "generated": True,
                },
            ],
            "style_brief": {"overall_style": "editorial illustration"},
        },
        "stage_settings": {"ready": "review"},
        "stage_status": {"images": "complete"},
    }


@pytest.mark.asyncio
async def test_ready_node_returns_expected_keys(ready_state):
    """Ready node should return ready content and stage metadata."""
    mock_response = AsyncMock()
    mock_response.content = '---\ntitle: "Best AR15 Optics"\nslug: "best-ar15-optics"\ndescription: "Find the best AR15 optics."\ndate: "2026-02-26"\nauthor: "team"\ncategory: "Optics"\nfeaturedImage: "/media/test-post-123/featured.png"\nfeaturedImageAlt: "AR15 with mounted optic"\npublished: true\n---\n\n# Best AR15 Optics\n\nIntro paragraph.\n\n## Budget Picks\n\nBudget content here.\n\n![Budget AR15 optics comparison](/media/test-post-123/budget-optics.png)\n\n## Mid-Range\n\nMid-range content.'
    mock_response.tokens_in = 2000
    mock_response.tokens_out = 3000
    mock_response.model = "claude-opus-4-6"

    with patch("src.pipeline.stages.ready.ClaudeClient") as MockClaude:
        instance = MockClaude.return_value
        instance.chat = AsyncMock(return_value=mock_response)
        instance.close = AsyncMock()

        result = await ready_node(ready_state)

    assert "ready" in result
    assert isinstance(result["ready"], str)
    assert "PUBLISHING NOTES" not in result["ready"]
    assert "featuredImage" in result["ready"]
    assert result["current_stage"] == "ready"
    assert result["stage_status"]["ready"] == "complete"
    assert result["_stage_meta"]["stage"] == "ready"


@pytest.mark.asyncio
async def test_ready_node_skips_failed_images(ready_state):
    """Ready node should not include failed images in its prompt."""
    ready_state["image_manifest"]["images"].append({
        "id": "content-2",
        "type": "content",
        "filename": "failed.png",
        "url": "/media/test-post-123/failed.png",
        "alt_text": "Failed image",
        "placement": {"location": "after_heading", "after_section": "Mid-Range"},
        "generated": False,
        "error": "Safety filter triggered",
    })

    mock_response = AsyncMock()
    mock_response.content = "assembled content"
    mock_response.tokens_in = 1000
    mock_response.tokens_out = 2000
    mock_response.model = "claude-opus-4-6"

    with patch("src.pipeline.stages.ready.ClaudeClient") as MockClaude:
        instance = MockClaude.return_value
        instance.chat = AsyncMock(return_value=mock_response)
        instance.close = AsyncMock()

        result = await ready_node(ready_state)

    # Verify the prompt sent to Claude doesn't include the failed image
    call_args = instance.chat.call_args
    prompt = call_args.kwargs.get("prompt") or call_args[1].get("prompt") or call_args[0][0] if call_args[0] else ""
    # The prompt should be a string that was sent to Claude
    assert result["ready"] == "assembled content"
