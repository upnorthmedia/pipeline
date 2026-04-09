"""Post CRUD, duplication, batch creation, and pipeline control endpoints."""

import io
import uuid
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.auth import get_current_user
from src.database import get_session
from src.models.auth import AuthUser
from src.models.post import Post
from src.models.profile import WebsiteProfile
from src.models.schemas import PostCreate, PostRead, PostUpdate
from src.pipeline.helpers import strip_leading_h1
from src.pipeline.state import STAGES

router = APIRouter(prefix="/api/posts", tags=["posts"])


async def _get_user_post(
    post_id: uuid.UUID, user: AuthUser, session: AsyncSession
) -> Post:
    result = await session.execute(
        select(Post)
        .join(WebsiteProfile, Post.profile_id == WebsiteProfile.id)
        .where(Post.id == post_id, WebsiteProfile.user_id == user.id)
    )
    post = result.scalar_one_or_none()
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")
    return post

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

# WordPress defaults copied from profile to post
_WP_PREFILL = {
    "wp_default_category_id": "wp_category_id",
    "wp_default_author_id": "wp_author_id",
}


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
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    query = select(Post).join(
        WebsiteProfile, Post.profile_id == WebsiteProfile.id
    ).where(WebsiteProfile.user_id == user.id)

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
    request: Request,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    post_data = data.model_dump()

    # Profile-driven prefill
    if data.profile_id:
        result = await session.execute(
            select(WebsiteProfile).where(
                WebsiteProfile.id == data.profile_id,
                WebsiteProfile.user_id == user.id,
            )
        )
        profile = result.scalar_one_or_none()
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

        # Copy WP defaults from profile
        for profile_field, post_field in _WP_PREFILL.items():
            if post_data.get(post_field) is None:
                val = getattr(profile, profile_field, None)
                if val is not None:
                    post_data[post_field] = val

    post = Post(**post_data)
    post.current_stage = STAGES[0]
    post.stage_status = {STAGES[0]: "running"}
    session.add(post)
    await session.commit()
    await session.refresh(post)

    # Auto-enqueue pipeline — the runner handles gate checks (pausing at review stages)
    redis = request.app.state.redis
    await redis.enqueue_job("run_pipeline_stage", str(post.id))

    return post


