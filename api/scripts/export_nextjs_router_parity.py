"""Export the parity oracle the TypeScript `nextjs` router port needs.

`api/src/api/nextjs.py` is a single endpoint, `POST /api/profiles/{profile_id}
/nextjs/test`, and almost all of it is error grammar rather than happy path:

* `_get_user_profile` is the multi-tenancy boundary, and a profile owned by
  another user is indistinguishable from one that does not exist;
* a missing webhook URL or secret, and a secret that will not decrypt, are both
  reported as a 200 carrying `{"connected": false, "error": ...}` rather than
  raised;
* the payload is `json.dumps` of two keys and the signature is HMAC-SHA256 over
  that exact string, so the bytes on the wire and the hex digest have to agree;
* anything but a 200 back from the webhook is rendered through
  `f"Webhook returned {status}: {detail}"`, where `detail` is
  `response.json().get("error", response.text[:200])` behind a bare `except`,
  so a non-object JSON body, a body with no `error` key and a body that is not
  JSON at all all land on the truncated text.

The real endpoint coroutine is driven here rather than reimplemented, against a
local HTTP server standing in for the Next.js blog and a stubbed session
standing in for the `_get_user_profile` lookup, so the request the endpoint
actually issues, the signature over it and the error grammar are all recorded
from a real run over a real socket.

The Fernet key below is a throwaway generated for this file. It encrypts one
fixture string and appears in the oracle so the TypeScript side can decrypt the
same token; no real credential is involved.

Usage:
    uv run python scripts/export_nextjs_router_parity.py
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
from urllib.parse import urlparse

from fastapi import HTTPException

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "api"))

from src.api.nextjs import test_nextjs_connection  # noqa: E402
from src.config import settings  # noqa: E402
from src.models.profile import WebsiteProfile  # noqa: E402
from src.services.crypto import encrypt  # noqa: E402

OUT = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "src"
    / "app"
    / "api"
    / "profiles"
    / "data"
    / "nextjs-router-parity.json"
)

# A throwaway Fernet key: 32 bytes of 0x0b, url-safe base64 with its padding.
TEST_KEY = base64.urlsafe_b64encode(bytes([11] * 32)).decode()
WEBHOOK_SECRET = "s3cret-webhook-signing-key"
PROFILE_ID = uuid.UUID("33333333-3333-4333-8333-333333333333")
USER = SimpleNamespace(id="user-under-test")
HOOK = "/api/jena/webhook"

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


def _redirect_route(status: int, location: str) -> dict:
    return {
        "status": status,
        "body": "moved",
        "content_type": "text/plain",
        "location": location,
    }


LONG_HTML = (
    "<html><body>" + ("vercel: this deployment is not found. " * 20) + "</body></html>"
)

# Every profile shape the two early returns and the happy path can see.
# `secret` is the literal stored in `nextjs_webhook_secret`; `encrypt` marks the
# ones that get a real Fernet token rather than the literal.
PROFILES: dict[str, dict] = {
    "ok": {"url": "{BASE}" + HOOK, "encrypt": True},
    "missing": {"absent": True},
    "other-user": {"url": "{BASE}" + HOOK, "encrypt": True, "user_id": "someone-else"},
    "no-url": {"url": None, "encrypt": True},
    "empty-url": {"url": "", "encrypt": True},
    "no-secret": {"url": "{BASE}" + HOOK, "secret": None},
    "empty-secret": {"url": "{BASE}" + HOOK, "secret": ""},
    "undecryptable": {"url": "{BASE}" + HOOK, "secret": "not-a-fernet-token"},
    "unset-key": {"url": "{BASE}" + HOOK, "encrypt": True, "unset_key": True},
    # Nothing is listening on this port, which is how the `httpx.RequestError`
    # branch is reached without a sleep.
    "dead-port": {"url": "http://127.0.0.1:9/api/jena/webhook", "encrypt": True},
}

SCENARIOS: list[dict] = [
    {
        "name": "success-200-json",
        "profile": "ok",
        "routes": {f"POST {HOOK}": _json_route(200, {"ok": True, "received": "test"})},
    },
    {
        "name": "success-200-empty-body",
        "profile": "ok",
        "routes": {f"POST {HOOK}": _text_route(200, "", "text/plain")},
    },
    {
        "name": "success-200-not-json",
        "profile": "ok",
        "routes": {f"POST {HOOK}": _text_route(200, "<html>fine, actually</html>")},
    },
    {
        "name": "created-201-is-a-failure",
        "profile": "ok",
        "routes": {f"POST {HOOK}": _json_route(201, {"ok": True})},
    },
    {
        "name": "no-content-204-is-a-failure",
        "profile": "ok",
        "routes": {f"POST {HOOK}": _text_route(204, "", "text/plain")},
    },
    {
        "name": "redirect-302-is-not-followed",
        "profile": "ok",
        "routes": {
            f"POST {HOOK}": _redirect_route(302, "/api/jena/webhook/v2"),
            "POST /api/jena/webhook/v2": _json_route(200, {"ok": True}),
        },
    },
    {
        "name": "401-json-error-key",
        "profile": "ok",
        "routes": {f"POST {HOOK}": _json_route(401, {"error": "Invalid signature"})},
    },
    {
        "name": "500-json-without-error-key",
        "profile": "ok",
        "routes": {f"POST {HOOK}": _json_route(500, {"message": "boom", "code": 17})},
    },
    {
        "name": "404-long-html-truncated-to-200-chars",
        "profile": "ok",
        "routes": {f"POST {HOOK}": _text_route(404, LONG_HTML)},
    },
    {
        "name": "400-json-array-body",
        "profile": "ok",
        "routes": {f"POST {HOOK}": _json_route(400, [{"error": "not reached"}])},
    },
    {
        "name": "400-json-null-body",
        "profile": "ok",
        "routes": {f"POST {HOOK}": _json_route(400, None)},
    },
    {
        "name": "400-json-string-body",
        "profile": "ok",
        "routes": {f"POST {HOOK}": _json_route(400, "just a string")},
    },
    {
        "name": "502-error-key-is-null",
        "profile": "ok",
        "routes": {f"POST {HOOK}": _json_route(502, {"error": None})},
    },
    {
        "name": "502-error-key-is-true",
        "profile": "ok",
        "routes": {f"POST {HOOK}": _json_route(502, {"error": True})},
    },
    {
        "name": "502-error-key-is-an-int",
        "profile": "ok",
        "routes": {f"POST {HOOK}": _json_route(502, {"error": 42})},
    },
    {
        "name": "502-error-key-is-an-integral-float",
        "profile": "ok",
        "routes": {f"POST {HOOK}": _json_route(502, {"error": 1.0})},
    },
    {
        "name": "502-error-key-is-a-list",
        "profile": "ok",
        "routes": {f"POST {HOOK}": _json_route(502, {"error": ["a", 1, None]})},
    },
    {
        # `repr` picks the quote character: single unless the string contains a
        # single quote and no double quote, and escapes only when it has both.
        "name": "502-error-key-is-a-list-of-quoted-strings",
        "profile": "ok",
        "routes": {
            f"POST {HOOK}": _json_route(
                502, {"error": ["it's", 'say "hi"', "both ' and \"", "back\\slash"]}
            )
        },
    },
    {
        "name": "502-error-key-is-an-object",
        "profile": "ok",
        "routes": {f"POST {HOOK}": _json_route(502, {"error": {"why": "nested"}})},
    },
    {
        "name": "503-empty-body",
        "profile": "ok",
        "routes": {f"POST {HOOK}": _text_route(503, "", "text/plain")},
    },
    {
        "name": "connection-refused",
        "profile": "dead-port",
        "routes": {},
    },
    {
        "name": "profile-not-found",
        "profile": "missing",
        "routes": {},
    },
    {
        "name": "profile-owned-by-another-user",
        "profile": "other-user",
        "routes": {},
    },
    {
        "name": "no-webhook-url",
        "profile": "no-url",
        "routes": {},
    },
    {
        "name": "empty-webhook-url",
        "profile": "empty-url",
        "routes": {},
    },
    {
        "name": "no-webhook-secret",
        "profile": "no-secret",
        "routes": {},
    },
    {
        "name": "empty-webhook-secret",
        "profile": "empty-secret",
        "routes": {},
    },
    {
        "name": "undecryptable-webhook-secret",
        "profile": "undecryptable",
        "routes": {},
    },
    {
        "name": "unset-encryption-key",
        "profile": "unset-key",
        "routes": {},
    },
]


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: object) -> None:  # keep the export output clean
        return

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's spelling
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length).decode() if length else ""
        _seen.append(
            {
                "method": "POST",
                "path": parsed.path,
                "query": parsed.query,
                "content_type": self.headers.get("Content-Type", ""),
                "signature": self.headers.get("X-Jena-Signature", ""),
                "body": body,
            }
        )
        route = _routes.get(f"POST {parsed.path}")
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
        if route.get("location"):
            self.send_header("Location", route["location"])
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class _Session:
    """Just enough of `AsyncSession` for `_get_user_profile`."""

    def __init__(self, profile: object) -> None:
        self._profile = profile

    async def get(self, _model: object, _pk: object) -> object:
        return self._profile


def _build_profile(spec: dict, base: str) -> WebsiteProfile | None:
    if spec.get("absent"):
        return None
    secret = encrypt(WEBHOOK_SECRET) if spec.get("encrypt") else spec.get("secret")
    url = spec.get("url")
    if isinstance(url, str):
        url = url.replace("{BASE}", base)
    return WebsiteProfile(
        id=PROFILE_ID,
        user_id=spec.get("user_id", USER.id),
        name="Fixture Blog",
        website_url="https://example.com",
        nextjs_webhook_url=url,
        nextjs_webhook_secret=secret,
    )


async def _run_scenarios(base: str) -> list[dict]:
    global _routes, _seen
    results: list[dict] = []
    for scenario in SCENARIOS:
        spec = PROFILES[scenario["profile"]]
        _routes = {key: {**route} for key, route in scenario["routes"].items()}
        _seen = []
        # The token has to be produced with the real key even for the scenario
        # that then blanks it, because that is the shape the row already has.
        settings.wp_encryption_key = TEST_KEY
        profile = _build_profile(spec, base)
        stored_secret = profile.nextjs_webhook_secret if profile else None
        if spec.get("unset_key"):
            settings.wp_encryption_key = ""

        outcome: dict
        try:
            value = await test_nextjs_connection(PROFILE_ID, USER, _Session(profile))
        except HTTPException as error:
            outcome = {"http_status": error.status_code, "detail": error.detail}
            summary = f"HTTPException {error.status_code}: {error.detail}"
        else:
            outcome = {"returned": value}
            summary = f"returned {json.dumps(value)[:90]}"
        finally:
            settings.wp_encryption_key = TEST_KEY

        results.append(
            {
                "name": scenario["name"],
                "profile": (
                    None
                    if profile is None
                    else {
                        "user_id": profile.user_id,
                        "nextjs_webhook_url": (
                            profile.nextjs_webhook_url.replace(base, "{BASE}")
                            if isinstance(profile.nextjs_webhook_url, str)
                            else profile.nextjs_webhook_url
                        ),
                        "nextjs_webhook_secret": stored_secret,
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
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    print(f"stand-in Next.js blog on {base}")

    try:
        scenarios = asyncio.run(_run_scenarios(base))
    finally:
        server.shutdown()
        server.server_close()

    payload = {
        "generated_by": "api/scripts/export_nextjs_router_parity.py",
        "source": "api/src/api/nextjs.py::test_nextjs_connection",
        "encryption_key": TEST_KEY,
        "webhook_secret": WEBHOOK_SECRET,
        "profile_id": str(PROFILE_ID),
        "user_id": USER.id,
        "hook_path": HOOK,
        "scenarios": scenarios,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {len(scenarios)} scenarios to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
