"""Tests for analytics endpoints."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update
from src.models.post import Post

pytestmark = pytest.mark.anyio


# --- Helpers ---


async def create_profile(client, name="Test Blog"):
    resp = await client.post(
        "/api/profiles",
        json={
            "name": name,
            "website_url": f"https://{name.lower().replace(' ', '')}.com",
        },
    )
    assert resp.status_code == 201
    return resp.json()


async def create_post(client, profile_id=None, slug=None, topic="Test Post"):
    data = {
        "slug": slug or f"test-{uuid.uuid4().hex[:8]}",
        "topic": topic,
    }
    if profile_id:
        data["profile_id"] = profile_id
    resp = await client.post("/api/posts", json=data)
    assert resp.status_code == 201
    return resp.json()


async def set_post_stage(db_session, post_id, stage, completed_at=None):
    values = {"current_stage": stage}
    if completed_at:
        values["completed_at"] = completed_at
    stmt = update(Post).where(Post.id == post_id).values(**values)
    await db_session.execute(stmt)
    await db_session.commit()


async def set_stage_logs(db_session, post_id, stage_logs):
    stmt = update(Post).where(Post.id == post_id).values(stage_logs=stage_logs)
    await db_session.execute(stmt)
    await db_session.commit()


async def set_stage_status(db_session, post_id, stage_status):
    stmt = update(Post).where(Post.id == post_id).values(stage_status=stage_status)
    await db_session.execute(stmt)
    await db_session.commit()


async def set_execution_logs(db_session, post_id, logs):
    stmt = update(Post).where(Post.id == post_id).values(execution_logs=logs)
    await db_session.execute(stmt)
    await db_session.commit()


# --- Dashboard Tests ---


class TestDashboard:
    async def test_empty_database(self, client):
        resp = await client.get("/api/analytics/dashboard")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 0
        assert data["complete"] == 0
        assert data["completion_rate"] == 0
        assert data["avg_duration_s"] is None
        assert data["by_profile"] == []
        assert data["over_time"] == []
        assert data["posts_today"] == 0

    async def test_posts_by_status(self, client, db_session):
        # Create posts — API sets current_stage to first stage
        await create_post(client, slug="post-research")
        p2 = await create_post(client, slug="post-edit")
        p3 = await create_post(client, slug="post-complete")

        await set_post_stage(db_session, p2["id"], "edit")
        await set_post_stage(db_session, p3["id"], "complete")

        resp = await client.get("/api/analytics/dashboard")
        data = resp.json()

        assert data["total"] == 3
        assert data["by_status"].get("research", 0) >= 1
        assert data["by_status"].get("edit", 0) == 1
        assert data["by_status"].get("complete", 0) == 1

    async def test_completion_rate(self, client, db_session):
        p1 = await create_post(client, slug="done-1")
        p2 = await create_post(client, slug="done-2")
        await create_post(client, slug="pending-1")
        await create_post(client, slug="pending-2")

        await set_post_stage(db_session, p1["id"], "complete")
        await set_post_stage(db_session, p2["id"], "complete")

        resp = await client.get("/api/analytics/dashboard")
        data = resp.json()

        assert data["complete"] == 2
        assert data["total"] == 4
        assert data["completion_rate"] == 50.0

    async def test_avg_duration(self, client, db_session):
        p1 = await create_post(client, slug="dur-1")
        now = datetime.now(UTC)
        # Set completed_at to simulate a 100-second pipeline
        await set_post_stage(db_session, p1["id"], "complete", completed_at=now)
        # Update created_at to be 100s ago
        stmt = (
            update(Post)
            .where(Post.id == p1["id"])
            .values(created_at=now - timedelta(seconds=100))
        )
        await db_session.execute(stmt)
        await db_session.commit()

        resp = await client.get("/api/analytics/dashboard")
        data = resp.json()

        assert data["avg_duration_s"] is not None
        assert abs(data["avg_duration_s"] - 100) < 2  # Allow small rounding

    async def test_posts_by_profile(self, client, db_session):
        profile = await create_profile(client, "Analytics Blog")
        pid = profile["id"]

        await create_post(client, profile_id=pid, slug="prof-1")
        await create_post(client, profile_id=pid, slug="prof-2")
        await create_post(client, slug="no-profile")

        resp = await client.get("/api/analytics/dashboard")
        data = resp.json()

        assert len(data["by_profile"]) >= 1
        matching = [p for p in data["by_profile"] if p["name"] == "Analytics Blog"]
        assert len(matching) == 1
        assert matching[0]["count"] == 2

    async def test_posts_over_time(self, client):
        await create_post(client, slug="time-1")
        await create_post(client, slug="time-2")

        resp = await client.get("/api/analytics/dashboard?days=7")
        data = resp.json()

        # Posts created today should appear
        assert len(data["over_time"]) >= 1
        today = datetime.now(UTC).strftime("%Y-%m-%d")
        matching = [d for d in data["over_time"] if d["date"] == today]
        assert len(matching) == 1
        assert matching[0]["count"] >= 2

    async def test_posts_today(self, client):
        await create_post(client, slug="today-1")
        await create_post(client, slug="today-2")

        resp = await client.get("/api/analytics/dashboard")
        data = resp.json()

        assert data["posts_today"] >= 2

    async def test_days_filter(self, client, db_session):
        p1 = await create_post(client, slug="old-post")
        # Move created_at to 60 days ago
        stmt = (
            update(Post)
            .where(Post.id == p1["id"])
            .values(created_at=datetime.now(UTC) - timedelta(days=60))
        )
        await db_session.execute(stmt)
        await db_session.commit()

        await create_post(client, slug="recent-post")

        # 7-day window should only show recent
        resp = await client.get("/api/analytics/dashboard?days=7")
        data = resp.json()
        # over_time only includes recent, but by_status includes all
        total_over_time = sum(d["count"] for d in data["over_time"])
        assert total_over_time >= 1


# --- Cost Analytics Tests ---


class TestCosts:
    async def test_empty_database(self, client):
        resp = await client.get("/api/analytics/costs")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total_tokens_in"] == 0
        assert data["total_tokens_out"] == 0
        assert data["total_cost"] == 0
        assert data["avg_cost_per_post"] == 0
        assert data["by_model"] == {}
        assert data["by_stage"] == {}

    async def test_cost_aggregation(self, client, db_session):
        p1 = await create_post(client, slug="cost-1")

        await set_stage_logs(
            db_session,
            p1["id"],
            {
                "research": {
                    "tokens_in": 1000,
                    "tokens_out": 2000,
                    "model": "sonar-pro",
                    "cost_usd": 0.033,
                    "duration_s": 5.2,
                },
                "outline": {
                    "tokens_in": 3000,
                    "tokens_out": 4000,
                    "model": "claude-opus-4-6",
                    "cost_usd": 0.345,
                    "duration_s": 8.1,
                },
            },
        )

        resp = await client.get("/api/analytics/costs")
        data = resp.json()

        assert data["total_tokens_in"] == 4000
        assert data["total_tokens_out"] == 6000
        assert abs(data["total_cost"] - 0.378) < 0.001

    async def test_cost_by_model(self, client, db_session):
        p1 = await create_post(client, slug="model-1")

        await set_stage_logs(
            db_session,
            p1["id"],
            {
                "research": {
                    "tokens_in": 1000,
                    "tokens_out": 2000,
                    "model": "sonar-pro",
                    "cost_usd": 0.033,
                    "duration_s": 5.0,
                },
                "write": {
                    "tokens_in": 5000,
                    "tokens_out": 10000,
                    "model": "claude-opus-4-6",
                    "cost_usd": 0.825,
                    "duration_s": 12.0,
                },
            },
        )

        resp = await client.get("/api/analytics/costs")
        data = resp.json()

        assert "sonar-pro" in data["by_model"]
        assert "claude-opus-4-6" in data["by_model"]
        assert data["by_model"]["sonar-pro"]["calls"] == 1
        assert data["by_model"]["claude-opus-4-6"]["calls"] == 1

    async def test_cost_by_stage(self, client, db_session):
        p1 = await create_post(client, slug="stage-cost-1")

        await set_stage_logs(
            db_session,
            p1["id"],
            {
                "research": {
                    "tokens_in": 1000,
                    "tokens_out": 2000,
                    "model": "sonar-pro",
                    "cost_usd": 0.033,
                    "duration_s": 5.0,
                },
            },
        )

        resp = await client.get("/api/analytics/costs")
        data = resp.json()

        assert "research" in data["by_stage"]
        assert data["by_stage"]["research"]["calls"] == 1

    async def test_avg_cost_per_post(self, client, db_session):
        p1 = await create_post(client, slug="avg-1")
        p2 = await create_post(client, slug="avg-2")

        await set_stage_logs(
            db_session,
            p1["id"],
            {
                "research": {
                    "tokens_in": 1000,
                    "tokens_out": 2000,
                    "model": "sonar-pro",
                    "cost_usd": 0.10,
                    "duration_s": 5.0,
                },
            },
        )
        await set_stage_logs(
            db_session,
            p2["id"],
            {
                "research": {
                    "tokens_in": 1000,
                    "tokens_out": 2000,
                    "model": "sonar-pro",
                    "cost_usd": 0.20,
                    "duration_s": 5.0,
                },
            },
        )

        resp = await client.get("/api/analytics/costs")
        data = resp.json()

        assert abs(data["avg_cost_per_post"] - 0.15) < 0.001

    async def test_error_key_filtered(self, client, db_session):
        """_error key in stage_logs excluded from cost aggregation."""
        p1 = await create_post(client, slug="error-filter")

        await set_stage_logs(
            db_session,
            p1["id"],
            {
                "research": {
                    "tokens_in": 1000,
                    "tokens_out": 2000,
                    "model": "sonar-pro",
                    "cost_usd": 0.033,
                    "duration_s": 5.0,
                },
                "_error": {
                    "message": "Pipeline failed",
                    "stage": "outline",
                },
            },
        )

        resp = await client.get("/api/analytics/costs")
        data = resp.json()

        # _error should not appear in by_stage
        assert "_error" not in data["by_stage"]
        assert "research" in data["by_stage"]

    async def test_cost_by_profile(self, client, db_session):
        profile = await create_profile(client, "Cost Profile")
        p1 = await create_post(client, profile_id=profile["id"], slug="prof-cost-1")

        await set_stage_logs(
            db_session,
            p1["id"],
            {
                "research": {
                    "tokens_in": 1000,
                    "tokens_out": 2000,
                    "model": "sonar-pro",
                    "cost_usd": 0.033,
                    "duration_s": 5.0,
                },
            },
        )

        resp = await client.get("/api/analytics/costs")
        data = resp.json()

        matching = [p for p in data["by_profile"] if p["name"] == "Cost Profile"]
        assert len(matching) == 1

    async def test_days_filter(self, client, db_session):
        resp = await client.get("/api/analytics/costs?days=7")
        assert resp.status_code == 200

    async def test_profile_filter(self, client, db_session):
        profile = await create_profile(client, "Filter Profile")
        resp = await client.get(f"/api/analytics/costs?profile_id={profile['id']}")
        assert resp.status_code == 200

    async def test_model_costs_reference(self, client):
        resp = await client.get("/api/analytics/costs")
        data = resp.json()
        assert "model_costs_reference" in data
        assert "sonar-pro" in data["model_costs_reference"]


# --- Model Analytics Tests ---


class TestModels:
    async def test_empty_database(self, client):
        resp = await client.get("/api/analytics/models")
        assert resp.status_code == 200
        data = resp.json()
        assert data["models"] == []
        assert data["stage_performance"] == []

    async def test_model_stats(self, client, db_session):
        p1 = await create_post(client, slug="model-stat-1")

        await set_stage_logs(
            db_session,
            p1["id"],
            {
                "research": {
                    "tokens_in": 1000,
                    "tokens_out": 2000,
                    "model": "sonar-pro",
                    "cost_usd": 0.033,
                    "duration_s": 5.2,
                },
                "outline": {
                    "tokens_in": 3000,
                    "tokens_out": 4000,
                    "model": "claude-opus-4-6",
                    "cost_usd": 0.345,
                    "duration_s": 8.1,
                },
            },
        )

        resp = await client.get("/api/analytics/models")
        data = resp.json()

        assert len(data["models"]) == 2
        model_names = [m["model"] for m in data["models"]]
        assert "sonar-pro" in model_names
        assert "claude-opus-4-6" in model_names

    async def test_stage_performance(self, client, db_session):
        p1 = await create_post(client, slug="perf-1")

        await set_stage_logs(
            db_session,
            p1["id"],
            {
                "research": {
                    "tokens_in": 1000,
                    "tokens_out": 2000,
                    "model": "sonar-pro",
                    "cost_usd": 0.033,
                    "duration_s": 5.0,
                },
                "outline": {
                    "tokens_in": 3000,
                    "tokens_out": 4000,
                    "model": "claude-opus-4-6",
                    "cost_usd": 0.345,
                    "duration_s": 8.0,
                },
            },
        )

        resp = await client.get("/api/analytics/models")
        data = resp.json()

        stage_names = [s["stage"] for s in data["stage_performance"]]
        assert "research" in stage_names
        assert "outline" in stage_names

    async def test_stage_success_rates(self, client, db_session):
        p1 = await create_post(client, slug="success-1")
        p2 = await create_post(client, slug="success-2")

        await set_stage_status(
            db_session,
            p1["id"],
            {
                "research": "complete",
                "outline": "complete",
            },
        )
        await set_stage_status(
            db_session,
            p2["id"],
            {
                "research": "complete",
                "outline": "failed",
            },
        )

        resp = await client.get("/api/analytics/models")
        data = resp.json()

        research = next(
            s for s in data["stage_success_rates"] if s["stage"] == "research"
        )
        assert research["complete"] == 2
        assert research["failed"] == 0
        assert research["success_rate"] == 100.0

        outline = next(
            s for s in data["stage_success_rates"] if s["stage"] == "outline"
        )
        assert outline["complete"] == 1
        assert outline["failed"] == 1
        assert outline["success_rate"] == 50.0

    async def test_all_stages_present_in_success_rates(self, client):
        """All 6 stages appear in success rates, even if unused."""
        resp = await client.get("/api/analytics/models")
        data = resp.json()

        stages = [s["stage"] for s in data["stage_success_rates"]]
        for expected in ["research", "outline", "write", "edit", "images", "ready"]:
            assert expected in stages


# --- Log Explorer Tests ---


class TestLogs:
    async def test_empty_database(self, client):
        resp = await client.get("/api/analytics/logs")
        assert resp.status_code == 200
        data = resp.json()
        assert data["items"] == []
        assert data["total"] == 0
        assert data["page"] == 1
        assert data["pages"] == 0

    async def test_cross_post_logs(self, client, db_session):
        p1 = await create_post(client, slug="log-1")
        p2 = await create_post(client, slug="log-2")

        now = datetime.now(UTC).isoformat()
        await set_execution_logs(
            db_session,
            p1["id"],
            [
                {
                    "ts": now,
                    "stage": "research",
                    "level": "info",
                    "event": "stage_start",
                    "message": "Starting research",
                },
            ],
        )
        await set_execution_logs(
            db_session,
            p2["id"],
            [
                {
                    "ts": now,
                    "stage": "outline",
                    "level": "error",
                    "event": "stage_error",
                    "message": "Outline failed",
                },
            ],
        )

        resp = await client.get("/api/analytics/logs")
        data = resp.json()

        assert data["total"] == 2
        assert len(data["items"]) == 2

    async def test_level_filter(self, client, db_session):
        p1 = await create_post(client, slug="level-filter")
        now = datetime.now(UTC).isoformat()
        await set_execution_logs(
            db_session,
            p1["id"],
            [
                {
                    "ts": now,
                    "stage": "research",
                    "level": "info",
                    "event": "log",
                    "message": "Info msg",
                },
                {
                    "ts": now,
                    "stage": "research",
                    "level": "error",
                    "event": "stage_error",
                    "message": "Error msg",
                },
            ],
        )

        resp = await client.get("/api/analytics/logs?level=error")
        data = resp.json()

        assert data["total"] == 1
        assert data["items"][0]["level"] == "error"

    async def test_stage_filter(self, client, db_session):
        p1 = await create_post(client, slug="stage-filter")
        now = datetime.now(UTC).isoformat()
        await set_execution_logs(
            db_session,
            p1["id"],
            [
                {
                    "ts": now,
                    "stage": "research",
                    "level": "info",
                    "event": "log",
                    "message": "Research msg",
                },
                {
                    "ts": now,
                    "stage": "outline",
                    "level": "info",
                    "event": "log",
                    "message": "Outline msg",
                },
            ],
        )

        resp = await client.get("/api/analytics/logs?stage=research")
        data = resp.json()

        assert data["total"] == 1
        assert data["items"][0]["stage"] == "research"

    async def test_text_search(self, client, db_session):
        p1 = await create_post(client, slug="search-test")
        now = datetime.now(UTC).isoformat()
        await set_execution_logs(
            db_session,
            p1["id"],
            [
                {
                    "ts": now,
                    "stage": "research",
                    "level": "info",
                    "event": "log",
                    "message": "Connection timeout error",
                },
                {
                    "ts": now,
                    "stage": "outline",
                    "level": "info",
                    "event": "log",
                    "message": "Outline complete",
                },
            ],
        )

        resp = await client.get("/api/analytics/logs?q=timeout")
        data = resp.json()

        assert data["total"] == 1
        assert "timeout" in data["items"][0]["message"].lower()

    async def test_pagination(self, client, db_session):
        p1 = await create_post(client, slug="paginate")
        now = datetime.now(UTC).isoformat()
        logs = [
            {
                "ts": now,
                "stage": "research",
                "level": "info",
                "event": "log",
                "message": f"Log entry {i}",
            }
            for i in range(5)
        ]
        await set_execution_logs(db_session, p1["id"], logs)

        resp = await client.get("/api/analytics/logs?per_page=2&page=1")
        data = resp.json()

        assert data["total"] == 5
        assert len(data["items"]) == 2
        assert data["page"] == 1
        assert data["pages"] == 3

        # Page 2
        resp = await client.get("/api/analytics/logs?per_page=2&page=2")
        data = resp.json()
        assert len(data["items"]) == 2
        assert data["page"] == 2

    async def test_log_entry_includes_post_info(self, client, db_session):
        p1 = await create_post(client, slug="info-test", topic="Test Topic")
        now = datetime.now(UTC).isoformat()
        await set_execution_logs(
            db_session,
            p1["id"],
            [
                {
                    "ts": now,
                    "stage": "research",
                    "level": "info",
                    "event": "log",
                    "message": "test",
                },
            ],
        )

        resp = await client.get("/api/analytics/logs")
        data = resp.json()

        entry = data["items"][0]
        assert entry["post_id"] == p1["id"]
        assert entry["slug"] == "info-test"
        assert entry["topic"] == "Test Topic"

    async def test_profile_filter(self, client, db_session):
        profile = await create_profile(client, "Log Profile")
        p1 = await create_post(client, profile_id=profile["id"], slug="prof-log-1")
        p2 = await create_post(client, slug="no-prof-log")

        now = datetime.now(UTC).isoformat()
        await set_execution_logs(
            db_session,
            p1["id"],
            [
                {
                    "ts": now,
                    "stage": "research",
                    "level": "info",
                    "event": "log",
                    "message": "With profile",
                },
            ],
        )
        await set_execution_logs(
            db_session,
            p2["id"],
            [
                {
                    "ts": now,
                    "stage": "research",
                    "level": "info",
                    "event": "log",
                    "message": "Without profile",
                },
            ],
        )

        resp = await client.get(f"/api/analytics/logs?profile_id={profile['id']}")
        data = resp.json()

        assert data["total"] == 1
        assert data["items"][0]["message"] == "With profile"

    async def test_date_range_filter(self, client, db_session):
        p1 = await create_post(client, slug="date-range")
        # Use fixed format timestamps for reliable string comparison
        old_ts = "2024-01-01T00:00:00+00:00"
        new_ts = datetime.now(UTC).isoformat()

        await set_execution_logs(
            db_session,
            p1["id"],
            [
                {
                    "ts": old_ts,
                    "stage": "research",
                    "level": "info",
                    "event": "log",
                    "message": "Old log",
                },
                {
                    "ts": new_ts,
                    "stage": "research",
                    "level": "info",
                    "event": "log",
                    "message": "New log",
                },
            ],
        )

        # Default 90 days should exclude old log
        resp = await client.get("/api/analytics/logs")
        data = resp.json()
        assert data["total"] == 1
        assert data["items"][0]["message"] == "New log"

        # Explicit since to include old log
        resp = await client.get("/api/analytics/logs?since=2023-01-01T00:00:00")
        data = resp.json()
        assert data["total"] == 2
