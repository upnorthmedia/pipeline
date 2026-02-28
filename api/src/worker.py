"""ARQ worker entry point for pipeline job processing."""

import json
import logging
import uuid
from datetime import UTC, datetime
from urllib.parse import urlparse

from arq.connections import RedisSettings
from arq.cron import cron
from sqlalchemy import select
from sqlalchemy import update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from src.api.events import publish_event
from src.config import settings
from src.models.link import InternalLink
from src.models.post import Post
from src.models.profile import WebsiteProfile
from src.pipeline.helpers import (
    append_execution_log,
    clear_event_context,
    log_stage_execution,
    save_stage_output,
    set_event_context,
)
from src.pipeline.stages.edit import edit_node
from src.pipeline.stages.images import images_node
from src.pipeline.stages.outline import outline_node
from src.pipeline.stages.ready import ready_node
from src.pipeline.stages.research import research_node
from src.pipeline.stages.write import write_node
from src.pipeline.state import STAGE_OUTPUT_KEY, STAGES, state_from_post
from src.services.sitemap import crawl_sitemap

STAGE_NODE_FN = {
    "research": research_node,
    "outline": outline_node,
    "write": write_node,
    "edit": edit_node,
    "images": images_node,
    "ready": ready_node,
}

logger = logging.getLogger(__name__)

DLQ_KEY = "arq:dead_letter_queue"
WORKER_LAST_COMPLETED_KEY = "arq:worker:last_completed"
MAX_ATTEMPTS = 3


async def run_pipeline_stage(ctx, post_id: str, stage: str | None = None):
    """Execute the pipeline for a post.

    If `stage` is specified, runs only that stage (no gate checks).
    Otherwise, runs all remaining stages sequentially (with gate checks).

    Retries up to MAX_ATTEMPTS times. On final failure, moves to dead letter queue.
    """
    job_try = ctx.get("job_try", 1)
    session_factory: async_sessionmaker = ctx["session_factory"]
    redis = ctx["redis"]

    # Verify post exists
    async with session_factory() as session:
        post = await session.get(Post, uuid.UUID(post_id))
        if not post:
            logger.error(f"Post {post_id} not found")
            return

    if stage:
        # Single-stage: run just this stage, skip gate checks
        await _run_pipeline(
            ctx,
            post_id,
            redis,
            session_factory,
            job_try,
            stages=[stage],
            check_gates=False,
        )
    else:
        # Full pipeline: all remaining stages with gate checks
        await _run_pipeline(
            ctx,
            post_id,
            redis,
            session_factory,
            job_try,
        )


