"""Test website profile CRUD endpoints."""

import pytest


@pytest.fixture
def profile_payload():
    return {
        "name": "Test Blog",
        "website_url": "https://testblog.com",
        "niche": "technology",
        "target_audience": "developers",
        "tone": "Professional",
        "word_count": 2500,
        "output_format": "both",
    }


class TestCreateProfile:
    async def test_create_profile(self, client, profile_payload):
        resp = await client.post("/api/profiles", json=profile_payload)
        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == "Test Blog"
        assert data["website_url"] == "https://testblog.com"
        assert data["niche"] == "technology"
        assert data["word_count"] == 2500
        assert data["crawl_status"] == "pending"
        assert "id" in data

    async def test_create_profile_minimal(self, client):
        resp = await client.post(
            "/api/profiles",
            json={"name": "Minimal", "website_url": "https://minimal.com"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == "Minimal"
        assert data["tone"] == "Conversational and friendly"
        assert data["word_count"] == 2000

    async def test_create_profile_missing_name(self, client):
        resp = await client.post(
            "/api/profiles", json={"website_url": "https://example.com"}
        )
        assert resp.status_code == 422

    async def test_create_profile_missing_url(self, client):
        resp = await client.post("/api/profiles", json={"name": "No URL"})
        assert resp.status_code == 422


class TestReadProfile:
    async def test_list_profiles_empty(self, client):
        resp = await client.get("/api/profiles")
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_list_profiles(self, client, profile_payload):
        await client.post("/api/profiles", json=profile_payload)
        await client.post(
            "/api/profiles",
            json={"name": "Second", "website_url": "https://second.com"},
        )
        resp = await client.get("/api/profiles")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2

    async def test_get_profile_by_id(self, client, profile_payload):
        create_resp = await client.post("/api/profiles", json=profile_payload)
        profile_id = create_resp.json()["id"]

        resp = await client.get(f"/api/profiles/{profile_id}")
        assert resp.status_code == 200
        assert resp.json()["id"] == profile_id
        assert resp.json()["name"] == "Test Blog"

    async def test_get_profile_not_found(self, client):
        resp = await client.get("/api/profiles/00000000-0000-0000-0000-000000000000")
        assert resp.status_code == 404


class TestUpdateProfile:
    async def test_update_profile(self, client, profile_payload):
        create_resp = await client.post("/api/profiles", json=profile_payload)
        profile_id = create_resp.json()["id"]

        resp = await client.patch(
            f"/api/profiles/{profile_id}",
            json={"name": "Updated Blog", "word_count": 3000},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "Updated Blog"
        assert data["word_count"] == 3000
        # Unchanged fields preserved
        assert data["niche"] == "technology"

    async def test_update_profile_not_found(self, client):
        resp = await client.patch(
            "/api/profiles/00000000-0000-0000-0000-000000000000",
            json={"name": "Ghost"},
        )
        assert resp.status_code == 404


class TestDeleteProfile:
    async def test_delete_profile(self, client, profile_payload):
        create_resp = await client.post("/api/profiles", json=profile_payload)
        profile_id = create_resp.json()["id"]

        resp = await client.delete(f"/api/profiles/{profile_id}")
        assert resp.status_code == 204

        # Confirm deleted
        resp = await client.get(f"/api/profiles/{profile_id}")
        assert resp.status_code == 404

    async def test_delete_profile_not_found(self, client):
        resp = await client.delete("/api/profiles/00000000-0000-0000-0000-000000000000")
        assert resp.status_code == 404
