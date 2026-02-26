"""Website profile CRUD endpoints."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_session
from src.models.profile import WebsiteProfile
from src.models.schemas import ProfileCreate, ProfileRead, ProfileUpdate

router = APIRouter(prefix="/api/profiles", tags=["profiles"])


@router.get("", response_model=list[ProfileRead])
async def list_profiles(session: AsyncSession = Depends(get_session)):
    result = await session.execute(
        select(WebsiteProfile).order_by(WebsiteProfile.created_at.desc())
    )
    return result.scalars().all()


@router.post("", response_model=ProfileRead, status_code=201)
async def create_profile(
    data: ProfileCreate,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    profile = WebsiteProfile(**data.model_dump())
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
    session: AsyncSession = Depends(get_session),
):
    profile = await session.get(WebsiteProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return profile


@router.patch("/{profile_id}", response_model=ProfileRead)
async def update_profile(
    profile_id: uuid.UUID,
    data: ProfileUpdate,
    session: AsyncSession = Depends(get_session),
):
    profile = await session.get(WebsiteProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(profile, field, value)

    await session.commit()
    await session.refresh(profile)
    return profile


@router.delete("/{profile_id}", status_code=204)
async def delete_profile(
    profile_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
):
    profile = await session.get(WebsiteProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    await session.delete(profile)
    await session.commit()


@router.post("/{profile_id}/crawl", status_code=202)
async def trigger_crawl(
    profile_id: uuid.UUID,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    profile = await session.get(WebsiteProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

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