async def _run_pipeline(
    ctx,
    post_id: str,
    redis,
    session_factory,
    job_try: int,
    stages: list[str] | None = None,
    check_gates: bool = True,
):
    """Run one or more pipeline stages sequentially.

    Args:
        stages: Specific stages to run, or None for all remaining.
        check_gates: Whether to check gate modes. True for full pipeline runs,
                    False for single-stage reruns (direct execution).

    Each iteration:
    1. Loads fresh post state from DB
    2. Checks gate mode — pauses for review if needed (when check_gates=True)
    3. Calls the stage node function directly
    4. Saves output to DB immediately (crash recovery = resume from last saved)
    5. Logs metrics and publishes SSE events
    """
    is_full_pipeline = stages is None
    target_stages = stages if stages is not None else STAGES

    try:
        if is_full_pipeline:
            # Log pipeline_start to DB
            async with session_factory() as session:
                await append_execution_log(
                    session,
                    post_id,
                    "",
                    "info",
                    "pipeline_start",
                    "Full pipeline run initiated",
                )

        # Fetch internal links once (needed by edit stage prompt)
        internal_links = await _fetch_internal_links_from_factory(
            session_factory, post_id
        )

        for stage in target_stages:
            node_fn = STAGE_NODE_FN.get(stage)
            if not node_fn:
                logger.error(f"No node function for stage '{stage}'")
                continue

            # Load fresh post from DB each iteration
            async with session_factory() as session:
                post = await session.get(Post, uuid.UUID(post_id))
                if not post:
                    logger.error(f"Post {post_id} not found during pipeline")
                    return

                # Skip already-completed stages (full pipeline only)
                if is_full_pipeline:
                    ss = post.stage_status or {}
                    if ss.get(stage) == "complete":
                        continue

                # Check gate mode (full pipeline only)
                if check_gates:
                    mode = (post.stage_settings or {}).get(stage, "review")
                    if mode in ("review", "approve_only"):
                        # Pause for human review
                        ss_new = dict(post.stage_status or {})
                        ss_new[stage] = "review"
                        post.stage_status = ss_new
                        post.current_stage = stage
                        await session.commit()

                        await append_execution_log(
                            session,
                            post_id,
                            stage,
                            "info",
                            "stage_review",
                            f"Stage {stage} paused for review",
                        )

                        await publish_event(
                            redis,
                            post_id,
                            "stage_review",
                            {
                                "stage": stage,
                                "message": f"Stage {stage} paused for review",
                            },
                        )
                        logger.info(
                            f"Pipeline paused at stage '{stage}' "
                            f"for post {post_id} (gate mode: {mode})"
                        )
                        return

                # Build state from fresh post data
                initial_state = state_from_post(post, internal_links)

            # Execute the stage
            await publish_event(
                redis,
                post_id,
                "stage_start",
                {"stage": stage, "message": f"Starting {stage}..."},
            )
            set_event_context(redis, post_id, session_factory)

            async with session_factory() as session:
                await append_execution_log(
                    session,
                    post_id,
                    stage,
                    "info",
                    "stage_start",
                    f"Starting {stage}...",
                )

            result = await node_fn(initial_state)

            clear_event_context()

            # Save output and log metrics immediately
            async with session_factory() as session:
                meta = result.get("_stage_meta")
                if isinstance(meta, dict):
                    await log_stage_execution(
                        session,
                        post_id,
                        stage,
                        meta["model"],
                        meta["tokens_in"],
                        meta["tokens_out"],
                        meta["duration_s"],
                    )

                content = result.get(STAGE_OUTPUT_KEY.get(stage, ""))
                stage_status = result.get("stage_status")
                if content is not None:
                    await save_stage_output(
                        session,
                        post_id,
                        stage,
                        content,
                        stage_status=stage_status,
                    )

                # Edit stage: also save final_html if present
                if stage == "edit" and result.get("final_html"):
                    stmt = (
                        sql_update(Post)
                        .where(Post.id == post_id)
                        .values(final_html_content=result["final_html"])
                    )
                    await session.execute(stmt)
                    await session.commit()

                # Single-stage rerun: check if all stages are now complete
                if not is_full_pipeline:
                    post = await session.get(Post, uuid.UUID(post_id))
                    if post:
                        ss = post.stage_status or {}
                        if all(ss.get(s) == "complete" for s in STAGES):
                            post.current_stage = "complete"
                        await session.commit()

                # Log stage_complete to DB
                await append_execution_log(
                    session,
                    post_id,
                    stage,
                    "info",
                    "stage_complete",
                    f"Stage {stage} complete",
                    data={
                        "model": meta["model"],
                        "tokens_in": meta["tokens_in"],
                        "tokens_out": meta["tokens_out"],
                        "duration_s": round(meta["duration_s"], 2),
                        "cost_usd": round(
                            (meta["tokens_in"] / 1_000_000 * 15.0)
                            + (meta["tokens_out"] / 1_000_000 * 75.0),
                            6,
                        ),
                    }
                    if meta
                    else {},
                )

            await publish_event(
                redis,
                post_id,
                "stage_complete",
                {
                    "stage": stage,
                    "model": meta["model"] if meta else "",
                    "duration_s": round(meta["duration_s"], 2) if meta else 0,
                },
            )

        # Full pipeline completion
        if is_full_pipeline:
            async with session_factory() as session:
                post = await session.get(Post, uuid.UUID(post_id))
                if post:
                    state = state_from_post(post, internal_links)
                    await _post_completion_hook(session, post_id, state)

                await append_execution_log(
                    session,
                    post_id,
                    "",
                    "info",
                    "pipeline_complete",
                    "Pipeline finished",
                )

            await publish_event(
                redis,
                post_id,
                "pipeline_complete",
                {"message": "Pipeline finished"},
            )

        await _record_job_completed(redis)

    except Exception as e:
        clear_event_context()
        failed_stage = target_stages[0] if len(target_stages) == 1 else ""
        logger.exception(
            f"Pipeline attempt {job_try}/{MAX_ATTEMPTS} failed for post {post_id}"
        )
        await publish_event(
            redis,
            post_id,
            "stage_error",
            {
                "stage": failed_stage,
                "error": str(e),
                "message": f"Pipeline failed: {e}",
            },
        )
        # Log error + retry to DB
        async with session_factory() as session:
            if job_try < MAX_ATTEMPTS:
                await append_execution_log(
                    session,
                    post_id,
                    failed_stage,
                    "warning",
                    "retry",
                    f"Pipeline attempt {job_try} failed, retrying...",
                    data={
                        "attempt": job_try,
                        "max_attempts": MAX_ATTEMPTS,
                        "error": str(e),
                    },
                )
            else:
                await append_execution_log(
                    session,
                    post_id,
                    failed_stage,
                    "error",
                    "stage_error",
                    f"Pipeline failed after {job_try} attempts: {e}",
                    data={
                        "error": str(e),
                        "attempts": job_try,
                        "moved_to_dlq": True,
                    },
                )
        if job_try >= MAX_ATTEMPTS:
            await _move_to_dlq(ctx, post_id, failed_stage or None, str(e), job_try)
            return
        raise


