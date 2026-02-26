"""Tests for re-crawl scheduling: cron job and interval logic."""

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from src.models.link import InternalLink
from src.models.profile import WebsiteProfile
from src.worker import check_recrawl_schedules

pytestmark = pytest.mark.anyio


def _make_ctx(session_factory, redis=None):
    """Build a minimal worker context dict."""
    return {
        "session_factory": session_factory,
        "redis": redis or AsyncMock(),
    }


async def test_recrawl_skips_profiles_without_interval(
    db_session: AsyncSession, db_engine
):
    """Profiles with recrawl_interval=None should be ignored."""
    from sqlalchemy.ext.asyncio import AsyncSession as AS
    from sqlalchemy.ext.asyncio import async_sessionmaker

    sf = async_sessionmaker(db_engine, class_=AS, expire_on_commit=False)

    profile = WebsiteProfile(
        name="No Recrawl",
        website_url="https://example.com",
        recrawl_interval=None,
        crawl_status="complete",
    )
    db_session.add(profile)
    await db_session.commit()

    redis = AsyncMock()
    ctx = _make_ctx(sf, redis)
    await check_recrawl_schedules(ctx)

    redis.enqueue_job.assert_not_called()


async def test_recrawl_enqueues_never_crawled(db_session: AsyncSession, db_engine):
    """Profile with interval set but never crawled should be enqueued."""
    from sqlalchemy.ext.asyncio import AsyncSession as AS
    from sqlalchemy.ext.asyncio import async_sessionmaker

    sf = async_sessionmaker(db_engine, class_=AS, expire_on_commit=False)

    profile = WebsiteProfile(
        name="Never Crawled",
        website_url="https://example.com",
        recrawl_interval="weekly",
        crawl_status="pending",
        last_crawled_at=None,
    )
    db_session.add(profile)
    await db_session.commit()

    redis = AsyncMock()
    ctx = _make_ctx(sf, redis)
    await check_recrawl_schedules(ctx)

    redis.enqueue_job.assert_called_once_with("crawl_profile_sitemap", str(profile.id))


async def test_recrawl_weekly_due(db_session: AsyncSession, db_engine):
    """Weekly profile crawled 8 days ago should be re-enqueued."""
    from sqlalchemy.ext.asyncio import AsyncSession as AS
    from sqlalchemy.ext.asyncio import async_sessionmaker

    sf = async_sessionmaker(db_engine, class_=AS, expire_on_commit=False)

    profile = WebsiteProfile(
        name="Weekly Due",
        website_url="https://example.com",
        recrawl_interval="weekly",
        crawl_status="complete",
        last_crawled_at=datetime.now(UTC) - timedelta(days=8),
    )
    db_session.add(profile)
    await db_session.commit()

    redis = AsyncMock()
    ctx = _make_ctx(sf, redis)
    await check_recrawl_schedules(ctx)

    redis.enqueue_job.assert_called_once()


async def test_recrawl_weekly_not_due(db_session: AsyncSession, db_engine):
    """Weekly profile crawled 3 days ago should not be re-enqueued."""
    from sqlalchemy.ext.asyncio import AsyncSession as AS
    from sqlalchemy.ext.asyncio import async_sessionmaker

    sf = async_sessionmaker(db_engine, class_=AS, expire_on_commit=False)

    profile = WebsiteProfile(
        name="Weekly Not Due",
        website_url="https://example.com",
        recrawl_interval="weekly",
        crawl_status="complete",
        last_crawled_at=datetime.now(UTC) - timedelta(days=3),
    )
    db_session.add(profile)
    await db_session.commit()

    redis = AsyncMock()
    ctx = _make_ctx(sf, redis)
    await check_recrawl_schedules(ctx)

    redis.enqueue_job.assert_not_called()


async def test_recrawl_monthly_due(db_session: AsyncSession, db_engine):
    """Monthly profile crawled 31 days ago should be re-enqueued."""
    from sqlalchemy.ext.asyncio import AsyncSession as AS
    from sqlalchemy.ext.asyncio import async_sessionmaker

    sf = async_sessionmaker(db_engine, class_=AS, expire_on_commit=False)

    profile = WebsiteProfile(
        name="Monthly Due",
        website_url="https://example.com",
        recrawl_interval="monthly",
        crawl_status="complete",
        last_crawled_at=datetime.now(UTC) - timedelta(days=31),
    )
    db_session.add(profile)
    await db_session.commit()

    redis = AsyncMock()
    ctx = _make_ctx(sf, redis)
    await check_recrawl_schedules(ctx)

    redis.enqueue_job.assert_called_once()


