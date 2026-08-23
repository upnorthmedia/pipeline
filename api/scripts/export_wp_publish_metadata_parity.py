"""Export the parity oracle for the pure metadata helpers of the WordPress publish hook.

`publish_to_wordpress` in `api/src/pipeline/publish.py` starts with two pieces of
pure content handling before it touches the network:

* `_extract_frontmatter`, which splits the ready content into a flat key-value
  map and a body. Its four operations all differ between Python and JavaScript:
  `\\s` inside the fence pattern matches `\\x1c`-`\\x1f` in Python but not in
  JavaScript and matches `\\ufeff` in JavaScript but not in Python, `str.strip()`
  with no argument strips a different character set than `String.trim()`, and
  `.strip('"').strip("'")` strips a *set* of characters in a fixed order rather
  than a substring.
* the loop that indexes `post.image_manifest` by filename and picks the featured
  entry. That loop is inline in `publish_to_wordpress`, so rather than
  transcribe it into this script (which would make the oracle a copy of a copy)
  the block is pulled out of the real function with `inspect.getsource` and
  executed. If the source moves, the extraction raises rather than silently
  recording stale answers.

Usage:
    uv run python scripts/export_wp_publish_metadata_parity.py
"""

from __future__ import annotations

import inspect
import json
import sys
import textwrap
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "api"))

from src.pipeline.publish import (  # noqa: E402
    _extract_frontmatter,
    publish_to_wordpress,
)

OUT = (
    REPO_ROOT
    / "web"
    / "src"
    / "mastra"
    / "wordpress"
    / "data"
    / "wp-publish-metadata-parity.json"
)

FIRST_LINE = "manifest = post.image_manifest or {}"
LAST_LINE = "featured_filename = fname"


def _manifest_block() -> str:
    """Pull the manifest-indexing block out of the real `publish_to_wordpress`."""
    lines = inspect.getsource(publish_to_wordpress).split("\n")
    starts = [i for i, line in enumerate(lines) if line.strip() == FIRST_LINE]
    ends = [i for i, line in enumerate(lines) if line.strip() == LAST_LINE]
    if len(starts) != 1 or len(ends) != 1 or ends[0] < starts[0]:
        raise RuntimeError(
            "the manifest-indexing block in publish_to_wordpress has moved; "
            f"found {len(starts)} start and {len(ends)} end markers"
        )
    return textwrap.dedent("\n".join(lines[starts[0] : ends[0] + 1]))


class _Post:
    def __init__(self, image_manifest: Any) -> None:
        self.image_manifest = image_manifest


def _run_manifest_block(block: str, image_manifest: Any) -> dict[str, Any]:
    namespace: dict[str, Any] = {"post": _Post(image_manifest)}
    exec(block, namespace)  # noqa: S102 - the source is this repo's own function
    return {
        "by_file": namespace["manifest_by_file"],
        "featured_filename": namespace["featured_filename"],
    }


