"""Queue management endpoints."""

import json

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.auth import get_current_user
from src.database import get_session
from src.models.auth import AuthUser
from src.models.post import Post
from src.models.profile import WebsiteProfile
from src.pipeline.state import STAGES
from src.worker import DLQ_KEY, WORKER_LAST_COMPLETED_KEY

router = APIRouter(prefix="/api/queue", tags=["queue"])


@router.get("")
async def queue_status(
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Current queue status: counts by stage status."""
    # Count posts by current_stage (scoped to user)
    result = await session.execute(
        select(Post.current_stage, func.count(Post.id))
        .join(WebsiteProfile, Post.profile_id == WebsiteProfile.id)
        .where(WebsiteProfile.user_id == user.id)
        .group_by(Post.current_stage)
    )
    counts = {row[0]: row[1] for row in result.all()}

    # Categorize
    running = sum(v for k, v in counts.items() if k in STAGES)

    return {
        "running": running,
        "pending": counts.get("pending", 0),
        "complete": counts.get("complete", 0),
        "failed": counts.get("failed", 0),
        "paused": counts.get("paused", 0),
        "total": sum(counts.values()),
    }


@router.get("/worker-status")
async def worker_status(
    request: Request,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Check worker health: alive, active/queued jobs, last completed time."""
    redis = request.app.state.redis

    # Check for ARQ worker heartbeat keys
    worker_keys = []
    async for key in redis.scan_iter("arq:worker:*"):
        if isinstance(key, bytes):
            key = key.decode()
        if key != WORKER_LAST_COMPLETED_KEY:
            worker_keys.append(key)

    # Count jobs in the ARQ queue
    queued_jobs = await redis.zcard("arq:queue")

    # Count active (in-progress) jobs via running posts in the DB
    result = await session.execute(
        select(func.count(Post.id)).where(Post.current_stage.in_(STAGES))
    )
    active_jobs = result.scalar_one()

    # Last completed timestamp
    last_completed_raw = await redis.get(WORKER_LAST_COMPLETED_KEY)
    last_completed = None
    if last_completed_raw:
        if isinstance(last_completed_raw, bytes):
            last_completed_raw = last_completed_raw.decode()
        last_completed = last_completed_raw

    return {
        "worker_alive": len(worker_keys) > 0,
        "active_jobs": active_jobs,
        "queued_jobs": queued_jobs,
        "last_completed": last_completed,
    }


@router.post("/pause-all", status_code=200)
async def pause_all(
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Pause all running and pending posts."""
    result = await session.execute(
        select(Post)
        .join(WebsiteProfile, Post.profile_id == WebsiteProfile.id)
        .where(WebsiteProfile.user_id == user.id)
        .where(Post.current_stage.in_(["pending", *STAGES]))
    )
    posts = result.scalars().all()
    count = 0
    for post in posts:
        post.current_stage = "paused"
        count += 1
    await session.commit()
    return {"status": "paused", "count": count}


@router.post("/resume-all", status_code=200)
async def resume_all(
    request: Request,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Resume all paused posts."""
    result = await session.execute(
        select(Post)
        .join(WebsiteProfile, Post.profile_id == WebsiteProfile.id)
        .where(WebsiteProfile.user_id == user.id)
        .where(Post.current_stage == "paused")
    )
    posts = result.scalars().all()
    count = 0
    redis = request.app.state.redis
    for post in posts:
        # Determine next stage to run
        stage_status = post.stage_status or {}
        next_stage = None
        for s in STAGES:
            if stage_status.get(s) not in ("complete",):
                next_stage = s
                break

        if next_stage:
            post.current_stage = next_stage
            await redis.enqueue_job("run_pipeline_stage", str(post.id), next_stage)
        else:
            post.current_stage = "complete"
        count += 1

    await session.commit()
    return {"status": "resumed", "count": count}


@router.get("/dead-letter")
async def dead_letter_queue(
    request: Request,
    user: AuthUser = Depends(get_current_user),
):
    """List all entries in the dead letter queue."""
    redis = request.app.state.redis
    raw_entries = await redis.lrange(DLQ_KEY, 0, -1)
    entries = []
    for raw in raw_entries:
        entry = json.loads(raw)
        entries.append(entry)
    return {"entries": entries, "count": len(entries)}


@router.post("/dead-letter/{post_id}/retry", status_code=202)
async def retry_dead_letter(
    post_id: str,
    request: Request,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Retry a failed job from the dead letter queue."""
    redis = request.app.state.redis
    post = await session.get(Post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    # Remove matching entries from DLQ
    raw_entries = await redis.lrange(DLQ_KEY, 0, -1)
    removed = False
    for raw in raw_entries:
        entry = json.loads(raw)
        if entry.get("post_id") == post_id:
            await redis.lrem(DLQ_KEY, 1, raw)
            removed = True

    if not removed:
        raise HTTPException(
            status_code=404, detail="Post not found in dead letter queue"
        )

    # Reset post status and re-enqueue
    post.current_stage = "pending"
    # Clear error from stage_logs
    logs = dict(post.stage_logs or {})
    logs.pop("_error", None)
    post.stage_logs = logs
    await session.commit()

    await redis.enqueue_job("run_pipeline_stage", str(post.id))

    return {"status": "retrying", "post_id": post_id}


@router.delete("/dead-letter", status_code=200)
async def clear_dead_letter(
    request: Request,
    user: AuthUser = Depends(get_current_user),
):
    """Clear all entries from the dead letter queue."""
    redis = request.app.state.redis
    count = await redis.llen(DLQ_KEY)
    await redis.delete(DLQ_KEY)
    return {"status": "cleared", "count": count}
