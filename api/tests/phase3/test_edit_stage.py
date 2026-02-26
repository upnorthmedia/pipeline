"""Tests for the edit stage node."""

from unittest.mock import AsyncMock, patch

import pytest
from src.pipeline.stages.edit import edit_node
from src.services.llm import LLMResponse


@pytest.fixture
def sample_state():
    return {
        "post_id": "test-123",
        "slug": "test-post",
        "topic": "Best Python Frameworks",
        "target_audience": "developers",
        "niche": "technology",
        "word_count": 2000,
        "tone": "Conversational and friendly",
        "output_format": "both",
        "draft": "# Blog Post\n\nDraft content here...",
        "internal_links": [
            {"url": "/django-guide/", "title": "Django Guide"},
            {"url": "/flask-tutorial/", "title": "Flask Tutorial"},
        ],
        "stage_settings": {"edit": "review"},
        "stage_status": {
            "research": "complete",
            "outline": "complete",
            "write": "complete",
        },
    }


@pytest.fixture
def mock_claude_response_both():
    md = "---\ntitle: Best Python Frameworks\n---\n\nFinal markdown."
    html = "<!-- wp:paragraph --><p>Final HTML.</p>"
    return LLMResponse(
        content=f"{md}\n\n---WORDPRESS_HTML---\n\n{html}",
        model="claude-opus-4-6",
        tokens_in=3000,
        tokens_out=6000,
    )


@pytest.fixture
def mock_claude_response_md_only():
    return LLMResponse(
        content="---\ntitle: Test\n---\n\nMarkdown only.",
        model="claude-opus-4-6",
        tokens_in=3000,
        tokens_out=5000,
    )


class TestEditNode:
    @pytest.mark.asyncio
    async def test_parses_both_formats(self, sample_state, mock_claude_response_both):
        with patch("src.pipeline.stages.edit.ClaudeClient") as MockClient:
            instance = MockClient.return_value
            instance.chat = AsyncMock(return_value=mock_claude_response_both)
            instance.close = AsyncMock()

            result = await edit_node(sample_state)

        assert "final_md" in result
        assert "Final markdown" in result["final_md"]
        assert "final_html" in result
        assert "Final HTML" in result["final_html"]

    @pytest.mark.asyncio
    async def test_markdown_only_format(
        self, sample_state, mock_claude_response_md_only
    ):
        sample_state["output_format"] = "markdown"
        with patch("src.pipeline.stages.edit.ClaudeClient") as MockClient:
            instance = MockClient.return_value
            instance.chat = AsyncMock(return_value=mock_claude_response_md_only)
            instance.close = AsyncMock()

            result = await edit_node(sample_state)

        assert "final_md" in result
        assert "Markdown only" in result["final_md"]
        assert "final_html" not in result

    @pytest.mark.asyncio
    async def test_internal_links_in_prompt(
        self, sample_state, mock_claude_response_both
    ):
        with patch("src.pipeline.stages.edit.ClaudeClient") as MockClient:
            instance = MockClient.return_value
            instance.chat = AsyncMock(return_value=mock_claude_response_both)
            instance.close = AsyncMock()

            await edit_node(sample_state)

            call_args = instance.chat.call_args
            prompt = call_args.kwargs.get(
                "prompt",
                call_args.args[0] if call_args.args else "",
            )
            assert "/django-guide/" in prompt
            assert "Django Guide" in prompt

    @pytest.mark.asyncio
    async def test_updates_stage_status(self, sample_state, mock_claude_response_both):
        with patch("src.pipeline.stages.edit.ClaudeClient") as MockClient:
            instance = MockClient.return_value
            instance.chat = AsyncMock(return_value=mock_claude_response_both)
            instance.close = AsyncMock()

            result = await edit_node(sample_state)

        assert result["current_stage"] == "edit"
        assert result["stage_status"]["edit"] == "complete"
