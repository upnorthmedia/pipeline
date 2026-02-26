"""Post CRUD, duplication, batch creation, and pipeline control endpoints."""

import io
import json
import uuid
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_session
from src.models.post import Post
from src.models.profile import WebsiteProfile
from src.models.schemas import PostCreate, PostRead, PostUpdate
from src.pipeline.state import STAGES

router = APIRouter(prefix="/api/posts", tags=["posts"])

# Fields copied from profile to post on creation
_PROFILE_PREFILL_FIELDS = [
    "niche",
    "target_audience",
    "tone",
    "brand_voice",
    "word_count",
    "output_format",
    "website_url",
    "image_style",
    "image_brand_colors",
    "image_exclude",
    "avoid",
    "required_mentions",
    "related_keywords",
]


# --- CRUD ---


@router.get("", response_model=list[PostRead])
async def list_posts(
    status: str | None = Query(None, description="Filter by current_stage"),
    stage: str | None = Query(None, description="Filter by current_stage value"),
    profile_id: uuid.UUID | None = Query(None, description="Filter by profile"),
    q: str | None = Query(None, description="Search topic and slug"),
    sort: str = Query("created_at", description="Sort field"),
    order: str = Query("desc", description="Sort order: asc or desc"),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    session: AsyncSession = Depends(get_session),
):
    query = select(Post)

    # Filters
    stage_filter = status or stage
    if stage_filter:
        query = query.where(Post.current_stage == stage_filter)
    if profile_id:
        query = query.where(Post.profile_id == profile_id)
    if q:
        pattern = f"%{q}%"
        query = query.where(or_(Post.topic.ilike(pattern), Post.slug.ilike(pattern)))

    # Sort
    sort_col = getattr(Post, sort, Post.created_at)
    query = query.order_by(sort_col.desc() if order == "desc" else sort_col.asc())

    # Pagination
    query = query.offset((page - 1) * per_page).limit(per_page)
    result = await session.execute(query)
    return result.scalars().all()


@router.post("", response_model=PostRead, status_code=201)
async def create_post(
    data: PostCreate,
    session: AsyncSession = Depends(get_session),
):
    post_data = data.model_dump()

    # Profile-driven prefill
    if data.profile_id:
        profile = await session.get(WebsiteProfile, data.profile_id)
        if not profile:
            raise HTTPException(status_code=404, detail="Profile not found")

        for field in _PROFILE_PREFILL_FIELDS:
            # Only prefill if not explicitly set by the user (still default)
            field_info = PostCreate.model_fields.get(field)
            schema_default = getattr(field_info, "default", None)
            if post_data.get(field) == schema_default or post_data.get(field) is None:
                profile_val = getattr(profile, field, None)
                if profile_val is not None:
                    post_data[field] = profile_val

        # Copy stage settings from profile defaults
        if data.stage_settings == PostCreate.model_fields["stage_settings"].default:
            post_data["stage_settings"] = profile.default_stage_settings

    post = Post(**post_data)
    session.add(post)
    await session.commit()
    await session.refresh(post)
    return post


