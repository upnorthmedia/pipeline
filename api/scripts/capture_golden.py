"""Capture golden pipeline fixtures from the Python stack for the Mastra port.

Runs the six stage nodes in order for representative posts and writes one JSON
fixture per post/stage containing the state fed into the stage, the exact
outbound provider request payloads, the raw provider responses, and the stage's
returned output.

The fixtures are the parity oracle for the TypeScript port and cannot be
regenerated once `api/` is deleted, so capture is deliberately transport-level:
the recorders wrap the provider SDK entry points, not the pipeline's own client
wrappers, so what lands in the fixture is what actually went over the wire.

`--dry-run` swaps the network call for a canned response while leaving every
other code path (prompt assembly, client wrappers, retries, manifest parsing,
image optimisation) intact, so the harness itself can be verified without
spending provider credits.

Usage:
    uv run python scripts/capture_golden.py --dry-run --out /tmp/golden-dryrun
    uv run python scripts/capture_golden.py --out ../docs/mastra-port/golden
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import io
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from src.config import settings  # noqa: E402
from src.models.post import Post  # noqa: E402
from src.pipeline.state import STAGES, state_from_post  # noqa: E402

# --------------------------------------------------------------------------
# Post specs: two representative posts with different article_type and
# output_format, per the Phase 0 exit criteria.
# --------------------------------------------------------------------------

POST_SPECS: list[dict[str, Any]] = [
    {
        "id": "00000000-0000-4000-8000-000000000001",
        "slug": "how-to-choose-a-crm-for-a-small-team",
        "topic": "How to choose a CRM for a small team",
        "target_audience": "Founders and operations leads at 5-30 person companies",
        "niche": "B2B SaaS tooling",
        "intent": "informational",
        "article_type": "how-to",
        "output_format": "markdown",
        "word_count": 1800,
        "tone": "Conversational and friendly",
        "website_url": "https://example.com",
        "related_keywords": ["small business crm", "crm comparison", "crm pricing"],
        "competitor_urls": ["https://example.org/crm-guide"],
        "image_style": "Clean flat vector illustration, soft shadows",
        "image_brand_colors": ["#1F3A93", "#F5F7FA"],
        "image_exclude": ["stock photo people", "text overlays"],
        "brand_voice": "Plain spoken, no hype, concrete examples",
        "avoid": "Buzzwords, em dashes, unsupported claims",
        "required_mentions": "Mention that migration cost is usually underestimated",
        "additional_info": "Readers are evaluating their first paid CRM.",
        "internal_links": [
            {
                "url": "https://example.com/blog/sales-pipeline-basics",
                "title": "Sales pipeline basics",
            },
            {
                "url": "https://example.com/blog/crm-data-hygiene",
                "title": "CRM data hygiene",
            },
            {"url": "https://example.com/pricing", "title": "Pricing"},
        ],
    },
    {
        "id": "00000000-0000-4000-8000-000000000002",
        "slug": "best-time-tracking-tools-for-agencies",
        "topic": "Best time tracking tools for agencies",
        "target_audience": "Agency owners billing hourly retainers",
        "niche": "Professional services software",
        "intent": "commercial",
        "article_type": "listicle",
        "output_format": "nextjs",
        "word_count": 2400,
        "tone": "Direct and analytical",
        "website_url": "https://example.com",
        "related_keywords": ["agency time tracking", "billable hours software"],
        "competitor_urls": [],
        "image_style": "Editorial isometric illustration, muted palette",
        "image_brand_colors": ["#0B7285"],
        "image_exclude": ["logos of real products"],
        "brand_voice": "Opinionated, evidence first",
        "avoid": "Affiliate language, em dashes",
        "required_mentions": "State the pricing model for every tool listed",
        "additional_info": "Rank by fit for 10-50 person agencies.",
        "internal_links": [],
    },
]

POST_FIELDS = (
    "id slug topic target_audience niche intent article_type output_format "
    "word_count tone website_url related_keywords competitor_urls image_style "
    "image_brand_colors image_exclude brand_voice avoid required_mentions "
    "additional_info"
).split()


# --------------------------------------------------------------------------
# Recording
# --------------------------------------------------------------------------


class Recorder:
    """Collects the provider calls made while a single stage runs."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.stage: str = ""

    def start(self, stage: str) -> None:
        self.calls = []
        self.stage = stage

    def record(self, provider: str, request: Any, response: Any) -> None:
        self.calls.append(
            {"provider": provider, "request": request, "response": response}
        )

    def record_error(self, provider: str, request: Any, exc: BaseException) -> None:
        """A failed call is still a captured request; the payload is the oracle."""
        self.calls.append(
            {
                "provider": provider,
                "request": request,
                "error": {"type": type(exc).__name__, "message": str(exc)},
                "response": None,
            }
        )


