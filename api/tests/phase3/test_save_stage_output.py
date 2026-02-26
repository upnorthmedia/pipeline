"""Tests for save_stage_output helper — verifies DB sync."""

import uuid

import pytest
from sqlalchemy import select
from src.models.post import Post
from src.pipeline.helpers import save_stage_output
from src.pipeline.state import STAGE_CONTENT_MAP


@pytest.fixture
async def post_in_db(db_session):
    post = Post(
        id=uuid.uuid4(),
        slug="test-save-output",
        topic="Save output test",
        current_stage="pending",
    )
    db_session.add(post)
    await db_session.commit()
    return post


async def _reload_post(session, post_id: uuid.UUID) -> Post:
    """Fetch a fresh Post row, bypassing identity-map cache."""
    result = await session.execute(
        select(Post).where(Post.id == post_id).execution_options(populate_existing=True)
    )
    return result.scalar_one()


class TestSaveStageOutput:
    @pytest.mark.asyncio
    async def test_saves_research_content(self, db_session, post_in_db):
        pid = post_in_db.id
        await save_stage_output(
            db_session,
            str(pid),
            "research",
            "# Research results\n\nKeyword data...",
        )

        post = await _reload_post(db_session, pid)
        assert post.research_content == "# Research results\n\nKeyword data..."
        assert post.current_stage == "research"

    @pytest.mark.asyncio
    async def test_saves_outline_content(self, db_session, post_in_db):
        pid = post_in_db.id
        await save_stage_output(
            db_session,
            str(pid),
            "outline",
            "## Introduction\n## Body\n## Conclusion",
        )

        post = await _reload_post(db_session, pid)
        assert post.outline_content is not None
        assert "Introduction" in post.outline_content

    @pytest.mark.asyncio
    async def test_saves_draft_content(self, db_session, post_in_db):
        pid = post_in_db.id
        await save_stage_output(
            db_session,
            str(pid),
            "write",
            "# Full Blog Draft\n\nLong content here...",
        )

        post = await _reload_post(db_session, pid)
        assert post.draft_content is not None
        assert "Full Blog Draft" in post.draft_content

    @pytest.mark.asyncio
    async def test_saves_final_md(self, db_session, post_in_db):
        pid = post_in_db.id
        md = "---\ntitle: Test\n---\n\nFinal markdown."
        await save_stage_output(
            db_session,
            str(pid),
            "edit",
            md,
        )

        post = await _reload_post(db_session, pid)
        assert post.final_md_content == md
        assert post.current_stage == "edit"

    @pytest.mark.asyncio
    async def test_saves_image_manifest_as_json(self, db_session, post_in_db):
        pid = post_in_db.id
        manifest = {"images": [{"prompt": "test"}], "total_generated": 1}
        await save_stage_output(
            db_session,
            str(pid),
            "images",
            manifest,
        )

        post = await _reload_post(db_session, pid)
        assert post.current_stage == "images"

    @pytest.mark.asyncio
    async def test_unknown_stage_does_not_crash(self, db_session, post_in_db):
        pid = post_in_db.id
        await save_stage_output(
            db_session,
            str(pid),
            "nonexistent",
            "content",
        )
        post = await _reload_post(db_session, pid)
        assert post.current_stage == "pending"

    @pytest.mark.asyncio
    async def test_all_stages_have_content_map_entries(self):
        from src.pipeline.state import STAGES

        for stage in STAGES:
            assert stage in STAGE_CONTENT_MAP
