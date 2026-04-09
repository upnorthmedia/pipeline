from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.auth import AuthUser
from src.models.profile import WebsiteProfile
from src.models.post import Post

TEST_USER_ID = "test-user-nextjs-models"


@pytest.fixture
async def auth_user(db_session: AsyncSession) -> AuthUser:
    user = AuthUser(
        id=TEST_USER_ID,
        name="Test User",
        email="test@example.com",
        email_verified=False,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    db_session.add(user)
    await db_session.commit()
    return user


@pytest.mark.asyncio
async def test_profile_has_nextjs_fields(db_session: AsyncSession, auth_user: AuthUser):
    profile = WebsiteProfile(
        user_id=auth_user.id,
        name="Test",
        website_url="https://test.com",
        nextjs_webhook_url="https://test.com/api/jena-webhook",
        nextjs_webhook_secret="encrypted-secret",
        nextjs_frontmatter_map={"title": "title", "category": {"key": "category", "transform": "array"}},
    )
    db_session.add(profile)
    await db_session.commit()
    await db_session.refresh(profile)

    assert profile.nextjs_webhook_url == "https://test.com/api/jena-webhook"
    assert profile.nextjs_webhook_secret == "encrypted-secret"
    assert profile.nextjs_frontmatter_map["title"] == "title"


@pytest.mark.asyncio
async def test_post_has_nextjs_fields(db_session: AsyncSession):
    post = Post(
        slug="test-post",
        topic="Test",
        nextjs_publish_status="published",
    )
    db_session.add(post)
    await db_session.commit()
    await db_session.refresh(post)

    assert post.nextjs_publish_status == "published"
    assert post.nextjs_published_at is None
