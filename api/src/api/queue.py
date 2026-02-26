"""Queue management endpoints."""

import json

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_session
from src.models.post import Post
from src.models.schemas import PostRead
from src.pipeline.state import STAGES
from src.worker import DLQ_KEY

router = APIRouter(prefix="/api/queue", tags=["queue"])


@router.get("")
async def queue_status(session: AsyncSession = Depends(get_session)):
    """Current queue status: counts by stage status."""
    # Count posts by current_stage
    result = await session.execute(
        select(Post.current_stage, func.count(Post.id)).group_by(Post.current_stage)
    )
    counts = {row[0]: row[1] for row in result.all()}

    # Categorize
    running = sum(v for k, v in counts.items() if k in STAGES)
    review = 0
    for stage in STAGES:
        # Count posts where any stage_status value is "review"
        review_count = await session.execute(
            select(func.count(Post.id)).where(
                Post.stage_status[stage].as_string() == "review"
            )
        )
        review += review_count.scalar_one()

    return {
        "running": running,
        "pending": counts.get("pending", 0),
        "review": review,
        "complete": counts.get("complete", 0),
        "failed": counts.get("failed", 0),
        "paused": counts.get("paused", 0),
        "total": sum(counts.values()),
    }


@router.get("/review", response_model=list[PostRead])
async def review_queue(session: AsyncSession = Depends(get_session)):
    """Posts with stages awaiting human review."""
    # Find posts where any stage has "review" status
    posts = []
    for stage in STAGES:
        result = await session.execute(
            select(Post)
            .where(Post.stage_status[stage].as_string() == "review")
            .order_by(Post.updated_at.asc())
        )
        for post in result.scalars().all():
            if post.id not in {p.id for p in posts}:
                posts.append(post)
    return posts


@router.post("/pause-all", status_code=200)
async def pause_all(session: AsyncSession = Depends(get_session)):
    """Pause all running and pending posts."""
    result = await session.execute(
        select(Post).where(Post.current_stage.in_(["pending", *STAGES]))
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
    session: AsyncSession = Depends(get_session),
):
    """Resume all paused posts."""
    result = await session.execute(select(Post).where(Post.current_stage == "paused"))
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
async def dead_letter_queue(request: Request):
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
async def clear_dead_letter(request: Request):
    """Clear all entries from the dead letter queue."""
    redis = request.app.state.redis
    count = await redis.llen(DLQ_KEY)
    await redis.delete(DLQ_KEY)
    return {"status": "cleared", "count": count}
