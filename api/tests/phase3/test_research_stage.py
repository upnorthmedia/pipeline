"""Tests for the research stage node."""

from unittest.mock import AsyncMock, patch

import pytest
from src.pipeline.stages.research import research_node
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
        "website_url": "https://example.com",
        "related_keywords": ["python", "web frameworks"],
        "competitor_urls": [],
        "stage_settings": {"research": "review"},
        "stage_status": {},
    }


@pytest.fixture
def mock_perplexity_response():
    return LLMResponse(
        content="# Research Output\n\nKeyword data...",
        model="sonar-pro",
        tokens_in=500,
        tokens_out=3000,
    )


class TestResearchNode:
    @pytest.mark.asyncio
    async def test_returns_research_content(
        self, sample_state, mock_perplexity_response
    ):
        with patch("src.pipeline.stages.research.PerplexityClient") as MockClient:
            instance = MockClient.return_value
            instance.chat = AsyncMock(return_value=mock_perplexity_response)
            instance.close = AsyncMock()

            result = await research_node(sample_state)

        assert "research" in result
        assert result["research"] == "# Research Output\n\nKeyword data..."

    @pytest.mark.asyncio
    async def test_updates_stage_status(self, sample_state, mock_perplexity_response):
        with patch("src.pipeline.stages.research.PerplexityClient") as MockClient:
            instance = MockClient.return_value
            instance.chat = AsyncMock(return_value=mock_perplexity_response)
            instance.close = AsyncMock()

            result = await research_node(sample_state)

        assert result["current_stage"] == "research"
        assert result["stage_status"]["research"] == "complete"

    @pytest.mark.asyncio
    async def test_includes_stage_meta(self, sample_state, mock_perplexity_response):
        with patch("src.pipeline.stages.research.PerplexityClient") as MockClient:
            instance = MockClient.return_value
            instance.chat = AsyncMock(return_value=mock_perplexity_response)
            instance.close = AsyncMock()

            result = await research_node(sample_state)

        meta = result["_stage_meta"]
        assert meta["stage"] == "research"
        assert meta["model"] == "sonar-pro"
        assert meta["tokens_in"] == 500
        assert meta["tokens_out"] == 3000
        assert meta["duration_s"] >= 0

    @pytest.mark.asyncio
    async def test_prompt_includes_topic(self, sample_state, mock_perplexity_response):
        with patch("src.pipeline.stages.research.PerplexityClient") as MockClient:
            instance = MockClient.return_value
            instance.chat = AsyncMock(return_value=mock_perplexity_response)
            instance.close = AsyncMock()

            await research_node(sample_state)

            # Verify the prompt was called with content
            call_args = instance.chat.call_args
            prompt = call_args.kwargs.get(
                "prompt", call_args.args[0] if call_args.args else ""
            )
            assert "Best Python Frameworks" in prompt

    @pytest.mark.asyncio
    async def test_closes_client_on_success(
        self, sample_state, mock_perplexity_response
    ):
        with patch("src.pipeline.stages.research.PerplexityClient") as MockClient:
            instance = MockClient.return_value
            instance.chat = AsyncMock(return_value=mock_perplexity_response)
            instance.close = AsyncMock()

            await research_node(sample_state)
            instance.close.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_closes_client_on_error(self, sample_state):
        with patch("src.pipeline.stages.research.PerplexityClient") as MockClient:
            instance = MockClient.return_value
            instance.chat = AsyncMock(side_effect=RuntimeError("API error"))
            instance.close = AsyncMock()

            with pytest.raises(RuntimeError, match="API error"):
                await research_node(sample_state)
            instance.close.assert_awaited_once()
