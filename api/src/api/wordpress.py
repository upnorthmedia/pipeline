"""WordPress integration endpoints (test connection, list categories/authors)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.auth import get_current_user
from src.database import get_session
from src.models.auth import AuthUser
from src.models.profile import WebsiteProfile
from src.services.crypto import decrypt
from src.services.wordpress import WordPressClient, WordPressError

router = APIRouter(prefix="/api/profiles/{profile_id}/wordpress", tags=["wordpress"])


async def _get_wp_client(
    profile: WebsiteProfile,
) -> WordPressClient:
    if not profile.wp_url or not profile.wp_username or not profile.wp_app_password:
        raise HTTPException(
            status_code=400,
            detail="WordPress credentials not configured on this profile",
        )
    try:
        password = decrypt(profile.wp_app_password)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Failed to decrypt WordPress app password — check WP_ENCRYPTION_KEY",
        )
    return WordPressClient(profile.wp_url, profile.wp_username, password)


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


@router.get("/test")
async def test_connection(
    profile_id: uuid.UUID,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    profile = await _get_user_profile(profile_id, user, session)

    try:
        client = await _get_wp_client(profile)
    except HTTPException as e:
        return {"connected": False, "error": e.detail}

    try:
        async with client:
            info = await client.test_connection()
        return {
            "connected": True,
            "site_name": info.get("name", ""),
        }
    except WordPressError as e:
        return {"connected": False, "error": str(e)}


@router.get("/categories")
async def list_categories(
    profile_id: uuid.UUID,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    profile = await _get_user_profile(profile_id, user, session)

    client = await _get_wp_client(profile)
    async with client:
        categories = await client.list_categories()

    return [
        {
            "id": c["id"],
            "name": c["name"],
            "slug": c["slug"],
            "count": c.get("count", 0),
        }
        for c in categories
    ]


@router.get("/authors")
async def list_authors(
    profile_id: uuid.UUID,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    profile = await _get_user_profile(profile_id, user, session)

    client = await _get_wp_client(profile)
    async with client:
        users = await client.list_users()

    return [
        {
            "id": u["id"],
            "name": u["name"],
            "slug": u["slug"],
        }
        for u in users
    ]
