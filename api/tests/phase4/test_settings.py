"""Tests for Settings CRUD endpoints."""

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.anyio


async def test_list_settings_empty(client: AsyncClient):
    resp = await client.get("/api/settings")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_update_settings_creates_new(client: AsyncClient):
    resp = await client.patch(
        "/api/settings",
        json={
            "worker_concurrency": {"max_jobs": 5},
            "default_stage_settings": {
                "research": "auto",
                "outline": "review",
                "write": "auto",
                "edit": "review",
                "images": "auto",
            },
        },
    )
    assert resp.status_code == 200
    settings = resp.json()
    assert len(settings) == 2

    keys = {s["key"] for s in settings}
    assert "worker_concurrency" in keys
    assert "default_stage_settings" in keys


async def test_update_settings_updates_existing(client: AsyncClient):
    # Create
    await client.patch(
        "/api/settings",
        json={"worker_concurrency": {"max_jobs": 3}},
    )

    # Update
    resp = await client.patch(
        "/api/settings",
        json={"worker_concurrency": {"max_jobs": 10}},
    )
    assert resp.status_code == 200
    settings = resp.json()
    wc = next(s for s in settings if s["key"] == "worker_concurrency")
    assert wc["value"] == {"max_jobs": 10}


async def test_list_settings_after_create(client: AsyncClient):
    await client.patch(
        "/api/settings",
        json={"test_key": {"data": "value"}},
    )
    resp = await client.get("/api/settings")
    assert resp.status_code == 200
    assert len(resp.json()) == 1
    assert resp.json()[0]["key"] == "test_key"
