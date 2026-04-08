from __future__ import annotations

import base64
import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class WordPressError(Exception):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class WordPressClient:
    # Common suffixes users add that should be stripped
    _STRIP_SUFFIXES = ("/wp-admin", "/wp-login.php", "/wp-json", "/wp-json/wp/v2")

    def __init__(self, wp_url: str, username: str, app_password: str):
        base = wp_url.rstrip("/")
        for suffix in self._STRIP_SUFFIXES:
            if base.lower().endswith(suffix):
                base = base[: -len(suffix)]
                break
        self.api_url = f"{base}/wp-json/wp/v2"
        self.site_url = f"{base}/wp-json"
        credentials = base64.b64encode(f"{username}:{app_password}".encode()).decode()
        self._client = httpx.AsyncClient(
            headers={"Authorization": f"Basic {credentials}"},
            timeout=httpx.Timeout(30.0, read=120.0),
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> WordPressClient:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    async def _request(
        self,
        method: str,
        url: str,
        **kwargs: Any,
    ) -> Any:
        resp = await self._client.request(method, url, **kwargs)
        if resp.status_code >= 400:
            try:
                detail = resp.json().get("message", resp.text[:200])
            except Exception:
                detail = resp.text[:200]
            raise WordPressError(
                f"WordPress API error: {detail}",
                status_code=resp.status_code,
            )
        try:
            return resp.json()
        except Exception:
            raise WordPressError(
                "WordPress returned non-JSON response — check that the site URL is correct",
                status_code=resp.status_code,
            )

    async def test_connection(self) -> dict[str, Any]:
        return await self._request("GET", self.site_url)

    async def list_categories(self) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        page = 1
        while True:
            data = await self._request(
                "GET",
                f"{self.api_url}/categories",
                params={"per_page": 100, "page": page},
            )
            results.extend(data)
            if len(data) < 100:
                break
            page += 1
        return results

    async def list_users(
        self,
        roles: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        if roles is None:
            roles = ["administrator", "editor", "author"]
        results: list[dict[str, Any]] = []
        page = 1
        while True:
            data = await self._request(
                "GET",
                f"{self.api_url}/users",
                params={"per_page": 100, "page": page, "roles": ",".join(roles)},
            )
            results.extend(data)
            if len(data) < 100:
                break
            page += 1
        return results

    async def upload_media(
        self,
        image_bytes: bytes,
        filename: str,
        mime_type: str = "image/png",
        alt_text: str = "",
    ) -> dict[str, Any]:
        headers = {
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Type": mime_type,
        }
        media = await self._request(
            "POST",
            f"{self.api_url}/media",
            content=image_bytes,
            headers=headers,
        )
        if alt_text and media.get("id"):
            await self._request(
                "POST",
                f"{self.api_url}/media/{media['id']}",
                json={"alt_text": alt_text},
            )
        return media

    async def create_post(
        self,
        title: str,
        content: str,
        status: str = "publish",
        categories: list[int] | None = None,
        author: int | None = None,
        featured_media: int | None = None,
        excerpt: str = "",
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "title": title,
            "content": content,
            "status": status,
        }
        if categories:
            payload["categories"] = categories
        if author:
            payload["author"] = author
        if featured_media:
            payload["featured_media"] = featured_media
        if excerpt:
            payload["excerpt"] = excerpt
        return await self._request("POST", f"{self.api_url}/posts", json=payload)

    async def update_post(self, wp_post_id: int, **kwargs: Any) -> dict[str, Any]:
        return await self._request(
            "POST", f"{self.api_url}/posts/{wp_post_id}", json=kwargs
        )
