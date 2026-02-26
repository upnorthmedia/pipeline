"""Test internal link CRUD endpoints."""

import pytest


@pytest.fixture
async def profile_id(client):
    resp = await client.post(
        "/api/profiles",
        json={"name": "Link Test Blog", "website_url": "https://linktest.com"},
    )
    return resp.json()["id"]


@pytest.fixture
def link_payload():
    return {
        "url": "https://linktest.com/blog/test-post/",
        "title": "Test Post Title",
        "slug": "test-post",
        "keywords": ["testing", "automation"],
    }


class TestCreateLink:
    async def test_create_link(self, client, profile_id, link_payload):
        resp = await client.post(f"/api/profiles/{profile_id}/links", json=link_payload)
        assert resp.status_code == 201
        data = resp.json()
        assert data["url"] == link_payload["url"]
        assert data["title"] == "Test Post Title"
        assert data["source"] == "manual"
        assert data["profile_id"] == profile_id

    async def test_create_link_minimal(self, client, profile_id):
        resp = await client.post(
            f"/api/profiles/{profile_id}/links",
            json={"url": "https://linktest.com/page/"},
        )
        assert resp.status_code == 201
        assert resp.json()["title"] is None

    async def test_create_duplicate_link(self, client, profile_id, link_payload):
        await client.post(f"/api/profiles/{profile_id}/links", json=link_payload)
        resp = await client.post(f"/api/profiles/{profile_id}/links", json=link_payload)
        assert resp.status_code == 409

    async def test_create_link_profile_not_found(self, client, link_payload):
        resp = await client.post(
            "/api/profiles/00000000-0000-0000-0000-000000000000/links",
            json=link_payload,
        )
        assert resp.status_code == 404


class TestListLinks:
    async def test_list_links_empty(self, client, profile_id):
        resp = await client.get(f"/api/profiles/{profile_id}/links")
        assert resp.status_code == 200
        data = resp.json()
        assert data["items"] == []
        assert data["total"] == 0

    async def test_list_links_with_data(self, client, profile_id):
        for i in range(3):
            await client.post(
                f"/api/profiles/{profile_id}/links",
                json={"url": f"https://linktest.com/page-{i}/", "title": f"Page {i}"},
            )

        resp = await client.get(f"/api/profiles/{profile_id}/links")
        data = resp.json()
        assert data["total"] == 3
        assert len(data["items"]) == 3

    async def test_list_links_pagination(self, client, profile_id):
        for i in range(5):
            await client.post(
                f"/api/profiles/{profile_id}/links",
                json={"url": f"https://linktest.com/p-{i}/"},
            )

        resp = await client.get(
            f"/api/profiles/{profile_id}/links", params={"per_page": 2, "page": 1}
        )
        data = resp.json()
        assert data["total"] == 5
        assert len(data["items"]) == 2
        assert data["pages"] == 3

        resp2 = await client.get(
            f"/api/profiles/{profile_id}/links", params={"per_page": 2, "page": 3}
        )
        data2 = resp2.json()
        assert len(data2["items"]) == 1

    async def test_search_by_url(self, client, profile_id):
        await client.post(
            f"/api/profiles/{profile_id}/links",
            json={
                "url": "https://linktest.com/blog/python-tips/",
                "title": "Python Tips",
            },
        )
        await client.post(
            f"/api/profiles/{profile_id}/links",
            json={"url": "https://linktest.com/about/", "title": "About Us"},
        )

        resp = await client.get(
            f"/api/profiles/{profile_id}/links", params={"q": "python"}
        )
        data = resp.json()
        assert data["total"] == 1
        assert "python" in data["items"][0]["url"]

    async def test_search_by_title(self, client, profile_id):
        await client.post(
            f"/api/profiles/{profile_id}/links",
            json={
                "url": "https://linktest.com/page-a/",
                "title": "Getting Started Guide",
            },
        )
        await client.post(
            f"/api/profiles/{profile_id}/links",
            json={"url": "https://linktest.com/page-b/", "title": "FAQ"},
        )

        resp = await client.get(
            f"/api/profiles/{profile_id}/links", params={"q": "started"}
        )
        data = resp.json()
        assert data["total"] == 1

    async def test_list_links_profile_not_found(self, client):
        resp = await client.get(
            "/api/profiles/00000000-0000-0000-0000-000000000000/links"
        )
        assert resp.status_code == 404


class TestDeleteLink:
    async def test_delete_link(self, client, profile_id, link_payload):
        create_resp = await client.post(
            f"/api/profiles/{profile_id}/links", json=link_payload
        )
        link_id = create_resp.json()["id"]

        resp = await client.delete(f"/api/profiles/{profile_id}/links/{link_id}")
        assert resp.status_code == 204

        # Verify deleted
        list_resp = await client.get(f"/api/profiles/{profile_id}/links")
        assert list_resp.json()["total"] == 0

    async def test_delete_link_not_found(self, client, profile_id):
        resp = await client.delete(
            f"/api/profiles/{profile_id}/links/00000000-0000-0000-0000-000000000000"
        )
        assert resp.status_code == 404