@router.get("/{post_id}", response_model=PostRead)
async def get_post(
    post_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
):
    post = await session.get(Post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")
    return post


@router.patch("/{post_id}", response_model=PostRead)
async def update_post(
    post_id: uuid.UUID,
    data: PostUpdate,
    session: AsyncSession = Depends(get_session),
):
    post = await session.get(Post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(post, field, value)

    await session.commit()
    await session.refresh(post)
    return post


@router.delete("/{post_id}", status_code=204)
async def delete_post(
    post_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
):
    post = await session.get(Post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    await session.delete(post)
    await session.commit()


# --- Duplication ---


@router.post("/{post_id}/duplicate", response_model=PostRead, status_code=201)
async def duplicate_post(
    post_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
):
    original = await session.get(Post, post_id)
    if not original:
        raise HTTPException(status_code=404, detail="Post not found")

    new_slug = f"{original.slug}-copy-{uuid.uuid4().hex[:6]}"
    config_fields = [
        "profile_id",
        "topic",
        "target_audience",
        "niche",
        "intent",
        "word_count",
        "tone",
        "output_format",
        "website_url",
        "related_keywords",
        "competitor_urls",
        "image_style",
        "image_brand_colors",
        "image_exclude",
        "brand_voice",
        "avoid",
        "required_mentions",
        "stage_settings",
    ]
    new_data = {"slug": new_slug}
    for field in config_fields:
        new_data[field] = getattr(original, field)

    new_post = Post(**new_data)
    session.add(new_post)
    await session.commit()
    await session.refresh(new_post)
    return new_post


# --- Batch Creation ---


@router.post("/batch", response_model=list[PostRead], status_code=201)
async def batch_create_posts(
    posts: list[PostCreate],
    session: AsyncSession = Depends(get_session),
):
    created = []
    for data in posts:
        post_data = data.model_dump()

        if data.profile_id:
            profile = await session.get(WebsiteProfile, data.profile_id)
            if profile:
                for field in _PROFILE_PREFILL_FIELDS:
                    schema_default = getattr(
                        PostCreate.model_fields.get(field), "default", None
                    )
                    if (
                        post_data.get(field) == schema_default
                        or post_data.get(field) is None
                    ):
                        profile_val = getattr(profile, field, None)
                        if profile_val is not None:
                            post_data[field] = profile_val
                ss_default = PostCreate.model_fields["stage_settings"].default
                if data.stage_settings == ss_default:
                    post_data["stage_settings"] = profile.default_stage_settings

        post = Post(**post_data)
        session.add(post)
        created.append(post)

    await session.commit()
    for post in created:
        await session.refresh(post)
    return created


# --- Pipeline Control ---


@router.post("/{post_id}/run", status_code=202)
async def run_post(
    post_id: uuid.UUID,
    request: Request,
    stage: str | None = None,
    session: AsyncSession = Depends(get_session),
):
    """Trigger the next pipeline stage (or a specific stage)."""
    post = await session.get(Post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    if stage and stage not in STAGES:
        raise HTTPException(status_code=400, detail=f"Invalid stage: {stage}")

    # Update status to running
    target_stage = stage or _next_stage(post)
    if not target_stage:
        raise HTTPException(status_code=400, detail="Pipeline already complete")

    post.current_stage = target_stage
    status = dict(post.stage_status or {})
    status[target_stage] = "running"
    post.stage_status = status
    await session.commit()

    # Enqueue job
    redis = request.app.state.redis
    await redis.enqueue_job("run_pipeline_stage", str(post_id), stage)

    return {"status": "queued", "stage": target_stage, "post_id": str(post_id)}


@router.post("/{post_id}/run-all", status_code=202)
async def run_all(
    post_id: uuid.UUID,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Run pipeline to completion (set all remaining stages to auto)."""
    post = await session.get(Post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    # Override remaining stages to auto mode
    stage_settings = dict(post.stage_settings or {})
    for s in STAGES:
        current_status = (post.stage_status or {}).get(s)
        if current_status not in ("complete",):
            stage_settings[s] = "auto"
    post.stage_settings = stage_settings
    await session.commit()

    redis = request.app.state.redis
    await redis.enqueue_job("run_pipeline_stage", str(post_id))

    return {"status": "queued", "mode": "run-all", "post_id": str(post_id)}


@router.post("/{post_id}/rerun/{stage}", status_code=202)
async def rerun_stage(
    post_id: uuid.UUID,
    stage: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Re-run a specific pipeline stage."""
    post = await session.get(Post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    if stage not in STAGES:
        raise HTTPException(status_code=400, detail=f"Invalid stage: {stage}")

    # Reset stage status
    status = dict(post.stage_status or {})
    status[stage] = "running"
    post.stage_status = status
    post.current_stage = stage
    await session.commit()

    redis = request.app.state.redis
    await redis.enqueue_job("run_pipeline_stage", str(post_id), stage)

    return {"status": "queued", "stage": stage, "post_id": str(post_id)}


@router.post("/{post_id}/approve", status_code=200)
async def approve_stage(
    post_id: uuid.UUID,
    request: Request,
    content: str | None = None,
    session: AsyncSession = Depends(get_session),
):
    """Approve the current review gate, optionally with edited content."""
    post = await session.get(Post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    current = post.current_stage
    if not current or current in ("pending", "complete", "failed"):
        raise HTTPException(status_code=400, detail="No stage awaiting review")

    # Check if stage is in review status
    stage_status = post.stage_status or {}
    if stage_status.get(current) != "review":
        raise HTTPException(
            status_code=400, detail=f"Stage '{current}' is not in review"
        )

    # If content provided, update the stage content
    if content is not None:
        from src.pipeline.helpers import save_stage_output

        await save_stage_output(session, str(post_id), current, content)

    # Mark as complete and set next stage
    status = dict(stage_status)
    status[current] = "complete"
    post.stage_status = status

    next_stage = _next_stage(post)
    if next_stage:
        post.current_stage = next_stage
        # Auto-enqueue next stage
        redis = request.app.state.redis
        await redis.enqueue_job("run_pipeline_stage", str(post_id), next_stage)
    else:
        post.current_stage = "complete"

    await session.commit()
    await session.refresh(post)

    return PostRead.model_validate(post)


@router.post("/{post_id}/pause", status_code=200)
async def pause_post(
    post_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
):
    """Pause pipeline execution."""
    post = await session.get(Post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    post.current_stage = "paused"
    await session.commit()

    return {"status": "paused", "post_id": str(post_id)}


# --- Export ---


@router.get("/{post_id}/export/markdown")
async def export_markdown(
    post_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
):
    post = await session.get(Post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")
    if not post.final_md_content:
        raise HTTPException(status_code=404, detail="No markdown content available")

    return Response(
        content=post.final_md_content,
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{post.slug}.md"'},
    )


@router.get("/{post_id}/export/html")
async def export_html(
    post_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
):
    post = await session.get(Post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")
    if not post.final_html_content:
        raise HTTPException(status_code=404, detail="No HTML content available")

    return Response(
        content=post.final_html_content,
        media_type="text/html",
        headers={"Content-Disposition": f'attachment; filename="{post.slug}.html"'},
    )


@router.get("/{post_id}/export/all")
async def export_all(
    post_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
):
    post = await session.get(Post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # Post config as input
        config = {
            "topic": post.topic,
            "slug": post.slug,
            "niche": post.niche,
            "target_audience": post.target_audience,
            "intent": post.intent,
            "word_count": post.word_count,
            "tone": post.tone,
            "output_format": post.output_format,
            "website_url": post.website_url,
            "related_keywords": post.related_keywords,
            "competitor_urls": post.competitor_urls,
        }
        zf.writestr("00-input.json", json.dumps(config, indent=2))

        if post.research_content:
            zf.writestr("01-research.md", post.research_content)
        if post.outline_content:
            zf.writestr("02-outline.md", post.outline_content)
        if post.draft_content:
            zf.writestr("03-draft.md", post.draft_content)
        if post.final_md_content:
            zf.writestr("final.md", post.final_md_content)
        if post.final_html_content:
            zf.writestr("final.html", post.final_html_content)
        if post.image_manifest:
            zf.writestr(
                "04-image-manifest.json",
                json.dumps(post.image_manifest, indent=2),
            )
            # Include generated image files
            from src.config import settings

            media_dir = Path(settings.media_dir) / str(post_id)
            if media_dir.is_dir():
                for img_file in media_dir.iterdir():
                    if img_file.is_file():
                        zf.write(
                            img_file,
                            f"images/{img_file.name}",
                        )

    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{post.slug}-export.zip"'
        },
    )


# --- Analytics ---


@router.get("/{post_id}/analytics")
async def post_analytics(
    post_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
):
    """Compute analytics for a post's final content."""
    post = await session.get(Post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    from src.services.analytics import compute_analytics

    content = post.final_md_content or post.draft_content or ""
    primary_kw = ""
    secondary_kws = []

    # Extract primary keyword from related_keywords if available
    keywords = post.related_keywords or []
    if keywords:
        primary_kw = keywords[0] if isinstance(keywords[0], str) else ""
        secondary_kws = [k for k in keywords[1:] if isinstance(k, str)]

    analytics = compute_analytics(
        content=content,
        primary_keyword=primary_kw,
        secondary_keywords=secondary_kws,
        title=post.topic or "",
    )

    return {
        "word_count": analytics.word_count,
        "sentence_count": analytics.sentence_count,
        "paragraph_count": analytics.paragraph_count,
        "avg_sentence_length": analytics.avg_sentence_length,
        "flesch_reading_ease": analytics.flesch_reading_ease,
        "keyword_density": analytics.keyword_density,
        "seo_checklist": analytics.seo_checklist,
    }


# --- Helpers ---


def _next_stage(post: Post) -> str | None:
    """Determine the next stage to run based on current status."""
    stage_status = post.stage_status or {}
    for s in STAGES:
        if stage_status.get(s) not in ("complete",):
            return s
    return None
