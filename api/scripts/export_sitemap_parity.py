"""Export the parity oracle the TypeScript `sitemap` port needs.

`api/src/services/sitemap.py` splits in two the same way `link_validator.py`
did, so this script exports two kinds of case:

1. **Parse cases.** `parse_sitemap_xml` and `parse_robots_txt` are pure, so
   they are exported as an input/output table over the XML fixtures the pytest
   suite already uses plus the edge cases it covers (gzip, a missing `<loc>`,
   broken XML, an unknown root element). The fixtures themselves are copied
   next to the JSON so the oracle survives the deletion of `api/`.

2. **Network cases.** `discover_sitemaps`, `fetch_and_parse_sitemap` and
   `crawl_sitemap` reach the network, so each case is a scenario: a routing
   table this script serves from a local HTTP server, a call to make against
   it, and what the real Python function returned. The routing table is
   exported verbatim, so the TypeScript test drives an equivalent Node server
   from the same data rather than a hand-copied one, and every URL is templated
   back to `{BASE}` so it can run on its own port.

The pytest suite mocks `httpx.AsyncClient` for these; this export does not.
Every request here goes over a real socket to a real server, which is also what
pins the two behaviours the mocks never exercised: a server that hangs up
without answering, and a gzipped sitemap fetched over HTTP.

Usage:
    uv run python scripts/export_sitemap_parity.py
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import json
import shutil
import socket
import sys
import threading
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "api"))

from src.services.sitemap import (  # noqa: E402
    SitemapParseError,
    crawl_sitemap,
    discover_sitemaps,
    fetch_and_parse_sitemap,
    parse_robots_txt,
    parse_sitemap_xml,
)

FIXTURES = REPO_ROOT / "api" / "tests" / "fixtures"
DATA = REPO_ROOT / "web" / "src" / "mastra" / "sitemap" / "data"
OUT = DATA / "sitemap-parity.json"
FIXTURE_OUT = DATA / "fixtures"

# Every fixture the pytest suite reads, copied so the oracle outlives `api/`.
FIXTURE_FILES = [
    "simple_sitemap.xml",
    "sitemap_index.xml",
    "sub_sitemap_pages.xml",
    "sub_sitemap_posts.xml",
    "sub_sitemap_products.xml",
    "malformed_sitemap.xml",
    "empty_sitemap.xml",
]

# The host the sitemap fixtures were written against. Routes flagged
# `template_base` have it rewritten to the local server so a sitemap index
# points at sub-sitemaps this server actually serves.
FIXTURE_HOST = "https://example.com"

ROBOTS_ONE = (
    "User-agent: *\nDisallow: /admin/\nSitemap: https://example.com/sitemap.xml\n"
)
ROBOTS_TWO = (
    "User-agent: *\n"
    "Sitemap: https://example.com/sitemap-posts.xml\n"
    "Sitemap: https://example.com/sitemap-pages.xml\n"
)

# (name, xml) cases parsed straight from a literal rather than a fixture.
INLINE_PARSE_CASES: list[tuple[str, bytes]] = [
    ("broken-xml", b"<not valid xml at all>>>"),
    ("unknown-root", b'<?xml version="1.0"?><unknown><item>test</item></unknown>'),
    (
        "no-namespace-urlset",
        b"<urlset><url><loc>https://example.com/a/</loc></url></urlset>",
    ),
    (
        "prefixed-namespace",
        b'<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">'
        b"<sm:url><sm:loc>https://example.com/b/</sm:loc>"
        b"<sm:lastmod>2024-07-04</sm:lastmod></sm:url></sm:urlset>",
    ),
    (
        "wrong-namespace-urlset",
        b'<urlset xmlns="https://example.com/not-sitemaps">'
        b"<url><loc>https://example.com/c/</loc></url></urlset>",
    ),
    (
        "empty-loc",
        b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        b"<url><loc></loc></url><url><loc>https://example.com/d/</loc></url></urlset>",
    ),
    (
        "whitespace-around-loc",
        b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        b"<url><loc>\n  https://example.com/e/\n  </loc>"
        b"<lastmod>  2024-08-09  </lastmod></url></urlset>",
    ),
    (
        "nested-index-in-urlset",
        b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        b"<url><loc>https://example.com/f/</loc></url>"
        b"<sitemap><loc>https://example.com/nested.xml</loc></sitemap></urlset>",
    ),
]

ROBOTS_CASES: list[tuple[str, str]] = [
    ("single-sitemap", ROBOTS_ONE),
    ("multiple-sitemaps", ROBOTS_TWO),
    ("no-sitemaps", "User-agent: *\nDisallow: /admin/\n"),
    ("case-insensitive", "SITEMAP: https://example.com/sitemap.xml\n"),
    ("empty", ""),
    ("bare-directive", "Sitemap:\n"),
    ("crlf-line-endings", "User-agent: *\r\nSitemap: https://example.com/a.xml\r\n"),
    ("indented", "   Sitemap:   https://example.com/b.xml   \n"),
]


def _route(
    status: int = 200,
    body: str | None = None,
    fixture: str | None = None,
    content_type: str = "application/xml",
    template_base: bool = False,
    gzipped: bool = False,
    reset: bool = False,
) -> dict:
    return {
        "status": status,
        "body": body,
        "fixture": fixture,
        "content_type": content_type,
        "template_base": template_base,
        "gzipped": gzipped,
        "reset": reset,
    }


NOT_FOUND = _route(status=404, body="")

# Each scenario is a routing table plus one call against it.
SCENARIOS: list[dict] = [
    {
        "name": "discover-from-robots-txt",
        "routes": {
            "/robots.txt": _route(body=ROBOTS_TWO, content_type="text/plain"),
        },
        "call": {"fn": "discover_sitemaps", "url": "{BASE}"},
    },
    {
        "name": "discover-falls-back-to-sitemap-xml",
        "routes": {
            "/robots.txt": NOT_FOUND,
            "/sitemap.xml": _route(fixture="simple_sitemap.xml"),
        },
        "call": {"fn": "discover_sitemaps", "url": "{BASE}"},
    },
    {
        "name": "discover-falls-back-to-sitemap-index-xml",
        "routes": {
            "/robots.txt": _route(body="User-agent: *\n", content_type="text/plain"),
            "/sitemap.xml": NOT_FOUND,
            "/sitemap_index.xml": _route(fixture="sitemap_index.xml"),
        },
        "call": {"fn": "discover_sitemaps", "url": "{BASE}"},
    },
    {
        "name": "discover-finds-nothing",
        "routes": {},
        "call": {"fn": "discover_sitemaps", "url": "{BASE}"},
    },
    {
        "name": "discover-survives-robots-hangup",
        "routes": {
            "/robots.txt": _route(reset=True),
            "/sitemap.xml": _route(fixture="simple_sitemap.xml"),
        },
        "call": {"fn": "discover_sitemaps", "url": "{BASE}"},
    },
    {
        "name": "discover-from-path-keeps-origin",
        "routes": {
            "/robots.txt": _route(body=ROBOTS_ONE, content_type="text/plain"),
        },
        "call": {"fn": "discover_sitemaps", "url": "{BASE}/blog/some-post/?a=1"},
    },
    {
        "name": "fetch-simple-sitemap",
        "routes": {"/sitemap.xml": _route(fixture="simple_sitemap.xml")},
        "call": {"fn": "fetch_and_parse_sitemap", "url": "{BASE}/sitemap.xml"},
    },
    {
        "name": "fetch-index-recursively",
        "routes": {
            "/sitemap.xml": _route(fixture="sitemap_index.xml", template_base=True),
            "/sitemap-pages.xml": _route(fixture="sub_sitemap_pages.xml"),
            "/sitemap-posts.xml": _route(fixture="sub_sitemap_posts.xml"),
            "/sitemap-products.xml": _route(fixture="sub_sitemap_products.xml"),
        },
        "call": {"fn": "fetch_and_parse_sitemap", "url": "{BASE}/sitemap.xml"},
    },
    {
        "name": "fetch-index-stops-at-max-depth",
        "routes": {
            "/sitemap.xml": _route(fixture="sitemap_index.xml", template_base=True),
            "/sitemap-pages.xml": _route(fixture="sub_sitemap_pages.xml"),
            "/sitemap-posts.xml": _route(fixture="sub_sitemap_posts.xml"),
            "/sitemap-products.xml": _route(fixture="sub_sitemap_products.xml"),
        },
        "call": {
            "fn": "fetch_and_parse_sitemap",
            "url": "{BASE}/sitemap.xml",
            "max_depth": 1,
        },
    },
    {
        "name": "fetch-missing-sitemap",
        "routes": {},
        "call": {"fn": "fetch_and_parse_sitemap", "url": "{BASE}/missing.xml"},
    },
    {
        "name": "fetch-server-error",
        "routes": {
            "/sitemap.xml": _route(status=500, body="boom", content_type="text/plain")
        },
        "call": {"fn": "fetch_and_parse_sitemap", "url": "{BASE}/sitemap.xml"},
    },
    {
        "name": "fetch-malformed-sitemap",
        "routes": {
            "/sitemap.xml": _route(body="<not valid xml at all>>>"),
        },
        "call": {"fn": "fetch_and_parse_sitemap", "url": "{BASE}/sitemap.xml"},
    },
    {
        "name": "fetch-gzipped-sitemap",
        "routes": {
            "/sitemap.xml": _route(fixture="simple_sitemap.xml", gzipped=True),
        },
        "call": {"fn": "fetch_and_parse_sitemap", "url": "{BASE}/sitemap.xml"},
    },
    {
        "name": "fetch-hangup",
        "routes": {"/sitemap.xml": _route(reset=True)},
        "call": {"fn": "fetch_and_parse_sitemap", "url": "{BASE}/sitemap.xml"},
    },
    {
        "name": "crawl-full",
        "routes": {
            "/robots.txt": _route(
                body="Sitemap: {BASE}/sitemap.xml", content_type="text/plain"
            ),
            "/sitemap.xml": _route(fixture="simple_sitemap.xml"),
        },
        "call": {"fn": "crawl_sitemap", "url": "{BASE}"},
    },
    {
        "name": "crawl-two-sitemaps-from-robots",
        "routes": {
            "/robots.txt": _route(
                body=(
                    "Sitemap: {BASE}/sitemap-pages.xml\n"
                    "Sitemap: {BASE}/sitemap-posts.xml\n"
                ),
                content_type="text/plain",
            ),
            "/sitemap-pages.xml": _route(fixture="sub_sitemap_pages.xml"),
            "/sitemap-posts.xml": _route(fixture="sub_sitemap_posts.xml"),
        },
        "call": {"fn": "crawl_sitemap", "url": "{BASE}"},
    },
    {
        "name": "crawl-no-sitemaps",
        "routes": {},
        "call": {"fn": "crawl_sitemap", "url": "{BASE}"},
    },
    {
        "name": "crawl-empty-sitemap",
        "routes": {
            "/robots.txt": NOT_FOUND,
            "/sitemap.xml": _route(fixture="empty_sitemap.xml"),
        },
        "call": {"fn": "crawl_sitemap", "url": "{BASE}"},
    },
]

# Set for the duration of one scenario; the handler reads it per request.
_routes: dict[str, dict] = {}
_base = ""


def _body_for(route: dict) -> bytes:
    if route["fixture"]:
        raw = (FIXTURES / route["fixture"]).read_bytes()
    else:
        raw = (route["body"] or "").encode()
    if route["template_base"]:
        raw = raw.replace(FIXTURE_HOST.encode(), _base.encode())
    else:
        raw = raw.replace(b"{BASE}", _base.encode())
    if route["gzipped"]:
        raw = gzip.compress(raw)
    return raw


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: object) -> None:  # keep the export output clean
        return

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's spelling
        path = urlparse(self.path).path
        route = _routes.get(path)
        if route is None:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if route["reset"]:
            # Hang up without answering, so the client raises a transport error
            # rather than seeing a status code.
            self.close_connection = True
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.connection.close()
            return
        body = _body_for(route)
        self.send_response(route["status"])
        self.send_header("Content-Type", route["content_type"])
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def _entries(entries: list) -> list[dict]:
    return [asdict(entry) for entry in entries]


def _template(value: str) -> str:
    return value.replace(_base, "{BASE}")


async def _run_scenarios() -> list[dict]:
    global _routes
    results: list[dict] = []
    for scenario in SCENARIOS:
        _routes = {path: {**route} for path, route in scenario["routes"].items()}
        call = scenario["call"]
        url = call["url"].replace("{BASE}", _base)
        if call["fn"] == "discover_sitemaps":
            found = await discover_sitemaps(url)
            expected: object = [_template(item) for item in found]
            summary = f"{len(found)} sitemap(s)"
        elif call["fn"] == "fetch_and_parse_sitemap":
            import httpx

            async with httpx.AsyncClient(
                timeout=30.0,
                headers={"User-Agent": "ContentPipelineBot/1.0"},
                follow_redirects=True,
            ) as client:
                kwargs = {"max_depth": call["max_depth"]} if "max_depth" in call else {}
                found = await fetch_and_parse_sitemap(url, client, **kwargs)
            expected = _entries(found)
            summary = f"{len(found)} entr(ies)"
        elif call["fn"] == "crawl_sitemap":
            found = await crawl_sitemap(url)
            expected = _entries(found)
            summary = f"{len(found)} entr(ies)"
        else:
            raise ValueError(f"unknown call: {call['fn']}")
        results.append({**scenario, "expected": expected})
        print(f"  {scenario['name']}: {summary}")
    _routes = {}
    return results


def _parse_cases() -> list[dict]:
    cases: list[dict] = []
    sources: list[tuple[str, dict, bytes]] = []
    for fixture in FIXTURE_FILES:
        sources.append(
            (fixture, {"fixture": fixture}, (FIXTURES / fixture).read_bytes())
        )
    raw_simple = (FIXTURES / "simple_sitemap.xml").read_bytes()
    sources.append(
        (
            "gzipped-simple",
            {"fixture": "simple_sitemap.xml", "gzipped": True},
            gzip.compress(raw_simple),
        )
    )
    for name, xml in INLINE_PARSE_CASES:
        sources.append((name, {"xml": xml.decode()}, xml))

    for name, source, content in sources:
        case: dict = {"name": name, **source}
        try:
            sub_sitemaps, entries = parse_sitemap_xml(content)
        except SitemapParseError as error:
            case["error"] = str(error)
        else:
            case["sub_sitemaps"] = sub_sitemaps
            case["entries"] = _entries(entries)
        cases.append(case)
    return cases


def main() -> int:
    global _base
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.daemon_threads = True
    _base = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"local server on {_base}")
    try:
        scenarios = asyncio.run(_run_scenarios())
    finally:
        server.shutdown()
        server.server_close()

    parse_cases = _parse_cases()
    robots_cases = [
        {"name": name, "content": content, "expected": parse_robots_txt(content, "")}
        for name, content in ROBOTS_CASES
    ]

    FIXTURE_OUT.mkdir(parents=True, exist_ok=True)
    for fixture in FIXTURE_FILES:
        shutil.copyfile(FIXTURES / fixture, FIXTURE_OUT / fixture)

    payload = {
        "generated_by": "api/scripts/export_sitemap_parity.py",
        "source": "api/src/services/sitemap.py",
        "python_version": sys.version.split()[0],
        "fixture_host": FIXTURE_HOST,
        "parse_cases": parse_cases,
        "robots_cases": robots_cases,
        "scenarios": scenarios,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(
        f"wrote {args.out.relative_to(REPO_ROOT)}: {len(parse_cases)} parse cases, "
        f"{len(robots_cases)} robots cases, {len(scenarios)} scenarios; "
        f"copied {len(FIXTURE_FILES)} fixtures"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
