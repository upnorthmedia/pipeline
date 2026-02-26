"""Shared pipeline helpers: rule loading, prompt building, DB sync."""

from __future__ import annotations

import json
import logging
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.models.post import Post
from src.pipeline.state import STAGE_CONTENT_MAP, PipelineState

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level event context for publishing SSE logs from stage nodes
# ---------------------------------------------------------------------------
_event_redis: Any | None = None
_event_post_id: str | None = None


def set_event_context(redis: Any, post_id: str) -> None:
    """Set the module-level Redis + post_id so stage nodes can publish logs."""
    global _event_redis, _event_post_id  # noqa: PLW0603
    _event_redis = redis
    _event_post_id = post_id


def clear_event_context() -> None:
    """Clear the module-level event context after pipeline execution."""
    global _event_redis, _event_post_id  # noqa: PLW0603
    _event_redis = None
    _event_post_id = None


async def publish_stage_log(
    message: str, stage: str = "", level: str = "info"
) -> None:
    """Publish a log event via SSE if event context is set.

    Safe to call even when no context is set (e.g. during tests) — it will
    silently no-op.
    """
    if _event_redis is None or _event_post_id is None:
        return

    from src.api.events import publish_event

    await publish_event(
        _event_redis,
        _event_post_id,
        "log",
        {
            "stage": stage,
            "message": message,
            "level": level,
            "timestamp": datetime.now(UTC).isoformat(),
        },
    )

# Approximate cost per 1M tokens (USD) — update as pricing changes
MODEL_COSTS: dict[str, dict[str, float]] = {
    "sonar-pro": {"input": 3.0, "output": 15.0},
    "claude-opus-4-6": {"input": 15.0, "output": 75.0},
    "gemini-3.1-flash-image-preview": {"input": 0.0, "output": 0.0},
}


def load_rules(stage: str) -> str:
    """Load a rule file for the given stage name (e.g. 'blog-research.md')."""
    from src.pipeline.state import STAGE_RULES_MAP

    filename = STAGE_RULES_MAP[stage]
    rules_path = Path(settings.rules_dir) / filename
    if not rules_path.exists():
        logger.warning(f"Rule file not found: {rules_path}")
        return ""
    return rules_path.read_text(encoding="utf-8")


def build_stage_prompt(stage: str, rules: str, state: PipelineState) -> str:
    """Build the full prompt for a stage from rules + state context."""
    sections: list[str] = []

    # Rules
    if rules:
        sections.append(rules)

    # Post config context
    config_section = _build_config_context(state)
    if config_section:
        sections.append(config_section)

    # Previous stage output (chain input)
    prev_output = _get_previous_output(stage, state)
    if prev_output:
        sections.append(f"## Previous Stage Output\n\n{prev_output}")

    # Internal links (for edit stage)
    if stage == "edit" and state.get("internal_links"):
        links_section = _build_links_context(state)
        sections.append(links_section)

    return "\n\n---\n\n".join(sections)


def _build_config_context(state: PipelineState) -> str:
    """Build the configuration context block from state."""
    lines = ["## Post Configuration\n"]
    fields = [
        ("BLOG_POST_TOPIC", "topic"),
        ("TARGET_AUDIENCE", "target_audience"),
        ("NICHE", "niche"),
        ("INTENT", "intent"),
        ("WORD_COUNT", "word_count"),
        ("TONE", "tone"),
        ("OUTPUT_FORMAT", "output_format"),
        ("WEBSITE_URL", "website_url"),
        ("BRAND_VOICE", "brand_voice"),
        ("AVOID", "avoid"),
        ("REQUIRED_MENTIONS", "required_mentions"),
    ]
    for label, key in fields:
        val = state.get(key, "")
        if val:
            lines.append(f"- **{label}**: {val}")

    kws = state.get("related_keywords", [])
    if kws:
        lines.append(f"- **RELATED_KEYWORDS**: {', '.join(kws)}")

    competitors = state.get("competitor_urls", [])
    if competitors:
        lines.append(f"- **COMPETITOR_URLS**: {', '.join(competitors)}")

    return "\n".join(lines)


def _get_previous_output(stage: str, state: PipelineState) -> str:
    """Get the output from the previous stage as input for the current one."""
    from src.pipeline.state import STAGES

    idx = STAGES.index(stage)
    if idx == 0:
        return ""

    # Map previous stage to its output key in state
    prev_stage = STAGES[idx - 1]
    output_keys = {
        "research": "research",
        "outline": "outline",
        "write": "draft",
        "edit": "final_md",
        "images": "image_manifest",
        "ready": "ready",
    }
    key = output_keys.get(prev_stage, "")
    if not key:
        return ""

    val = state.get(key, "")
    if isinstance(val, dict):
        return json.dumps(val, indent=2)
    return val or ""


def _build_links_context(state: PipelineState) -> str:
    """Build the internal links section for the edit stage prompt."""
    links = state.get("internal_links", [])
    if not links:
        return ""

    lines = [f"## Available Internal Links ({len(links)} total)\n"]
    for link in links[:50]:  # Cap at 50 most relevant
        url = link.get("url", "")
        title = link.get("title", "")
        if title:
            lines.append(f'- {url} - "{title}"')
        else:
            lines.append(f"- {url}")

    return "\n".join(lines)


async def save_stage_output(
    session: AsyncSession,
    post_id: str,
    stage: str,
    content: str | dict,
    stage_status: dict | None = None,
) -> None:
    """Sync a stage's output from LangGraph state to the posts table."""
    column = STAGE_CONTENT_MAP.get(stage)
    if not column:
        logger.error(f"Unknown stage '{stage}' — cannot save output")
        return

    # Pass content as-is: dicts go to JSONB columns, strings to text columns
    col_value = content

    values: dict[str, Any] = {
        column: col_value,
        "current_stage": stage,
    }

    # Persist the full stage_status dict so frontend shows correct progress
    if stage_status is not None:
        values["stage_status"] = stage_status

    stmt = update(Post).where(Post.id == post_id).values(**values)
    await session.execute(stmt)
    await session.commit()

    logger.info(f"Saved {stage} output for post {post_id}")


async def log_stage_execution(
    session: AsyncSession,
    post_id: str,
    stage: str,
    model: str,
    tokens_in: int,
    tokens_out: int,
    duration_s: float,
) -> None:
    """Record execution metrics for a stage in the post's stage_logs."""
    cost_info = MODEL_COSTS.get(model, {"input": 0.0, "output": 0.0})
    cost_usd = (tokens_in / 1_000_000 * cost_info["input"]) + (
        tokens_out / 1_000_000 * cost_info["output"]
    )

    log_entry = {
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "model": model,
        "duration_s": round(duration_s, 2),
        "cost_usd": round(cost_usd, 6),
    }

    # Fetch current logs, merge, and update
    from sqlalchemy import select

    result = await session.execute(select(Post.stage_logs).where(Post.id == post_id))
    current_logs = result.scalar_one_or_none() or {}
    current_logs[stage] = log_entry

    stmt = update(Post).where(Post.id == post_id).values(stage_logs=current_logs)
    await session.execute(stmt)
    await session.commit()

    logger.info(
        f"Logged {stage} execution: {tokens_in}in/{tokens_out}out tokens, "
        f"{duration_s:.1f}s, ${cost_usd:.4f}"
    )


class StageTimer:
    """Context manager to time stage execution."""

    def __init__(self):
        self.start_time: float = 0
        self.duration: float = 0

    def __enter__(self):
        self.start_time = time.monotonic()
        return self

    def __exit__(self, *args):
        self.duration = time.monotonic() - self.start_time