FRONTMATTER_CASES: list[tuple[str, str]] = [
    ("empty", ""),
    ("no frontmatter", "# Hello\n\nBody.\n"),
    ("plain frontmatter", "---\ntitle: Hello\ndescription: A post\n---\nBody.\n"),
    ("no body after the closing fence", "---\ntitle: Hello\n---\n"),
    ("empty frontmatter block", "---\n\n---\nBody.\n"),
    ("fence not at the start of the string", "\n---\ntitle: Hello\n---\nBody.\n"),
    ("leading space before the opening fence", " ---\ntitle: Hello\n---\nBody.\n"),
    ("four dashes on the opening fence", "----\ntitle: Hello\n---\nBody.\n"),
    ("spaces after the opening fence", "---   \ntitle: Hello\n---\nBody.\n"),
    ("spaces after the closing fence", "---\ntitle: Hello\n---   \nBody.\n"),
    ("crlf line endings", "---\r\ntitle: Hello\r\n---\r\nBody.\r\n"),
    ("blank line after the opening fence", "---\n\ntitle: Hello\n---\nBody.\n"),
    (
        "a second fence pair later in the body",
        "---\ntitle: Hello\n---\nBody.\n\n---\ntitle: Other\n---\nMore.\n",
    ),
    ("horizontal rule in the body", "---\ntitle: Hello\n---\nBody.\n\n---\n\nMore.\n"),
    ("line without a colon is skipped", "---\ntitle: Hello\njust text\n---\nBody.\n"),
    ("duplicate key, last wins", "---\ntitle: One\ntitle: Two\n---\nBody.\n"),
    ("empty value", "---\ntitle:\ndescription: d\n---\nBody.\n"),
    ("value with an inner colon", "---\ntitle: Hello: World\n---\nBody.\n"),
    ("key with surrounding spaces", "---\n  title  : Hello\n---\nBody.\n"),
    ("double-quoted value", '---\ntitle: "Hello"\n---\nBody.\n'),
    ("single-quoted value", "---\ntitle: 'Hello'\n---\nBody.\n"),
    ("double quotes outside single", "---\ntitle: \"'Hello'\"\n---\nBody.\n"),
    ("single quotes outside double", "---\ntitle: '\"Hello\"'\n---\nBody.\n"),
    ("tripled double quotes", '---\ntitle: """Hello"""\n---\nBody.\n'),
    ("unbalanced trailing quote", '---\ntitle: Hello"\n---\nBody.\n'),
    ("quote in the middle of the value", '---\ntitle: He"llo\n---\nBody.\n'),
    ("value is only quotes", '---\ntitle: "\'"\n---\nBody.\n'),
    ("tab-padded value", "---\ntitle:\tHello\t\n---\nBody.\n"),
    ("key named __proto__", "---\n__proto__: x\ntitle: Hello\n---\nBody.\n"),
    ("key named constructor", "---\nconstructor: x\ntitle: Hello\n---\nBody.\n"),
    (
        "file separator after the opening fence",
        "---\x1c\ntitle: Hello\n---\nBody.\n",
    ),
    (
        "byte order mark after the opening fence",
        "---\ufeff\ntitle: Hello\n---\nBody.\n",
    ),
    (
        "next line character after the closing fence",
        "---\ntitle: Hello\n---\x85\nBody.\n",
    ),
    (
        "line separator after the closing fence",
        "---\ntitle: Hello\n---\u2028\nBody.\n",
    ),
    ("file separator around a key", "---\n\x1ctitle\x1c: Hello\n---\nBody.\n"),
    ("byte order mark around a key", "---\n\ufefftitle\ufeff: Hello\n---\nBody.\n"),
    ("file separator around a value", "---\ntitle: \x1cHello\x1c\n---\nBody.\n"),
    ("byte order mark around a value", "---\ntitle: \ufeffHello\ufeff\n---\nBody.\n"),
    ("no-break space around a value", "---\ntitle: \xa0Hello\xa0\n---\nBody.\n"),
    ("line separator inside a value", "---\ntitle: Hello\u2028World\n---\nBody.\n"),
    ("body keeps its trailing newline", "---\ntitle: Hello\n---\nBody.\n\n\n"),
    ("body with no trailing newline", "---\ntitle: Hello\n---\nBody."),
    (
        "media url in the body",
        "---\ntitle: Hello\n---\n![a](/media/POST/a.webp)\n",
    ),
]


def _img(**kwargs: Any) -> dict[str, Any]:
    return dict(kwargs)


