"""Tests for API key endpoints — GET/PUT /api/settings/api-keys."""

from unittest.mock import AsyncMock, patch

import pytest
from src.models.setting import Setting

pytestmark = pytest.mark.anyio


async def test_get_api_keys_empty(client):
    """GET returns all providers with configured=False when no keys."""
    resp = await client.get("/api/settings/api-keys")
    assert resp.status_code == 200
    data = resp.json()
    assert "anthropic" in data
    assert "perplexity" in data
    assert "gemini" in data
    assert data["anthropic"]["configured"] is False
    assert data["perplexity"]["configured"] is False
    assert data["gemini"]["configured"] is False


async def test_put_api_keys_saves_and_validates(client):
    """PUT stores keys and returns validation results."""
    with patch(
        "src.api.settings.validate_keys",
        new_callable=AsyncMock,
    ) as mock_validate:
        mock_validate.return_value = {"anthropic": (True, None)}

        resp = await client.put(
            "/api/settings/api-keys",
            json={"anthropic": "sk-ant-newkey1234"},
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["anthropic"]["configured"] is True
    assert data["anthropic"]["source"] == "db"
    assert data["anthropic"]["valid"] is True
    assert data["anthropic"]["hint"] == "...1234"


async def test_put_api_keys_encrypted_at_rest(client, db_session):
    """PUT stores encrypted values, not plaintext."""
    with patch(
        "src.api.settings.validate_keys",
        new_callable=AsyncMock,
        return_value={},
    ):
        resp = await client.put(
            "/api/settings/api-keys",
            json={"anthropic": "sk-ant-secret-value"},
        )
    assert resp.status_code == 200

    # Verify DB contains encrypted value
    setting = await db_session.get(Setting, "api_keys")
    assert setting is not None
    assert setting.value.get("anthropic") != "sk-ant-secret-value"
    assert len(setting.value.get("anthropic", "")) > 0


async def test_put_api_keys_partial_update(client):
    """PUT with partial keys only updates provided providers."""
    with patch(
        "src.api.settings.validate_keys",
        new_callable=AsyncMock,
    ) as mock_validate:
        mock_validate.return_value = {
            "perplexity": (True, None),
        }

        resp = await client.put(
            "/api/settings/api-keys",
            json={"perplexity": "pplx-newkey5678"},
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["perplexity"]["configured"] is True
    assert data["perplexity"]["valid"] is True


async def test_get_api_keys_never_returns_plaintext(client):
    """GET response never contains actual API key values."""
    with patch(
        "src.api.settings.validate_keys",
        new_callable=AsyncMock,
        return_value={},
    ):
        # Save a key first
        await client.put(
            "/api/settings/api-keys",
            json={"anthropic": "sk-ant-supersecretkey"},
        )

    # GET should not contain the key
    resp = await client.get("/api/settings/api-keys")
    data = resp.json()
    resp_str = str(data)
    assert "sk-ant-supersecretkey" not in resp_str


async def test_put_api_keys_validation_failure(client):
    """PUT still saves keys even when validation fails."""
    with patch(
        "src.api.settings.validate_keys",
        new_callable=AsyncMock,
    ) as mock_validate:
        mock_validate.return_value = {
            "anthropic": (False, "Invalid API key"),
        }

        resp = await client.put(
            "/api/settings/api-keys",
            json={"anthropic": "sk-ant-badkey12345"},
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["anthropic"]["configured"] is True
    assert data["anthropic"]["valid"] is False
