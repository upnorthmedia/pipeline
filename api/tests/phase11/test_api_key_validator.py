"""Tests for API key validator — mock provider responses."""

from unittest.mock import AsyncMock, MagicMock, patch

import anthropic
import pytest
from src.services.api_key_validator import (
    validate_anthropic,
    validate_gemini,
    validate_keys,
    validate_perplexity,
)

pytestmark = pytest.mark.anyio


async def test_validate_anthropic_success():
    """Valid Anthropic key returns (True, None)."""
    mock_client = AsyncMock()
    mock_client.messages.create = AsyncMock(return_value=MagicMock())

    with patch(
        "src.services.api_key_validator.anthropic.AsyncAnthropic",
        return_value=mock_client,
    ):
        valid, error = await validate_anthropic("sk-ant-valid")
    assert valid is True
    assert error is None


async def test_validate_anthropic_auth_error():
    """Invalid Anthropic key returns (False, 'Invalid API key')."""
    mock_client = AsyncMock()
    mock_response = MagicMock()
    mock_response.status_code = 401
    mock_client.messages.create = AsyncMock(
        side_effect=anthropic.AuthenticationError(
            response=mock_response, body=None, message=""
        )
    )

    with patch(
        "src.services.api_key_validator.anthropic.AsyncAnthropic",
        return_value=mock_client,
    ):
        valid, error = await validate_anthropic("sk-ant-invalid")
    assert valid is False
    assert error == "Invalid API key"


async def test_validate_anthropic_empty():
    """Empty key returns (False, 'No key provided')."""
    valid, error = await validate_anthropic("")
    assert valid is False
    assert error == "No key provided"


async def test_validate_perplexity_success():
    """Valid Perplexity key returns (True, None)."""
    mock_response = MagicMock()
    mock_response.status_code = 200

    with patch("src.services.api_key_validator.httpx.AsyncClient") as mock_cls:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        mock_cls.return_value = mock_client

        valid, error = await validate_perplexity("pplx-valid")
    assert valid is True
    assert error is None


async def test_validate_perplexity_401():
    """Invalid Perplexity key returns (False, 'Invalid API key')."""
    mock_response = MagicMock()
    mock_response.status_code = 401

    with patch("src.services.api_key_validator.httpx.AsyncClient") as mock_cls:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        mock_cls.return_value = mock_client

        valid, error = await validate_perplexity("pplx-invalid")
    assert valid is False
    assert error == "Invalid API key"


async def test_validate_perplexity_empty():
    valid, error = await validate_perplexity("")
    assert valid is False


async def test_validate_gemini_success():
    """Valid Gemini key returns (True, None)."""
    mock_client = MagicMock()
    mock_models = MagicMock()
    mock_models.list.return_value = iter([])
    mock_client.models = mock_models

    with patch(
        "src.services.api_key_validator.genai.Client",
        return_value=mock_client,
    ):
        valid, error = await validate_gemini("AIzaValid")
    assert valid is True
    assert error is None


async def test_validate_gemini_invalid():
    """Invalid Gemini key returns (False, ...)."""
    mock_client = MagicMock()
    mock_models = MagicMock()
    mock_models.list.side_effect = Exception("401 API_KEY_INVALID")
    mock_client.models = mock_models

    with patch(
        "src.services.api_key_validator.genai.Client",
        return_value=mock_client,
    ):
        valid, error = await validate_gemini("AIzaBadKey")
    assert valid is False
    assert "Invalid API key" in error


async def test_validate_gemini_empty():
    valid, error = await validate_gemini("")
    assert valid is False


async def test_validate_keys_multiple():
    """validate_keys runs validation for all provided keys."""
    mock_anthropic = AsyncMock(return_value=(True, None))
    mock_perplexity = AsyncMock(return_value=(False, "Invalid"))
    with patch.dict(
        "src.services.api_key_validator.VALIDATORS",
        {"anthropic": mock_anthropic, "perplexity": mock_perplexity},
    ):
        results = await validate_keys({"anthropic": "key1", "perplexity": "key2"})
    assert results["anthropic"] == (True, None)
    assert results["perplexity"] == (False, "Invalid")


async def test_validate_keys_skips_empty():
    """validate_keys skips empty key values."""
    results = await validate_keys({"anthropic": "", "perplexity": ""})
    assert results == {}
