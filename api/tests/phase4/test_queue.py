"""Tests for queue management endpoints."""

import uuid
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.anyio


async def test_queue_status_empty(client: AsyncClient):
    resp = await client.get("/api/queue")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 0
    assert data["running"] == 0
    assert data["pending"] == 0


async def test_queue_status_with_posts(client: AsyncClient):
    # Create posts in different states
    for i in range(3):
        await client.post(
            "/api/posts",
            json={
                "slug": f"queue-test-{i}-{uuid.uuid4().hex[:6]}",
                "topic": f"Queue Test {i}",
            },
        )

    resp = await client.get("/api/queue")
    data = resp.json()
    assert data["running"] == 3
    assert data["total"] == 3


async def test_review_queue_empty(client: AsyncClient):
    resp = await client.get("/api/queue/review")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_review_queue_with_review_posts(
    client: AsyncClient, db_session, sample_post_data
):
    """Posts in review status should appear in review queue."""
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post_data = create_resp.json()

    # Set post to review state via DB
    from src.models.post import Post

    post = await db_session.get(Post, uuid.UUID(post_data["id"]))
    post.current_stage = "outline"
    post.stage_status = {"research": "complete", "outline": "review"}
    await db_session.commit()

    resp = await client.get("/api/queue/review")
    assert resp.status_code == 200
    posts = resp.json()
    assert len(posts) == 1
    assert posts[0]["id"] == post_data["id"]


async def test_pause_all(client: AsyncClient):
    # Create some pending posts
    for i in range(3):
        await client.post(
            "/api/posts",
            json={
                "slug": f"pause-{i}-{uuid.uuid4().hex[:6]}",
                "topic": f"Pause Test {i}",
            },
        )

    resp = await client.post("/api/queue/pause-all")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "paused"
    assert data["count"] == 3

    # Verify all posts are paused
    list_resp = await client.get("/api/posts")
    for post in list_resp.json():
        assert post["current_stage"] == "paused"


async def test_resume_all(client: AsyncClient):
    from src.main import app

    mock_redis = AsyncMock()
    app.state.redis = mock_redis

    # Create and pause posts
    for i in range(2):
        await client.post(
            "/api/posts",
            json={
                "slug": f"resume-{i}-{uuid.uuid4().hex[:6]}",
                "topic": f"Resume Test {i}",
            },
        )

    await client.post("/api/queue/pause-all")

    # Reset mock to count only resume-all enqueue calls
    mock_redis.enqueue_job.reset_mock()

    resp = await client.post("/api/queue/resume-all")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "resumed"
    assert data["count"] == 2

    # Verify jobs were enqueued
    assert mock_redis.enqueue_job.call_count == 2