def _serialize(obj: Any) -> Any:
    """Best-effort JSON-safe view of a provider request or response object."""
    if obj is None or isinstance(obj, (bool, int, float, str)):
        return obj
    if isinstance(obj, bytes):
        return {"__bytes__": len(obj), "sha256": hashlib.sha256(obj).hexdigest()}
    if isinstance(obj, dict):
        return {str(k): _serialize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_serialize(v) for v in obj]
    for attr in ("model_dump_json", "to_json_dict"):
        fn = getattr(obj, attr, None)
        if callable(fn):
            try:
                dumped = fn()
                return json.loads(dumped) if isinstance(dumped, str) else dumped
            except Exception:  # noqa: BLE001 - fixture capture must never crash a run
                pass
    fn = getattr(obj, "to_dict", None)
    if callable(fn):
        try:
            return _serialize(fn())
        except Exception:  # noqa: BLE001
            pass
    return repr(obj)


# Provider responses embed generated images as base64. Keeping them inline would
# make a single fixture tens of megabytes, so blobs are replaced by their length
# and digest; the bytes themselves are already on disk as the optimised .webp.
_BLOB_KEYS = frozenset({"data", "inline_data", "inlineData", "b64_json", "image_bytes"})
_MAX_INLINE_CHARS = 200_000


