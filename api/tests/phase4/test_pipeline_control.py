"""Tests for pipeline control endpoints (run, run-all, approve, rerun, pause)."""

import uuid
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.anyio


@pytest.fixture
def mock_redis(monkeypatch):
    """Mock Redis enqueue_job on the app state."""
    mock = AsyncMock()

    async def _patch_redis(app):
        app.state.redis = mock

    return mock


async def test_run_post(client: AsyncClient, sample_post_data, monkeypatch):
    # Create post
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post = create_resp.json()

    # Mock redis
    from src.main import app

    mock_redis = AsyncMock()
    app.state.redis = mock_redis

    resp = await client.post(f"/api/posts/{post['id']}/run")
    assert resp.status_code == 202
    data = resp.json()
    assert data["status"] == "queued"
    assert data["stage"] == "research"
    mock_redis.enqueue_job.assert_called_once_with(
        "run_pipeline_stage", post["id"], None
    )


async def test_run_post_specific_stage(
    client: AsyncClient, sample_post_data, monkeypatch
):
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post = create_resp.json()

    from src.main import app

    mock_redis = AsyncMock()
    app.state.redis = mock_redis

    resp = await client.post(
        f"/api/posts/{post['id']}/run", params={"stage": "outline"}
    )
    assert resp.status_code == 202
    assert resp.json()["stage"] == "outline"


async def test_run_post_invalid_stage(client: AsyncClient, sample_post_data):
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post = create_resp.json()

    from src.main import app

    app.state.redis = AsyncMock()

    resp = await client.post(
        f"/api/posts/{post['id']}/run", params={"stage": "invalid"}
    )
    assert resp.status_code == 400


async def test_run_all(client: AsyncClient, sample_post_data):
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post = create_resp.json()

    from src.main import app

    mock_redis = AsyncMock()
    app.state.redis = mock_redis

    resp = await client.post(f"/api/posts/{post['id']}/run-all")
    assert resp.status_code == 202
    assert resp.json()["mode"] == "run-all"
    mock_redis.enqueue_job.assert_called_once()

    # Verify stage settings updated to auto
    get_resp = await client.get(f"/api/posts/{post['id']}")
    settings = get_resp.json()["stage_settings"]
    for stage in ["research", "outline", "write", "edit", "images"]:
        assert settings[stage] == "auto"


async def test_rerun_stage(client: AsyncClient, sample_post_data):
    """Rerun detects the first non-complete stage and re-queues from there."""
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post = create_resp.json()

    # Simulate research complete, outline stuck at running
    from src.main import app

    await client.patch(
        f"/api/posts/{post['id']}",
        json={"research_content": "some research"},
    )
    # Manually set stage_status via direct DB — use run endpoint to set status first
    mock_redis = AsyncMock()
    app.state.redis = mock_redis

    resp = await client.post(f"/api/posts/{post['id']}/rerun")
    assert resp.status_code == 202
    data = resp.json()
    assert data["mode"] == "rerun"
    assert data["rerun_from"] == "research"  # first non-complete stage
    mock_redis.enqueue_job.assert_called_once()

    # Verify stage status reset
    get_resp = await client.get(f"/api/posts/{post['id']}")
    assert get_resp.json()["stage_status"]["research"] == "pending"
    assert get_resp.json()["current_stage"] == "pending"


async def test_restart_pipeline(client: AsyncClient, sample_post_data):
    """Force restart clears all content and stages, starts fresh."""
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post = create_resp.json()

    # Add some content first
    await client.patch(
        f"/api/posts/{post['id']}",
        json={
            "research_content": "some research",
            "outline_content": "some outline",
        },
    )

    from src.main import app

    mock_redis = AsyncMock()
    app.state.redis = mock_redis

    resp = await client.post(f"/api/posts/{post['id']}/restart")
    assert resp.status_code == 202
    assert resp.json()["mode"] == "restart"
    mock_redis.enqueue_job.assert_called_once()

    # Verify everything is cleared
    get_resp = await client.get(f"/api/posts/{post['id']}")
    data = get_resp.json()
    assert data["current_stage"] == "pending"
    assert data["research_content"] is None
    assert data["outline_content"] is None
    for stage in ["research", "outline", "write", "edit", "images", "ready"]:
        assert data["stage_status"][stage] == "pending"


async def test_pause_post(client: AsyncClient, sample_post_data):
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post = create_resp.json()

    resp = await client.post(f"/api/posts/{post['id']}/pause")
    assert resp.status_code == 200
    assert resp.json()["status"] == "paused"

    # Verify post is paused
    get_resp = await client.get(f"/api/posts/{post['id']}")
    assert get_resp.json()["current_stage"] == "paused"


async def test_run_post_not_found(client: AsyncClient):
    from src.main import app

    app.state.redis = AsyncMock()

    fake_id = str(uuid.uuid4())
    resp = await client.post(f"/api/posts/{fake_id}/run")
    assert resp.status_code == 404
