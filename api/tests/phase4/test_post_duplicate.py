"""Tests for post duplication."""

import uuid

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.anyio


async def test_duplicate_post(client: AsyncClient, sample_post_data):
    # Create original post
    create_resp = await client.post("/api/posts", json=sample_post_data)
    assert create_resp.status_code == 201
    original = create_resp.json()

    # Duplicate
    resp = await client.post(f"/api/posts/{original['id']}/duplicate")
    assert resp.status_code == 201
    dup = resp.json()

    # Same config
    assert dup["topic"] == original["topic"]
    assert dup["niche"] == original["niche"]
    assert dup["target_audience"] == original["target_audience"]
    assert dup["word_count"] == original["word_count"]
    assert dup["tone"] == original["tone"]
    assert dup["stage_settings"] == original["stage_settings"]

    # Different identity
    assert dup["id"] != original["id"]
    assert dup["slug"] != original["slug"]
    assert dup["slug"].startswith(original["slug"])

    # Empty stage content
    assert dup["research_content"] is None
    assert dup["outline_content"] is None
    assert dup["draft_content"] is None
    assert dup["final_md_content"] is None
    assert dup["current_stage"] == "pending"


async def test_duplicate_post_with_content(client: AsyncClient, sample_post_data):
    """Duplicate should not copy stage content."""
    create_resp = await client.post("/api/posts", json=sample_post_data)
    original = create_resp.json()

    # Add some content to original
    await client.patch(
        f"/api/posts/{original['id']}",
        json={"research_content": "Research data here"},
    )

    # Duplicate should have empty content
    resp = await client.post(f"/api/posts/{original['id']}/duplicate")
    dup = resp.json()
    assert dup["research_content"] is None


async def test_duplicate_post_not_found(client: AsyncClient):
    fake_id = str(uuid.uuid4())
    resp = await client.post(f"/api/posts/{fake_id}/duplicate")
    assert resp.status_code == 404