MANIFEST_CASES: list[tuple[str, Any]] = [
    ("null manifest", None),
    ("empty manifest", {}),
    ("manifest without an images key", {"count": 0}),
    ("empty images list", {"images": []}),
    (
        "one inline image",
        {"images": [_img(url="/media/p1/body-1.webp", alt_text="A chart")]},
    ),
    (
        "featured by placement",
        {
            "images": [
                _img(url="/media/p1/featured-010225-47.webp", placement="featured"),
                _img(url="/media/p1/body-1.webp", placement="inline"),
            ]
        },
    ),
    (
        "featured by type",
        {
            "images": [
                _img(url="/media/p1/body-1.webp", placement="inline"),
                _img(url="/media/p1/hero.webp", type="featured"),
            ]
        },
    ),
    (
        "two featured entries, last wins",
        {
            "images": [
                _img(url="/media/p1/a.webp", placement="featured"),
                _img(url="/media/p1/b.webp", type="featured"),
            ]
        },
    ),
    (
        "featured flag with the wrong case",
        {"images": [_img(url="/media/p1/a.webp", placement="Featured")]},
    ),
    (
        "entry with no url",
        {"images": [_img(generated=False, error="no prompt", index=0)]},
    ),
    (
        "url with no slash",
        {"images": [_img(url="bare.webp", alt_text="Bare")]},
    ),
    (
        "url ending in a slash",
        {"images": [_img(url="/media/p1/", alt_text="Trailing")]},
    ),
    (
        "two entries with the same filename, last wins",
        {
            "images": [
                _img(url="/media/p1/a.webp", alt_text="First"),
                _img(url="/media/p2/a.webp", alt_text="Second"),
            ]
        },
    ),
    (
        "featured entry overwritten by a later entry with the same filename",
        {
            "images": [
                _img(url="/media/p1/a.webp", placement="featured"),
                _img(url="/media/p2/a.webp", placement="inline"),
            ]
        },
    ),
    (
        "explicit null alt text",
        {"images": [_img(url="/media/p1/a.webp", alt_text=None)]},
    ),
    (
        "filename that is a javascript prototype key",
        {"images": [_img(url="/media/p1/__proto__", placement="featured")]},
    ),
    (
        "absolute remote url",
        {"images": [_img(url="https://cdn.example.com/x/y.webp", alt_text="Remote")]},
    ),
    (
        "windows-style separators are not path separators here",
        {"images": [_img(url="media\\p1\\a.webp", alt_text="Backslash")]},
    ),
    (
        "full manifest as the images stage writes it",
        {
            "images": [
                _img(
                    prompt="A wide hero shot",
                    placement="featured",
                    alt_text="Hero",
                    filename="featured.png",
                    generated=True,
                    size_bytes=182344,
                    url="/media/p1/featured-010225-47.webp",
                    index=0,
                ),
                _img(
                    prompt="A diagram",
                    placement="inline",
                    alt_text="Diagram",
                    filename="image-1.png",
                    generated=True,
                    size_bytes=91002,
                    url="/media/p1/image-1.webp",
                    index=1,
                ),
                _img(
                    prompt="",
                    placement="inline",
                    generated=False,
                    error="no prompt",
                    index=2,
                ),
            ],
            "count": 3,
        },
    ),
]


def main() -> None:
    block = _manifest_block()
    frontmatter = []
    for name, content in FRONTMATTER_CASES:
        meta, body = _extract_frontmatter(content)
        frontmatter.append(
            {
                "name": name,
                "input": content,
                "meta": [[k, v] for k, v in meta.items()],
                "body": body,
            }
        )
    manifests = []
    for name, image_manifest in MANIFEST_CASES:
        result = _run_manifest_block(block, image_manifest)
        manifests.append(
            {
                "name": name,
                "input": image_manifest,
                "byFile": [[k, v] for k, v in result["by_file"].items()],
                "featuredFilename": result["featured_filename"],
            }
        )
    # Both maps are emitted as pair lists rather than JSON objects: a model can
    # write `__proto__` as a frontmatter key or an image filename, and that key
    # does not survive a round trip through a JavaScript object literal.
    payload = {
        "manifestBlockSource": block,
        "frontmatter": frontmatter,
        "manifests": manifests,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    parsed = sum(1 for row in frontmatter if row["meta"])
    featured = sum(1 for row in manifests if row["featuredFilename"] is not None)
    print(
        f"wrote {len(frontmatter)} frontmatter cases ({parsed} with a parsed block) "
        f"and {len(manifests)} manifest cases ({featured} with a featured image) "
        f"to {OUT}"
    )


if __name__ == "__main__":
    main()
