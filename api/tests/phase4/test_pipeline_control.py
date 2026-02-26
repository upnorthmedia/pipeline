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
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post = create_resp.json()

    from src.main import app

    mock_redis = AsyncMock()
    app.state.redis = mock_redis

    resp = await client.post(f"/api/posts/{post['id']}/rerun/research")
    assert resp.status_code == 202
    assert resp.json()["stage"] == "research"

    # Verify stage status updated
    get_resp = await client.get(f"/api/posts/{post['id']}")
    assert get_resp.json()["stage_status"]["research"] == "running"


async def test_rerun_invalid_stage(client: AsyncClient, sample_post_data):
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post = create_resp.json()

    from src.main import app

    app.state.redis = AsyncMock()

    resp = await client.post(f"/api/posts/{post['id']}/rerun/invalid")
    assert resp.status_code == 400


async def test_approve_stage_not_in_review(client: AsyncClient, sample_post_data):
    """Approving a post that isn't in review should fail."""
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post = create_resp.json()

    from src.main import app

    app.state.redis = AsyncMock()

    resp = await client.post(f"/api/posts/{post['id']}/approve")
    assert resp.status_code == 400


async def test_approve_stage_in_review(
    client: AsyncClient, db_session, sample_post_data
):
    """Test approving a stage that is actually in review."""
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post_data = create_resp.json()
    post_id = post_data["id"]

    # Set the post to review state via DB
    from src.models.post import Post

    post = await db_session.get(Post, uuid.UUID(post_id))
    post.current_stage = "research"
    post.stage_status = {"research": "review"}
    post.research_content = "Original research"
    await db_session.commit()

    from src.main import app

    mock_redis = AsyncMock()
    app.state.redis = mock_redis

    # Approve with edited content
    resp = await client.post(
        f"/api/posts/{post_id}/approve",
        params={"content": "Edited research content"},
    )
    assert resp.status_code == 200
    result = resp.json()
    assert result["stage_status"]["research"] == "complete"


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
