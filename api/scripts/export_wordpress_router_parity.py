"""Export the parity oracle the TypeScript `wordpress` router port needs.

`api/src/api/wordpress.py` is three endpoints over the client ported in ledger
item 5.9a, and all three of the interesting decisions live in the router rather
than the client:

* `_get_wp_client` has two 400s, one for missing credentials and one for a
  `wp_app_password` that will not decrypt, and the second one is an
  `except Exception` so a missing `WP_ENCRYPTION_KEY` lands there too;
* `/test` swallows both of those, and every `WordPressError`, into
  `{"connected": false, "error": ...}`, while `/categories` and `/authors` let
  the 400s out as real 400s and let a `WordPressError` escape as a 500;
* both list endpoints reproject the WordPress payload, `/categories` with a
  `.get("count", 0)` default and `["id"]`/`["name"]`/`["slug"]` subscripts that
  raise on a missing key.

The three real endpoint coroutines are driven here rather than reimplemented,
against a local HTTP server standing in for the WordPress install and a stubbed
session standing in for the `_get_user_profile` lookup, so the reprojection, the
error grammar and the request the client actually issues are all recorded from a
real run over a real socket.

The Fernet key below is a throwaway generated for this file. It encrypts one
fixture string and appears in the oracle so the TypeScript side can decrypt the
same token; no real credential is involved.

Usage:
    uv run python scripts/export_wordpress_router_parity.py
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qsl, urlparse

from fastapi import HTTPException

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "api"))

from src.api.wordpress import (  # noqa: E402
    list_authors,
    list_categories,
    test_connection,
)
from src.config import settings  # noqa: E402
from src.models.profile import WebsiteProfile  # noqa: E402
from src.services.crypto import encrypt  # noqa: E402
from src.services.wordpress import WordPressError  # noqa: E402

OUT = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "src"
    / "app"
    / "api"
    / "profiles"
    / "data"
    / "wordpress-router-parity.json"
)

# A throwaway Fernet key: 32 bytes of 0x07, url-safe base64 with its padding.
TEST_KEY = base64.urlsafe_b64encode(bytes([7] * 32)).decode()
APP_PASSWORD = "abcd EFGH 1234 ijkl"
USERNAME = "wp-user"
PROFILE_ID = uuid.UUID("22222222-2222-4222-8222-222222222222")
USER = SimpleNamespace(id="user-under-test")

CATEGORIES = "/wp-json/wp/v2/categories"
USERS = "/wp-json/wp/v2/users"
ROOT = "/wp-json"

_routes: dict[str, dict] = {}
_seen: list[dict] = []


def _json_route(status: int, payload: object) -> dict:
    return {
        "status": status,
        "body": json.dumps(payload),
        "content_type": "application/json",
    }


def _text_route(status: int, body: str, content_type: str = "text/html") -> dict:
    return {"status": status, "body": body, "content_type": content_type}


LONG_HTML = "<html><body>" + ("nginx: not found. " * 30) + "</body></html>"

# Every profile shape the two 400s and the happy path can see. `password` is the
# literal stored in `wp_app_password`; `encrypt` marks the ones that get a real
# Fernet token rather than the literal.
PROFILES: dict[str, dict] = {
    "ok": {"wp_url": "{BASE}", "wp_username": USERNAME, "encrypt": True},
    "missing": {"absent": True},
    "no-url": {"wp_url": None, "wp_username": USERNAME, "encrypt": True},
    "empty-url": {"wp_url": "", "wp_username": USERNAME, "encrypt": True},
    "no-username": {"wp_url": "{BASE}", "wp_username": None, "encrypt": True},
    "empty-username": {"wp_url": "{BASE}", "wp_username": "", "encrypt": True},
    "no-password": {"wp_url": "{BASE}", "wp_username": USERNAME, "password": None},
    "empty-password": {"wp_url": "{BASE}", "wp_username": USERNAME, "password": ""},
    "undecryptable": {
        "wp_url": "{BASE}",
        "wp_username": USERNAME,
        "password": "not-a-fernet-token",
    },
    "unset-key": {
        "wp_url": "{BASE}",
        "wp_username": USERNAME,
        "encrypt": True,
        "unset_key": True,
    },
    # The client strips one known suffix, so a profile storing the admin URL
    # still reaches the same site root.
    "wp-admin-url": {
        "wp_url": "{BASE}/wp-admin",
        "wp_username": USERNAME,
        "encrypt": True,
    },
}

SCENARIOS: list[dict] = [
    # --- /test -----------------------------------------------------------
    {
        "name": "test-success",
        "endpoint": "test",
        "profile": "ok",
        "routes": {
            f"GET {ROOT}": _json_route(
                200, {"name": "Test Site", "description": "Just another site"}
            )
        },
    },
    {
        "name": "test-success-name-absent",
        "endpoint": "test",
        "profile": "ok",
        "routes": {f"GET {ROOT}": _json_route(200, {"description": "No name here"})},
    },
    {
        "name": "test-success-name-null",
        "endpoint": "test",
        "profile": "ok",
        "routes": {f"GET {ROOT}": _json_route(200, {"name": None})},
    },
    {
        "name": "test-success-name-not-a-string",
        "endpoint": "test",
        "profile": "ok",
        "routes": {f"GET {ROOT}": _json_route(200, {"name": 1234})},
    },
    {
        "name": "test-success-through-stripped-wp-admin",
        "endpoint": "test",
        "profile": "wp-admin-url",
        "routes": {f"GET {ROOT}": _json_route(200, {"name": "Stripped"})},
    },
    {
        "name": "test-401-message-swallowed",
        "endpoint": "test",
        "profile": "ok",
        "routes": {
            f"GET {ROOT}": _json_route(
                401,
                {
                    "code": "rest_not_logged_in",
                    "message": "You are not currently logged in.",
                    "data": {"status": 401},
                },
            )
        },
    },
    {
        "name": "test-404-html-swallowed",
        "endpoint": "test",
        "profile": "ok",
        "routes": {f"GET {ROOT}": _text_route(404, LONG_HTML)},
    },
    {
        "name": "test-non-json-200-swallowed",
        "endpoint": "test",
        "profile": "ok",
        "routes": {f"GET {ROOT}": _text_route(200, "<html>a parked domain</html>")},
    },
    {
        "name": "test-root-returns-json-array",
        "endpoint": "test",
        "profile": "ok",
        "routes": {f"GET {ROOT}": _json_route(200, [{"name": "not a site"}])},
    },
    {
        "name": "test-root-returns-json-null",
        "endpoint": "test",
        "profile": "ok",
        "routes": {f"GET {ROOT}": _json_route(200, None)},
    },
    {
        "name": "test-root-returns-json-string",
        "endpoint": "test",
        "profile": "ok",
        "routes": {f"GET {ROOT}": _json_route(200, "just a string")},
    },
    {
        "name": "test-profile-not-found",
        "endpoint": "test",
        "profile": "missing",
        "routes": {},
    },
    {
        "name": "test-no-url",
        "endpoint": "test",
        "profile": "no-url",
        "routes": {},
    },
    {
        "name": "test-empty-url",
        "endpoint": "test",
        "profile": "empty-url",
        "routes": {},
    },
    {
        "name": "test-no-username",
        "endpoint": "test",
        "profile": "no-username",
        "routes": {},
    },
    {
        "name": "test-empty-username",
        "endpoint": "test",
        "profile": "empty-username",
        "routes": {},
    },
    {
        "name": "test-no-password",
        "endpoint": "test",
        "profile": "no-password",
        "routes": {},
    },
    {
        "name": "test-empty-password",
        "endpoint": "test",
        "profile": "empty-password",
        "routes": {},
    },
    {
        "name": "test-undecryptable-password",
        "endpoint": "test",
        "profile": "undecryptable",
        "routes": {},
    },
    {
        "name": "test-unset-encryption-key",
        "endpoint": "test",
        "profile": "unset-key",
        "routes": {},
    },
    # --- /categories -----------------------------------------------------
    {
        "name": "categories-success",
        "endpoint": "categories",
        "profile": "ok",
        "routes": {
            f"GET {CATEGORIES}?page=1&per_page=100": _json_route(
                200,
                [
                    {
                        "id": 1,
                        "name": "Uncategorized",
                        "slug": "uncategorized",
                        "count": 12,
                        "description": "dropped by the projection",
                        "parent": 0,
                    },
                    {
                        "id": 7,
                        "name": "Espresso & Milk",
                        "slug": "espresso-milk",
                        "count": 0,
                    },
                ],
            )
        },
    },
    {
        "name": "categories-count-absent-defaults-to-zero",
        "endpoint": "categories",
        "profile": "ok",
        "routes": {
            f"GET {CATEGORIES}?page=1&per_page=100": _json_route(
                200, [{"id": 3, "name": "No Count", "slug": "no-count"}]
            )
        },
    },
    {
        "name": "categories-count-null-is-not-defaulted",
        "endpoint": "categories",
        "profile": "ok",
        "routes": {
            f"GET {CATEGORIES}?page=1&per_page=100": _json_route(
                200,
                [{"id": 5, "name": "Null Count", "slug": "null-count", "count": None}],
            )
        },
    },
    {
        "name": "categories-count-not-an-int-passes-through",
        "endpoint": "categories",
        "profile": "ok",
        "routes": {
            f"GET {CATEGORIES}?page=1&per_page=100": _json_route(
                200, [{"id": 4, "name": "Stringy", "slug": "stringy", "count": "9"}]
            )
        },
    },
    {
        "name": "categories-empty",
        "endpoint": "categories",
        "profile": "ok",
        "routes": {f"GET {CATEGORIES}?page=1&per_page=100": _json_route(200, [])},
    },
    {
        "name": "categories-missing-id-raises",
        "endpoint": "categories",
        "profile": "ok",
        "routes": {
            f"GET {CATEGORIES}?page=1&per_page=100": _json_route(
                200, [{"name": "No Id", "slug": "no-id", "count": 1}]
            )
        },
    },
    {
        "name": "categories-401-escapes",
        "endpoint": "categories",
        "profile": "ok",
        "routes": {
            f"GET {CATEGORIES}?page=1&per_page=100": _json_route(
                401, {"message": "Sorry, you are not allowed to do that."}
            )
        },
    },
    {
        "name": "categories-profile-not-found",
        "endpoint": "categories",
        "profile": "missing",
        "routes": {},
    },
    {
        "name": "categories-no-credentials",
        "endpoint": "categories",
        "profile": "no-url",
        "routes": {},
    },
    {
        "name": "categories-undecryptable-password",
        "endpoint": "categories",
        "profile": "undecryptable",
        "routes": {},
    },
    # --- /authors --------------------------------------------------------
    {
        "name": "authors-success",
        "endpoint": "authors",
        "profile": "ok",
        "routes": {
            f"GET {USERS}?page=1&per_page=100&roles=administrator,editor,author": (
                _json_route(
                    200,
                    [
                        {
                            "id": 1,
                            "name": "Site Admin",
                            "slug": "admin",
                            "link": "dropped by the projection",
                            "description": "",
                        },
                        {"id": 5, "name": "Guest Writer", "slug": "guest-writer"},
                    ],
                )
            )
        },
    },
    {
        "name": "authors-empty",
        "endpoint": "authors",
        "profile": "ok",
        "routes": {
            f"GET {USERS}?page=1&per_page=100&roles=administrator,editor,author": (
                _json_route(200, [])
            )
        },
    },
    {
        "name": "authors-missing-slug-raises",
        "endpoint": "authors",
        "profile": "ok",
        "routes": {
            f"GET {USERS}?page=1&per_page=100&roles=administrator,editor,author": (
                _json_route(200, [{"id": 2, "name": "No Slug"}])
            )
        },
    },
    {
        "name": "authors-403-escapes",
        "endpoint": "authors",
        "profile": "ok",
        "routes": {
            f"GET {USERS}?page=1&per_page=100&roles=administrator,editor,author": (
                _json_route(
                    403, {"message": "Sorry, you are not allowed to list users."}
                )
            )
        },
    },
    {
        "name": "authors-profile-not-found",
        "endpoint": "authors",
        "profile": "missing",
        "routes": {},
    },
    {
        "name": "authors-no-password",
        "endpoint": "authors",
        "profile": "no-password",
        "routes": {},
    },
]


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


class _Result:
    def __init__(self, value: object) -> None:
        self._value = value

    def scalar_one_or_none(self) -> object:
        return self._value


class _Session:
    """Just enough of `AsyncSession` for `_get_user_profile`."""

    def __init__(self, profile: object) -> None:
        self._profile = profile

    async def execute(self, _statement: object) -> _Result:
        return _Result(self._profile)


def _build_profile(spec: dict, base: str) -> WebsiteProfile | None:
    if spec.get("absent"):
        return None
    password = encrypt(APP_PASSWORD) if spec.get("encrypt") else spec.get("password")
    wp_url = spec.get("wp_url")
    if isinstance(wp_url, str):
        wp_url = wp_url.replace("{BASE}", base)
    return WebsiteProfile(
        id=PROFILE_ID,
        user_id=USER.id,
        name="Fixture Blog",
        website_url="https://example.com",
        wp_url=wp_url,
        wp_username=spec.get("wp_username"),
        wp_app_password=password,
    )


ENDPOINTS = {
    "test": test_connection,
    "categories": list_categories,
    "authors": list_authors,
}


async def _run_scenarios(base: str) -> list[dict]:
    global _routes, _seen
    results: list[dict] = []
    for scenario in SCENARIOS:
        spec = PROFILES[scenario["profile"]]
        _routes = {
            _route_key("GET", key.split(" ", 1)[1]): {**route}
            for key, route in scenario["routes"].items()
        }
        _seen = []
        # The token has to be produced with the real key even for the scenario
        # that then blanks it, because that is the shape the row already has.
        settings.wp_encryption_key = TEST_KEY
        profile = _build_profile(spec, base)
        stored_password = profile.wp_app_password if profile else None
        if spec.get("unset_key"):
            settings.wp_encryption_key = ""

        endpoint = ENDPOINTS[scenario["endpoint"]]
        outcome: dict
        try:
            value = await endpoint(PROFILE_ID, USER, _Session(profile))
        except HTTPException as error:
            outcome = {"http_status": error.status_code, "detail": error.detail}
            summary = f"HTTPException {error.status_code}: {error.detail}"
        except WordPressError as error:
            outcome = {
                "unhandled": "WordPressError",
                "message": str(error),
                "status_code": error.status_code,
            }
            summary = f"unhandled WordPressError: {error}"
        except (KeyError, TypeError, AttributeError) as error:
            outcome = {"unhandled": type(error).__name__, "message": str(error)}
            summary = f"unhandled {type(error).__name__}: {error}"
        else:
            outcome = {"returned": value}
            summary = f"returned {json.dumps(value)[:70]}"
        finally:
            settings.wp_encryption_key = TEST_KEY

        results.append(
            {
                "name": scenario["name"],
                "endpoint": scenario["endpoint"],
                "profile": (
                    None
                    if profile is None
                    else {
                        "wp_url": (
                            profile.wp_url.replace(base, "{BASE}")
                            if isinstance(profile.wp_url, str)
                            else profile.wp_url
                        ),
                        "wp_username": profile.wp_username,
                        "wp_app_password": stored_password,
                    }
                ),
                "unset_key": bool(spec.get("unset_key")),
                "routes": {key: {**route} for key, route in scenario["routes"].items()},
                "requests": _seen,
                "expected": outcome,
            }
        )
        print(f"  {scenario['name']}: {len(_seen)} request(s), {summary}")
    _routes = {}
    _seen = []
    return results


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
        "generated_by": "api/scripts/export_wordpress_router_parity.py",
        "source": "api/src/api/wordpress.py",
        "python_version": sys.version.split()[0],
        "encryption_key": TEST_KEY,
        "app_password": APP_PASSWORD,
        "profile_id": str(PROFILE_ID),
        "scenarios": scenarios,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    print(f"wrote {args.out} ({len(scenarios)} scenarios)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
