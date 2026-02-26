"""Tests for the post-completion hook in the worker."""

import uuid

import pytest
from sqlalchemy import select
from src.models.link import InternalLink
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
    async def test_creates_internal_link(self, db_session, post_in_db, profile_in_db):
        state = {"related_keywords": ["python", "testing"]}
        await _post_completion_hook(db_session, str(post_in_db.id), state)

        result = await db_session.execute(
            select(InternalLink).where(
                InternalLink.profile_id == profile_in_db.id,
                InternalLink.source == "generated",
            )
        )
        link = result.scalar_one()
        assert link.url == "https://testblog.com/my-test-post/"
        assert link.title == "How to Test Python Code"
        assert link.slug == "my-test-post"
        assert link.keywords == ["python", "testing"]

    @pytest.mark.asyncio
    async def test_marks_post_complete(self, db_session, post_in_db, profile_in_db):
        await _post_completion_hook(db_session, str(post_in_db.id), {})

        result = await db_session.execute(select(Post).where(Post.id == post_in_db.id))
        post = result.scalar_one()
        assert post.current_stage == "complete"
        assert post.completed_at is not None

    @pytest.mark.asyncio
    async def test_no_duplicate_links(self, db_session, post_in_db, profile_in_db):
        # Run twice — second should be a no-op
        await _post_completion_hook(db_session, str(post_in_db.id), {})
        await _post_completion_hook(db_session, str(post_in_db.id), {})

        result = await db_session.execute(
            select(InternalLink).where(
                InternalLink.profile_id == profile_in_db.id,
                InternalLink.url == "https://testblog.com/my-test-post/",
            )
        )
        links = result.scalars().all()
        assert len(links) == 1

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

        # Should not crash, no links created
        result = await db_session.execute(select(InternalLink))
        assert result.scalars().all() == []

    @pytest.mark.asyncio
    async def test_post_not_found_skips(self, db_session):
        fake_id = str(uuid.uuid4())
        # Should not raise
        await _post_completion_hook(db_session, fake_id, {})
