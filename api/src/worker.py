"""ARQ worker entry point for pipeline job processing."""

import json
import logging
import uuid
from datetime import UTC, datetime
from urllib.parse import urlparse

from arq.connections import RedisSettings
from arq.cron import cron
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from src.api.events import publish_event
from src.config import settings
from src.models.link import InternalLink
from src.models.post import Post
from src.models.profile import WebsiteProfile
from src.pipeline.graph import create_pipeline_graph
from src.pipeline.helpers import (
    clear_event_context,
    log_stage_execution,
    save_stage_output,
    set_event_context,
)
from src.pipeline.stages.edit import edit_node
from src.pipeline.stages.images import images_node
from src.pipeline.stages.outline import outline_node
from src.pipeline.stages.research import research_node
from src.pipeline.stages.write import write_node
from src.pipeline.state import STAGES, state_from_post
from src.services.sitemap import crawl_sitemap

STAGE_NODE_FN = {
    "research": research_node,
    "outline": outline_node,
    "write": write_node,
    "edit": edit_node,
    "images": images_node,
}

logger = logging.getLogger(__name__)

DLQ_KEY = "arq:dead_letter_queue"
MAX_ATTEMPTS = 3


async def run_pipeline_stage(ctx, post_id: str, stage: str | None = None):
    """Execute the pipeline for a post, running from the current stage forward.

    If `stage` is specified, runs only that stage. Otherwise, runs the full
    pipeline from the beginning (or resumes from where it left off via checkpointing).

    Retries up to MAX_ATTEMPTS times. On final failure, moves to dead letter queue.
    """
    job_try = ctx.get("job_try", 1)
    session_factory: async_sessionmaker = ctx["session_factory"]

    async with session_factory() as session:
        post = await session.get(Post, uuid.UUID(post_id))
        if not post:
            logger.error(f"Post {post_id} not found")
            return

        # Fetch internal links for the edit stage
        internal_links: list[dict] = []
        if post.profile_id:
            result = await session.execute(
                select(InternalLink).where(InternalLink.profile_id == post.profile_id)
            )
            links = result.scalars().all()
            internal_links = [
                {"url": link.url, "title": link.title, "slug": link.slug}
                for link in links
            ]

        # Build initial state from post
        initial_state = state_from_post(post, internal_links)

        # Generate or reuse thread_id for LangGraph checkpointing
        thread_id = post.thread_id or f"post-{post_id}"
        if not post.thread_id:
            post.thread_id = thread_id
            await session.commit()

        config = {"configurable": {"thread_id": thread_id}}

    redis = ctx["redis"]

    if stage:
        # Single-stage rerun: call the node function directly
        await _run_single_stage(
            ctx, post_id, stage, initial_state, redis,
            session_factory, job_try,
        )
    else:
        # Full pipeline run via LangGraph
        await _run_full_pipeline(
            ctx, post_id, initial_state, config, redis,
            session_factory, job_try,
        )


