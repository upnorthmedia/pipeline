"""Integration tests for sitemap crawler with httpx mocks."""

from pathlib import Path
from unittest.mock import AsyncMock

import httpx
from src.services.sitemap import (
    crawl_sitemap,
    discover_sitemaps,
    fetch_and_parse_sitemap,
)

FIXTURES = Path(__file__).parent.parent / "fixtures"


def _mock_response(
    content: bytes | str,
    status_code: int = 200,
    content_type: str = "application/xml",
):
    if isinstance(content, str):
        content = content.encode()
    resp = httpx.Response(
        status_code=status_code,
        content=content,
        headers={"content-type": content_type},
        request=httpx.Request("GET", "https://example.com"),
    )
    return resp


class TestDiscoverSitemaps:
    async def test_discovers_from_robots_txt(self):
        client = AsyncMock(spec=httpx.AsyncClient)
        robots_content = "User-agent: *\nSitemap: https://example.com/sitemap.xml\n"
        client.get = AsyncMock(
            return_value=_mock_response(robots_content, content_type="text/plain")
        )

        result = await discover_sitemaps("https://example.com", client)
        assert result == ["https://example.com/sitemap.xml"]
        client.get.assert_called_once_with("https://example.com/robots.txt")

    async def test_fallback_to_sitemap_xml(self):
        call_count = 0

        async def mock_get(url, **kwargs):
            nonlocal call_count
            call_count += 1
            if "robots.txt" in url:
                return _mock_response("", status_code=404)
            if url == "https://example.com/sitemap.xml":
                return _mock_response("<urlset></urlset>")
            return _mock_response("", status_code=404)

        client = AsyncMock(spec=httpx.AsyncClient)
        client.get = AsyncMock(side_effect=mock_get)

        result = await discover_sitemaps("https://example.com", client)
        assert result == ["https://example.com/sitemap.xml"]

    async def test_no_sitemaps_found(self):
        async def mock_get(url, **kwargs):
            return _mock_response("", status_code=404)

        client = AsyncMock(spec=httpx.AsyncClient)
        client.get = AsyncMock(side_effect=mock_get)

        result = await discover_sitemaps("https://example.com", client)
        assert result == []

    async def test_robots_txt_network_error_fallback(self):
        async def mock_get(url, **kwargs):
            if "robots.txt" in url:
                raise httpx.ConnectError("Connection refused")
            if url == "https://example.com/sitemap.xml":
                return _mock_response("<urlset></urlset>")
            return _mock_response("", status_code=404)

        client = AsyncMock(spec=httpx.AsyncClient)
        client.get = AsyncMock(side_effect=mock_get)

        result = await discover_sitemaps("https://example.com", client)
        assert result == ["https://example.com/sitemap.xml"]


class TestFetchAndParseSitemap:
    async def test_simple_sitemap(self):
        content = (FIXTURES / "simple_sitemap.xml").read_bytes()
        client = AsyncMock(spec=httpx.AsyncClient)
        client.get = AsyncMock(return_value=_mock_response(content))

        entries = await fetch_and_parse_sitemap(
            "https://example.com/sitemap.xml", client
        )
        assert len(entries) == 10

    async def test_sitemap_index_recursive(self):
        index_content = (FIXTURES / "sitemap_index.xml").read_bytes()
        pages_content = (FIXTURES / "sub_sitemap_pages.xml").read_bytes()
        posts_content = (FIXTURES / "sub_sitemap_posts.xml").read_bytes()
        products_content = (FIXTURES / "sub_sitemap_products.xml").read_bytes()

        responses = {
            "https://example.com/sitemap.xml": _mock_response(index_content),
            "https://example.com/sitemap-pages.xml": _mock_response(pages_content),
            "https://example.com/sitemap-posts.xml": _mock_response(posts_content),
            "https://example.com/sitemap-products.xml": _mock_response(
                products_content
            ),
        }

        async def mock_get(url, **kwargs):
            return responses.get(url, _mock_response("", status_code=404))

        client = AsyncMock(spec=httpx.AsyncClient)
        client.get = AsyncMock(side_effect=mock_get)

        entries = await fetch_and_parse_sitemap(
            "https://example.com/sitemap.xml", client
        )
        # 2 pages + 2 posts + 1 product = 5
        assert len(entries) == 5

    async def test_fetch_failure_returns_empty(self):
        client = AsyncMock(spec=httpx.AsyncClient)
        client.get = AsyncMock(
            return_value=_mock_response("Not Found", status_code=404)
        )

        entries = await fetch_and_parse_sitemap(
            "https://example.com/missing.xml", client
        )
        assert entries == []

    async def test_max_depth_prevents_infinite_recursion(self):
        # Sitemap index that points to itself
        index_content = (FIXTURES / "sitemap_index.xml").read_bytes()
        client = AsyncMock(spec=httpx.AsyncClient)
        client.get = AsyncMock(return_value=_mock_response(index_content))

        entries = await fetch_and_parse_sitemap(
            "https://example.com/sitemap.xml", client, max_depth=1
        )
        # Depth 1: parses index, but sub-sitemaps at depth 0 are skipped
        assert entries == []


class TestCrawlSitemap:
    async def test_full_crawl(self):
        simple_content = (FIXTURES / "simple_sitemap.xml").read_bytes()
        robots_content = "Sitemap: https://example.com/sitemap.xml"

        async def mock_get(url, **kwargs):
            if "robots.txt" in url:
                return _mock_response(robots_content, content_type="text/plain")
            if "sitemap.xml" in url:
                return _mock_response(simple_content)
            return _mock_response("", status_code=404)

        client = AsyncMock(spec=httpx.AsyncClient)
        client.get = AsyncMock(side_effect=mock_get)
        client.aclose = AsyncMock()

        entries = await crawl_sitemap("https://example.com", client=client)
        assert len(entries) == 10
        assert entries[0].url == "https://example.com/page-1/"

    async def test_crawl_no_sitemaps(self):
        async def mock_get(url, **kwargs):
            return _mock_response("", status_code=404)

        client = AsyncMock(spec=httpx.AsyncClient)
        client.get = AsyncMock(side_effect=mock_get)
        client.aclose = AsyncMock()

        entries = await crawl_sitemap("https://example.com", client=client)
        assert entries == []
