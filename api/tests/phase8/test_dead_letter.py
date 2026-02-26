"""Tests for dead letter queue: DLQ endpoints and retry logic."""

import json
import uuid
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient
from src.main import app

pytestmark = pytest.mark.anyio


@pytest.fixture
def mock_redis():
    """Set up a mock Redis with DLQ support."""
    redis = AsyncMock()
    redis._dlq_data = []

    async def lrange(key, start, end):
        return [json.dumps(e).encode() for e in redis._dlq_data]

    async def llen(key):
        return len(redis._dlq_data)

    async def lpush(key, *values):
        for v in values:
            redis._dlq_data.insert(0, json.loads(v))

    async def lrem(key, count, value):
        entry = json.loads(value)
        redis._dlq_data = [
            e for e in redis._dlq_data if e.get("post_id") != entry.get("post_id")
        ]

    async def delete(key):
        redis._dlq_data.clear()

    redis.lrange = lrange
    redis.llen = llen
    redis.lpush = lpush
    redis.lrem = lrem
    redis.delete = delete
    redis.enqueue_job = AsyncMock()

    app.state.redis = redis
    return redis


async def test_dead_letter_queue_empty(client: AsyncClient, mock_redis):
    resp = await client.get("/api/queue/dead-letter")
    assert resp.status_code == 200
    data = resp.json()
    assert data["entries"] == []
    assert data["count"] == 0


async def test_dead_letter_queue_with_entries(client: AsyncClient, mock_redis):
    mock_redis._dlq_data = [
        {
            "post_id": str(uuid.uuid4()),
            "stage": "research",
            "error": "API timeout",
            "attempts": 3,
            "failed_at": "2026-02-26T12:00:00",
        },
        {
            "post_id": str(uuid.uuid4()),
            "stage": "write",
            "error": "Rate limit exceeded",
            "attempts": 3,
            "failed_at": "2026-02-26T13:00:00",
        },
    ]
    resp = await client.get("/api/queue/dead-letter")
    data = resp.json()
    assert data["count"] == 2
    assert data["entries"][0]["stage"] == "research"
    assert data["entries"][1]["stage"] == "write"


async def test_retry_dead_letter_success(
    client: AsyncClient, mock_redis, sample_post_data
):
    """Retry removes from DLQ, resets post, and re-enqueues."""
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post = create_resp.json()

    # Simulate failed post
    await client.patch(f"/api/posts/{post['id']}", json={"research_content": None})
    # Add to DLQ
    mock_redis._dlq_data = [
        {
            "post_id": post["id"],
            "stage": "research",
            "error": "Timeout",
            "attempts": 3,
            "failed_at": "2026-02-26T12:00:00",
        }
    ]
    # Mark post as failed

    # Use the API to set failed state
    resp = await client.post(f"/api/queue/dead-letter/{post['id']}/retry")
    assert resp.status_code == 202
    data = resp.json()
    assert data["status"] == "retrying"
    assert data["post_id"] == post["id"]

    # Verify DLQ is now empty
    assert len(mock_redis._dlq_data) == 0

    # Verify job was re-enqueued
    mock_redis.enqueue_job.assert_called_once()


async def test_retry_dead_letter_not_found(client: AsyncClient, mock_redis):
    """Retry should 404 if post not in DLQ."""
    fake_id = str(uuid.uuid4())
    resp = await client.post(f"/api/queue/dead-letter/{fake_id}/retry")
    assert resp.status_code == 404


async def test_clear_dead_letter(client: AsyncClient, mock_redis):
    mock_redis._dlq_data = [
        {"post_id": "a", "stage": "research", "error": "e", "attempts": 3},
        {"post_id": "b", "stage": "write", "error": "e", "attempts": 3},
    ]
    resp = await client.delete("/api/queue/dead-letter")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "cleared"
    assert data["count"] == 2

    # Verify cleared
    resp2 = await client.get("/api/queue/dead-letter")
    assert resp2.json()["count"] == 0
