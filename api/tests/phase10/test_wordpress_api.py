"""Tests for WordPress API endpoints."""

from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
async def wp_profile(client, sample_profile_data):
    """Create a profile with WP credentials."""
    # Mock encryption so we don't need a real key
    with patch("src.services.crypto.encrypt", return_value="encrypted-password"):
        data = {
            **sample_profile_data,
            "wp_url": "https://wp.example.com",
            "wp_username": "admin",
            "wp_app_password": "xxxx-xxxx",
            "output_format": "wordpress",
        }
        resp = await client.post("/api/profiles", json=data)
        assert resp.status_code == 201
        return resp.json()


async def test_wp_test_connection_success(client, wp_profile):
    pid = wp_profile["id"]
    with (
        patch("src.api.wordpress.decrypt", return_value="real-password"),
        patch("src.api.wordpress.WordPressClient") as MockClient,
    ):
        instance = AsyncMock()
        instance.test_connection.return_value = {"name": "My WP Site"}
        instance.__aenter__ = AsyncMock(return_value=instance)
        instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = instance

        resp = await client.get(f"/api/profiles/{pid}/wordpress/test")
        assert resp.status_code == 200
        data = resp.json()
        assert data["connected"] is True
        assert data["site_name"] == "My WP Site"


async def test_wp_test_connection_failure(client, wp_profile):
    pid = wp_profile["id"]
    from src.services.wordpress import WordPressError

    with (
        patch("src.api.wordpress.decrypt", return_value="real-password"),
        patch("src.api.wordpress.WordPressClient") as MockClient,
    ):
        instance = AsyncMock()
        instance.test_connection.side_effect = WordPressError("Auth failed", 401)
        instance.__aenter__ = AsyncMock(return_value=instance)
        instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = instance

        resp = await client.get(f"/api/profiles/{pid}/wordpress/test")
        assert resp.status_code == 200
        data = resp.json()
        assert data["connected"] is False
        assert "Auth failed" in data["error"]


async def test_wp_list_categories(client, wp_profile):
    pid = wp_profile["id"]
    cats = [
        {"id": 1, "name": "Tech", "slug": "tech", "count": 10},
        {"id": 2, "name": "News", "slug": "news", "count": 5},
    ]
    with (
        patch("src.api.wordpress.decrypt", return_value="real-password"),
        patch("src.api.wordpress.WordPressClient") as MockClient,
    ):
        instance = AsyncMock()
        instance.list_categories.return_value = cats
        instance.__aenter__ = AsyncMock(return_value=instance)
        instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = instance

        resp = await client.get(f"/api/profiles/{pid}/wordpress/categories")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2
        assert data[0]["name"] == "Tech"


async def test_wp_list_authors(client, wp_profile):
    pid = wp_profile["id"]
    users = [{"id": 1, "name": "Admin", "slug": "admin"}]
    with (
        patch("src.api.wordpress.decrypt", return_value="real-password"),
        patch("src.api.wordpress.WordPressClient") as MockClient,
    ):
        instance = AsyncMock()
        instance.list_users.return_value = users
        instance.__aenter__ = AsyncMock(return_value=instance)
        instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = instance

        resp = await client.get(f"/api/profiles/{pid}/wordpress/authors")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["name"] == "Admin"


async def test_wp_no_creds_returns_400(client, sample_profile_data):
    # Create profile without WP creds
    resp = await client.post("/api/profiles", json=sample_profile_data)
    assert resp.status_code == 201
    pid = resp.json()["id"]

    resp = await client.get(f"/api/profiles/{pid}/wordpress/test")
    assert resp.status_code == 200
    data = resp.json()
    assert data["connected"] is False


async def test_publish_endpoint(client, wp_profile, sample_post_data):
    pid = wp_profile["id"]
    post_data = {
        **sample_post_data,
        "profile_id": pid,
        "output_format": "wordpress",
    }
    resp = await client.post("/api/posts", json=post_data)
    assert resp.status_code == 201
    post_id = resp.json()["id"]

    # Set post to complete with content
    await client.patch(
        f"/api/posts/{post_id}",
        json={
            "ready_content": "# Test\nContent here",
        },
    )

    # Try to publish
    resp = await client.post(f"/api/posts/{post_id}/publish")
    assert resp.status_code == 202
    data = resp.json()
    assert data["status"] == "queued"


async def test_publish_wrong_format_returns_400(
    client, sample_profile_data, sample_post_data
):
    # Create profile and post with markdown format
    resp = await client.post("/api/profiles", json=sample_profile_data)
    pid = resp.json()["id"]

    post_data = {
        **sample_post_data,
        "profile_id": pid,
        "output_format": "markdown",
    }
    resp = await client.post("/api/posts", json=post_data)
    post_id = resp.json()["id"]

    await client.patch(
        f"/api/posts/{post_id}",
        json={"ready_content": "# Test"},
    )

    resp = await client.post(f"/api/posts/{post_id}/publish")
    assert resp.status_code == 400
