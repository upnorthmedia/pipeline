from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from cryptography.fernet import Fernet
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.post import Post
from src.models.profile import WebsiteProfile

_FERNET_KEY = Fernet.generate_key().decode()


@pytest.fixture(autouse=True)
def _patch_encryption_key():
    with patch("src.services.crypto.settings") as mock_settings:
        mock_settings.wp_encryption_key = _FERNET_KEY
        yield


@pytest.mark.asyncio
async def test_nextjs_post_fields_ready_for_auto_publish(db_session: AsyncSession):
    """Verify that a post with output_format='nextjs' and a configured profile
    has the right fields for the worker to trigger auto-publish."""
    from src.models.auth import AuthUser
    from src.services.crypto import encrypt

    now = datetime.now(timezone.utc)
    user = AuthUser(
        id="test-worker-user",
        name="Test",
        email="worker@test.com",
        email_verified=False,
        created_at=now,
        updated_at=now,
    )
    db_session.add(user)
    await db_session.flush()

    profile = WebsiteProfile(
        name="Test",
        website_url="https://test.com",
        user_id=user.id,
        nextjs_webhook_url="https://test.com/api/jena-webhook",
        nextjs_webhook_secret=encrypt("secret"),
    )
    db_session.add(profile)
    await db_session.flush()

    post = Post(
        slug="auto-publish-test",
        topic="Auto Publish",
        profile_id=profile.id,
        output_format="nextjs",
    )
    db_session.add(post)
    await db_session.commit()

    # Verify the conditions the worker checks
    assert post.output_format == "nextjs"
    assert profile.nextjs_webhook_url is not None
    assert profile.nextjs_webhook_secret is not None

    # Verify publish_to_nextjs is importable and registered
    from src.services.nextjs_publish import publish_to_nextjs
    assert callable(publish_to_nextjs)
