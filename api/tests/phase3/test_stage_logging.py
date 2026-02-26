"""Tests for log_stage_execution — verifies stage_logs populated."""

import uuid

import pytest
from sqlalchemy import select
from src.models.post import Post
from src.pipeline.helpers import MODEL_COSTS, StageTimer, log_stage_execution


@pytest.fixture
async def post_in_db(db_session):
    post = Post(
        id=uuid.uuid4(),
        slug="test-logging",
        topic="Logging test",
        current_stage="pending",
        stage_logs={},
    )
    db_session.add(post)
    await db_session.commit()
    return post


class TestLogStageExecution:
    @pytest.mark.asyncio
    async def test_logs_basic_metrics(self, db_session, post_in_db):
        await log_stage_execution(
            db_session,
            str(post_in_db.id),
            "research",
            "sonar-pro",
            tokens_in=500,
            tokens_out=2000,
            duration_s=3.5,
        )

        result = await db_session.execute(
            select(Post.stage_logs).where(Post.id == post_in_db.id)
        )
        logs = result.scalar_one()
        assert "research" in logs
        entry = logs["research"]
        assert entry["tokens_in"] == 500
        assert entry["tokens_out"] == 2000
        assert entry["model"] == "sonar-pro"
        assert entry["duration_s"] == 3.5

    @pytest.mark.asyncio
    async def test_calculates_cost(self, db_session, post_in_db):
        await log_stage_execution(
            db_session,
            str(post_in_db.id),
            "outline",
            "claude-opus-4-6",
            tokens_in=1000,
            tokens_out=2000,
            duration_s=5.0,
        )

        result = await db_session.execute(
            select(Post.stage_logs).where(Post.id == post_in_db.id)
        )
        logs = result.scalar_one()
        entry = logs["outline"]

        # Expected: (1000/1M * 15) + (2000/1M * 75) = 0.015 + 0.15 = 0.165
        assert entry["cost_usd"] == pytest.approx(0.165, abs=1e-4)

    @pytest.mark.asyncio
    async def test_multiple_stages_accumulate(self, db_session, post_in_db):
        await log_stage_execution(
            db_session,
            str(post_in_db.id),
            "research",
            "sonar-pro",
            tokens_in=500,
            tokens_out=1000,
            duration_s=2.0,
        )
        await log_stage_execution(
            db_session,
            str(post_in_db.id),
            "outline",
            "claude-opus-4-6",
            tokens_in=800,
            tokens_out=1500,
            duration_s=4.0,
        )

        result = await db_session.execute(
            select(Post.stage_logs).where(Post.id == post_in_db.id)
        )
        logs = result.scalar_one()
        assert "research" in logs
        assert "outline" in logs

    @pytest.mark.asyncio
    async def test_unknown_model_zero_cost(self, db_session, post_in_db):
        await log_stage_execution(
            db_session,
            str(post_in_db.id),
            "research",
            "unknown-model",
            tokens_in=1000,
            tokens_out=1000,
            duration_s=1.0,
        )

        result = await db_session.execute(
            select(Post.stage_logs).where(Post.id == post_in_db.id)
        )
        logs = result.scalar_one()
        assert logs["research"]["cost_usd"] == 0.0


class TestModelCosts:
    def test_known_models_have_costs(self):
        assert "sonar-pro" in MODEL_COSTS
        assert "claude-opus-4-6" in MODEL_COSTS

    def test_cost_structure(self):
        for model, costs in MODEL_COSTS.items():
            assert "input" in costs
            assert "output" in costs
            assert costs["input"] >= 0
            assert costs["output"] >= 0


class TestStageTimer:
    def test_timer_measures_duration(self):
        import time

        with StageTimer() as timer:
            time.sleep(0.05)

        assert timer.duration >= 0.04
        assert timer.duration < 1.0
