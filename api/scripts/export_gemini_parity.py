"""Export the parity oracle the TypeScript `GeminiClient.generate_image` port needs.

Every Gemini call recorded in `docs/mastra-port/golden/*/images.json` is a 429,
so the golden fixtures pin the prompt text and nothing else: not the request
that carries it, not the shape of a successful answer, and not the token
accounting the stage sums into `_stage_meta_gemini`. This script supplies all
three by driving the real `GeminiClient` with `httpx` intercepted, so both the
outbound request and the parsing of a canned answer come from the production
code path rather than from a description of it.

Two kinds of case are exported:

* `wire`: the exact HTTP request `google-genai` builds for one
  `generate_image(...)` argument set. Method, URL, filtered headers and the
  JSON body, so the port can assert byte equality against what Python sends
  rather than against the REST reference.
* `responses`: a canned HTTP status and body fed back through the SDK, with
  the resulting `ImageGenResponse` fields or the raised exception recorded.
  These cover the branches the fixtures never reached: usage metadata present,
  absent and zero-valued, a text part ahead of the image part, an empty
  `parts`, and both error classes.

`attempts` on an error case is the number of HTTP requests `_retry` actually
made. It is 1 for both 429 and 500, because `_is_retryable` tests for
`httpx.HTTPStatusError` and `anthropic.APIStatusError` and `google.genai`
raises neither, so the retry wrapper is inert for this client. That is
behaviour the port has to reproduce, not a bug to fix here.

Usage:
    uv run python scripts/export_gemini_parity.py
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
from pathlib import Path
from typing import Any

import httpx

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "api"))

from google.genai._api_client import SyncHttpxClient  # noqa: E402
from src.services.llm import GeminiClient  # noqa: E402

OUT = REPO_ROOT / "web" / "src" / "mastra" / "images" / "data" / "gemini-parity.json"

# Never the real key: the interception happens below the transport, so no
# request leaves the process and the value only has to be shaped like a key.
FAKE_KEY = "test-key-not-a-real-credential"

# Headers whose value is either the credential or an environment fingerprint.
# `x-goog-api-key` is recorded as the sentinel below so the port can assert the
# header name and position without the corpus carrying a secret.
REDACTED = "<redacted>"
KEY_HEADERS = {"x-goog-api-key", "authorization"}
VOLATILE_HEADERS = {"user-agent", "x-goog-api-client"}

# A 1x1 PNG, the smallest thing that survives a round trip through base64 and
# is still a decodable image.
PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


class _Interceptor:
    """Records every request and replays a queued response for it."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.status = 200
        self.body: str = "{}"

    def request(self, **kwargs) -> httpx.Response:
        headers = {}
        for name, value in dict(kwargs.get("headers") or {}).items():
            lowered = name.lower()
            if lowered in KEY_HEADERS or lowered in VOLATILE_HEADERS:
                value = REDACTED
            headers[lowered] = value
        content = kwargs.get("content")
        if isinstance(content, bytes):
            content = content.decode()
        self.requests.append(
            {
                "method": kwargs.get("method"),
                "url": str(kwargs.get("url")),
                "headers": headers,
                # Both forms: the parsed body for readability, and the exact
                # string, because `json.dumps` puts a space after every colon
                # and comma and escapes non-ASCII, neither of which
                # `JSON.stringify` does. The port cannot match those bytes and
                # the test asserts the achievable equality instead.
                "body": json.loads(content) if content else None,
                "body_raw": content,
            }
        )
        return httpx.Response(
            status_code=self.status,
            headers={"content-type": "application/json"},
            text=self.body,
            request=httpx.Request(
                kwargs.get("method", "POST"), str(kwargs.get("url", ""))
            ),
        )


def _body(
    parts: list[dict[str, Any]] | None,
    usage: dict[str, Any] | None = None,
) -> str:
    """A `generateContent` response body with the given candidate parts."""
    payload: dict[str, Any] = {}
    if parts is not None:
        payload["candidates"] = [{"content": {"parts": parts, "role": "model"}}]
    if usage is not None:
        payload["usageMetadata"] = usage
    return json.dumps(payload)


def _image_part(data: bytes = PNG_1X1) -> dict[str, Any]:
    return {
        "inlineData": {
            "mimeType": "image/png",
            "data": base64.b64encode(data).decode(),
        }
    }


WIRE_CASES: list[dict[str, Any]] = [
    {
        "label": "defaults",
        "why": "generate_image's own defaults: 4:3 at 1K on the incumbent model",
        "args": {"prompt": "a teal isometric dashboard"},
    },
    {
        "label": "featured",
        "why": "what images_node sends for placement=featured: 16:9 at 2K",
        "args": {
            "prompt": "a wide editorial header",
            "aspect_ratio": "16:9",
            "image_size": "2K",
        },
    },
    {
        "label": "inline-1k-1x1",
        "why": "a square aspect ratio, to pin the field is passed through verbatim",
        "args": {"prompt": "a square icon", "aspect_ratio": "1:1", "image_size": "512"},
    },
    {
        "label": "explicit-model",
        "why": "a non-default model id, to pin where the id lands in the URL",
        "args": {
            "prompt": "any",
            "model": "gemini-3.1-flash-image-preview",
            "aspect_ratio": "4:3",
            "image_size": "4K",
        },
    },
    {
        "label": "unicode-prompt",
        "why": "non-ASCII in the prompt, to pin the JSON escaping of the body",
        "args": {"prompt": "café — 日本語 🎨"},
    },
]