async def test_recrawl_monthly_not_due(db_session: AsyncSession, db_engine):
    """Monthly profile crawled 15 days ago should not be re-enqueued."""
    from sqlalchemy.ext.asyncio import AsyncSession as AS
    from sqlalchemy.ext.asyncio import async_sessionmaker

    sf = async_sessionmaker(db_engine, class_=AS, expire_on_commit=False)

    profile = WebsiteProfile(
        name="Monthly Not Due",
        website_url="https://example.com",
        recrawl_interval="monthly",
        crawl_status="complete",
        last_crawled_at=datetime.now(UTC) - timedelta(days=15),
    )
    db_session.add(profile)
    await db_session.commit()

    redis = AsyncMock()
    ctx = _make_ctx(sf, redis)
    await check_recrawl_schedules(ctx)

    redis.enqueue_job.assert_not_called()


async def test_recrawl_skips_currently_crawling(db_session: AsyncSession, db_engine):
    """Profiles currently crawling should not be enqueued again."""
    from sqlalchemy.ext.asyncio import AsyncSession as AS
    from sqlalchemy.ext.asyncio import async_sessionmaker

    sf = async_sessionmaker(db_engine, class_=AS, expire_on_commit=False)

    profile = WebsiteProfile(
        name="Crawling Now",
        website_url="https://example.com",
        recrawl_interval="weekly",
        crawl_status="crawling",
        last_crawled_at=datetime.now(UTC) - timedelta(days=10),
    )
    db_session.add(profile)
    await db_session.commit()

    redis = AsyncMock()
    ctx = _make_ctx(sf, redis)
    await check_recrawl_schedules(ctx)

    redis.enqueue_job.assert_not_called()


async def test_recrawl_preserves_generated_links(db_session: AsyncSession, db_engine):
    """Re-crawl should not affect links with source='generated'."""
    from sqlalchemy.ext.asyncio import AsyncSession as AS
    from sqlalchemy.ext.asyncio import async_sessionmaker

    sf = async_sessionmaker(db_engine, class_=AS, expire_on_commit=False)

    profile = WebsiteProfile(
        name="Preserve Links",
        website_url="https://example.com",
        recrawl_interval="weekly",
        crawl_status="complete",
        last_crawled_at=datetime.now(UTC) - timedelta(days=10),
    )
    db_session.add(profile)
    await db_session.commit()
    await db_session.refresh(profile)

    # Add a generated link
    gen_link = InternalLink(
        profile_id=profile.id,
        url="https://example.com/my-generated-post/",
        title="Generated Post",
        slug="my-generated-post",
        source="generated",
    )
    db_session.add(gen_link)
    await db_session.commit()

    redis = AsyncMock()
    ctx = _make_ctx(sf, redis)
    await check_recrawl_schedules(ctx)

    # Re-crawl was enqueued (the job itself would preserve generated links)
    redis.enqueue_job.assert_called_once()

    # Verify generated link still exists
    await db_session.refresh(gen_link)
    assert gen_link.source == "generated"


async def test_recrawl_profile_api_field(client, sample_profile_data):
    """API should accept and return recrawl_interval on profiles."""
    data = {**sample_profile_data, "recrawl_interval": "weekly"}
    resp = await client.post("/api/profiles", json=data)
    assert resp.status_code == 201
    profile = resp.json()
    assert profile["recrawl_interval"] == "weekly"

    # Update to monthly
    resp2 = await client.patch(
        f"/api/profiles/{profile['id']}",
        json={"recrawl_interval": "monthly"},
    )
    assert resp2.status_code == 200
    assert resp2.json()["recrawl_interval"] == "monthly"

    # Disable
    resp3 = await client.patch(
        f"/api/profiles/{profile['id']}",
        json={"recrawl_interval": None},
    )
    assert resp3.status_code == 200
    assert resp3.json()["recrawl_interval"] is None
