"""Tests for Post CRUD endpoints."""

import uuid

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.anyio


async def test_create_post(client: AsyncClient, sample_post_data):
    resp = await client.post("/api/posts", json=sample_post_data)
    assert resp.status_code == 201
    data = resp.json()
    assert data["slug"] == sample_post_data["slug"]
    assert data["topic"] == sample_post_data["topic"]
    assert data["current_stage"] == "research"
    assert data["stage_status"]["research"] == "running"
    assert "id" in data


async def test_create_post_missing_required_fields(client: AsyncClient):
    resp = await client.post("/api/posts", json={"slug": "test"})
    assert resp.status_code == 422


async def test_list_posts_empty(client: AsyncClient):
    resp = await client.get("/api/posts")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_list_posts(client: AsyncClient, sample_post_data):
    await client.post("/api/posts", json=sample_post_data)
    resp = await client.get("/api/posts")
    assert resp.status_code == 200
    assert len(resp.json()) == 1


async def test_list_posts_filter_by_status(client: AsyncClient, sample_post_data):
    await client.post("/api/posts", json=sample_post_data)
    # Filter by research (should match — new posts start with current_stage="research")
    resp = await client.get("/api/posts", params={"status": "research"})
    assert len(resp.json()) == 1
    # Filter by complete (should not match)
    resp = await client.get("/api/posts", params={"status": "complete"})
    assert len(resp.json()) == 0


async def test_list_posts_filter_by_search(client: AsyncClient, sample_post_data):
    await client.post("/api/posts", json=sample_post_data)
    resp = await client.get("/api/posts", params={"q": "REST API"})
    assert len(resp.json()) == 1
    resp = await client.get("/api/posts", params={"q": "nonexistent"})
    assert len(resp.json()) == 0


async def test_get_post(client: AsyncClient, sample_post_data):
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post_id = create_resp.json()["id"]

    resp = await client.get(f"/api/posts/{post_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == post_id


async def test_get_post_not_found(client: AsyncClient):
    fake_id = str(uuid.uuid4())
    resp = await client.get(f"/api/posts/{fake_id}")
    assert resp.status_code == 404


async def test_update_post(client: AsyncClient, sample_post_data):
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post_id = create_resp.json()["id"]

    resp = await client.patch(
        f"/api/posts/{post_id}",
        json={"topic": "Updated Topic", "word_count": 3000},
    )
    assert resp.status_code == 200
    assert resp.json()["topic"] == "Updated Topic"
    assert resp.json()["word_count"] == 3000


async def test_update_post_stage_content(client: AsyncClient, sample_post_data):
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post_id = create_resp.json()["id"]

    resp = await client.patch(
        f"/api/posts/{post_id}",
        json={"research_content": "# Research Results\n\nSome research."},
    )
    assert resp.status_code == 200
    assert resp.json()["research_content"] == "# Research Results\n\nSome research."


async def test_delete_post(client: AsyncClient, sample_post_data):
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post_id = create_resp.json()["id"]

    resp = await client.delete(f"/api/posts/{post_id}")
    assert resp.status_code == 204

    resp = await client.get(f"/api/posts/{post_id}")
    assert resp.status_code == 404


async def test_delete_post_not_found(client: AsyncClient):
    fake_id = str(uuid.uuid4())
    resp = await client.delete(f"/api/posts/{fake_id}")
    assert resp.status_code == 404


async def test_list_posts_pagination(client: AsyncClient):
    for i in range(5):
        await client.post(
            "/api/posts",
            json={
                "slug": f"post-{i}-{uuid.uuid4().hex[:6]}",
                "topic": f"Topic {i}",
            },
        )
    resp = await client.get("/api/posts", params={"per_page": 2, "page": 1})
    assert len(resp.json()) == 2
    resp = await client.get("/api/posts", params={"per_page": 2, "page": 3})
    assert len(resp.json()) == 1
