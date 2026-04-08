"""API key management service — encrypted DB storage."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from src.models.setting import Setting
from src.services.crypto import decrypt, encrypt

logger = logging.getLogger(__name__)

SETTING_KEY = "api_keys"
VALIDATION_KEY = "api_keys_validation"

PROVIDERS = ("anthropic", "perplexity", "gemini")


async def get_api_keys(session: AsyncSession) -> dict[str, str]:
    """Load API keys from DB (decrypted). Returns empty string if not set."""
    db_keys = await _load_decrypted(session)
    return {provider: db_keys.get(provider, "") for provider in PROVIDERS}


async def reveal_api_key(session: AsyncSession, provider: str) -> str | None:
    """Return the decrypted key for a single provider, or None."""
    if provider not in PROVIDERS:
        return None
    db_keys = await _load_decrypted(session)
    return db_keys.get(provider) or None


async def save_api_keys(session: AsyncSession, keys: dict[str, str]) -> None:
    """Encrypt non-empty keys and merge into settings table."""
    # Load existing encrypted values so we don't overwrite providers not in `keys`
    existing = await _load_raw(session)
    merged = dict(existing)

    for provider in PROVIDERS:
        val = keys.get(provider, "")
        if val:
            merged[provider] = encrypt(val)

    setting = await session.get(Setting, SETTING_KEY)
    if setting:
        setting.value = merged
        setting.updated_at = datetime.now(UTC)
    else:
        setting = Setting(key=SETTING_KEY, value=merged)
        session.add(setting)

    await session.commit()


async def save_validation_results(
    session: AsyncSession, results: dict[str, bool]
) -> None:
    """Persist validation results so they survive page reloads."""
    # Merge with any existing results
    setting = await session.get(Setting, VALIDATION_KEY)
    existing = dict(setting.value) if setting and setting.value else {}
    existing.update(results)

    if setting:
        setting.value = existing
        setting.updated_at = datetime.now(UTC)
    else:
        setting = Setting(key=VALIDATION_KEY, value=existing)
        session.add(setting)

    await session.commit()


async def get_masked_keys(session: AsyncSession) -> dict[str, dict]:
    """Return masked key status per provider (never returns actual keys)."""
    db_keys = await _load_decrypted(session)
    validation = await _load_validation(session)
    result: dict[str, dict] = {}

    for provider in PROVIDERS:
        val = db_keys.get(provider, "")
        if val:
            hint = f"...{val[-4:]}" if len(val) >= 4 else "...***"
            result[provider] = {
                "configured": True,
                "source": "db",
                "hint": hint,
                "valid": validation.get(provider),
            }
        else:
            result[provider] = {
                "configured": False,
                "source": "none",
                "hint": "",
                "valid": None,
            }

    return result


async def _load_raw(session: AsyncSession) -> dict[str, str]:
    """Load raw encrypted values from the settings table."""
    setting = await session.get(Setting, SETTING_KEY)
    if not setting or not setting.value:
        return {}
    return dict(setting.value)


async def _load_decrypted(session: AsyncSession) -> dict[str, str]:
    """Load and decrypt keys from the settings table."""
    raw = await _load_raw(session)
    decrypted: dict[str, str] = {}
    for provider, cipher_text in raw.items():
        if not cipher_text:
            continue
        try:
            decrypted[provider] = decrypt(cipher_text)
        except Exception:
            logger.warning(f"Failed to decrypt key for {provider}, skipping")
    return decrypted


async def _load_validation(session: AsyncSession) -> dict[str, bool]:
    """Load persisted validation results."""
    setting = await session.get(Setting, VALIDATION_KEY)
    if not setting or not setting.value:
        return {}
    return {k: bool(v) for k, v in setting.value.items()}
