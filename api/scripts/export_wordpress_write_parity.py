"""Export the parity oracle the TypeScript `wordpress` write half needs.

`api/scripts/export_wordpress_parity.py` covers `test_connection`,
`list_categories` and `list_users`. This script covers the three methods that
script deliberately left alone: `upload_media`, `create_post` and
`update_post`, whose only caller is `api/src/pipeline/publish.py`.

The write half is where the request body starts mattering, so each scenario
records every byte the server received: the method, the path, the query, and
the `Authorization`, `Content-Type`, `Content-Disposition` and `Content-Length`
headers, plus the raw body base64-encoded. `upload_media` sends image bytes
under a `Content-Disposition` filename and then, conditionally, a second JSON
request; `create_post` builds its payload with truthiness tests that drop
falsy values; `update_post` forwards its keyword arguments untouched, nulls
included. None of those are visible from a return value alone.

`api/tests/phase10/test_wordpress_service.py` replaces
`client._client.request` with an `AsyncMock`, so it asserts on the arguments
httpx *would* have been given rather than on the bytes httpx actually sent.
Every request here goes over a real socket.

Usage:
    uv run python scripts/export_wordpress_write_parity.py
"""

from __future__ import annotations

import argparse
import asyncio
import base64
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
OUT = DATA / "wordpress-write-parity.json"

USERNAME = "pipeline-bot"
APP_PASSWORD = "abcd efgh ijkl mnop"

MEDIA = "/wp-json/wp/v2/media"
POSTS = "/wp-json/wp/v2/posts"

# A one-pixel PNG, so the exported bytes are a real image rather than a string
# that happens to be binary-shaped.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmM"
    "IQAAAABJRU5ErkJggg=="
)
PNG_B64 = base64.b64encode(PNG).decode()


def _json_route(status: int, payload: object) -> dict:
    return {
        "status": status,
        "body": json.dumps(payload),
        "content_type": "application/json",
    }


def _text_route(status: int, body: str, content_type: str = "text/html") -> dict:
    return {"status": status, "body": body, "content_type": content_type}


LONG_HTML = "<html><body>" + ("upload rejected by the origin. " * 40) + "</body></html>"

