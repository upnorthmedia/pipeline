"""Tests for the outline stage node."""

from unittest.mock import AsyncMock, patch

import pytest
from src.pipeline.stages.outline import outline_node
from src.services.llm import LLMResponse


@pytest.fixture
def sample_state():
    return {
        "post_id": "test-123",
        "slug": "test-post",
        "topic": "Best Python Frameworks",
        "target_audience": "developers",
        "niche": "technology",
        "intent": "informational",
        "word_count": 2000,
        "tone": "Conversational and friendly",
        "output_format": "both",
        "research": "# Research data\n\nKeywords: python, django...",
        "stage_settings": {"outline": "review"},
        "stage_status": {"research": "complete"},
    }


@pytest.fixture
def mock_claude_response():
    return LLMResponse(
        content="# Outline\n\n## Introduction\n...",
        model="claude-opus-4-6",
        tokens_in=1000,
        tokens_out=2000,
    )


class TestOutlineNode:
    @pytest.mark.asyncio
    async def test_returns_outline_content(self, sample_state, mock_claude_response):
        with patch("src.pipeline.stages.outline.ClaudeClient") as MockClient:
            instance = MockClient.return_value
            instance.chat = AsyncMock(return_value=mock_claude_response)
            instance.close = AsyncMock()

            result = await outline_node(sample_state)

        assert result["outline"] == "# Outline\n\n## Introduction\n..."
        assert result["current_stage"] == "outline"
        assert result["stage_status"]["outline"] == "complete"

    @pytest.mark.asyncio
    async def test_prompt_includes_research_output(
        self, sample_state, mock_claude_response
    ):
        with patch("src.pipeline.stages.outline.ClaudeClient") as MockClient:
            instance = MockClient.return_value
            instance.chat = AsyncMock(return_value=mock_claude_response)
            instance.close = AsyncMock()

            await outline_node(sample_state)

            call_args = instance.chat.call_args
            prompt = call_args.kwargs.get(
                "prompt", call_args.args[0] if call_args.args else ""
            )
            assert "Research data" in prompt

    @pytest.mark.asyncio
    async def test_includes_stage_meta(self, sample_state, mock_claude_response):
        with patch("src.pipeline.stages.outline.ClaudeClient") as MockClient:
            instance = MockClient.return_value
            instance.chat = AsyncMock(return_value=mock_claude_response)
            instance.close = AsyncMock()

            result = await outline_node(sample_state)

        meta = result["_stage_meta"]
        assert meta["stage"] == "outline"
        assert meta["model"] == "claude-opus-4-6"
