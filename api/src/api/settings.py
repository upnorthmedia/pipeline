"""Global settings CRUD endpoints."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.auth import get_current_user
from src.database import get_session
from src.models.auth import AuthUser
from src.models.schemas import ApiKeyStatus, ApiKeyUpdate, SettingRead
from src.models.setting import Setting
from src.services.api_key_validator import validate_keys
from src.services.api_keys import (
    get_masked_keys,
    reveal_api_key,
    save_api_keys,
    save_validation_results,
)

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("", response_model=list[SettingRead])
async def list_settings(
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(Setting).where(Setting.user_id == user.id).order_by(Setting.key)
    )
    return result.scalars().all()


@router.patch("", response_model=list[SettingRead])
async def update_settings(
    updates: dict[str, dict],
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Update multiple settings at once. Body: {"key": {"value": ...}, ...}"""
    for key, payload in updates.items():
        result = await session.execute(
            select(Setting).where(Setting.key == key, Setting.user_id == user.id)
        )
        setting = result.scalar_one_or_none()
        if setting:
            setting.value = payload
            setting.updated_at = datetime.now(UTC)
        else:
            setting = Setting(key=key, user_id=user.id, value=payload)
            session.add(setting)

    await session.commit()

    result = await session.execute(
        select(Setting).where(Setting.user_id == user.id).order_by(Setting.key)
    )
    return result.scalars().all()


@router.get("/api-keys", response_model=dict[str, ApiKeyStatus])
async def get_api_keys_status(
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Return masked key status per provider (never returns actual keys)."""
    masked = await get_masked_keys(session)
    return {
        provider: ApiKeyStatus(provider=provider, **info)
        for provider, info in masked.items()
    }


@router.get("/api-keys/{provider}/reveal")
async def reveal_key(
    provider: str,
    request: Request,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Return the decrypted API key for a single provider.

    Restricted to localhost/loopback requests only.
    """
    client_host = request.client.host if request.client else ""
    if client_host not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(status_code=403, detail="Forbidden")
    key = await reveal_api_key(session, provider)
    if key is None:
        raise HTTPException(status_code=404, detail="Key not configured")
    return {"provider": provider, "key": key}


@router.put("/api-keys", response_model=dict[str, ApiKeyStatus])
async def update_api_keys(
    body: ApiKeyUpdate,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Validate, encrypt, and store API keys. Returns per-provider results."""
    keys_to_save: dict[str, str] = {}
    keys_to_validate: dict[str, str] = {}

    for provider in ("anthropic", "perplexity", "gemini"):
        val = getattr(body, provider)
        if val is not None:
            keys_to_save[provider] = val
            if val:
                keys_to_validate[provider] = val

    # Live validation
    validation = await validate_keys(keys_to_validate)

    # Save to DB (even if some fail validation — user can fix later)
    if keys_to_save:
        await save_api_keys(session, keys_to_save)

    # Persist validation results
    if validation:
        valid_map = {p: v[0] for p, v in validation.items()}
        await save_validation_results(session, valid_map)

    # Build response
    masked = await get_masked_keys(session)
    result: dict[str, ApiKeyStatus] = {}
    for provider, info in masked.items():
        valid = info.get("valid")
        if provider in validation:
            valid = validation[provider][0]
        result[provider] = ApiKeyStatus(
            provider=provider,
            configured=info["configured"],
            source=info["source"],
            hint=info["hint"],
            valid=valid,
        )

    return result
