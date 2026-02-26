"""Global settings CRUD endpoints."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_session
from src.models.schemas import SettingRead
from src.models.setting import Setting

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("", response_model=list[SettingRead])
async def list_settings(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(Setting).order_by(Setting.key))
    return result.scalars().all()


@router.patch("", response_model=list[SettingRead])
async def update_settings(
    updates: dict[str, dict],
    session: AsyncSession = Depends(get_session),
):
    """Update multiple settings at once. Body: {"key": {"value": ...}, ...}"""
    for key, payload in updates.items():
        setting = await session.get(Setting, key)
        if setting:
            setting.value = payload
            setting.updated_at = datetime.now(UTC)
        else:
            setting = Setting(key=key, value=payload)
            session.add(setting)

    await session.commit()

    result = await session.execute(select(Setting).order_by(Setting.key))
    return result.scalars().all()