def _blob_summary(value: str | bytes) -> dict[str, Any]:
    raw = value.encode() if isinstance(value, str) else value
    return {
        "__elided_blob__": True,
        "length": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def _elide_value(key: Any, value: Any) -> Any:
    is_blob = (
        str(key) in _BLOB_KEYS and isinstance(value, (str, bytes)) and len(value) > 1024
    )
    return _blob_summary(value) if is_blob else _elide_blobs(value)


def _elide_blobs(obj: Any) -> Any:
    """Replace embedded binary payloads with a length + digest summary."""
    if isinstance(obj, (str, bytes)) and len(obj) > _MAX_INLINE_CHARS:
        return _blob_summary(obj)
    if isinstance(obj, dict):
        return {k: _elide_value(k, v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_elide_blobs(v) for v in obj]
    return obj


def _redact(obj: Any, secrets: list[str]) -> Any:
    """Strip api_keys and replace any literal secret value with a placeholder."""
    if isinstance(obj, str):
        for secret in secrets:
            if secret and secret in obj:
                obj = obj.replace(secret, "[REDACTED]")
        return obj
    if isinstance(obj, dict):
        return {
            k: (
                "[REDACTED]"
                if k in ("api_keys", "api_key", "authorization")
                else _redact(v, secrets)
            )
            for k, v in obj.items()
        }
    if isinstance(obj, (list, tuple)):
        return [_redact(v, secrets) for v in obj]
    return obj


def _rendered_prompt(call: dict[str, Any]) -> str | None:
    """Pull the user-facing prompt text out of a recorded request payload."""
    req = call.get("request")
    if not isinstance(req, dict):
        return None
    if call["provider"] == "perplexity":
        messages = req.get("messages") or []
        for msg in reversed(messages):
            if msg.get("role") == "user":
                return msg.get("content")
        return None
    if call["provider"] == "anthropic":
        messages = req.get("messages") or []
        for msg in reversed(messages):
            if msg.get("role") == "user":
                return msg.get("content")
        return None
    if call["provider"] == "gemini":
        return req.get("contents")
    return None


# --------------------------------------------------------------------------
# Stubs used by --dry-run
# --------------------------------------------------------------------------

_STUB_RESEARCH = (
    "# Research\n\n## Primary keyword\nstub keyword\n\n## Pain points\n"
    "- stub pain point\n\n## Competitor gaps\n- stub competitor\n\n"
    "## Search intent\nInformational.\n"
)

_STUB_MANIFEST = json.dumps(
    {
        "style_brief": {"style": "stub", "palette": ["#000000"]},
        "images": [
            {
                "filename": "featured.png",
                "placement": "featured",
                "alt": "stub featured image",
                "prompt": "A stub featured illustration",
            },
            {
                "filename": "inline-1.png",
                "placement": "section-1",
                "alt": "stub inline image",
                "prompt": "A stub inline illustration",
                "aspect_ratio": "4:3",
                "image_size": "1K",
            },
        ],
    }
)

_STUB_CLAUDE_TEXT = {
    "outline": "# Stub outline\n\n## H2 one\n- point\n\n## H2 two\n- point\n",
    "write": "---\ntitle: Stub draft\n---\n\n# Stub draft\n\nStub body copy.\n",
    "edit": "---\ntitle: Stub final\n---\n\n# Stub final\n\nStub edited copy.\n",
    "images": _STUB_MANIFEST,
    "ready": "---\ntitle: Stub ready\n---\n\n# Stub ready\n\nStub assembled copy.\n",
}


class _StubBlock:
    def __init__(self, text: str) -> None:
        self.type = "text"
        self.text = text


class _StubUsage:
    def __init__(self) -> None:
        self.input_tokens = 0
        self.output_tokens = 0


class _StubMessage:
    def __init__(self, text: str, model: str) -> None:
        self.content = [_StubBlock(text)]
        self.usage = _StubUsage()
        self.model = model
        self.stop_reason = "end_turn"

    def to_dict(self) -> dict[str, Any]:
        return {
            "__stub__": True,
            "model": self.model,
            "stop_reason": self.stop_reason,
            "content": [{"type": "text", "text": self.content[0].text}],
            "usage": {"input_tokens": 0, "output_tokens": 0},
        }


def _stub_png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (31, 58, 147)).save(buf, format="PNG")
    return buf.getvalue()


class _StubInlineData:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.mime_type = "image/png"


class _StubPart:
    def __init__(self, data: bytes) -> None:
        self.inline_data = _StubInlineData(data)


class _StubGeminiResponse:
    def __init__(self) -> None:
        self.parts = [_StubPart(_stub_png())]
        self.usage_metadata = None

    def to_dict(self) -> dict[str, Any]:
        return {"__stub__": True, "parts": 1, "mime_type": "image/png"}


# --------------------------------------------------------------------------
# Transport patching
# --------------------------------------------------------------------------


def install_recorders(rec: Recorder, dry_run: bool) -> None:
    """Wrap the three provider SDK entry points with recording (and stubbing)."""
    import httpx
    from anthropic.resources.messages import AsyncMessages
    from google.genai.models import Models

    real_post = httpx.AsyncClient.post

    async def post(self, url, *args, **kwargs):  # type: ignore[no-untyped-def]
        if "api.perplexity.ai" not in str(getattr(self, "base_url", "")):
            return await real_post(self, url, *args, **kwargs)
        payload = kwargs.get("json")
        if dry_run:
            response = httpx.Response(
                200,
                json={
                    "choices": [
                        {"message": {"role": "assistant", "content": _STUB_RESEARCH}}
                    ],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0},
                    "__stub__": True,
                },
                request=httpx.Request("POST", str(self.base_url) + str(url)),
            )
        else:
            try:
                response = await real_post(self, url, *args, **kwargs)
            except BaseException as exc:
                rec.record_error(
                    "perplexity",
                    {"url": str(self.base_url) + str(url), **(payload or {})},
                    exc,
                )
                raise
        body: Any
        try:
            body = response.json()
        except Exception:  # noqa: BLE001
            body = response.text
        rec.record(
            "perplexity",
            {"url": str(self.base_url) + str(url), **(payload or {})},
            {"status_code": response.status_code, "body": body},
        )
        return response

    httpx.AsyncClient.post = post

    real_create = AsyncMessages.create

    async def create(self, **kwargs):  # type: ignore[no-untyped-def]
        if dry_run:
            text = _STUB_CLAUDE_TEXT.get(rec.stage, "stub")
            response: Any = _StubMessage(text, kwargs.get("model", ""))
        else:
            try:
                response = await real_create(self, **kwargs)
            except BaseException as exc:
                rec.record_error("anthropic", _serialize(kwargs), exc)
                raise
        rec.record("anthropic", _serialize(kwargs), _serialize(response))
        return response

    AsyncMessages.create = create

    real_generate = Models.generate_content

    def generate_content(self, **kwargs):  # type: ignore[no-untyped-def]
        if dry_run:
            response: Any = _StubGeminiResponse()
        else:
            try:
                response = real_generate(self, **kwargs)
            except BaseException as exc:
                rec.record_error("gemini", _serialize(kwargs), exc)
                raise
        rec.record("gemini", _serialize(kwargs), _serialize(response))
        return response

    Models.generate_content = generate_content


