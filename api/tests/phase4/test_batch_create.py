"""Tests for batch post creation."""

import uuid

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.anyio


async def test_batch_create_posts(client: AsyncClient):
    posts_data = [
        {
            "slug": f"batch-{i}-{uuid.uuid4().hex[:6]}",
            "topic": f"Batch Topic {i}",
            "niche": "technology",
        }
        for i in range(5)
    ]

    resp = await client.post("/api/posts/batch", json=posts_data)
    assert resp.status_code == 201
    created = resp.json()
    assert len(created) == 5

    for i, post in enumerate(created):
        assert post["topic"] == f"Batch Topic {i}"
        assert post["current_stage"] == "pending"
        assert "id" in post


async def test_batch_create_with_profile(client: AsyncClient):
    # Create a profile first
    profile_resp = await client.post(
        "/api/profiles",
        json={
            "name": "Batch Profile",
            "website_url": "https://batchtest.com",
            "niche": "firearms",
            "word_count": 3000,
        },
    )
    profile = profile_resp.json()

    posts_data = [
        {
            "slug": f"batch-prof-{i}-{uuid.uuid4().hex[:6]}",
            "topic": f"Profile Batch {i}",
            "profile_id": profile["id"],
        }
        for i in range(3)
    ]

    resp = await client.post("/api/posts/batch", json=posts_data)
    assert resp.status_code == 201
    created = resp.json()
    assert len(created) == 3

    for post in created:
        assert post["niche"] == "firearms"
        assert post["word_count"] == 3000
        assert post["profile_id"] == profile["id"]


async def test_batch_create_empty(client: AsyncClient):
    resp = await client.post("/api/posts/batch", json=[])
    assert resp.status_code == 201
    assert resp.json() == []
