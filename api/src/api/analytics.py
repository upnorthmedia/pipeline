"""Analytics endpoints for observability dashboard."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import Date, cast, func, literal_column, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.auth import get_current_user
from src.database import get_session
from src.models.auth import AuthUser
from src.models.post import Post
from src.models.profile import WebsiteProfile
from src.pipeline.helpers import MODEL_COSTS
from src.pipeline.state import STAGES

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


@router.get("/dashboard")
async def dashboard_stats(
    days: int = Query(30, ge=1, le=365),
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Overview stats for the observability dashboard."""
    since = datetime.now(UTC) - timedelta(days=days)

    # Posts by status (scoped to user)
    user_posts = (
        select(Post)
        .join(WebsiteProfile, Post.profile_id == WebsiteProfile.id)
        .where(WebsiteProfile.user_id == user.id)
    ).subquery()

    result = await session.execute(
        select(user_posts.c.current_stage, func.count(user_posts.c.id)).group_by(
            user_posts.c.current_stage
        )
    )
    by_status = {row[0]: row[1] for row in result.all()}

    # Total and complete counts
    total = sum(by_status.values())
    complete = by_status.get("complete", 0)
    completion_rate = round(complete / total * 100, 1) if total > 0 else 0

    # Average pipeline duration (completed posts only)
    result = await session.execute(
        select(
            func.avg(
                func.extract("epoch", Post.completed_at)
                - func.extract("epoch", Post.created_at)
            )
        )
        .join(WebsiteProfile, Post.profile_id == WebsiteProfile.id)
        .where(WebsiteProfile.user_id == user.id)
        .where(Post.completed_at.isnot(None))
    )
    avg_duration_s = result.scalar_one_or_none()
    avg_duration_s = round(avg_duration_s, 0) if avg_duration_s else None

    # Posts by profile (top 10)
    result = await session.execute(
        select(
            WebsiteProfile.name,
            func.count(Post.id).label("count"),
        )
        .join(WebsiteProfile, Post.profile_id == WebsiteProfile.id)
        .where(WebsiteProfile.user_id == user.id)
        .group_by(WebsiteProfile.name)
        .order_by(func.count(Post.id).desc())
        .limit(10)
    )
    by_profile = [{"name": row[0], "count": row[1]} for row in result.all()]

    # Posts over time (last N days)
    result = await session.execute(
        select(
            cast(Post.created_at, Date).label("date"),
            func.count(Post.id).label("count"),
        )
        .join(WebsiteProfile, Post.profile_id == WebsiteProfile.id)
        .where(WebsiteProfile.user_id == user.id)
        .where(Post.created_at >= since)
        .group_by(literal_column("date"))
        .order_by(literal_column("date"))
    )
    over_time = [{"date": str(row[0]), "count": row[1]} for row in result.all()]

    # Posts created today
    today_start = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    result = await session.execute(
        select(func.count(Post.id))
        .join(WebsiteProfile, Post.profile_id == WebsiteProfile.id)
        .where(WebsiteProfile.user_id == user.id)
        .where(Post.created_at >= today_start)
    )
    posts_today = result.scalar_one()

    return {
        "by_status": by_status,
        "total": total,
        "complete": complete,
        "completion_rate": completion_rate,
        "avg_duration_s": avg_duration_s,
        "by_profile": by_profile,
        "over_time": over_time,
        "posts_today": posts_today,
    }


