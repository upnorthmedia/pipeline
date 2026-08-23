"""Tests for api_keys service — DB storage, encryption, masking."""

import pytest
from sqlalchemy import select
from src.models.setting import Setting
from src.services.api_keys import (
    get_api_keys,
    get_masked_keys,
    save_api_keys,
)

pytestmark = pytest.mark.anyio


async def _get_api_keys_row(db_session):
    """The `api_keys` row, looked up by key rather than by primary key.

    Alembic 012 made the primary key a surrogate `id`, so `session.get()` no
    longer takes the settings key. `save_api_keys()` never sets `user_id`, and
    the unique constraint over `(key, user_id)` is NULLS NOT DISTINCT, so this
    still names exactly one row.
    """
    result = await db_session.execute(
        select(Setting).where(Setting.key == "api_keys", Setting.user_id.is_(None))
    )
    return result.scalar_one_or_none()


async def test_get_api_keys_returns_empty_when_no_db(db_session):
    """With no DB keys, returns empty strings."""
    keys = await get_api_keys(db_session)
    assert keys == {"anthropic": "", "perplexity": "", "gemini": ""}


async def test_save_and_load_round_trip(db_session):
    """Keys survive save → load round trip with encryption."""
    await save_api_keys(
        db_session,
        {"anthropic": "sk-ant-test123", "perplexity": "pplx-test456"},
    )

    # DB has encrypted values (not plaintext)
    setting = await _get_api_keys_row(db_session)
    assert setting is not None
    assert setting.value.get("anthropic") != "sk-ant-test123"

    # Loading decrypts them
    keys = await get_api_keys(db_session)
    assert keys["anthropic"] == "sk-ant-test123"
    assert keys["perplexity"] == "pplx-test456"
    assert keys["gemini"] == ""


async def test_save_empty_key_not_stored(db_session):
    """Empty string keys are not stored in DB."""
    await save_api_keys(
        db_session,
        {"anthropic": "sk-ant-test", "gemini": ""},
    )
    setting = await _get_api_keys_row(db_session)
    assert "gemini" not in setting.value


async def test_save_upserts_existing(db_session):
    """Second save updates the existing setting row."""
    await save_api_keys(db_session, {"anthropic": "sk-ant-first"})
    await save_api_keys(db_session, {"anthropic": "sk-ant-second"})

    keys = await get_api_keys(db_session)
    assert keys["anthropic"] == "sk-ant-second"


async def test_get_masked_keys_configured(db_session):
    """Masked keys show configured=True with last-4 hint and source=db."""
    await save_api_keys(db_session, {"anthropic": "sk-ant-abcd1234"})

    masked = await get_masked_keys(db_session)
    assert masked["anthropic"]["configured"] is True
    assert masked["anthropic"]["source"] == "db"
    assert masked["anthropic"]["hint"] == "...1234"
    assert masked["perplexity"]["configured"] is False
    assert masked["perplexity"]["source"] == "none"
    assert masked["perplexity"]["hint"] == ""


async def test_get_masked_keys_never_returns_actual_key(db_session):
    """Masked response never contains the full key."""
    await save_api_keys(db_session, {"anthropic": "sk-ant-secret-key-value"})

    masked = await get_masked_keys(db_session)
    hint = masked["anthropic"]["hint"]
    assert "sk-ant-secret-key-value" not in hint
    assert len(hint) <= 7  # "...XXXX"
