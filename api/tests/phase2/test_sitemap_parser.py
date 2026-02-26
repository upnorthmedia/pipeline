"""Unit tests for sitemap XML parser with fixture files."""

import gzip
from pathlib import Path

import pytest
from src.services.sitemap import SitemapParseError, parse_robots_txt, parse_sitemap_xml

FIXTURES = Path(__file__).parent.parent / "fixtures"


class TestParseSitemapXml:
    def test_simple_sitemap_10_urls(self):
        content = (FIXTURES / "simple_sitemap.xml").read_bytes()
        sub_sitemaps, entries = parse_sitemap_xml(content)
        assert sub_sitemaps == []
        assert len(entries) == 10
        assert entries[0].url == "https://example.com/page-1/"
        assert entries[0].lastmod == "2024-01-15"

    def test_sitemap_index_3_sub_sitemaps(self):
        content = (FIXTURES / "sitemap_index.xml").read_bytes()
        sub_sitemaps, entries = parse_sitemap_xml(content)
        assert len(sub_sitemaps) == 3
        assert entries == []
        assert sub_sitemaps[0] == "https://example.com/sitemap-pages.xml"
        assert sub_sitemaps[1] == "https://example.com/sitemap-posts.xml"
        assert sub_sitemaps[2] == "https://example.com/sitemap-products.xml"

    def test_gzipped_sitemap(self):
        raw = (FIXTURES / "simple_sitemap.xml").read_bytes()
        compressed = gzip.compress(raw)
        sub_sitemaps, entries = parse_sitemap_xml(compressed)
        assert len(entries) == 10

    def test_malformed_xml_missing_loc(self):
        content = (FIXTURES / "malformed_sitemap.xml").read_bytes()
        # Should not crash - just skip entries without <loc>
        sub_sitemaps, entries = parse_sitemap_xml(content)
        # Only entries with <loc> tags are returned
        assert all(e.url for e in entries)
        assert len(entries) == 2

    def test_completely_broken_xml(self):
        with pytest.raises(SitemapParseError, match="Malformed XML"):
            parse_sitemap_xml(b"<not valid xml at all>>>")

    def test_empty_sitemap(self):
        content = (FIXTURES / "empty_sitemap.xml").read_bytes()
        sub_sitemaps, entries = parse_sitemap_xml(content)
        assert sub_sitemaps == []
        assert entries == []

    def test_unknown_root_element(self):
        xml = b'<?xml version="1.0"?><unknown><item>test</item></unknown>'
        with pytest.raises(SitemapParseError, match="Unknown root element"):
            parse_sitemap_xml(xml)

    def test_url_without_lastmod(self):
        content = (FIXTURES / "simple_sitemap.xml").read_bytes()
        _, entries = parse_sitemap_xml(content)
        # Some entries have lastmod, some don't
        has_lastmod = [e for e in entries if e.lastmod]
        no_lastmod = [e for e in entries if not e.lastmod]
        assert len(has_lastmod) > 0
        assert len(no_lastmod) > 0


class TestParseRobotsTxt:
    def test_single_sitemap(self):
        robots = "User-agent: *\nDisallow: /admin/\nSitemap: https://example.com/sitemap.xml\n"
        result = parse_robots_txt(robots, "https://example.com")
        assert result == ["https://example.com/sitemap.xml"]

    def test_multiple_sitemaps(self):
        robots = (
            "User-agent: *\n"
            "Sitemap: https://example.com/sitemap-posts.xml\n"
            "Sitemap: https://example.com/sitemap-pages.xml\n"
        )
        result = parse_robots_txt(robots, "https://example.com")
        assert len(result) == 2

    def test_no_sitemaps(self):
        robots = "User-agent: *\nDisallow: /admin/\n"
        result = parse_robots_txt(robots, "https://example.com")
        assert result == []

    def test_case_insensitive(self):
        robots = "SITEMAP: https://example.com/sitemap.xml\n"
        result = parse_robots_txt(robots, "https://example.com")
        assert result == ["https://example.com/sitemap.xml"]

    def test_empty_robots(self):
        result = parse_robots_txt("", "https://example.com")
        assert result == []