@router.get("/costs")
async def cost_analytics(
    days: int = Query(30, ge=1, le=365),
    profile_id: str | None = Query(None),
    model: str | None = Query(None),
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Token & cost breakdown from stage_logs JSONB."""
    since = datetime.now(UTC) - timedelta(days=days)

    # Use raw SQL for JSONB extraction
    sql_str = """
        SELECT
            sl.key AS stage_name,
            (sl.value->>'model') AS model,
            COALESCE((sl.value->>'tokens_in')::float, 0),
            COALESCE((sl.value->>'tokens_out')::float, 0),
            COALESCE((sl.value->>'cost_usd')::float, 0),
            COALESCE((sl.value->>'duration_s')::float, 0),
            p.id AS post_id,
            p.profile_id,
            p.completed_at
        FROM posts p,
             jsonb_each(p.stage_logs) AS sl(key, value)
        JOIN website_profiles wp ON p.profile_id = wp.id
        WHERE wp.user_id = :user_id
          AND p.created_at >= :since
          AND p.stage_logs != '{}'::jsonb
          AND sl.key NOT LIKE '\\_%'
    """
    params: dict = {"since": since, "user_id": user.id}
    if profile_id:
        sql_str += " AND p.profile_id = :profile_id"
        params["profile_id"] = profile_id
    if model:
        sql_str += " AND sl.value->>'model' = :model"
        params["model"] = model

    result = await session.execute(text(sql_str), params)
    rows = result.all()

    # Aggregations
    total_tokens_in = 0
    total_tokens_out = 0
    total_cost = 0.0
    by_model: dict[str, dict] = {}
    by_stage: dict[str, dict] = {}
    post_costs: dict[str, float] = {}
    cost_by_date: dict[str, float] = {}
    by_profile_map: dict[str, float] = {}

    for row in rows:
        (
            stage_name,
            model,
            tokens_in,
            tokens_out,
            cost_usd,
            _duration_s,
            post_id,
            pid,
            completed_at,
        ) = row

        total_tokens_in += tokens_in
        total_tokens_out += tokens_out
        total_cost += cost_usd

        # By model
        if model:
            if model not in by_model:
                by_model[model] = {
                    "tokens_in": 0,
                    "tokens_out": 0,
                    "cost_usd": 0,
                    "calls": 0,
                }
            by_model[model]["tokens_in"] += tokens_in
            by_model[model]["tokens_out"] += tokens_out
            by_model[model]["cost_usd"] += cost_usd
            by_model[model]["calls"] += 1

        # By stage
        if stage_name not in by_stage:
            by_stage[stage_name] = {
                "tokens_in": 0,
                "tokens_out": 0,
                "cost_usd": 0,
                "calls": 0,
            }
        by_stage[stage_name]["tokens_in"] += tokens_in
        by_stage[stage_name]["tokens_out"] += tokens_out
        by_stage[stage_name]["cost_usd"] += cost_usd
        by_stage[stage_name]["calls"] += 1

        # Per-post cost
        post_key = str(post_id)
        post_costs[post_key] = post_costs.get(post_key, 0) + cost_usd

        # Cost over time
        if completed_at:
            date_key = str(completed_at.date())
            cost_by_date[date_key] = cost_by_date.get(date_key, 0) + cost_usd

        # By profile
        if pid:
            pid_str = str(pid)
            by_profile_map[pid_str] = by_profile_map.get(pid_str, 0) + cost_usd

    num_posts = len(post_costs) if post_costs else 0
    avg_cost_per_post = round(total_cost / num_posts, 4) if num_posts > 0 else 0

    # Round model/stage costs
    for m in by_model.values():
        m["cost_usd"] = round(m["cost_usd"], 6)
    for s in by_stage.values():
        s["cost_usd"] = round(s["cost_usd"], 6)

    # Resolve profile names for by_profile
    by_profile: list[dict] = []
    if by_profile_map:
        result = await session.execute(
            select(WebsiteProfile.id, WebsiteProfile.name).where(
                WebsiteProfile.id.in_(list(by_profile_map.keys()))
            )
        )
        name_map = {str(row[0]): row[1] for row in result.all()}
        by_profile = [
            {
                "name": name_map.get(pid, "Unknown"),
                "cost_usd": round(cost, 6),
            }
            for pid, cost in sorted(
                by_profile_map.items(),
                key=lambda x: x[1],
                reverse=True,
            )
        ]

    cost_over_time = [
        {"date": d, "cost_usd": round(c, 6)} for d, c in sorted(cost_by_date.items())
    ]

    return {
        "total_tokens_in": int(total_tokens_in),
        "total_tokens_out": int(total_tokens_out),
        "total_cost": round(total_cost, 6),
        "avg_cost_per_post": avg_cost_per_post,
        "by_model": by_model,
        "by_stage": by_stage,
        "by_profile": by_profile,
        "cost_over_time": cost_over_time,
        "model_costs_reference": MODEL_COSTS,
    }


@router.get("/models")
async def model_analytics(
    model: str | None = Query(None),
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Model usage stats and stage performance."""
    # Per-model stats from stage_logs
    model_where = ""
    model_params: dict = {"user_id": user.id}
    if model:
        model_where = " AND sl.value->>'model' = :model"
        model_params["model"] = model

    result = await session.execute(
        text(f"""
        SELECT
            (sl.value->>'model') AS model,
            COUNT(*) AS call_count,
            AVG(COALESCE((sl.value->>'tokens_in')::float, 0)),
            AVG(COALESCE((sl.value->>'tokens_out')::float, 0)),
            AVG(COALESCE((sl.value->>'duration_s')::float, 0)),
            SUM(COALESCE((sl.value->>'cost_usd')::float, 0))
        FROM posts p
             JOIN website_profiles wp ON p.profile_id = wp.id,
             jsonb_each(p.stage_logs) AS sl(key, value)
        WHERE wp.user_id = :user_id
          AND p.stage_logs != '{{}}'::jsonb
          AND sl.key NOT LIKE '\\_%'
          AND sl.value->>'model' IS NOT NULL
          {model_where}
        GROUP BY model
        ORDER BY call_count DESC
    """),
        model_params,
    )
    models = []
    for row in result.all():
        models.append(
            {
                "model": row[0],
                "call_count": row[1],
                "avg_tokens_in": round(row[2], 0),
                "avg_tokens_out": round(row[3], 0),
                "avg_duration_s": round(row[4], 1),
                "total_cost": round(row[5], 6),
            }
        )

    # Stage performance
    result = await session.execute(
        text(f"""
        SELECT
            sl.key AS stage,
            COUNT(*) AS runs,
            AVG(COALESCE((sl.value->>'duration_s')::float, 0)),
            SUM(COALESCE((sl.value->>'cost_usd')::float, 0))
        FROM posts p
             JOIN website_profiles wp ON p.profile_id = wp.id,
             jsonb_each(p.stage_logs) AS sl(key, value)
        WHERE wp.user_id = :user_id
          AND p.stage_logs != '{{}}'::jsonb
          AND sl.key NOT LIKE '\\_%'
          {model_where}
        GROUP BY sl.key
        ORDER BY sl.key
    """),
        model_params,
    )
    stages = []
    for row in result.all():
        stages.append(
            {
                "stage": row[0],
                "runs": row[1],
                "avg_duration_s": round(row[2], 1),
                "total_cost": round(row[3], 6),
            }
        )

    # Stage success rates from stage_status JSONB
    result = await session.execute(
        text("""
        SELECT
            ss.key AS stage,
            ss.value::text AS status,
            COUNT(*) AS count
        FROM posts p
             JOIN website_profiles wp ON p.profile_id = wp.id,
             jsonb_each(p.stage_status) AS ss(key, value)
        WHERE wp.user_id = :user_id
          AND p.stage_status != '{}'::jsonb
        GROUP BY ss.key, ss.value
        ORDER BY ss.key
    """),
        {"user_id": user.id},
    )
    status_counts: dict[str, dict[str, int]] = {}
    for row in result.all():
        stage_name = row[0]
        # JSONB value comes with quotes, strip them
        status = row[1].strip('"')
        count = row[2]
        if stage_name not in status_counts:
            status_counts[stage_name] = {}
        status_counts[stage_name][status] = count

    stage_success: list[dict] = []
    for stage_name in STAGES:
        counts = status_counts.get(stage_name, {})
        total_runs = sum(counts.values())
        completed = counts.get("complete", 0)
        failed = counts.get("failed", 0)
        success_rate = round(completed / total_runs * 100, 1) if total_runs > 0 else 0
        stage_success.append(
            {
                "stage": stage_name,
                "total": total_runs,
                "complete": completed,
                "failed": failed,
                "success_rate": success_rate,
            }
        )

    return {
        "models": models,
        "stage_performance": stages,
        "stage_success_rates": stage_success,
    }


@router.get("/logs")
async def search_logs(
    level: str | None = Query(None),
    stage: str | None = Query(None),
    profile_id: str | None = Query(None),
    q: str | None = Query(None),
    since: str | None = Query(None),
    until: str | None = Query(None),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Cross-post log explorer with filtering."""
    # Default to last 90 days
    if not since:
        since_dt = datetime.now(UTC) - timedelta(days=90)
    else:
        since_dt = datetime.fromisoformat(since)

    until_dt = None
    if until:
        until_dt = datetime.fromisoformat(until)

    # Build dynamic WHERE clauses
    where_clauses = [
        "p.execution_logs != '[]'::jsonb",
        "wp.user_id = :user_id",
    ]
    params: dict = {"user_id": user.id}

    if level:
        levels = [lv.strip() for lv in level.split(",")]
        where_clauses.append("log_entry->>'level' = ANY(:levels)")
        params["levels"] = levels

    if stage:
        where_clauses.append("log_entry->>'stage' = :stage")
        params["stage"] = stage

    if profile_id:
        where_clauses.append("p.profile_id = :profile_id")
        params["profile_id"] = profile_id

    if q:
        where_clauses.append("log_entry->>'message' ILIKE :q")
        params["q"] = f"%{q}%"

    where_clauses.append("log_entry->>'ts' >= :since")
    params["since"] = since_dt.isoformat()

    if until_dt:
        where_clauses.append("log_entry->>'ts' <= :until")
        params["until"] = until_dt.isoformat()

    where_sql = " AND ".join(where_clauses)
    offset = (page - 1) * per_page
    params["limit"] = per_page
    params["offset"] = offset

    # Count total matching
    count_sql = text(f"""
        SELECT COUNT(*)
        FROM posts p
             JOIN website_profiles wp ON p.profile_id = wp.id,
             jsonb_array_elements(p.execution_logs) AS log_entry
        WHERE {where_sql}
    """)
    result = await session.execute(count_sql, params)
    total = result.scalar_one()

    # Fetch paginated results
    data_sql = text(f"""
        SELECT
            p.id AS post_id,
            p.slug,
            p.topic,
            log_entry->>'ts' AS timestamp,
            log_entry->>'stage' AS stage,
            log_entry->>'level' AS level,
            log_entry->>'event' AS event,
            log_entry->>'message' AS message,
            log_entry->'data' AS data
        FROM posts p
             JOIN website_profiles wp ON p.profile_id = wp.id,
             jsonb_array_elements(p.execution_logs) AS log_entry
        WHERE {where_sql}
        ORDER BY log_entry->>'ts' DESC
        LIMIT :limit OFFSET :offset
    """)
    result = await session.execute(data_sql, params)

    items = []
    for row in result.all():
        items.append(
            {
                "post_id": str(row[0]),
                "slug": row[1],
                "topic": row[2],
                "timestamp": row[3],
                "stage": row[4],
                "level": row[5],
                "event": row[6],
                "message": row[7],
                "data": row[8],
            }
        )

    pages = (total + per_page - 1) // per_page if total > 0 else 0

    return {
        "items": items,
        "total": total,
        "page": page,
        "per_page": per_page,
        "pages": pages,
    }
