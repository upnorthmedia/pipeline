"""Tests for the write stage node."""

from unittest.mock import AsyncMock, patch

import pytest
from src.pipeline.stages.write import write_node
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
        "outline": "## Introduction\n## Django\n## Flask",
        "stage_settings": {"write": "review"},
        "stage_status": {"research": "complete", "outline": "complete"},
    }


@pytest.fixture
def mock_claude_response():
    return LLMResponse(
        content="# Best Python Frameworks\n\nFull blog draft...",
        model="claude-opus-4-6",
        tokens_in=2000,
        tokens_out=8000,
    )


class TestWriteNode:
    @pytest.mark.asyncio
    async def test_returns_draft_content(self, sample_state, mock_claude_response):
        with patch("src.pipeline.stages.write.ClaudeClient") as MockClient:
            instance = MockClient.return_value
            instance.chat = AsyncMock(return_value=mock_claude_response)
            instance.close = AsyncMock()

            result = await write_node(sample_state)

        assert "draft" in result
        assert "Full blog draft" in result["draft"]
        assert result["current_stage"] == "write"
        assert result["stage_status"]["write"] == "complete"

    @pytest.mark.asyncio
    async def test_prompt_includes_outline(self, sample_state, mock_claude_response):
        with patch("src.pipeline.stages.write.ClaudeClient") as MockClient:
            instance = MockClient.return_value
            instance.chat = AsyncMock(return_value=mock_claude_response)
            instance.close = AsyncMock()

            await write_node(sample_state)

            call_args = instance.chat.call_args
            prompt = call_args.kwargs.get(
                "prompt", call_args.args[0] if call_args.args else ""
            )
            assert "Django" in prompt
            assert "Flask" in prompt

    @pytest.mark.asyncio
    async def test_uses_high_max_tokens(self, sample_state, mock_claude_response):
        with patch("src.pipeline.stages.write.ClaudeClient") as MockClient:
            instance = MockClient.return_value
            instance.chat = AsyncMock(return_value=mock_claude_response)
            instance.close = AsyncMock()

            await write_node(sample_state)

            call_args = instance.chat.call_args
            assert call_args.kwargs.get("max_tokens") == 16000
