"""Tests for the post-completion hook in the worker."""

import uuid

import pytest
from sqlalchemy import select
from src.models.post import Post
from src.models.profile import WebsiteProfile
from src.worker import _post_completion_hook


@pytest.fixture
async def profile_in_db(db_session):
    profile = WebsiteProfile(
        id=uuid.uuid4(),
        name="Test Blog",
        website_url="https://testblog.com",
    )
    db_session.add(profile)
    await db_session.commit()
    return profile


@pytest.fixture
async def post_in_db(db_session, profile_in_db):
    post = Post(
        id=uuid.uuid4(),
        profile_id=profile_in_db.id,
        slug="my-test-post",
        topic="How to Test Python Code",
        current_stage="images",
    )
    db_session.add(post)
    await db_session.commit()
    return post


class TestPostCompletionHook:
    @pytest.mark.asyncio
    async def test_marks_post_complete(self, db_session, post_in_db, profile_in_db):
        await _post_completion_hook(db_session, str(post_in_db.id), {})

        result = await db_session.execute(select(Post).where(Post.id == post_in_db.id))
        post = result.scalar_one()
        assert post.current_stage == "complete"
        assert post.completed_at is not None

    @pytest.mark.asyncio
    async def test_no_profile_skips(self, db_session):
        post = Post(
            id=uuid.uuid4(),
            slug="orphan-post",
            topic="Orphan",
            profile_id=None,
        )
        db_session.add(post)
        await db_session.commit()

        await _post_completion_hook(db_session, str(post.id), {})

        # Post without profile should still be marked complete
        result = await db_session.execute(select(Post).where(Post.id == post.id))
        updated = result.scalar_one()
        assert updated.current_stage == "complete"

    @pytest.mark.asyncio
    async def test_post_not_found_skips(self, db_session):
        fake_id = str(uuid.uuid4())
        # Should not raise
        await _post_completion_hook(db_session, fake_id, {})