RESPONSE_CASES: list[dict[str, Any]] = [
    {
        "label": "usage-reported",
        "why": "the happy path: both token counts come from usage_metadata",
        "args": {"prompt": "p"},
        "status": 200,
        "body": _body(
            [_image_part()],
            {
                "promptTokenCount": 37,
                "candidatesTokenCount": 1290,
                "totalTokenCount": 1327,
            },
        ),
    },
    {
        "label": "usage-absent",
        "why": "no usage_metadata at all: tokens_out falls back to the 1K entry",
        "args": {"prompt": "p"},
        "status": 200,
        "body": _body([_image_part()]),
    },
    {
        "label": "usage-zero-candidates-2k",
        "why": "candidatesTokenCount 0 with usage_metadata present: 2K fallback",
        "args": {"prompt": "p", "image_size": "2K"},
        "status": 200,
        "body": _body(
            [_image_part()],
            {"promptTokenCount": 12, "candidatesTokenCount": 0},
        ),
    },
    {
        "label": "usage-zero-candidates-512",
        "why": "the 512 entry of the fallback table",
        "args": {"prompt": "p", "image_size": "512"},
        "status": 200,
        "body": _body([_image_part()], {"promptTokenCount": 0}),
    },
    {
        "label": "usage-zero-candidates-4k",
        "why": "the 4K entry of the fallback table",
        "args": {"prompt": "p", "image_size": "4K"},
        "status": 200,
        "body": _body([_image_part()], {"promptTokenCount": 0}),
    },
    {
        "label": "unknown-image-size",
        "why": "an image_size outside the table: the 1K default, not an error",
        "args": {"prompt": "p", "image_size": "3K"},
        "status": 200,
        "body": _body([_image_part()]),
    },
    {
        "label": "text-part-first",
        "why": "a text part first: the loop takes the first inline_data, not part[0]",
        "args": {"prompt": "p"},
        "status": 200,
        "body": _body([{"text": "here is your image"}, _image_part()]),
    },
    {
        "label": "two-image-parts",
        "why": "two inline parts: the loop breaks on the first",
        "args": {"prompt": "p"},
        "status": 200,
        "body": _body([_image_part(b"\x89PNG-first"), _image_part(b"\x89PNG-second")]),
    },
    {
        "label": "inline-data-without-bytes",
        "why": (
            "a part carrying inline_data with no bytes: the loop breaks on the "
            "truthy Blob and then trips the None check, so this reaches the "
            "second RuntimeError rather than skipping to the next part"
        ),
        "args": {"prompt": "p"},
        "status": 200,
        "body": _body([{"inlineData": {"mimeType": "image/png"}}, _image_part()]),
    },
    {
        "label": "candidate-without-content",
        "why": "a candidate with no content at all, the other shape of an empty answer",
        "args": {"prompt": "p"},
        "status": 200,
        "body": json.dumps({"candidates": [{"finishReason": "SAFETY"}]}),
    },
    {
        "label": "no-candidates",
        "why": "an empty response, the shape a safety filter produces",
        "args": {"prompt": "p"},
        "status": 200,
        "body": _body(None),
    },
    {
        "label": "text-only",
        "why": "parts present but none inline: the second RuntimeError branch",
        "args": {"prompt": "p"},
        "status": 200,
        "body": _body([{"text": "I cannot generate that"}]),
    },
    {
        "label": "error-429",
        "why": "what every golden fixture recorded; _retry does not retry it",
        "args": {"prompt": "p"},
        "status": 429,
        "body": json.dumps(
            {
                "error": {
                    "code": 429,
                    "message": "RESOURCE_EXHAUSTED",
                    "status": "RESOURCE_EXHAUSTED",
                }
            }
        ),
    },
    {
        "label": "error-500",
        "why": "a server error is retryable for the httpx clients and not for this one",
        "args": {"prompt": "p"},
        "status": 500,
        "body": json.dumps(
            {"error": {"code": 500, "message": "internal", "status": "INTERNAL"}}
        ),
    },
]


async def _run() -> dict[str, Any]:
    interceptor = _Interceptor()
    original = SyncHttpxClient.request
    SyncHttpxClient.request = interceptor.request  # type: ignore[method-assign]
    try:
        client = GeminiClient(api_key=FAKE_KEY)

        wire = []
        for case in WIRE_CASES:
            interceptor.requests.clear()
            interceptor.status = 200
            interceptor.body = _body([_image_part()])
            await client.generate_image(**case["args"])
            assert len(interceptor.requests) == 1, case["label"]
            wire.append(
                {
                    "label": case["label"],
                    "why": case["why"],
                    "args": case["args"],
                    "request": interceptor.requests[0],
                }
            )

        responses = []
        for case in RESPONSE_CASES:
            interceptor.requests.clear()
            interceptor.status = case["status"]
            interceptor.body = case["body"]
            record: dict[str, Any] = {
                "label": case["label"],
                "why": case["why"],
                "args": case["args"],
                "status": case["status"],
                "body": json.loads(case["body"]),
            }
            try:
                result = await client.generate_image(**case["args"])
            except Exception as exc:  # noqa: BLE001 - the corpus records the type
                record["error"] = {
                    "type": type(exc).__name__,
                    "message": str(exc)[:200],
                }
            else:
                record["result"] = {
                    "image_bytes_base64": base64.b64encode(result.image_bytes).decode(),
                    "model": result.model,
                    "tokens_in": result.tokens_in,
                    "tokens_out": result.tokens_out,
                }
            record["attempts"] = len(interceptor.requests)
            responses.append(record)
    finally:
        SyncHttpxClient.request = original  # type: ignore[method-assign]

    return {"wire": wire, "responses": responses}


def main() -> None:
    data = asyncio.run(_run())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=2, sort_keys=False) + "\n")
    print(f"wrote {OUT.relative_to(REPO_ROOT)}")
    print(f"  wire cases: {len(data['wire'])}")
    print(f"  response cases: {len(data['responses'])}")


if __name__ == "__main__":
    main()
