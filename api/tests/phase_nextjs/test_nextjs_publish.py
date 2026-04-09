from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from cryptography.fernet import Fernet
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.auth import AuthUser
from src.models.post import Post
from src.models.profile import WebsiteProfile

TEST_USER_ID = "test-user-nextjs-publish"
_FERNET_KEY = Fernet.generate_key().decode()


@pytest.fixture(autouse=True)
def _patch_encryption_key():
    with patch("src.services.crypto.settings") as mock_settings:
        mock_settings.wp_encryption_key = _FERNET_KEY
        yield


@pytest.fixture
async def auth_user(db_session: AsyncSession) -> AuthUser:
    user = AuthUser(
        id=TEST_USER_ID,
        name="Publish Test User",
        email="publish@example.com",
        email_verified=False,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    db_session.add(user)
    await db_session.commit()
    return user


@pytest.fixture
async def profile_and_post(db_session: AsyncSession, auth_user: AuthUser):
    from src.services.crypto import encrypt

    encrypted_secret = encrypt("my-webhook-secret")

    profile = WebsiteProfile(
        user_id=auth_user.id,
        name="Next.js Blog",
        website_url="https://myblog.com",
        nextjs_webhook_url="https://myblog.com/api/jena-webhook",
        nextjs_webhook_secret=encrypted_secret,
    )
    db_session.add(profile)
    await db_session.flush()

    post = Post(
        profile_id=profile.id,
        slug="test-publish-post",
        topic="Test Publish",
        ready_content="# Hello\nThis is the post.",
    )
    db_session.add(post)
    await db_session.commit()
    await db_session.refresh(post)

    return profile, post


@pytest.mark.asyncio
async def test_successful_webhook_delivery_sets_published_status(
    db_session: AsyncSession, profile_and_post
):
    """A 200 response from the webhook endpoint marks the post as published."""
    profile, post = profile_and_post
    post_id = str(post.id)

    @asynccontextmanager
    async def mock_session_factory():
        yield db_session

    mock_response = MagicMock()
    mock_response.status_code = 200

    mock_http_client = AsyncMock()
    mock_http_client.post = AsyncMock(return_value=mock_response)

    ctx = {"session_factory": mock_session_factory, "redis": AsyncMock()}

    with patch("httpx.AsyncClient") as mock_client_class:
        mock_client_class.return_value.__aenter__ = AsyncMock(
            return_value=mock_http_client
        )
        mock_client_class.return_value.__aexit__ = AsyncMock(return_value=False)

        from src.services.nextjs_publish import publish_to_nextjs

        await publish_to_nextjs(ctx, post_id)

    await db_session.refresh(post)
    assert post.nextjs_publish_status == "published"
    assert post.nextjs_published_at is not None


@pytest.mark.asyncio
async def test_failed_webhook_response_sets_failed_status(
    db_session: AsyncSession, profile_and_post
):
    """A 500 response from the webhook endpoint marks the post as failed."""
    profile, post = profile_and_post
    post_id = str(post.id)

    @asynccontextmanager
    async def mock_session_factory():
        yield db_session

    mock_response = MagicMock()
    mock_response.status_code = 500
    mock_response.text = "Internal Server Error"

    mock_http_client = AsyncMock()
    mock_http_client.post = AsyncMock(return_value=mock_response)

    ctx = {"session_factory": mock_session_factory, "redis": AsyncMock()}

    with patch("httpx.AsyncClient") as mock_client_class:
        mock_client_class.return_value.__aenter__ = AsyncMock(
            return_value=mock_http_client
        )
        mock_client_class.return_value.__aexit__ = AsyncMock(return_value=False)

        from src.services.nextjs_publish import publish_to_nextjs

        await publish_to_nextjs(ctx, post_id)

    await db_session.refresh(post)
    assert post.nextjs_publish_status == "failed"
    assert post.nextjs_published_at is None
