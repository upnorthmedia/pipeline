"""Tests for LLM client wrappers (mocked — no API calls)."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from src.services.llm import ClaudeClient, LLMResponse, PerplexityClient


class TestPerplexityClient:
    @pytest.fixture
    def client(self):
        return PerplexityClient(api_key="pplx-test-key")

    async def test_chat_builds_correct_request(self, client):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "choices": [{"message": {"content": "Research results here"}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 500},
        }

        with patch.object(
            client._client, "post", new_callable=AsyncMock, return_value=mock_response
        ) as mock_post:
            result = await client.chat(
                "Research topic X", system="You are a researcher"
            )

            mock_post.assert_called_once()
            call_kwargs = mock_post.call_args
            body = call_kwargs.kwargs["json"]
            assert body["model"] == "sonar-pro"
            assert len(body["messages"]) == 2
            assert body["messages"][0]["role"] == "system"
            assert body["messages"][1]["role"] == "user"

            assert isinstance(result, LLMResponse)
            assert result.content == "Research results here"
            assert result.tokens_in == 100
            assert result.tokens_out == 500

    async def test_chat_without_system_message(self, client):
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "choices": [{"message": {"content": "Result"}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 200},
        }

        with patch.object(
            client._client, "post", new_callable=AsyncMock, return_value=mock_response
        ) as mock_post:
            await client.chat("Simple prompt")
            body = mock_post.call_args.kwargs["json"]
            assert len(body["messages"]) == 1
            assert body["messages"][0]["role"] == "user"


class TestClaudeClient:
    @pytest.fixture
    def client(self):
        return ClaudeClient(api_key="sk-ant-test-key")

    async def test_chat_builds_correct_request(self, client):
        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "Outline content here"
        mock_response = MagicMock()
        mock_response.content = [text_block]
        mock_response.usage = MagicMock(input_tokens=200, output_tokens=1000)

        with patch.object(
            client._client.messages,
            "create",
            new_callable=AsyncMock,
            return_value=mock_response,
        ) as mock_create:
            result = await client.chat(
                "Create an outline",
                model="claude-opus-4-6",
                system="You are an outline writer",
            )

            mock_create.assert_called_once()
            call_kwargs = mock_create.call_args.kwargs
            assert call_kwargs["model"] == "claude-opus-4-6"
            assert call_kwargs["system"] == "You are an outline writer"
            assert call_kwargs["max_tokens"] == 16000
            assert call_kwargs["thinking"]["type"] == "enabled"
            assert call_kwargs["thinking"]["budget_tokens"] == 10000

            assert isinstance(result, LLMResponse)
            assert result.content == "Outline content here"
            assert result.tokens_in == 200
            assert result.tokens_out == 1000

    async def test_chat_filters_thinking_blocks(self, client):
        """Extended thinking response should only return text blocks."""
        thinking_block = MagicMock()
        thinking_block.type = "thinking"
        thinking_block.thinking = "Let me reason through this..."
        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "Draft"
        mock_response = MagicMock()
        mock_response.content = [thinking_block, text_block]
        mock_response.usage = MagicMock(input_tokens=100, output_tokens=500)

        with patch.object(
            client._client.messages,
            "create",
            new_callable=AsyncMock,
            return_value=mock_response,
        ):
            result = await client.chat("Write a draft")
            assert result.content == "Draft"

    async def test_chat_handles_streaming_default_max_tokens(self, client):
        text_block = MagicMock()
        text_block.type = "text"
        text_block.text = "Draft"
        mock_response = MagicMock()
        mock_response.content = [text_block]
        mock_response.usage = MagicMock(input_tokens=100, output_tokens=500)

        with patch.object(
            client._client.messages,
            "create",
            new_callable=AsyncMock,
            return_value=mock_response,
        ) as mock_create:
            await client.chat("Write a draft")
            assert mock_create.call_args.kwargs["max_tokens"] == 16000
