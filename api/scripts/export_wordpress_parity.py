"""Export the parity oracle the TypeScript `wordpress` client port needs.

`api/src/services/wordpress.py` is a thin REST client, so this script exports
two kinds of case:

1. **Constructor cases.** The URL normalisation (`rstrip("/")` plus a single
   case-insensitive suffix strip) and the Basic credential are pure, so they
   are exported as an input/output table over `api_url`, `site_url` and the
   `Authorization` header the client sets.

2. **Network scenarios.** `test_connection`, `list_categories` and
   `list_users` reach the network, so each case is a scenario: a routing table
   this script serves from a local HTTP server, the call to make against it,
   every request the server actually saw, and what the real Python client
   returned or raised. The routing table is exported verbatim so the
   TypeScript test drives an equivalent Node server from the same data rather
   than a hand-copied one.

The pytest suite in `api/tests/phase10/test_wordpress_service.py` replaces
`client._client.request` with an `AsyncMock`, so it never exercises the
pagination query string, the `>= 400` error grammar, or the non-JSON branch
against a real response. Every request here goes over a real socket.

Only the read half of the client is exported. `upload_media`, `create_post`
and `update_post` have no TypeScript consumer until the publish workflows land
(ledger item 5.3c-iii-b), so porting them now would be speculative.

Usage:
    uv run python scripts/export_wordpress_parity.py
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlparse

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "api"))

from src.services.wordpress import WordPressClient, WordPressError  # noqa: E402

DATA = REPO_ROOT / "web" / "src" / "mastra" / "wordpress" / "data"
OUT = DATA / "wordpress-parity.json"

USERNAME = "pipeline-bot"
APP_PASSWORD = "abcd efgh ijkl mnop"

# (name, wp_url, username, app_password)
CONSTRUCTOR_CASES: list[tuple[str, str, str, str]] = [
    ("plain-origin", "https://example.com", USERNAME, APP_PASSWORD),
    ("one-trailing-slash", "https://example.com/", USERNAME, APP_PASSWORD),
    ("many-trailing-slashes", "https://example.com///", USERNAME, APP_PASSWORD),
    ("subdirectory-install", "https://example.com/blog", USERNAME, APP_PASSWORD),
    (
        "subdirectory-trailing-slash",
        "https://example.com/blog/",
        USERNAME,
        APP_PASSWORD,
    ),
    ("strips-wp-admin", "https://example.com/wp-admin", USERNAME, APP_PASSWORD),
    ("strips-wp-admin-slash", "https://example.com/wp-admin/", USERNAME, APP_PASSWORD),
    (
        "strips-wp-admin-uppercase",
        "https://example.com/WP-ADMIN",
        USERNAME,
        APP_PASSWORD,
    ),
    (
        "strips-wp-admin-mixed-case",
        "https://example.com/Wp-Admin",
        USERNAME,
        APP_PASSWORD,
    ),
    ("strips-wp-login", "https://example.com/wp-login.php", USERNAME, APP_PASSWORD),
    ("strips-wp-json", "https://example.com/wp-json", USERNAME, APP_PASSWORD),
    ("strips-wp-json-slash", "https://example.com/wp-json/", USERNAME, APP_PASSWORD),
    (
        "strips-wp-json-wp-v2",
        "https://example.com/wp-json/wp/v2",
        USERNAME,
        APP_PASSWORD,
    ),
    (
        "strips-wp-json-wp-v2-slash",
        "https://example.com/wp-json/wp/v2/",
        USERNAME,
        APP_PASSWORD,
    ),
    # Only one suffix is stripped: the loop breaks on the first match.
    (
        "strips-one-suffix-only",
        "https://example.com/wp-admin/wp-json",
        USERNAME,
        APP_PASSWORD,
    ),
    # Without the `break` the loop would keep going and strip `/wp-json` too,
    # because `/wp-admin` is earlier in the tuple than `/wp-json`.
    (
        "strips-one-suffix-only-reversed",
        "https://example.com/wp-json/wp-admin",
        USERNAME,
        APP_PASSWORD,
    ),
    # The suffix must be preceded by a slash, so this one is left alone.
    (
        "leaves-unslashed-lookalike",
        "https://example.com/my-wp-admin",
        USERNAME,
        APP_PASSWORD,
    ),
    (
        "leaves-inner-occurrence",
        "https://example.com/wp-admin/page",
        USERNAME,
        APP_PASSWORD,
    ),
    (
        "subdirectory-with-wp-json",
        "https://example.com/blog/wp-json",
        USERNAME,
        APP_PASSWORD,
    ),
    ("empty-url", "", USERNAME, APP_PASSWORD),
    ("bare-slash", "/", USERNAME, APP_PASSWORD),
    ("no-scheme", "example.com", USERNAME, APP_PASSWORD),
    ("keeps-query-string", "https://example.com/?a=1", USERNAME, APP_PASSWORD),
    ("empty-password", "https://example.com", USERNAME, ""),
    ("colon-in-password", "https://example.com", USERNAME, "a:b:c"),
    ("empty-username", "https://example.com", "", APP_PASSWORD),
    ("non-ascii-credentials", "https://example.com", "wordpress-üser", "påss wörd"),
]


def _json_route(status: int, payload: object) -> dict:
    return {
        "status": status,
        "body": json.dumps(payload),
        "content_type": "application/json",
    }


def _text_route(status: int, body: str, content_type: str = "text/html") -> dict:
    return {"status": status, "body": body, "content_type": content_type}


def _categories(start: int, count: int) -> list[dict]:
    return [
        {
            "id": n,
            "name": f"Category {n}",
            "slug": f"category-{n}",
            "count": n * 2,
            "description": "",
        }
        for n in range(start, start + count)
    ]


def _users(start: int, count: int) -> list[dict]:
    return [
        {"id": n, "name": f"Author {n}", "slug": f"author-{n}", "link": "https://x/"}
        for n in range(start, start + count)
    ]


LONG_HTML = "<html><body>" + ("nginx 404 not found. " * 40) + "</body></html>"

CATEGORIES = "/wp-json/wp/v2/categories"
USERS = "/wp-json/wp/v2/users"
DEFAULT_ROLES = "administrator,editor,author"

SCENARIOS: list[dict] = [
    {
        "name": "test-connection-success",
        "url": "{BASE}",
        "routes": {
            "GET /wp-json": _json_route(
                200,
                {
                    "name": "Test Site",
                    "description": "Just another site",
                    "url": "https://example.com",
                    "gmt_offset": 0,
                },
            )
        },
        "call": {"fn": "test_connection"},
    },
    {
        "name": "test-connection-through-stripped-wp-admin",
        "url": "{BASE}/wp-admin",
        "routes": {"GET /wp-json": _json_route(200, {"name": "Stripped"})},
        "call": {"fn": "test_connection"},
    },
    {
        "name": "test-connection-subdirectory-install",
        "url": "{BASE}/blog",
        "routes": {"GET /blog/wp-json": _json_route(200, {"name": "Blog"})},
        "call": {"fn": "test_connection"},
    },
    {
        "name": "test-connection-401-with-message",
        "url": "{BASE}",
        "routes": {
            "GET /wp-json": _json_route(
                401,
                {
                    "code": "rest_not_logged_in",
                    "message": "You are not currently logged in.",
                    "data": {"status": 401},
                },
            )
        },
        "call": {"fn": "test_connection"},
    },
    {
        "name": "test-connection-404-long-html",
        "url": "{BASE}",
        "routes": {"GET /wp-json": _text_route(404, LONG_HTML)},
        "call": {"fn": "test_connection"},
    },
    {
        "name": "test-connection-400-json-without-message",
        "url": "{BASE}",
        "routes": {"GET /wp-json": _json_route(400, {"code": "rest_bad", "data": {}})},
        "call": {"fn": "test_connection"},
    },
    {
        "name": "test-connection-500-json-array",
        "url": "{BASE}",
        "routes": {"GET /wp-json": _json_route(500, ["boom", "again"])},
        "call": {"fn": "test_connection"},
    },
    {
        "name": "test-connection-500-long-json-array",
        "url": "{BASE}",
        "routes": {
            "GET /wp-json": _json_route(500, [f"error number {n}" for n in range(20)])
        },
        "call": {"fn": "test_connection"},
    },
    {
        "name": "test-connection-500-json-null",
        "url": "{BASE}",
        "routes": {"GET /wp-json": _json_route(500, None)},
        "call": {"fn": "test_connection"},
    },
    {
        "name": "test-connection-200-json-null",
        "url": "{BASE}",
        "routes": {"GET /wp-json": _json_route(200, None)},
        "call": {"fn": "test_connection"},
    },
    {
        "name": "test-connection-403-empty-body",
        "url": "{BASE}",
        "routes": {"GET /wp-json": _text_route(403, "")},
        "call": {"fn": "test_connection"},
    },
    {
        "name": "test-connection-200-non-json",
        "url": "{BASE}",
        "routes": {
            "GET /wp-json": _text_route(200, "<!DOCTYPE html><html>a theme</html>")
        },
        "call": {"fn": "test_connection"},
    },
    {
        "name": "test-connection-200-json-array",
        "url": "{BASE}",
        "routes": {"GET /wp-json": _json_route(200, [1, 2, 3])},
        "call": {"fn": "test_connection"},
    },
    {
        "name": "test-connection-200-json-with-html-content-type",
        "url": "{BASE}",
        "routes": {
            "GET /wp-json": _text_route(
                200, json.dumps({"name": "Sniffed"}), "text/html"
            )
        },
        "call": {"fn": "test_connection"},
    },
    {
        "name": "categories-single-page",
        "url": "{BASE}",
        "routes": {
            f"GET {CATEGORIES}?page=1&per_page=100": _json_route(200, _categories(1, 3))
        },
        "call": {"fn": "list_categories"},
    },
    {
        "name": "categories-empty",
        "url": "{BASE}",
        "routes": {f"GET {CATEGORIES}?page=1&per_page=100": _json_route(200, [])},
        "call": {"fn": "list_categories"},
    },
    {
        "name": "categories-two-pages",
        "url": "{BASE}",
        "routes": {
            f"GET {CATEGORIES}?page=1&per_page=100": _json_route(
                200, _categories(1, 100)
            ),
            f"GET {CATEGORIES}?page=2&per_page=100": _json_route(
                200, _categories(101, 3)
            ),
        },
        "call": {"fn": "list_categories"},
    },
    {
        "name": "categories-full-page-then-empty",
        "url": "{BASE}",
        "routes": {
            f"GET {CATEGORIES}?page=1&per_page=100": _json_route(
                200, _categories(1, 100)
            ),
            f"GET {CATEGORIES}?page=2&per_page=100": _json_route(200, []),
        },
        "call": {"fn": "list_categories"},
    },
    {
        "name": "categories-error-on-second-page",
        "url": "{BASE}",
        "routes": {
            f"GET {CATEGORIES}?page=1&per_page=100": _json_route(
                200, _categories(1, 100)
            ),
            f"GET {CATEGORIES}?page=2&per_page=100": _json_route(
                500, {"message": "Internal server error"}
            ),
        },
        "call": {"fn": "list_categories"},
    },
    {
        "name": "categories-through-subdirectory-install",
        "url": "{BASE}/blog",
        "routes": {
            f"GET /blog{CATEGORIES}?page=1&per_page=100": _json_route(
                200, _categories(7, 1)
            )
        },
        "call": {"fn": "list_categories"},
    },
    {
        "name": "users-default-roles",
        "url": "{BASE}",
        "routes": {
            f"GET {USERS}?page=1&per_page=100&roles={DEFAULT_ROLES}": _json_route(
                200, _users(1, 2)
            )
        },
        "call": {"fn": "list_users"},
    },
    {
        "name": "users-custom-roles",
        "url": "{BASE}",
        "routes": {
            f"GET {USERS}?page=1&per_page=100&roles=subscriber": _json_route(
                200, _users(5, 1)
            )
        },
        "call": {"fn": "list_users", "roles": ["subscriber"]},
    },
    {
        "name": "users-empty-roles-list",
        "url": "{BASE}",
        "routes": {
            f"GET {USERS}?page=1&per_page=100&roles=": _json_route(200, _users(9, 1))
        },
        "call": {"fn": "list_users", "roles": []},
    },
    {
        "name": "users-two-pages",
        "url": "{BASE}",
        "routes": {
            f"GET {USERS}?page=1&per_page=100&roles={DEFAULT_ROLES}": _json_route(
                200, _users(1, 100)
            ),
            f"GET {USERS}?page=2&per_page=100&roles={DEFAULT_ROLES}": _json_route(
                200, _users(101, 1)
            ),
        },
        "call": {"fn": "list_users"},
    },
    {
        "name": "users-401",
        "url": "{BASE}",
        "routes": {
            f"GET {USERS}?page=1&per_page=100&roles={DEFAULT_ROLES}": _json_route(
                401, {"message": "Sorry, you are not allowed to list users."}
            )
        },
        "call": {"fn": "list_users"},
    },
]

# Set for the duration of one scenario; the handler reads them per request.
_routes: dict[str, dict] = {}
_seen: list[dict] = []


def _route_key(method: str, target: str) -> str:
    parsed = urlparse(target)
    pairs = sorted(parse_qsl(parsed.query, keep_blank_values=True))
    if not pairs:
        return f"{method} {parsed.path}"
    query = "&".join(f"{k}={v}" for k, v in pairs)
    return f"{method} {parsed.path}?{query}"


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: object) -> None:  # keep the export output clean
        return

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's spelling
        parsed = urlparse(self.path)
        _seen.append(
            {
                "method": "GET",
                "path": parsed.path,
                "query": parsed.query,
                "authorization": self.headers.get("Authorization", ""),
            }
        )
        route = _routes.get(_route_key("GET", self.path))
        if route is None:
            body = b"no route"
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        body = route["body"].encode()
        self.send_response(route["status"])
        self.send_header("Content-Type", route["content_type"])
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


async def _run_scenarios(base: str) -> list[dict]:
    global _routes, _seen
    results: list[dict] = []
    for scenario in SCENARIOS:
        _routes = {key: {**route} for key, route in scenario["routes"].items()}
        _seen = []
        call = scenario["call"]
        client = WordPressClient(
            scenario["url"].replace("{BASE}", base), USERNAME, APP_PASSWORD
        )
        outcome: dict
        try:
            async with client:
                if call["fn"] == "test_connection":
                    value = await client.test_connection()
                elif call["fn"] == "list_categories":
                    value = await client.list_categories()
                elif call["fn"] == "list_users":
                    kwargs = {"roles": call["roles"]} if "roles" in call else {}
                    value = await client.list_users(**kwargs)
                else:
                    raise ValueError(f"unknown call: {call['fn']}")
        except WordPressError as error:
            outcome = {
                "error": str(error),
                "status_code": error.status_code,
            }
            summary = f"raised {error}"
        else:
            outcome = {"result": value}
            summary = f"returned {json.dumps(value)[:60]}"
        results.append(
            {
                **scenario,
                "api_url": client.api_url.replace(base, "{BASE}"),
                "site_url": client.site_url.replace(base, "{BASE}"),
                "requests": _seen,
                "expected": outcome,
            }
        )
        print(f"  {scenario['name']}: {len(_seen)} request(s), {summary}")
    _routes = {}
    _seen = []
    return results


def _constructor_cases() -> list[dict]:
    cases: list[dict] = []
    for name, wp_url, username, password in CONSTRUCTOR_CASES:
        client = WordPressClient(wp_url, username, password)
        cases.append(
            {
                "name": name,
                "wp_url": wp_url,
                "username": username,
                "app_password": password,
                "api_url": client.api_url,
                "site_url": client.site_url,
                "authorization": client._client.headers["Authorization"],
            }
        )
    return cases


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.daemon_threads = True
    base = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"local server on {base}")
    try:
        scenarios = asyncio.run(_run_scenarios(base))
    finally:
        server.shutdown()
        server.server_close()

    payload = {
        "generated_by": "api/scripts/export_wordpress_parity.py",
        "source": "api/src/services/wordpress.py",
        "python_version": sys.version.split()[0],
        "scenario_credentials": {"username": USERNAME, "app_password": APP_PASSWORD},
        "constructor_cases": _constructor_cases(),
        "scenarios": scenarios,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    print(f"wrote {args.out} ({len(scenarios)} scenarios)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
