"""Tests for error handling: LLM retry, graceful failure, post status updates."""

import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from src.models.post import Post
from src.pipeline.helpers import log_stage_execution
from src.services.llm import _retry

pytestmark = pytest.mark.anyio


async def test_retry_succeeds_first_try():
    """Retry helper should return on first success."""
    fn = AsyncMock(return_value="ok")
    result = await _retry(fn, retries=3, base_delay=0)
    assert result == "ok"
    assert fn.call_count == 1


async def test_retry_succeeds_after_failures():
    """Retry helper should succeed after transient failures."""
    fn = AsyncMock(side_effect=[ValueError("fail"), ValueError("fail"), "ok"])
    result = await _retry(fn, retries=3, base_delay=0)
    assert result == "ok"
    assert fn.call_count == 3


async def test_retry_exhausted_raises():
    """Retry helper should raise after all retries exhausted."""
    fn = AsyncMock(side_effect=ValueError("persistent failure"))
    with pytest.raises(ValueError, match="persistent failure"):
        await _retry(fn, retries=3, base_delay=0)
    assert fn.call_count == 3


async def test_retry_exponential_delay():
    """Retry delays should increase exponentially."""
    delays = []

    async def sleep_tracker(d):
        delays.append(d)

    fn = AsyncMock(side_effect=[ValueError("1"), ValueError("2"), "ok"])
    with patch("src.services.llm.asyncio.sleep", side_effect=sleep_tracker):
        await _retry(fn, retries=3, base_delay=1.0)

    assert len(delays) == 2
    assert delays[0] == 1.0  # 1.0 * 2^0
    assert delays[1] == 2.0  # 1.0 * 2^1


async def test_log_stage_execution_cost_calculation(db_session: AsyncSession):
    """Cost should be correctly computed from token counts and model pricing."""
    post = Post(
        slug=f"cost-test-{uuid.uuid4().hex[:8]}",
        topic="Cost Test",
        stage_logs={},
    )
    db_session.add(post)
    await db_session.commit()
    await db_session.refresh(post)

    await log_stage_execution(
        db_session,
        str(post.id),
        "research",
        "sonar-pro",  # $3/M in, $15/M out
        tokens_in=1000,
        tokens_out=2000,
        duration_s=5.0,
    )

    await db_session.refresh(post)
    log = post.stage_logs["research"]
    assert log["tokens_in"] == 1000
    assert log["tokens_out"] == 2000
    assert log["model"] == "sonar-pro"
    assert log["duration_s"] == 5.0
    # Cost: (1000/1M * 3.0) + (2000/1M * 15.0) = 0.003 + 0.030 = 0.033
    assert abs(log["cost_usd"] - 0.033) < 0.001


async def test_log_stage_execution_claude_cost(db_session: AsyncSession):
    """Claude cost should reflect higher per-token pricing."""
    post = Post(
        slug=f"claude-cost-{uuid.uuid4().hex[:8]}",
        topic="Claude Cost Test",
        stage_logs={},
    )
    db_session.add(post)
    await db_session.commit()
    await db_session.refresh(post)

    await log_stage_execution(
        db_session,
        str(post.id),
        "write",
        "claude-opus-4-6",  # $15/M in, $75/M out
        tokens_in=5000,
        tokens_out=10000,
        duration_s=30.0,
    )

    await db_session.refresh(post)
    log = post.stage_logs["write"]
    # Cost: (5000/1M * 15.0) + (10000/1M * 75.0) = 0.075 + 0.75 = 0.825
    assert abs(log["cost_usd"] - 0.825) < 0.001


async def test_log_stage_execution_unknown_model(db_session: AsyncSession):
    """Unknown model should default to zero cost."""
    post = Post(
        slug=f"unknown-model-{uuid.uuid4().hex[:8]}",
        topic="Unknown Model Test",
        stage_logs={},
    )
    db_session.add(post)
    await db_session.commit()
    await db_session.refresh(post)

    await log_stage_execution(
        db_session,
        str(post.id),
        "outline",
        "unknown-model",
        tokens_in=1000,
        tokens_out=2000,
        duration_s=5.0,
    )

    await db_session.refresh(post)
    log = post.stage_logs["outline"]
    assert log["cost_usd"] == 0.0


async def test_log_stage_execution_merges_logs(db_session: AsyncSession):
    """Multiple stage logs should merge without overwriting."""
    post = Post(
        slug=f"merge-logs-{uuid.uuid4().hex[:8]}",
        topic="Merge Logs Test",
        stage_logs={},
    )
    db_session.add(post)
    await db_session.commit()
    await db_session.refresh(post)

    await log_stage_execution(
        db_session, str(post.id), "research", "sonar-pro", 100, 200, 1.0
    )
    await log_stage_execution(
        db_session, str(post.id), "outline", "claude-opus-4-6", 300, 400, 2.0
    )

    await db_session.refresh(post)
    assert "research" in post.stage_logs
    assert "outline" in post.stage_logs
    assert post.stage_logs["research"]["model"] == "sonar-pro"
    assert post.stage_logs["outline"]["model"] == "claude-opus-4-6"