@router.get("/{post_id}", response_model=PostRead)
async def get_post(
    post_id: uuid.UUID,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await _get_user_post(post_id, user, session)


@router.patch("/{post_id}", response_model=PostRead)
async def update_post(
    post_id: uuid.UUID,
    data: PostUpdate,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    post = await _get_user_post(post_id, user, session)

    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(post, field, value)

    await session.commit()
    await session.refresh(post)
    return post


@router.delete("/{post_id}", status_code=204)
async def delete_post(
    post_id: uuid.UUID,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    post = await _get_user_post(post_id, user, session)

    await session.delete(post)
    await session.commit()

    # Clean up media directory
    import shutil

    from src.config import settings

    media_dir = Path(settings.media_dir) / str(post_id)
    if media_dir.exists():
        shutil.rmtree(media_dir)


# --- Duplication ---


@router.post("/{post_id}/duplicate", response_model=PostRead, status_code=201)
async def duplicate_post(
    post_id: uuid.UUID,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    original = await _get_user_post(post_id, user, session)

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
    request: Request,
    user: AuthUser = Depends(get_current_user),
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

                # Copy WP defaults from profile
                for profile_field, post_field in _WP_PREFILL.items():
                    if post_data.get(post_field) is None:
                        val = getattr(profile, profile_field, None)
                        if val is not None:
                            post_data[post_field] = val

        post = Post(**post_data)
        session.add(post)
        created.append(post)

    await session.commit()
    for post in created:
        await session.refresh(post)

    # Auto-enqueue pipeline for each post
    redis = request.app.state.redis
    for post in created:
        await redis.enqueue_job("run_pipeline_stage", str(post.id))

    return created


# --- Pipeline Control ---


@router.post("/{post_id}/run", status_code=202)
async def run_post(
    post_id: uuid.UUID,
    request: Request,
    stage: str | None = None,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Trigger the next pipeline stage (or a specific stage)."""
    post = await _get_user_post(post_id, user, session)

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
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Run pipeline to completion (set all remaining stages to auto)."""
    post = await _get_user_post(post_id, user, session)

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


@router.post("/{post_id}/rerun", status_code=202)
async def rerun_stage(
    post_id: uuid.UUID,
    request: Request,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Re-run the current/stuck stage and continue through remaining stages.

    Detects the first non-complete stage (or stuck "running" stage),
    resets it and all downstream stages, clears their content, then
    enqueues a full pipeline run.
    """
    post = await _get_user_post(post_id, user, session)

    ss = dict(post.stage_status or {})

    # Find the first non-complete stage (the one to rerun from)
    rerun_from = None
    for s in STAGES:
        if ss.get(s) != "complete":
            rerun_from = s
            break

    if rerun_from is None:
        # All stages complete — rerun the last stage
        rerun_from = STAGES[-1]

    # Reset this stage and all downstream stages
    rerun_idx = STAGES.index(rerun_from)
    content_map = {
        "research": "research_content",
        "outline": "outline_content",
        "write": "draft_content",
        "edit": "final_md_content",
        "images": "image_manifest",
        "ready": "ready_content",
    }
    for s in STAGES[rerun_idx:]:
        ss[s] = "pending"
        # Clear downstream content so stale data doesn't show
        col = content_map.get(s)
        if col:
            setattr(post, col, None)

    post.stage_status = ss
    post.current_stage = "pending"
    post.completed_at = None
    await session.commit()

    redis = request.app.state.redis
    await redis.enqueue_job("run_pipeline_stage", str(post_id))

    return {
        "status": "queued",
        "mode": "rerun",
        "rerun_from": rerun_from,
        "post_id": str(post_id),
    }


@router.post("/{post_id}/restart", status_code=202)
async def restart_pipeline(
    post_id: uuid.UUID,
    request: Request,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Force restart: clear all content and stages, begin fresh from research."""
    post = await _get_user_post(post_id, user, session)

    # Reset all stage statuses
    post.stage_status = {s: "pending" for s in STAGES}
    post.current_stage = "pending"
    post.completed_at = None

    # Clear all stage content
    post.research_content = None
    post.outline_content = None
    post.draft_content = None
    post.final_md_content = None
    post.final_html_content = None
    post.image_manifest = None
    post.ready_content = None

    # Clear stage logs and error info
    post.stage_logs = {}

    await session.commit()

    redis = request.app.state.redis
    await redis.enqueue_job("run_pipeline_stage", str(post_id))

    return {"status": "queued", "mode": "restart", "post_id": str(post_id)}


@router.post("/{post_id}/pause", status_code=200)
async def pause_post(
    post_id: uuid.UUID,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Pause pipeline execution."""
    post = await _get_user_post(post_id, user, session)

    post.current_stage = "paused"
    await session.commit()

    return {"status": "paused", "post_id": str(post_id)}


@router.post("/{post_id}/publish", status_code=202)
async def publish_post(
    post_id: uuid.UUID,
    request: Request,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Manually trigger publishing (WordPress or Next.js)."""
    post = await _get_user_post(post_id, user, session)

    if not post.ready_content and not post.final_md_content:
        raise HTTPException(status_code=400, detail="No content to publish")

    redis = request.app.state.redis

    if post.output_format == "wordpress":
        post.wp_publish_status = "pending"
        await session.commit()
        await redis.enqueue_job("publish_to_wordpress", str(post_id))
        return {"status": "queued", "post_id": str(post_id)}

    if post.output_format == "nextjs":
        post.nextjs_publish_status = "pending"
        await session.commit()
        await redis.enqueue_job("publish_to_nextjs", str(post_id))
        return {"status": "queued", "post_id": str(post_id)}

    raise HTTPException(
        status_code=400,
        detail=f"Publishing not supported for output_format '{post.output_format}'",
    )


# --- Export ---


@router.get("/{post_id}/export/markdown")
async def export_markdown(
    post_id: uuid.UUID,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    post = await _get_user_post(post_id, user, session)

    content = post.ready_content or post.final_md_content
    if not content:
        raise HTTPException(status_code=404, detail="No markdown content available")

    export_content = strip_leading_h1(content)
    export_content = export_content.replace(f"/media/{post_id}/", "/")

    return Response(
        content=export_content,
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{post.slug}.mdx"'},
    )


@router.get("/{post_id}/export/html")
async def export_html(
    post_id: uuid.UUID,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    post = await _get_user_post(post_id, user, session)
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
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    post = await _get_user_post(post_id, user, session)

    content = post.ready_content or post.final_md_content
    if not content:
        raise HTTPException(status_code=404, detail="No content available to export")

    from src.config import settings

    media_dir = Path(settings.media_dir) / str(post_id)
    image_files: list[Path] = []
    if media_dir.is_dir():
        image_files = [f for f in media_dir.iterdir() if f.is_file()]

    # Strip leading H1 and rewrite image URLs
    export_content = strip_leading_h1(content)
    export_content = export_content.replace(f"/media/{post_id}/", "/")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{post.slug}.mdx", export_content)

        for img_file in image_files:
            zf.write(img_file, img_file.name)

    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{post.slug}.zip"'},
    )


# --- Execution Logs ---


@router.get("/{post_id}/logs")
async def get_execution_logs(
    post_id: uuid.UUID,
    level: list[str] | None = Query(None, description="Filter by level(s)"),
    stage: str | None = Query(None, description="Filter by stage name"),
    since: str | None = Query(None, description="ISO timestamp filter"),
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Return execution logs for a post, with optional filtering."""
    post = await _get_user_post(post_id, user, session)

    logs = list(post.execution_logs or [])

    if level:
        logs = [entry for entry in logs if entry.get("level") in level]
    if stage:
        logs = [entry for entry in logs if entry.get("stage") == stage]
    if since:
        logs = [entry for entry in logs if entry.get("ts", "") > since]

    return logs


# --- Analytics ---


@router.get("/{post_id}/analytics")
async def post_analytics(
    post_id: uuid.UUID,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Compute analytics for a post's final content."""
    post = await _get_user_post(post_id, user, session)

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
        website_url=post.website_url or "",
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
