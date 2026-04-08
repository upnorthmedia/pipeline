"""Tests for the research stage node."""

from unittest.mock import AsyncMock, patch

import pytest
from src.pipeline.stages.research import (
    MAX_RESEARCH_ATTEMPTS,
    _is_valid_research,
    research_node,
)
from src.services.llm import LLMResponse

VALID_RESEARCH = (
    "# Research Document: Best Python Frameworks\n\n"
    "## 1. Keyword Research\n\nPrimary keyword: python frameworks\n\n"
    "## 3. Pain Points & Challenges\n\nUsers struggle with...\n\n"
    "## 4. Competitor Analysis\n\nTop articles...\n\n"
    "## 5. Search Intent Analysis\n\nInformational intent..."
)

META_RESPONSE = (
    "I appreciate the detailed instructions, but I need to clarify my role here. "
    "I'm **Perplexity**, a search assistant designed to synthesize and answer questions. "
    "I'm not a blog research agent that can create custom research documents."
)


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
        "output_format": "markdown",
        "website_url": "https://example.com",
        "related_keywords": ["python", "web frameworks"],
        "competitor_urls": [],
        "stage_settings": {"research": "auto"},
        "stage_status": {},
    }


@pytest.fixture
def mock_perplexity_response():
    return LLMResponse(
        content=VALID_RESEARCH,
        model="sonar-pro",
        tokens_in=500,
        tokens_out=3000,
    )


class TestResearchValidation:
    def test_valid_research_passes(self):
        assert _is_valid_research(VALID_RESEARCH) is True

    def test_meta_response_fails(self):
        assert _is_valid_research(META_RESPONSE) is False

    def test_refusal_patterns(self):
        assert _is_valid_research("I'm Perplexity, a search assistant") is False
        assert _is_valid_research("I need to clarify my role here") is False
        assert _is_valid_research("I cannot create custom research") is False
        assert _is_valid_research("I'm not a blog research agent") is False
        assert _is_valid_research("What I *can* do instead") is False
        assert _is_valid_research("Which would be most helpful?") is False

    def test_empty_content_fails(self):
        assert _is_valid_research("") is False

    def test_minimal_valid_content(self):
        content = "keyword analysis here and pain point data and competitor review"
        assert _is_valid_research(content) is True

    def test_insufficient_sections_fails(self):
        content = "Some text about keyword research only"
        assert _is_valid_research(content) is False


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
        assert result["research"] == VALID_RESEARCH

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

    @pytest.mark.asyncio
    async def test_retries_on_meta_response(self, sample_state):
        """When Perplexity returns a meta-response, the stage retries."""
        meta_resp = LLMResponse(
            content=META_RESPONSE, model="sonar-pro", tokens_in=200, tokens_out=500
        )
        valid_resp = LLMResponse(
            content=VALID_RESEARCH, model="sonar-pro", tokens_in=500, tokens_out=3000
        )

        with patch("src.pipeline.stages.research.PerplexityClient") as MockClient:
            instance = MockClient.return_value
            instance.chat = AsyncMock(side_effect=[meta_resp, valid_resp])
            instance.close = AsyncMock()

            result = await research_node(sample_state)

        assert result["research"] == VALID_RESEARCH
        assert instance.chat.await_count == 2
        # Tokens should be accumulated across attempts
        assert result["_stage_meta"]["tokens_in"] == 700
        assert result["_stage_meta"]["tokens_out"] == 3500

    @pytest.mark.asyncio
    async def test_uses_reinforced_prompt_on_retry(self, sample_state):
        """Retry attempts use a reinforced prompt."""
        meta_resp = LLMResponse(
            content=META_RESPONSE, model="sonar-pro", tokens_in=200, tokens_out=500
        )
        valid_resp = LLMResponse(
            content=VALID_RESEARCH, model="sonar-pro", tokens_in=500, tokens_out=3000
        )

        with patch("src.pipeline.stages.research.PerplexityClient") as MockClient:
            instance = MockClient.return_value
            instance.chat = AsyncMock(side_effect=[meta_resp, valid_resp])
            instance.close = AsyncMock()

            await research_node(sample_state)

            # Second call should use reinforced prompt
            second_call = instance.chat.call_args_list[1]
            prompt = second_call.kwargs.get(
                "prompt", second_call.args[0] if second_call.args else ""
            )
            assert "IMPORTANT" in prompt
            assert "Do NOT describe yourself" in prompt

    @pytest.mark.asyncio
    async def test_falls_back_after_max_attempts(self, sample_state):
        """After max attempts, uses the last response as fallback."""
        meta_resp = LLMResponse(
            content=META_RESPONSE, model="sonar-pro", tokens_in=200, tokens_out=500
        )

        with patch("src.pipeline.stages.research.PerplexityClient") as MockClient:
            instance = MockClient.return_value
            instance.chat = AsyncMock(return_value=meta_resp)
            instance.close = AsyncMock()

            result = await research_node(sample_state)

        # Should still return a result (degraded), not raise
        assert result["research"] == META_RESPONSE
        assert instance.chat.await_count == MAX_RESEARCH_ATTEMPTS
