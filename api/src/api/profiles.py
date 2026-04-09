"""Website profile CRUD endpoints."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.auth import get_current_user
from src.database import get_session
from src.models.auth import AuthUser
from src.models.profile import WebsiteProfile
from src.models.schemas import ProfileCreate, ProfileRead, ProfileUpdate

router = APIRouter(prefix="/api/profiles", tags=["profiles"])


async def _get_user_profile(
    profile_id: uuid.UUID, user: AuthUser, session: AsyncSession
) -> WebsiteProfile:
    result = await session.execute(
        select(WebsiteProfile).where(
            WebsiteProfile.id == profile_id,
            WebsiteProfile.user_id == user.id,
        )
    )
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return profile


@router.get("", response_model=list[ProfileRead])
async def list_profiles(
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(WebsiteProfile)
        .where(WebsiteProfile.user_id == user.id)
        .order_by(WebsiteProfile.created_at.desc())
    )
    return result.scalars().all()


@router.post("", response_model=ProfileRead, status_code=201)
async def create_profile(
    data: ProfileCreate,
    request: Request,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    dump = data.model_dump()
    if dump.get("wp_app_password"):
        from src.services.crypto import encrypt

        dump["wp_app_password"] = encrypt(dump["wp_app_password"])
    if dump.get("nextjs_webhook_secret"):
        from src.services.crypto import encrypt

        dump["nextjs_webhook_secret"] = encrypt(dump["nextjs_webhook_secret"])
    profile = WebsiteProfile(user_id=user.id, **dump)
    session.add(profile)
    await session.commit()
    await session.refresh(profile)

    # Auto-enqueue sitemap crawl
    try:
        await request.app.state.redis.enqueue_job(
            "crawl_profile_sitemap", str(profile.id)
        )
    except Exception:
        pass  # Crawl failure shouldn't block profile creation

    return profile


@router.get("/{profile_id}", response_model=ProfileRead)
async def get_profile(
    profile_id: uuid.UUID,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    profile = await _get_user_profile(profile_id, user, session)
    return profile


@router.patch("/{profile_id}", response_model=ProfileRead)
async def update_profile(
    profile_id: uuid.UUID,
    data: ProfileUpdate,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    profile = await _get_user_profile(profile_id, user, session)

    updates = data.model_dump(exclude_unset=True)
    if "wp_app_password" in updates and updates["wp_app_password"]:
        from src.services.crypto import encrypt

        updates["wp_app_password"] = encrypt(updates["wp_app_password"])
    if "nextjs_webhook_secret" in updates and updates["nextjs_webhook_secret"]:
        from src.services.crypto import encrypt

        updates["nextjs_webhook_secret"] = encrypt(updates["nextjs_webhook_secret"])

    for field, value in updates.items():
        setattr(profile, field, value)

    await session.commit()
    await session.refresh(profile)
    return profile


@router.delete("/{profile_id}", status_code=204)
async def delete_profile(
    profile_id: uuid.UUID,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    profile = await _get_user_profile(profile_id, user, session)

    await session.delete(profile)
    await session.commit()


@router.post("/{profile_id}/crawl", status_code=202)
async def trigger_crawl(
    profile_id: uuid.UUID,
    request: Request,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    profile = await _get_user_profile(profile_id, user, session)

    # Update status to crawling
    profile.crawl_status = "crawling"
    await session.commit()

    # Enqueue crawl job
    try:
        await request.app.state.redis.enqueue_job(
            "crawl_profile_sitemap", str(profile.id)
        )
    except Exception as e:
        profile.crawl_status = "failed"
        await session.commit()
        raise HTTPException(status_code=500, detail=f"Failed to enqueue crawl: {e}")

    return {"status": "crawling", "profile_id": str(profile_id)}
