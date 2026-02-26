"""Integration test: profile creation → sitemap crawl → links populated."""

import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from src.models.link import InternalLink
from src.models.profile import WebsiteProfile
from src.services.sitemap import SitemapEntry
from src.worker import crawl_profile_sitemap


@pytest.fixture
async def profile_in_db(db_session: AsyncSession):
    profile = WebsiteProfile(
        name="Crawl Test Site",
        website_url="https://crawltest.com",
        niche="tech",
    )
    db_session.add(profile)
    await db_session.commit()
    await db_session.refresh(profile)
    return profile


class TestCrawlIntegration:
    async def test_crawl_populates_links(self, db_session, db_engine, profile_in_db):
        """Simulate crawl_profile_sitemap worker job and verify links are stored."""
        from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

        session_factory = async_sessionmaker(
            db_engine, class_=AsyncSession, expire_on_commit=False
        )

        mock_entries = [
            SitemapEntry(url="https://crawltest.com/blog/post-1/", title="Post 1"),
            SitemapEntry(url="https://crawltest.com/blog/post-2/", title="Post 2"),
            SitemapEntry(url="https://crawltest.com/about/", title="About"),
        ]

        ctx = {"session_factory": session_factory}

        with patch("src.worker.crawl_sitemap", new_callable=AsyncMock) as mock_crawl:
            mock_crawl.return_value = mock_entries
            await crawl_profile_sitemap(ctx, str(profile_in_db.id))

        # Verify links in DB
        result = await db_session.execute(
            select(InternalLink).where(InternalLink.profile_id == profile_in_db.id)
        )
        links = result.scalars().all()
        assert len(links) == 3
        urls = {link.url for link in links}
        assert "https://crawltest.com/blog/post-1/" in urls
        assert "https://crawltest.com/about/" in urls

        # Verify slugs extracted
        post1_link = next(lnk for lnk in links if "post-1" in lnk.url)
        assert post1_link.slug == "post-1"
        assert post1_link.source == "sitemap"

    async def test_crawl_updates_profile_status(
        self, db_session, db_engine, profile_in_db
    ):
        from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

        session_factory = async_sessionmaker(
            db_engine, class_=AsyncSession, expire_on_commit=False
        )
        ctx = {"session_factory": session_factory}

        with patch("src.worker.crawl_sitemap", new_callable=AsyncMock) as mock_crawl:
            mock_crawl.return_value = [
                SitemapEntry(url="https://crawltest.com/page/"),
            ]
            await crawl_profile_sitemap(ctx, str(profile_in_db.id))

        # Refresh profile to see updated status
        await db_session.refresh(profile_in_db)
        assert profile_in_db.crawl_status == "complete"
        assert profile_in_db.last_crawled_at is not None

    async def test_crawl_failure_sets_failed_status(
        self, db_session, db_engine, profile_in_db
    ):
        from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

        session_factory = async_sessionmaker(
            db_engine, class_=AsyncSession, expire_on_commit=False
        )
        ctx = {"session_factory": session_factory}

        with patch("src.worker.crawl_sitemap", new_callable=AsyncMock) as mock_crawl:
            mock_crawl.side_effect = Exception("Network error")
            await crawl_profile_sitemap(ctx, str(profile_in_db.id))

        await db_session.refresh(profile_in_db)
        assert profile_in_db.crawl_status == "failed"

    async def test_crawl_nonexistent_profile(self, db_engine):
        from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

        session_factory = async_sessionmaker(
            db_engine, class_=AsyncSession, expire_on_commit=False
        )
        ctx = {"session_factory": session_factory}

        # Should not raise, just log error
        await crawl_profile_sitemap(ctx, str(uuid.uuid4()))

    async def test_crawl_upserts_existing_links(
        self, db_session, db_engine, profile_in_db
    ):
        """Re-crawling updates existing links rather than duplicating."""
        from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

        session_factory = async_sessionmaker(
            db_engine, class_=AsyncSession, expire_on_commit=False
        )
        ctx = {"session_factory": session_factory}

        entries_v1 = [
            SitemapEntry(url="https://crawltest.com/page/", title="Old Title"),
        ]
        entries_v2 = [
            SitemapEntry(url="https://crawltest.com/page/", title="New Title"),
            SitemapEntry(url="https://crawltest.com/new-page/", title="Brand New"),
        ]

        # First crawl
        with patch("src.worker.crawl_sitemap", new_callable=AsyncMock) as mock_crawl:
            mock_crawl.return_value = entries_v1
            await crawl_profile_sitemap(ctx, str(profile_in_db.id))

        # Second crawl
        with patch("src.worker.crawl_sitemap", new_callable=AsyncMock) as mock_crawl:
            mock_crawl.return_value = entries_v2
            await crawl_profile_sitemap(ctx, str(profile_in_db.id))

        result = await db_session.execute(
            select(InternalLink).where(InternalLink.profile_id == profile_in_db.id)
        )
        links = result.scalars().all()
        assert len(links) == 2  # Upserted, not duplicated

        page_link = next(
            lnk for lnk in links if lnk.url == "https://crawltest.com/page/"
        )
        assert page_link.title == "New Title"  # Updated
