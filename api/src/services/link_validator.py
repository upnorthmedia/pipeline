"""Post-edit link validation — strips confirmed dead links from content."""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field

import httpx

logger = logging.getLogger(__name__)

# Match markdown links: [text](url)
_MD_LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")

# Match HTML links: <a href="url">text</a>
_HTML_LINK_RE = re.compile(r'<a\s[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.IGNORECASE)

# HTTP status codes that indicate a confirmed dead link
_DEAD_STATUSES = {404, 410, 451}

_SEMAPHORE_LIMIT = 5
_REQUEST_TIMEOUT = 10


@dataclass
class RemovedLink:
    url: str
    status: int
    text: str


@dataclass
class ValidationResult:
    content: str
    removed: list[RemovedLink] = field(default_factory=list)


async def _check_url(
    client: httpx.AsyncClient,
    sem: asyncio.Semaphore,
    url: str,
) -> int | None:
    """HEAD-request a URL. Returns status code, or None on error."""
    async with sem:
        try:
            resp = await client.head(url, follow_redirects=True)
            return resp.status_code
        except Exception:
            return None


async def validate_links(content: str) -> ValidationResult:
    """Validate all markdown links in content, stripping confirmed 404s.

    Conservative approach: only strips links that return 404/410/451.
    Timeouts and connection errors keep the link (may be temporary).
    Relative and anchor links are skipped.
    """
    matches = _MD_LINK_RE.findall(content)
    if not matches:
        return ValidationResult(content=content)

    # Collect unique external URLs to check
    urls_to_check: dict[str, list[str]] = {}  # url -> [link_texts]
    for text, url in matches:
        if not url.startswith(("http://", "https://")):
            continue
        urls_to_check.setdefault(url, []).append(text)

    if not urls_to_check:
        return ValidationResult(content=content)

    # Check all URLs concurrently
    sem = asyncio.Semaphore(_SEMAPHORE_LIMIT)
    async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT) as client:
        tasks = {
            url: asyncio.create_task(_check_url(client, sem, url))
            for url in urls_to_check
        }
        results = {url: await task for url, task in tasks.items()}

    # Identify dead links
    dead_urls: set[str] = set()
    removed: list[RemovedLink] = []
    for url, status in results.items():
        if status in _DEAD_STATUSES:
            dead_urls.add(url)
            for text in urls_to_check[url]:
                removed.append(RemovedLink(url=url, status=status, text=text))
            logger.warning(f"Dead link ({status}): {url}")

    if not dead_urls:
        return ValidationResult(content=content)

    # Strip dead links from markdown: [text](url) -> text
    cleaned = content
    for url in dead_urls:
        # Replace all markdown links pointing to this dead URL
        cleaned = re.sub(
            r"\[([^\]]*)\]\(" + re.escape(url) + r"\)",
            r"\1",
            cleaned,
        )

    return ValidationResult(content=cleaned, removed=removed)


def strip_dead_links_html(html: str, dead_urls: set[str]) -> str:
    """Strip dead links from HTML: <a href="dead">text</a> -> text."""
    if not dead_urls:
        return html

    def _replace(m: re.Match) -> str:
        href = m.group(1)
        text = m.group(2)
        if href in dead_urls:
            return text
        return m.group(0)

    return _HTML_LINK_RE.sub(_replace, html)