# --------------------------------------------------------------------------
# Capture
# --------------------------------------------------------------------------


def build_state(spec: dict[str, Any], api_keys: dict[str, str]) -> dict[str, Any]:
    post = Post(**{k: spec[k] for k in POST_FIELDS if k in spec})
    state = state_from_post(post, internal_links=spec.get("internal_links") or [])
    state["api_keys"] = api_keys
    return state


async def capture_post(
    spec: dict[str, Any],
    stages: list[str],
    out_dir: Path,
    rec: Recorder,
    api_keys: dict[str, str],
    dry_run: bool,
) -> list[Path]:
    from src.pipeline.stages.edit import edit_node
    from src.pipeline.stages.images import images_node
    from src.pipeline.stages.outline import outline_node
    from src.pipeline.stages.ready import ready_node
    from src.pipeline.stages.research import research_node
    from src.pipeline.stages.write import write_node

    nodes = {
        "research": research_node,
        "outline": outline_node,
        "write": write_node,
        "edit": edit_node,
        "images": images_node,
        "ready": ready_node,
    }

    slug = spec["slug"]
    post_dir = out_dir / slug
    post_dir.mkdir(parents=True, exist_ok=True)
    settings.media_dir = str(post_dir / "media")

    secrets = [v for v in api_keys.values() if v]
    state = build_state(spec, api_keys)
    written: list[Path] = []

    for stage in stages:
        print(f"[{slug}] {stage}: running", flush=True)
        state_input = _redact(_serialize(dict(state)), secrets)
        rec.start(stage)
        output = await nodes[stage](state)
        calls = _elide_blobs(_redact(_serialize(rec.calls), secrets))

        fixture = {
            "schema_version": 1,
            "generated_by": "api/scripts/capture_golden.py",
            "mode": "dry-run" if dry_run else "live",
            "captured_at": datetime.now(UTC).isoformat(),
            "post_slug": slug,
            "stage": stage,
            "post_spec": _redact(spec, secrets),
            "state_input": state_input,
            "rendered_prompts": [_rendered_prompt(c) for c in calls],
            "provider_calls": calls,
            "stage_output": _redact(_serialize(output), secrets),
        }
        path = post_dir / f"{stage}.json"
        path.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n")
        written.append(path)
        print(f"[{slug}] {stage}: wrote {path} ({path.stat().st_size} bytes)")

        state.update(output)

    return written


def load_api_keys() -> dict[str, str]:
    return {
        "perplexity": os.environ.get("PERPLEXITY_API_KEY", ""),
        "anthropic": os.environ.get("ANTHROPIC_API_KEY", ""),
        "gemini": os.environ.get("GEMINI_API_KEY", ""),
    }


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="fixture output directory")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="stub the network call, exercise everything else",
    )
    parser.add_argument("--post", action="append", help="limit to these post slugs")
    parser.add_argument(
        "--stages", default=",".join(STAGES), help="comma separated stage list"
    )
    args = parser.parse_args()

    stages = [s.strip() for s in args.stages.split(",") if s.strip()]
    unknown = [s for s in stages if s not in STAGES]
    if unknown:
        parser.error(f"unknown stage(s): {', '.join(unknown)}")

    specs = POST_SPECS
    if args.post:
        specs = [s for s in POST_SPECS if s["slug"] in args.post]
        if not specs:
            parser.error(f"no post spec matches {args.post}")

    api_keys = load_api_keys()
    if args.dry_run:
        api_keys = {k: v or "dry-run-placeholder" for k, v in api_keys.items()}
    else:
        missing = [k for k, v in api_keys.items() if not v]
        if missing:
            parser.error(
                "missing API key env var(s) for: "
                + ", ".join(missing)
                + " (set PERPLEXITY_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY)"
            )

    rec = Recorder()
    install_recorders(rec, args.dry_run)

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    written: list[Path] = []
    for spec in specs:
        written += await capture_post(
            spec, stages, out_dir, rec, api_keys, args.dry_run
        )

    print(f"\nWrote {len(written)} fixture file(s) under {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
