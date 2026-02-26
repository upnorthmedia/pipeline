"""Sitemap discovery, parsing, and crawling service."""

import gzip
import logging
from dataclasses import dataclass
from io import BytesIO
from urllib.parse import urlparse

import httpx
from lxml import etree

logger = logging.getLogger(__name__)

SITEMAP_NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
SITEMAP_TIMEOUT = 30.0
TITLE_FETCH_TIMEOUT = 10.0
MAX_URLS_PER_SITEMAP = 50000
USER_AGENT = "ContentPipelineBot/1.0"


@dataclass
class SitemapEntry:
    url: str
    title: str | None = None
    lastmod: str | None = None


class SitemapParseError(Exception):
    pass


def parse_sitemap_xml(content: bytes) -> tuple[list[str], list[SitemapEntry]]:
    """Parse sitemap XML, returning (sub_sitemap_urls, entries).

    Handles both sitemap index files and regular sitemaps.
    Returns a tuple of:
      - sub_sitemap_urls: list of nested sitemap URLs (from <sitemapindex>)
      - entries: list of SitemapEntry (from <urlset>)
    """
    # Try to decompress gzip
    try:
        content = gzip.decompress(content)
    except (gzip.BadGzipFile, OSError):
        pass  # Not gzipped, use raw content

    try:
        tree = etree.parse(BytesIO(content))
    except etree.XMLSyntaxError as e:
        raise SitemapParseError(f"Malformed XML: {e}") from e

    root = tree.getroot()
    tag = etree.QName(root.tag).localname if root.tag else ""

    sub_sitemaps: list[str] = []
    entries: list[SitemapEntry] = []

    if tag == "sitemapindex":
        for sitemap_el in root.findall("sm:sitemap", SITEMAP_NS):
            loc = sitemap_el.findtext("sm:loc", namespaces=SITEMAP_NS)
            if loc:
                sub_sitemaps.append(loc.strip())
    elif tag == "urlset":
        for url_el in root.findall("sm:url", SITEMAP_NS):
            loc = url_el.findtext("sm:loc", namespaces=SITEMAP_NS)
            if not loc:
                continue
            lastmod = url_el.findtext("sm:lastmod", namespaces=SITEMAP_NS)
            entries.append(
                SitemapEntry(
                    url=loc.strip(),
                    lastmod=lastmod.strip() if lastmod else None,
                )
            )
    else:
        raise SitemapParseError(f"Unknown root element: {tag}")

    return sub_sitemaps, entries


def parse_robots_txt(content: str, base_url: str) -> list[str]:
    """Extract sitemap URLs from robots.txt content."""
    sitemaps = []
    for line in content.splitlines():
        line = line.strip()
        if line.lower().startswith("sitemap:"):
            url = line.split(":", 1)[1].strip()
            if url:
                sitemaps.append(url)
    return sitemaps


async def discover_sitemaps(
    website_url: str, client: httpx.AsyncClient | None = None
) -> list[str]:
    """Discover sitemap URLs for a website via robots.txt fallback chain.

    1. Try robots.txt for Sitemap: directives
    2. Fallback to /sitemap.xml
    3. Fallback to /sitemap_index.xml
    """
    parsed = urlparse(website_url)
    base = f"{parsed.scheme}://{parsed.netloc}"
    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(
            timeout=SITEMAP_TIMEOUT,
            headers={"User-Agent": USER_AGENT},
            follow_redirects=True,
        )

    try:
        # Try robots.txt
        try:
            resp = await client.get(f"{base}/robots.txt")
            if resp.status_code == 200:
                sitemaps = parse_robots_txt(resp.text, base)
                if sitemaps:
                    return sitemaps
        except httpx.HTTPError:
            pass

        # Fallback: try common sitemap paths
        for path in ["/sitemap.xml", "/sitemap_index.xml"]:
            try:
                resp = await client.get(f"{base}{path}")
                if resp.status_code == 200:
                    return [f"{base}{path}"]
            except httpx.HTTPError:
                continue

        return []
    finally:
        if own_client:
            await client.aclose()


async def fetch_and_parse_sitemap(
    url: str, client: httpx.AsyncClient, max_depth: int = 3
) -> list[SitemapEntry]:
    """Fetch a sitemap URL and recursively resolve any sitemap indexes.

    Returns a flat list of all SitemapEntry objects found.
    """
    if max_depth <= 0:
        logger.warning(f"Max sitemap depth reached for {url}")
        return []

    try:
        resp = await client.get(url)
        resp.raise_for_status()
    except httpx.HTTPError as e:
        logger.error(f"Failed to fetch sitemap {url}: {e}")
        return []

    try:
        sub_sitemaps, entries = parse_sitemap_xml(resp.content)
    except SitemapParseError as e:
        logger.error(f"Failed to parse sitemap {url}: {e}")
        return []

    # Recursively fetch sub-sitemaps
    for sub_url in sub_sitemaps:
        sub_entries = await fetch_and_parse_sitemap(sub_url, client, max_depth - 1)
        entries.extend(sub_entries)

    return entries


async def fetch_page_title(url: str, client: httpx.AsyncClient) -> str | None:
    """Fetch a page and extract its <title> tag."""
    try:
        resp = await client.get(url, timeout=TITLE_FETCH_TIMEOUT)
        resp.raise_for_status()
    except httpx.HTTPError:
        return None

    content_type = resp.headers.get("content-type", "")
    if "html" not in content_type:
        return None

    from bs4 import BeautifulSoup

    soup = BeautifulSoup(resp.text[:50000], "html.parser")
    title_tag = soup.find("title")
    return title_tag.get_text(strip=True) if title_tag else None


async def crawl_sitemap(
    website_url: str,
    fetch_titles: bool = False,
    client: httpx.AsyncClient | None = None,
) -> list[SitemapEntry]:
    """Full sitemap crawl: discover sitemaps, parse all, optionally fetch titles.

    Returns list of SitemapEntry with url, title, and lastmod.
    """
    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(
            timeout=SITEMAP_TIMEOUT,
            headers={"User-Agent": USER_AGENT},
            follow_redirects=True,
        )

    try:
        sitemap_urls = await discover_sitemaps(website_url, client)
        if not sitemap_urls:
            logger.warning(f"No sitemaps found for {website_url}")
            return []

        all_entries: list[SitemapEntry] = []
        for sitemap_url in sitemap_urls:
            entries = await fetch_and_parse_sitemap(sitemap_url, client)
            all_entries.extend(entries)

        # Optionally fetch page titles (rate-limited by httpx connection pool)
        if fetch_titles:
            for entry in all_entries:
                if not entry.title:
                    entry.title = await fetch_page_title(entry.url, client)

        return all_entries
    finally:
        if own_client:
            await client.aclose()