async def _fetch_internal_links(session: AsyncSession, post: Post) -> list[dict]:
    """Fetch internal links for a post's profile."""
    if not post.profile_id:
        return []
    result = await session.execute(
        select(InternalLink).where(InternalLink.profile_id == post.profile_id)
    )
    links = result.scalars().all()
    return [{"url": link.url, "title": link.title, "slug": link.slug} for link in links]


async def _fetch_internal_links_from_factory(
    session_factory, post_id: str
) -> list[dict]:
    """Fetch internal links using a session factory (for the sequential pipeline)."""
    async with session_factory() as session:
        post = await session.get(Post, uuid.UUID(post_id))
        if not post:
            return []
        return await _fetch_internal_links(session, post)


async def _move_to_dlq(
    ctx, post_id: str, stage: str | None, error: str, attempts: int
) -> None:
    """Move a failed job to the dead letter queue in Redis and mark post as failed."""
    session_factory: async_sessionmaker = ctx["session_factory"]
    redis = ctx["redis"]

    dlq_entry = json.dumps(
        {
            "post_id": post_id,
            "stage": stage,
            "error": error,
            "attempts": attempts,
            "failed_at": datetime.now(UTC).isoformat(),
        }
    )
    await redis.lpush(DLQ_KEY, dlq_entry)

    async with session_factory() as session:
        post = await session.get(Post, uuid.UUID(post_id))
        if post:
            post.current_stage = "failed"
            # Store error info in stage_logs
            logs = dict(post.stage_logs or {})
            logs["_error"] = {
                "message": error,
                "attempts": attempts,
                "failed_at": datetime.now(UTC).isoformat(),
            }
            post.stage_logs = logs
            await session.commit()

    logger.error(
        f"Post {post_id} moved to dead letter queue after {attempts} failures: {error}"
    )


async def _post_completion_hook(
    session: AsyncSession, post_id: str, state: dict
) -> None:
    """After pipeline completes, add the generated post to internal_links."""
    post = await session.get(Post, uuid.UUID(post_id))
    if not post or not post.profile_id:
        return

    # Build the post URL from profile website_url + slug
    profile = await session.get(WebsiteProfile, post.profile_id)
    if not profile:
        return

    website_url = profile.website_url.rstrip("/")
    post_url = f"{website_url}/{post.slug}/"

    # Check if already exists
    existing = await session.execute(
        select(InternalLink).where(
            InternalLink.profile_id == post.profile_id,
            InternalLink.url == post_url,
        )
    )
    if existing.scalar_one_or_none():
        return

    # Extract keywords from research content
    keywords = state.get("related_keywords", [])

    link = InternalLink(
        profile_id=post.profile_id,
        url=post_url,
        title=post.topic,
        slug=post.slug,
        source="generated",
        post_id=post.id,
        keywords=keywords,
    )
    session.add(link)

    # Mark post as completed
    post.current_stage = "complete"
    post.completed_at = datetime.now(UTC)
    await session.commit()

    logger.info(f"Post {post_id} completed, added to internal links: {post_url}")


async def _record_job_completed(redis) -> None:
    """Record the timestamp of the last completed job in Redis."""
    await redis.set(WORKER_LAST_COMPLETED_KEY, datetime.now(UTC).isoformat())