SCENARIOS: list[dict] = [
    # ---- upload_media -------------------------------------------------
    {
        "name": "upload-media-with-alt-text-patches-the-attachment",
        "routes": {
            f"POST {MEDIA}": _json_route(
                201,
                {
                    "id": 42,
                    "source_url": "https://example.com/wp-content/uploads/hero.png",
                    "alt_text": "",
                },
            ),
            f"POST {MEDIA}/42": _json_route(200, {"id": 42, "alt_text": "A hero"}),
        },
        "call": {
            "fn": "upload_media",
            "image_b64": PNG_B64,
            "filename": "hero.png",
            "mime_type": "image/png",
            "alt_text": "A hero",
        },
    },
    {
        "name": "upload-media-returns-the-first-response-not-the-patch",
        "routes": {
            f"POST {MEDIA}": _json_route(
                201, {"id": 7, "source_url": "https://x/7.png"}
            ),
            f"POST {MEDIA}/7": _json_route(200, {"id": 7, "alt_text": "replaced"}),
        },
        "call": {
            "fn": "upload_media",
            "image_b64": PNG_B64,
            "filename": "7.png",
            "mime_type": "image/png",
            "alt_text": "replaced",
        },
    },
    {
        "name": "upload-media-without-alt-text-sends-one-request",
        "routes": {
            f"POST {MEDIA}": _json_route(
                201, {"id": 9, "source_url": "https://x/9.png"}
            ),
            f"POST {MEDIA}/9": _json_route(200, {"unreachable": True}),
        },
        "call": {
            "fn": "upload_media",
            "image_b64": PNG_B64,
            "filename": "9.png",
            "mime_type": "image/png",
            "alt_text": "",
        },
    },
    {
        "name": "upload-media-omitting-alt-text-uses-the-empty-default",
        "routes": {
            f"POST {MEDIA}": _json_route(201, {"id": 11, "source_url": "https://x/a"}),
        },
        "call": {"fn": "upload_media", "image_b64": PNG_B64, "filename": "a.png"},
    },
    {
        "name": "upload-media-omitting-mime-type-uses-the-image-png-default",
        "routes": {
            f"POST {MEDIA}": _json_route(201, {"id": 12}),
        },
        "call": {"fn": "upload_media", "image_b64": PNG_B64, "filename": "b.bin"},
    },
    {
        "name": "upload-media-jpeg-mime-type",
        "routes": {
            f"POST {MEDIA}": _json_route(201, {"id": 13, "source_url": "https://x/b"}),
        },
        "call": {
            "fn": "upload_media",
            "image_b64": PNG_B64,
            "filename": "photo.jpg",
            "mime_type": "image/jpeg",
            "alt_text": "",
        },
    },
    {
        "name": "upload-media-alt-text-but-response-carries-no-id",
        "routes": {
            f"POST {MEDIA}": _json_route(201, {"source_url": "https://x/no-id.png"}),
        },
        "call": {
            "fn": "upload_media",
            "image_b64": PNG_B64,
            "filename": "no-id.png",
            "mime_type": "image/png",
            "alt_text": "still no patch",
        },
    },
    {
        "name": "upload-media-alt-text-but-id-is-zero",
        "routes": {
            f"POST {MEDIA}": _json_route(201, {"id": 0, "source_url": "https://x/0"}),
            f"POST {MEDIA}/0": _json_route(200, {"unreachable": True}),
        },
        "call": {
            "fn": "upload_media",
            "image_b64": PNG_B64,
            "filename": "zero.png",
            "mime_type": "image/png",
            "alt_text": "zero is falsy",
        },
    },
    {
        "name": "upload-media-alt-text-non-ascii",
        "routes": {
            f"POST {MEDIA}": _json_route(201, {"id": 55}),
            f"POST {MEDIA}/55": _json_route(200, {"id": 55}),
        },
        "call": {
            "fn": "upload_media",
            "image_b64": PNG_B64,
            "filename": "cafe.png",
            "mime_type": "image/png",
            "alt_text": "Café façade, 60% wide",
        },
    },
    {
        "name": "upload-media-filename-with-spaces-and-a-quote",
        "routes": {
            f"POST {MEDIA}": _json_route(201, {"id": 56}),
        },
        "call": {
            "fn": "upload_media",
            "image_b64": PNG_B64,
            "filename": 'my "best" shot.png',
            "mime_type": "image/png",
            "alt_text": "",
        },
    },
    {
        "name": "upload-media-empty-bytes",
        "routes": {
            f"POST {MEDIA}": _json_route(201, {"id": 57}),
        },
        "call": {
            "fn": "upload_media",
            "image_b64": "",
            "filename": "empty.png",
            "mime_type": "image/png",
            "alt_text": "",
        },
    },
    {
        "name": "upload-media-401",
        "routes": {
            f"POST {MEDIA}": _json_route(
                401, {"message": "Sorry, you are not allowed to upload files."}
            ),
        },
        "call": {
            "fn": "upload_media",
            "image_b64": PNG_B64,
            "filename": "denied.png",
            "mime_type": "image/png",
            "alt_text": "denied",
        },
    },
    {
        "name": "upload-media-413-html-body-truncated-to-200",
        "routes": {f"POST {MEDIA}": _text_route(413, LONG_HTML)},
        "call": {
            "fn": "upload_media",
            "image_b64": PNG_B64,
            "filename": "big.png",
            "mime_type": "image/png",
            "alt_text": "",
        },
    },
    {
        "name": "upload-media-200-non-json",
        "routes": {f"POST {MEDIA}": _text_route(200, "<html>a login page</html>")},
        "call": {
            "fn": "upload_media",
            "image_b64": PNG_B64,
            "filename": "login.png",
            "mime_type": "image/png",
            "alt_text": "",
        },
    },
    {
        "name": "upload-media-alt-text-patch-fails-after-the-upload-succeeded",
        "routes": {
            f"POST {MEDIA}": _json_route(201, {"id": 88, "source_url": "https://x/88"}),
            f"POST {MEDIA}/88": _json_route(
                403, {"message": "Sorry, you are not allowed to edit this media."}
            ),
        },
        "call": {
            "fn": "upload_media",
            "image_b64": PNG_B64,
            "filename": "orphan.png",
            "mime_type": "image/png",
            "alt_text": "the upload is already committed",
        },
    },
    # ---- create_post --------------------------------------------------
    {
        "name": "create-post-minimal-defaults",
        "routes": {
            f"POST {POSTS}": _json_route(
                201, {"id": 100, "link": "https://example.com/?p=100"}
            )
        },
        "call": {"fn": "create_post", "title": "A title", "content": "<p>Body</p>"},
    },
    {
        "name": "create-post-every-field-set",
        "routes": {
            f"POST {POSTS}": _json_route(
                201, {"id": 101, "link": "https://example.com/a-title/"}
            )
        },
        "call": {
            "fn": "create_post",
            "title": "A title",
            "content": "<p>Body</p>",
            "status": "draft",
            "categories": [3, 9],
            "author": 4,
            "featured_media": 42,
            "excerpt": "A summary",
        },
    },
    {
        "name": "create-post-empty-categories-list-is-dropped",
        "routes": {
            f"POST {POSTS}": _json_route(201, {"id": 102, "link": "https://x/"})
        },
        "call": {
            "fn": "create_post",
            "title": "T",
            "content": "C",
            "status": "publish",
            "categories": [],
            "author": 4,
            "featured_media": 42,
            "excerpt": "E",
        },
    },
    {
        "name": "create-post-zero-author-and-zero-featured-media-are-dropped",
        "routes": {
            f"POST {POSTS}": _json_route(201, {"id": 103, "link": "https://x/"})
        },
        "call": {
            "fn": "create_post",
            "title": "T",
            "content": "C",
            "status": "publish",
            "categories": [1],
            "author": 0,
            "featured_media": 0,
            "excerpt": "E",
        },
    },
    {
        "name": "create-post-none-author-and-none-featured-media-are-dropped",
        "routes": {
            f"POST {POSTS}": _json_route(201, {"id": 104, "link": "https://x/"})
        },
        "call": {
            "fn": "create_post",
            "title": "T",
            "content": "C",
            "status": "publish",
            "categories": None,
            "author": None,
            "featured_media": None,
            "excerpt": "",
        },
    },
    {
        "name": "create-post-empty-title-and-content-still-ride-along",
        "routes": {
            f"POST {POSTS}": _json_route(201, {"id": 105, "link": "https://x/"})
        },
        "call": {"fn": "create_post", "title": "", "content": "", "status": ""},
    },
    {
        "name": "create-post-non-ascii-title-and-excerpt",
        "routes": {
            f"POST {POSTS}": _json_route(201, {"id": 106, "link": "https://x/"})
        },
        "call": {
            "fn": "create_post",
            "title": "Crème brûlée & <em>more</em>",
            "content": "<p>Naïve</p>",
            "status": "publish",
            "excerpt": "60% naïveté and a dash",
        },
    },
    {
        "name": "create-post-400",
        "routes": {
            f"POST {POSTS}": _json_route(
                400, {"message": "Invalid parameter(s): categories"}
            )
        },
        "call": {
            "fn": "create_post",
            "title": "T",
            "content": "C",
            "categories": [999999],
        },
    },
    {
        # `json.loads("0")` succeeds and answers the integer 0, so this is not
        # the non-JSON branch: a scalar body is returned as-is, and every
        # caller that reaches for `.get("id")` on it would raise.
        "name": "create-post-200-scalar-zero-body",
        "routes": {f"POST {POSTS}": _text_route(200, "0", "text/plain")},
        "call": {"fn": "create_post", "title": "T", "content": "C"},
    },
    {
        "name": "create-post-200-non-json",
        "routes": {f"POST {POSTS}": _text_route(200, "<html>a login page</html>")},
        "call": {"fn": "create_post", "title": "T", "content": "C"},
    },
    # ---- update_post --------------------------------------------------
    {
        "name": "update-post-forwards-the-publish-hook-kwargs-nulls-included",
        "routes": {
            f"POST {POSTS}/100": _json_route(
                200, {"id": 100, "link": "https://example.com/updated/"}
            )
        },
        "call": {
            "fn": "update_post",
            "wp_post_id": 100,
            # A list of pairs rather than a dict: this file is written with
            # `sort_keys=True`, which would reorder a dict and take the
            # keyword order (and so the serialised body) with it.
            "kwargs": [
                ["title", "Updated"],
                ["content", "<p>New</p>"],
                ["status", "publish"],
                ["categories", []],
                ["author", None],
                ["featured_media", None],
                ["excerpt", ""],
            ],
        },
    },
    {
        "name": "update-post-with-no-kwargs-sends-an-empty-object",
        "routes": {
            f"POST {POSTS}/101": _json_route(200, {"id": 101, "link": "https://x/"})
        },
        "call": {"fn": "update_post", "wp_post_id": 101, "kwargs": []},
    },
    {
        "name": "update-post-404",
        "routes": {
            f"POST {POSTS}/999": _json_route(
                404, {"message": "Invalid post ID.", "data": {"status": 404}}
            )
        },
        "call": {"fn": "update_post", "wp_post_id": 999, "kwargs": [["title", "T"]]},
    },
    {
        "name": "update-post-500-with-no-message-key",
        "routes": {f"POST {POSTS}/7": _json_route(500, {"code": "internal_error"})},
        "call": {"fn": "update_post", "wp_post_id": 7, "kwargs": [["title", "T"]]},
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

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's spelling
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        _seen.append(
            {
                "method": "POST",
                "path": parsed.path,
                "query": parsed.query,
                "authorization": self.headers.get("Authorization", ""),
                "content_type": self.headers.get("Content-Type", ""),
                "content_disposition": self.headers.get("Content-Disposition", ""),
                "content_length": self.headers.get("Content-Length", ""),
                "body_b64": base64.b64encode(body).decode(),
            }
        )
        route = _routes.get(_route_key("POST", self.path))
        if route is None:
            payload = b"no route"
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        payload = route["body"].encode()
        self.send_response(route["status"])
        self.send_header("Content-Type", route["content_type"])
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


async def _invoke(client: WordPressClient, call: dict) -> object:
    fn = call["fn"]
    if fn == "upload_media":
        kwargs: dict = {}
        if "mime_type" in call:
            kwargs["mime_type"] = call["mime_type"]
        if "alt_text" in call:
            kwargs["alt_text"] = call["alt_text"]
        return await client.upload_media(
            base64.b64decode(call["image_b64"]), call["filename"], **kwargs
        )
    if fn == "create_post":
        kwargs = {
            key: call[key]
            for key in ("status", "categories", "author", "featured_media", "excerpt")
            if key in call
        }
        return await client.create_post(call["title"], call["content"], **kwargs)
    if fn == "update_post":
        return await client.update_post(call["wp_post_id"], **dict(call["kwargs"]))
    raise ValueError(f"unknown call: {fn}")


async def _run_scenarios(base: str) -> list[dict]:
    global _routes, _seen
    results: list[dict] = []
    for scenario in SCENARIOS:
        _routes = {key: {**route} for key, route in scenario["routes"].items()}
        _seen = []
        client = WordPressClient(base, USERNAME, APP_PASSWORD)
        outcome: dict
        try:
            async with client:
                value = await _invoke(client, scenario["call"])
        except WordPressError as error:
            outcome = {"error": str(error), "status_code": error.status_code}
            summary = f"raised {error}"
        else:
            outcome = {"result": value}
            summary = f"returned {json.dumps(value)[:60]}"
        results.append(
            {
                **scenario,
                "api_url": client.api_url.replace(base, "{BASE}"),
                "requests": _seen,
                "expected": outcome,
            }
        )
        print(f"  {scenario['name']}: {len(_seen)} request(s), {summary}")
    _routes = {}
    _seen = []
    return results


def main() -> int:
    import httpx

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
        "generated_by": "api/scripts/export_wordpress_write_parity.py",
        "source": "api/src/services/wordpress.py",
        "python_version": sys.version.split()[0],
        "httpx_version": httpx.__version__,
        "scenario_credentials": {"username": USERNAME, "app_password": APP_PASSWORD},
        "scenarios": scenarios,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    print(f"wrote {args.out} ({len(scenarios)} scenarios)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
