"""Tests for WordPress service client."""

from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from src.services.wordpress import WordPressClient, WordPressError


@pytest.fixture
def wp_client():
    return WordPressClient("https://test.example.com", "admin", "xxxx-xxxx-xxxx")


def _mock_response(status_code=200, json_data=None):
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    resp.json.return_value = json_data or {}
    resp.text = ""
    return resp


class TestWordPressClient:
    async def test_test_connection(self, wp_client):
        wp_client._client.request = AsyncMock(
            return_value=_mock_response(200, {"name": "Test Site"})
        )
        result = await wp_client.test_connection()
        assert result["name"] == "Test Site"

    async def test_list_categories(self, wp_client):
        cats = [{"id": 1, "name": "News", "slug": "news", "count": 5}]
        wp_client._client.request = AsyncMock(return_value=_mock_response(200, cats))
        result = await wp_client.list_categories()
        assert len(result) == 1
        assert result[0]["name"] == "News"

    async def test_list_users(self, wp_client):
        users = [{"id": 1, "name": "Admin", "slug": "admin"}]
        wp_client._client.request = AsyncMock(return_value=_mock_response(200, users))
        result = await wp_client.list_users()
        assert len(result) == 1
        assert result[0]["name"] == "Admin"

    async def test_create_post(self, wp_client):
        wp_post = {"id": 42, "link": "https://test.example.com/?p=42"}
        wp_client._client.request = AsyncMock(return_value=_mock_response(201, wp_post))
        result = await wp_client.create_post(
            title="Test", content="<p>Hello</p>", status="publish"
        )
        assert result["id"] == 42

    async def test_update_post(self, wp_client):
        wp_post = {"id": 42, "link": "https://test.example.com/?p=42"}
        wp_client._client.request = AsyncMock(return_value=_mock_response(200, wp_post))
        result = await wp_client.update_post(42, title="Updated")
        assert result["id"] == 42

    async def test_upload_media(self, wp_client):
        media = {"id": 10, "source_url": "https://test.example.com/image.png"}
        wp_client._client.request = AsyncMock(return_value=_mock_response(201, media))
        result = await wp_client.upload_media(b"fake-image", "test.png", "image/png")
        assert result["id"] == 10

    async def test_error_handling(self, wp_client):
        wp_client._client.request = AsyncMock(
            return_value=_mock_response(401, {"message": "Invalid credentials"})
        )
        with pytest.raises(WordPressError, match="Invalid credentials"):
            await wp_client.test_connection()

    async def test_auth_header(self, wp_client):
        auth = wp_client._client.headers.get("Authorization")
        assert auth is not None
        assert auth.startswith("Basic ")

    async def test_create_post_with_all_params(self, wp_client):
        wp_post = {"id": 99, "link": "https://test.example.com/?p=99"}
        wp_client._client.request = AsyncMock(return_value=_mock_response(201, wp_post))
        result = await wp_client.create_post(
            title="Full Post",
            content="<p>Content</p>",
            status="draft",
            categories=[1, 2],
            author=5,
            featured_media=10,
            excerpt="Short excerpt",
        )
        assert result["id"] == 99
        # Verify the payload was constructed correctly
        call_args = wp_client._client.request.call_args
        payload = call_args.kwargs.get("json", {})
        assert payload["categories"] == [1, 2]
        assert payload["author"] == 5
        assert payload["featured_media"] == 10
