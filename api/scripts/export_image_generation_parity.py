"""Export the parity oracle the TypeScript port of `_generate_one` needs.

`_generate_one` is a closure inside `images_node`, so it cannot be imported and
called directly. This script instead drives the real `images_node` with both
providers intercepted, which keeps the oracle on the production code path: the
manifest comes back from a stubbed `ClaudeClient.chat`, every Gemini call is
recorded and answered with a real PNG, and everything between those two points
(the aspect-ratio and image-size decision, the featured-image overrides, the
1920-vs-1200 optimize width, `Path(filename).stem`, the featured filename
rewrite, the disk write and the `/media/<post_id>/<filename>` URL) runs for
real against a temporary media directory.

Three things are pinned so the corpus is reproducible:

* `datetime.now(UTC)` inside the stage module, because the featured filename
  carries `%m%d%y`;
* `random.randint`, because it carries two more digits;
* the PNG handed back for every image, at 64x48 so `optimize_image` never
  resizes. Pillow and sharp produce byte-identical WebP when no resize happens
  (item 3.5b), so the recorded output bytes are an equality the port can assert
  rather than a tolerance.

The image specs in `MANIFEST` are deliberately not the golden fixtures'. Every
Gemini call in those was a 429, so they exercise exactly one of the branches
below; the cases here cover the rest, including the three the real manifests
cannot reach because Claude writes `placement` as an object rather than the
string `"featured"` the override branch tests for.

Usage:
    uv run python scripts/export_image_generation_parity.py
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import re
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "api"))

from src.config import settings  # noqa: E402
from src.pipeline import helpers  # noqa: E402
from src.pipeline.stages import images as images_stage  # noqa: E402
from src.services.llm import ImageGenResponse, LLMResponse  # noqa: E402

OUT = (
    REPO_ROOT
    / "web"
    / "src"
    / "mastra"
    / "images"
    / "data"
    / "image-generation-parity.json"
)


def _png_64x48() -> bytes:
    """A deterministic 64x48 opaque PNG, built rather than pasted.

    64x48 is under both optimize widths, so `optimize_image` never resizes and
    the WebP bytes it produces are byte-identical to sharp's (item 3.5b). The
    diagonal gradient exists so the encoder has real entropy to work on instead
    of a flat fill that would compress to almost nothing.
    """
    image = Image.new("RGB", (64, 48))
    image.putdata(
        [
            ((x * 4) % 256, (y * 5) % 256, (x + y) % 256)
            for y in range(48)
            for x in range(64)
        ]
    )
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


PNG_64X48 = _png_64x48()


def _png_2400x1600() -> bytes:
    """A deterministic 2400x1600 PNG, wider than both optimize widths.

    Without it the corpus cannot tell the 1920 branch from the 1200 one: every
    other input here is 64px wide, so `optimize_image` returns it untouched
    whichever width it is handed. These two cases are the only ones that
    actually resize, which is also why their bytes are not comparable across
    stacks (Pillow's Lanczos convolution against libvips' reduce, item 3.5b);
    the corpus records their dimensions instead of a hash.
    """
    image = Image.new("RGB", (2400, 1600))
    image.putdata(
        [
            ((x // 9) % 256, (y // 6) % 256, (x ^ y) % 256)
            for y in range(1600)
            for x in range(2400)
        ]
    )
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


PNG_2400X1600 = _png_2400x1600()

# The post id the stage builds `media_dir` and every image URL from.
POST_ID = "00000000-0000-4000-8000-0000000000e5"

# The frozen clock and random digits behind the featured filename.
FROZEN_NOW = datetime(2026, 3, 7, 15, 4, 5, tzinfo=UTC)
FROZEN_RANDINT = 47

# Neither reaches a real provider: both clients are replaced below.
FAKE_KEYS = {
    "anthropic": "test-key-not-a-real-credential",
    "gemini": "test-key-not-a-real-credential",
}

# One image spec per branch of `_generate_one`. `why` is carried into the corpus
# so the TypeScript test can name the case it is asserting.
MANIFEST: dict[str, Any] = {
    "version": "1.0",
    "style_brief": {"overall_style": "flat vector", "color_palette": ["#1F3A93"]},
    "images": [
        {
            "why": "the real manifest shape: placement is an object, so only "
            "`type` marks it featured and the aspect/size override never fires",
            "id": "featured",
            "type": "featured",
            "filename": "featured-082226-39.png",
            "aspect_ratio": "16:9",
            "image_size": "2K",
            "prompt": "a wide editorial hero",
            "placement": {"location": "featured_image", "after_section": None},
        },
        {
            "why": "placement is the literal string the override branch tests "
            "for and no aspect_ratio key, so both 16:9 and 2K are forced",
            "id": "hero-string-placement",
            "filename": "hero.png",
            "prompt": "a hero with no declared ratio",
            "placement": "featured",
        },
        {
            "why": "same string placement but an explicit aspect_ratio, so the "
            "size is forced to 2K and the ratio survives",
            "id": "hero-string-placement-with-ratio",
            "filename": "hero-square.png",
            "aspect_ratio": "1:1",
            "image_size": "1K",
            "prompt": "a square hero",
            "placement": "featured",
        },
        {
            "why": "a plain content image: both provider defaults apply and the "
            "optimize width is 1200",
            "id": "content-defaults",
            "filename": "diagram-1.png",
            "prompt": "a simple diagram",
        },
        {
            "why": "no filename key at all, so the default is image-<index>.png",
            "id": "no-filename",
            "prompt": "an unnamed image",
        },
        {
            "why": "Path().stem strips only the last suffix",
            "id": "multi-dot",
            "filename": "chart.v2.final.png",
            "prompt": "a multi-dot filename",
        },
        {
            "why": "Path().stem on a name with no suffix returns it unchanged",
            "id": "no-extension",
            "filename": "plain",
            "prompt": "an extensionless filename",
        },
        {
            "why": "Path().stem drops the directory, so a filename carrying a "
            "path writes flat into the media dir",
            "id": "nested-filename",
            "filename": "sub/dir/nested.png",
            "prompt": "a filename with a directory in it",
        },
        {
            "why": "an empty filename leaves the bare extension",
            "id": "empty-filename",
            "filename": "",
            "prompt": "an empty filename",
        },
        {
            "why": "an empty prompt short-circuits before Gemini is called",
            "id": "empty-prompt",
            "filename": "skipped.png",
            "prompt": "",
        },
        {
            "why": "a missing prompt key takes the same short-circuit",
            "id": "missing-prompt",
            "filename": "skipped-2.png",
        },
        {
            "why": "a provider failure is caught per image and recorded as "
            "str(e) without failing the stage",
            "id": "provider-error",
            "filename": "boom.png",
            "prompt": "RAISE",
        },
        {
            "why": "wider than both optimize widths and not featured, so it is "
            "the only case that pins the 1200 branch",
            "id": "wide-content",
            "filename": "wide-content.png",
            "prompt": "WIDE",
        },
        {
            "why": "the same input marked featured by `type`, which is what "
            "separates the 1920 branch from the 1200 one",
            "id": "wide-featured",
            "type": "featured",
            "filename": "wide-featured.png",
            "prompt": "WIDE",
        },
        {
            "why": "the optimizer fails on bytes that are not an image, and the "
            "failure lands in the same handler as a provider failure even "
            "though the call was already made and billed",
            "id": "unoptimizable",
            "filename": "corrupt.png",
            "prompt": "BADBYTES",
        },
        {
            "why": "keys the stage sets itself are overwritten, not merged "
            "under, so a re-run cannot leave a stale generated/index behind",
            "id": "stale-keys",
            "filename": "stale.png",
            "prompt": "a spec carrying stale bookkeeping",
            "generated": True,
            "index": 99,
            "url": "/media/somewhere-else/stale.webp",
            "size_bytes": 1,
        },
    ],
}

# Inputs for the `Path(...).stem` oracle, POSIX semantics.
PATH_STEM_CASES = [
    "featured.png",
    "a.b.c.png",
    "plain",
    "sub/dir/x.png",
    "",
    ".hidden",
    "x.",
    "..",
    ".",
    "a/b/",
    "/abs/y.PNG",
    "..png",
    "a//b.png",
    "...",
    "..a.b",
]

# The message the stubbed Gemini raises for the failure case. Chosen so the
# recorded `str(e)` is stable across runs.
GEMINI_ERROR = "429 RESOURCE_EXHAUSTED. quota exceeded"


class _FakeClaude:
    """Returns the manifest above instead of calling Anthropic."""

    def __init__(self, api_key: str | None = None) -> None:
        self.api_key = api_key

    async def chat(self, prompt: str, system: str, max_tokens: int) -> LLMResponse:
        _FakeClaude.calls.append(
            {"prompt": prompt, "system": system, "max_tokens": max_tokens}
        )
        # `why` is corpus metadata, not part of what Claude would emit, but it
        # is left in on purpose: it proves the stage passes unknown keys through
        # into the stored manifest untouched.
        return LLMResponse(
            content=json.dumps(MANIFEST),
            model="claude-opus-4-6",
            tokens_in=1234,
            tokens_out=567,
        )

    async def close(self) -> None:
        return None


_FakeClaude.calls = []


class _FakeGemini:
    """Records every generate_image call and answers with a real PNG."""

    calls: list[dict[str, Any]] = []

    def __init__(self, api_key: str | None = None) -> None:
        self.api_key = api_key

    async def generate_image(
        self, prompt: str, aspect_ratio: str, image_size: str
    ) -> ImageGenResponse:
        self.calls.append(
            {
                "prompt": prompt,
                "aspect_ratio": aspect_ratio,
                "image_size": image_size,
            }
        )
        if prompt == "RAISE":
            raise RuntimeError(GEMINI_ERROR)
        image_bytes = PNG_64X48
        if prompt == "BADBYTES":
            image_bytes = b"not an image"
        elif prompt == "WIDE":
            image_bytes = PNG_2400X1600
        # Distinct per call so the summed totals cannot be produced by accident.
        return ImageGenResponse(
            image_bytes=image_bytes,
            model="gemini-3.1-flash-image-preview",
            tokens_in=10 + len(self.calls),
            tokens_out=100 + len(self.calls),
        )


class _FrozenDatetime:
    """Only `now` is used by the stage; nothing else needs to exist."""

    @staticmethod
    def now(tz: Any = None) -> datetime:
        return FROZEN_NOW


class _FrozenRandom:
    @staticmethod
    def randint(low: int, high: int) -> int:
        _FrozenRandom.calls.append([low, high])
        return FROZEN_RANDINT


_FrozenRandom.calls = []


def _state(media_dir: str) -> dict[str, Any]:
    """The subset of `PipelineState` the images stage reads."""
    fixture = json.loads(
        (
            REPO_ROOT
            / "docs"
            / "mastra-port"
            / "golden"
            / "how-to-choose-a-crm-for-a-small-team"
            / "images.json"
        ).read_text()
    )
    state = dict(fixture["state_input"])
    state["post_id"] = POST_ID
    state["api_keys"] = FAKE_KEYS
    return state


async def _run() -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as tmp:
        settings.media_dir = tmp
        images_stage.ClaudeClient = _FakeClaude
        images_stage.GeminiClient = _FakeGemini
        images_stage.datetime = _FrozenDatetime
        images_stage.random = _FrozenRandom

        async def _no_publish(*args: Any, **kwargs: Any) -> None:
            return None

        images_stage.publish_stage_log = _no_publish
        helpers.publish_stage_log = _no_publish

        result = await images_stage.images_node(_state(tmp))

        media_dir = Path(tmp) / POST_ID
        files = sorted(p.name for p in media_dir.iterdir() if p.is_file())
        written = {}
        for name in files:
            data = (media_dir / name).read_bytes()
            with Image.open(io.BytesIO(data)) as decoded:
                width, height = decoded.size
            entry: dict[str, Any] = {
                "bytes": len(data),
                "width": width,
                "height": height,
                # True for the two cases that were wider than their optimize
                # width. A resized file's bytes are Pillow's resampler and the
                # port's are libvips', so only the dimensions are comparable.
                "resized": width != 64,
            }
            if not entry["resized"]:
                entry["sha256"] = hashlib.sha256(data).hexdigest()
            written[name] = entry

    manifest = result["image_manifest"]
    # Pillow renders the failing buffer's memory address into its message, so
    # the raw string is not reproducible run to run, let alone across stacks.
    # The address is masked here and `unoptimizable` is the one case whose
    # `error` text the TypeScript test asserts the shape of rather than the
    # value; every other error in this corpus comes from the provider and is
    # carried across verbatim.
    for image in manifest["images"]:
        if isinstance(image.get("error"), str):
            image["error"] = re.sub(r"0x[0-9a-f]+", "0xADDR", image["error"])

    return {
        "why": __doc__.strip().split("\n\n")[0],
        # A direct oracle for `Path(...).stem`, the one Python builtin the port
        # has to reimplement here. The manifest cases above only reach five of
        # these; the rest pin the boundaries of `0 < i < len(name) - 1` and of
        # how a `.` component disappears from a path while `..` does not.
        "path_stem_cases": [
            {"input": value, "stem": Path(value).stem, "name": Path(value).name}
            for value in PATH_STEM_CASES
        ],
        "post_id": POST_ID,
        "frozen_now": FROZEN_NOW.isoformat(),
        "frozen_randint": FROZEN_RANDINT,
        "randint_calls": _FrozenRandom.calls,
        "png_base64": base64.b64encode(PNG_64X48).decode(),
        "wide_png_base64": base64.b64encode(PNG_2400X1600).decode(),
        "input_manifest": MANIFEST,
        "gemini_calls": _FakeGemini.calls,
        "images": manifest["images"],
        "total_generated": manifest["total_generated"],
        "total_failed": manifest["total_failed"],
        "manifest_keys": list(manifest.keys()),
        "stage_status": result["stage_status"],
        "stage_meta": result["_stage_meta"],
        "stage_meta_gemini": {
            key: value
            for key, value in result["_stage_meta_gemini"].items()
            if key != "duration_s"
        },
        "written_files": written,
    }


def main() -> None:
    payload = asyncio.run(_run())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {OUT.relative_to(REPO_ROOT)}")
    print(f"  images: {len(payload['images'])}")
    print(f"  gemini calls: {len(payload['gemini_calls'])}")
    print(f"  files written: {len(payload['written_files'])}")


if __name__ == "__main__":
    main()