async def crawl_profile_sitemap(ctx, profile_id: str):
    """Crawl a website profile's sitemap and populate internal links."""
    session_factory: async_sessionmaker = ctx["session_factory"]

    async with session_factory() as session:
        profile = await session.get(WebsiteProfile, uuid.UUID(profile_id))
        if not profile:
            logger.error(f"Profile {profile_id} not found")
            return

        profile.crawl_status = "crawling"
        await session.commit()

        try:
            entries = await crawl_sitemap(profile.website_url, fetch_titles=False)
            logger.info(
                f"Crawled {len(entries)} URLs for "
                f"profile {profile.name} ({profile.website_url})"
            )

            # Store discovered sitemap URLs on the profile
            sitemap_urls_seen: list[str] = []

            # Upsert entries into internal_links
            for entry in entries:
                # Extract slug from URL path
                parsed = urlparse(entry.url)
                path = parsed.path.strip("/")
                slug = path.split("/")[-1] if path else None

                existing = await session.execute(
                    select(InternalLink).where(
                        InternalLink.profile_id == profile.id,
                        InternalLink.url == entry.url,
                    )
                )
                link = existing.scalar_one_or_none()

                if link:
                    # Update existing
                    if entry.title:
                        link.title = entry.title
                    if slug:
                        link.slug = slug
                else:
                    # Create new
                    link = InternalLink(
                        profile_id=profile.id,
                        url=entry.url,
                        title=entry.title,
                        slug=slug,
                        source="sitemap",
                    )
                    session.add(link)

            profile.crawl_status = "complete"
            profile.last_crawled_at = datetime.now(UTC)
            if sitemap_urls_seen:
                profile.sitemap_urls = sitemap_urls_seen
            await session.commit()

            logger.info(f"Sitemap crawl complete for profile {profile.name}")

        except Exception:
            logger.exception(f"Sitemap crawl failed for profile {profile_id}")
            profile.crawl_status = "failed"
            await session.commit()


async def check_recrawl_schedules(ctx):
    """Check profiles due for re-crawl based on their recrawl_interval."""
    session_factory = ctx["session_factory"]
    redis = ctx["redis"]

    async with session_factory() as session:
        result = await session.execute(
            select(WebsiteProfile).where(
                WebsiteProfile.recrawl_interval.isnot(None),
                WebsiteProfile.crawl_status != "crawling",
            )
        )
        profiles = result.scalars().all()

        now = datetime.now(UTC)
        enqueued = 0
        for profile in profiles:
            if not profile.last_crawled_at:
                await redis.enqueue_job("crawl_profile_sitemap", str(profile.id))
                enqueued += 1
                continue

            delta = now - profile.last_crawled_at
            if profile.recrawl_interval == "weekly" and delta.days >= 7:
                await redis.enqueue_job("crawl_profile_sitemap", str(profile.id))
                enqueued += 1
            elif profile.recrawl_interval == "monthly" and delta.days >= 30:
                await redis.enqueue_job("crawl_profile_sitemap", str(profile.id))
                enqueued += 1

        logger.info(
            f"Re-crawl check: {enqueued} profiles enqueued out of {len(profiles)}"
        )


async def startup(ctx):
    """Worker startup: create DB engine, session factory, and Redis reference."""
    logger.info("Worker starting up")
    engine = create_async_engine(settings.database_url, echo=False)
    ctx["session_factory"] = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    # Store redis reference from ARQ context for DLQ operations
    ctx["redis"] = ctx["redis"]


async def shutdown(ctx):
    """Worker shutdown: dispose DB engine gracefully."""
    logger.info("Worker shutting down gracefully")
    if "session_factory" in ctx:
        engine = ctx["session_factory"].kw.get("bind")
        if engine:
            await engine.dispose()
    logger.info("Worker shutdown complete")


class WorkerSettings:
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    functions = [run_pipeline_stage, crawl_profile_sitemap]
    cron_jobs = [cron(check_recrawl_schedules, hour=0, minute=0)]
    on_startup = startup
    on_shutdown = shutdown
    max_jobs = settings.worker_max_jobs
    job_timeout = 3600  # 60 minutes — full 6-stage pipeline with extended thinking
    max_tries = MAX_ATTEMPTS
    retry_delay = 10  # seconds between retries
    handle_signals = True  # ARQ handles SIGTERM/SIGINT gracefully


# Allow running directly: python -m src.worker
if __name__ == "__main__":
    import asyncio

    from arq import run_worker

    # Configure logging
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    asyncio.run(run_worker(WorkerSettings))
