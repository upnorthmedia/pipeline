"""Tests for SQLAlchemy models — CRUD operations on all tables."""

import pytest
from src.models import InternalLink, Post, Setting, WebsiteProfile


class TestWebsiteProfile:
    async def test_create_and_read(self, db_session):
        profile = WebsiteProfile(
            name="Test Blog",
            website_url="https://testblog.com",
            niche="technology",
            target_audience="developers",
        )
        db_session.add(profile)
        await db_session.commit()

        result = await db_session.get(WebsiteProfile, profile.id)
        assert result is not None
        assert result.name == "Test Blog"
        assert result.website_url == "https://testblog.com"
        assert result.niche == "technology"
        assert result.tone == "Conversational and friendly"
        assert result.word_count == 2000
        assert result.crawl_status == "pending"
        assert result.default_stage_settings["research"] == "review"

    async def test_update(self, db_session):
        profile = WebsiteProfile(name="Old Name", website_url="https://old.com")
        db_session.add(profile)
        await db_session.commit()

        profile.name = "New Name"
        await db_session.commit()

        result = await db_session.get(WebsiteProfile, profile.id)
        assert result.name == "New Name"

    async def test_delete(self, db_session):
        profile = WebsiteProfile(name="To Delete", website_url="https://delete.com")
        db_session.add(profile)
        await db_session.commit()
        pid = profile.id

        await db_session.delete(profile)
        await db_session.commit()

        result = await db_session.get(WebsiteProfile, pid)
        assert result is None


class TestPost:
    async def test_create_with_profile(self, db_session):
        profile = WebsiteProfile(name="Blog", website_url="https://blog.com")
        db_session.add(profile)
        await db_session.commit()

        post = Post(
            profile_id=profile.id,
            slug="test-post",
            topic="Test Topic",
            niche="tech",
        )
        db_session.add(post)
        await db_session.commit()

        result = await db_session.get(Post, post.id)
        assert result is not None
        assert result.slug == "test-post"
        assert result.profile_id == profile.id
        assert result.current_stage == "pending"
        assert result.stage_settings["research"] == "review"

    async def test_create_without_profile(self, db_session):
        post = Post(slug="standalone-post", topic="Standalone Topic")
        db_session.add(post)
        await db_session.commit()

        result = await db_session.get(Post, post.id)
        assert result is not None
        assert result.profile_id is None

    async def test_update_stage_content(self, db_session):
        post = Post(slug="content-test", topic="Content Test")
        db_session.add(post)
        await db_session.commit()

        post.research_content = "# Research Results\nKeyword analysis..."
        post.current_stage = "research"
        post.stage_status = {"research": "complete"}
        await db_session.commit()

        result = await db_session.get(Post, post.id)
        assert result.research_content.startswith("# Research")
        assert result.stage_status["research"] == "complete"

    async def test_stage_logs_jsonb(self, db_session):
        post = Post(slug="logs-test", topic="Logs Test")
        db_session.add(post)
        await db_session.commit()

        post.stage_logs = {
            "research": {
                "tokens_in": 500,
                "tokens_out": 3000,
                "model": "sonar-pro",
                "duration_s": 12.5,
                "cost_usd": 0.03,
            }
        }
        await db_session.commit()

        result = await db_session.get(Post, post.id)
        assert result.stage_logs["research"]["tokens_in"] == 500
        assert result.stage_logs["research"]["model"] == "sonar-pro"


class TestInternalLink:
    async def test_create_link(self, db_session):
        profile = WebsiteProfile(name="Blog", website_url="https://blog.com")
        db_session.add(profile)
        await db_session.commit()

        link = InternalLink(
            profile_id=profile.id,
            url="https://blog.com/best-article/",
            title="Best Article Ever",
            slug="best-article",
            keywords=["seo", "writing"],
        )
        db_session.add(link)
        await db_session.commit()

        result = await db_session.get(InternalLink, link.id)
        assert result.url == "https://blog.com/best-article/"
        assert result.title == "Best Article Ever"
        assert result.source == "sitemap"
        assert "seo" in result.keywords

    async def test_cascade_delete_with_profile(self, db_session):
        profile = WebsiteProfile(name="Cascade Test", website_url="https://cascade.com")
        db_session.add(profile)
        await db_session.commit()

        link = InternalLink(
            profile_id=profile.id,
            url="https://cascade.com/page/",
            title="Page",
        )
        db_session.add(link)
        await db_session.commit()
        link_id = link.id

        await db_session.delete(profile)
        await db_session.commit()

        result = await db_session.get(InternalLink, link_id)
        assert result is None

    async def test_unique_constraint_profile_url(self, db_session):
        profile = WebsiteProfile(name="Unique Test", website_url="https://unique.com")
        db_session.add(profile)
        await db_session.commit()

        link1 = InternalLink(profile_id=profile.id, url="https://unique.com/page/")
        db_session.add(link1)
        await db_session.commit()

        link2 = InternalLink(profile_id=profile.id, url="https://unique.com/page/")
        db_session.add(link2)
        with pytest.raises(Exception):  # IntegrityError
            await db_session.commit()


class TestSetting:
    async def test_create_and_read(self, db_session):
        setting = Setting(
            key="default_stage_settings",
            value={"research": "auto", "outline": "review"},
        )
        db_session.add(setting)
        await db_session.commit()

        result = await db_session.get(Setting, "default_stage_settings")
        assert result is not None
        assert result.value["research"] == "auto"

    async def test_update(self, db_session):
        setting = Setting(key="worker_concurrency", value={"max_jobs": 3})
        db_session.add(setting)
        await db_session.commit()

        setting.value = {"max_jobs": 5}
        await db_session.commit()

        result = await db_session.get(Setting, "worker_concurrency")
        assert result.value["max_jobs"] == 5