async def _run_single_stage(
    ctx,
    post_id: str,
    stage: str,
    initial_state: dict,
    redis,
    session_factory,
    job_try: int,
):
    """Run a single stage node directly (for reruns)."""
    node_fn = STAGE_NODE_FN.get(stage)
    if not node_fn:
        logger.error(f"No node function for stage '{stage}'")
        return

    content_key_map = {
        "research": "research",
        "outline": "outline",
        "write": "draft",
        "edit": "final_md",
        "images": "image_manifest",
    }

    try:
        await publish_event(redis, post_id, "stage_start", {
            "stage": stage,
            "message": f"Starting {stage}...",
        })
        set_event_context(redis, post_id)

        result = await node_fn(initial_state)

        clear_event_context()

        # Save output and log metrics
        async with session_factory() as session:
            meta = result.get("_stage_meta")
            if isinstance(meta, dict):
                await log_stage_execution(
                    session, post_id, stage,
                    meta["model"], meta["tokens_in"],
                    meta["tokens_out"], meta["duration_s"],
                )

            content = result.get(content_key_map.get(stage, ""))
            stage_status = result.get("stage_status")
            if content:
                await save_stage_output(
                    session, post_id, stage, content,
                    stage_status=stage_status,
                )

            # Restore current_stage for completed post
            post = await session.get(Post, uuid.UUID(post_id))
            if post:
                # If all stages are complete, mark post complete
                ss = post.stage_status or {}
                if all(ss.get(s) == "complete" for s in STAGES):
                    post.current_stage = "complete"
                await session.commit()

        await publish_event(redis, post_id, "stage_complete", {
            "stage": stage,
            "model": meta["model"] if meta else "",
            "duration_s": round(
                meta["duration_s"], 2
            ) if meta else 0,
        })

    except Exception as e:
        clear_event_context()
        logger.exception(
            f"Stage {stage} attempt {job_try}/{MAX_ATTEMPTS} "
            f"failed for post {post_id}"
        )
        await publish_event(redis, post_id, "stage_error", {
            "stage": stage,
            "error": str(e),
            "message": f"Stage {stage} failed: {e}",
        })
        if job_try >= MAX_ATTEMPTS:
            await _move_to_dlq(
                ctx, post_id, stage, str(e), job_try
            )
            return
        raise


async def _run_full_pipeline(
    ctx,
    post_id: str,
    initial_state: dict,
    config: dict,
    redis,
    session_factory,
    job_try: int,
):
    """Run the full LangGraph pipeline."""
    graph, checkpointer_cm = await create_pipeline_graph()
    try:
        await publish_event(redis, post_id, "stage_start", {
            "stage": STAGES[0],
            "message": f"Starting {STAGES[0]}...",
        })
        set_event_context(redis, post_id)

        result = await graph.ainvoke(initial_state, config)

        clear_event_context()

        # Save outputs and log metrics for each completed stage
        async with session_factory() as session:
            for stage_name in STAGES:
                meta = result.get("_stage_meta")
                if (
                    isinstance(meta, dict)
                    and meta.get("stage") == stage_name
                ):
                    await log_stage_execution(
                        session, post_id, stage_name,
                        meta["model"], meta["tokens_in"],
                        meta["tokens_out"], meta["duration_s"],
                    )
                    await publish_event(
                        redis, post_id, "stage_complete", {
                            "stage": stage_name,
                            "model": meta["model"],
                            "tokens_in": meta["tokens_in"],
                            "tokens_out": meta["tokens_out"],
                            "duration_s": round(
                                meta["duration_s"], 2
                            ),
                        },
                    )

                content_key_map = {
                    "research": "research",
                    "outline": "outline",
                    "write": "draft",
                    "edit": "final_md",
                    "images": "image_manifest",
                }
                content = result.get(
                    content_key_map.get(stage_name, "")
                )
                if content:
                    await save_stage_output(
                        session, post_id, stage_name, content,
                        stage_status=result.get("stage_status"),
                    )

            await _post_completion_hook(session, post_id, result)

        await publish_event(redis, post_id, "pipeline_complete", {
            "message": "Pipeline finished",
        })

    except Exception as e:
        clear_event_context()
        logger.exception(
            f"Pipeline attempt {job_try}/{MAX_ATTEMPTS} "
            f"failed for post {post_id}"
        )
        await publish_event(redis, post_id, "stage_error", {
            "stage": "",
            "error": str(e),
            "message": f"Pipeline failed: {e}",
        })
        if job_try >= MAX_ATTEMPTS:
            await _move_to_dlq(ctx, post_id, None, str(e), job_try)
            return
        async with session_factory() as session:
            post = await session.get(Post, uuid.UUID(post_id))
            if post:
                await session.commit()
        raise
    finally:
        await checkpointer_cm.__aexit__(None, None, None)


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
    job_timeout = 600  # 10 minutes per stage
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
