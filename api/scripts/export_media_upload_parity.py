"""Export the parity oracle for the upload loop of the WordPress publish hook.

`publish_to_wordpress` in `api/src/pipeline/publish.py` uploads every image it
found with twenty lines that decide four things: which files are images, what
alt text each upload carries, which upload becomes the featured media, and how
the rendered HTML is rewritten to point at WordPress instead of the local media
directory.

    mime, _ = mimetypes.guess_type(img_file.name)
    if not mime or not mime.startswith("image/"):
        continue

    img_info = manifest_by_file.get(img_file.name, {})
    alt = img_info.get("alt_text", title)

    img_bytes = img_file.read_bytes()
    media = await client.upload_media(img_bytes, img_file.name, mime, alt_text=alt)
    wp_media_url = media.get("source_url", "")
    local_url = f"/media/{post_id}/{img_file.name}"
    image_map[local_url] = wp_media_url

    if featured_filename and img_file.name == featured_filename:
        featured_media_id = media.get("id")
    elif featured_media_id is None and not featured_filename:
        featured_media_id = media.get("id")

    ...

    for local, remote in image_map.items():
        wp_html = wp_html.replace(local, remote)

The parts that do not survive a naive transcription:

* `dict.get(key, default)` returns the *stored* value when the key is present,
  so an `alt_text` of `None` or `""` is forwarded rather than falling back to
  the title. `info.alt_text ?? title` gets both wrong.
* `featured_media_id = media.get("id")` can put the variable *back* to `None`
  when the response has no `id`, which re-arms the `elif` for the next file, so
  the "first image" fallback is really "first image with an id".
* an empty `featured_filename` is falsy, so a manifest whose featured entry has
  a url ending in `/` takes the first-image path rather than matching the file
  whose name is the empty string.
* a `featured_filename` that matches no file leaves the featured media unset;
  there is no fallback in that direction.
* `str.replace` is `String.prototype.replaceAll`, except that JavaScript reads
  `$&`, `` $` ``, `$'` and `$$` in the *replacement* as substitution patterns.
  A `source_url` containing any of them is corrupted by the obvious port.
* the replacements run in insertion order over the whole document, so an
  earlier local URL that is a prefix of a later one rewrites the later one's
  prefix first.

The twenty lines are pulled out of the real function with `inspect.getsource`
and executed rather than transcribed, so the recorded answers cannot drift from
the function they describe without this script raising.

The files are real files in a scratch directory: `read_bytes` reads them and
`mimetypes.guess_type` runs against the interpreter's table. That table is not
reproducible on a developer machine, so this script refuses to run anywhere but
the deployed image: `mimetypes.init()` reads `mimetypes.knownfiles`, macOS has
`/etc/apache2/mime.types`, and reading it grows the table from 152 entries to
1036 (see `export_mimetypes_parity.py`). Python 3.13 also added `.webp` to the
builtin table and 3.12 does not have it, which changes this loop's answer for
every file the images stage writes.

Each corpus file carries the type the deployed table gives it and the script
asserts that too, so a wrong interpreter cannot silently record a different
mime.

Usage:
    docker build -t jena-api-oracle api
    docker run --rm -v "$PWD":/w -w /w/api jena-api-oracle \
        python scripts/export_media_upload_parity.py
"""

from __future__ import annotations

import asyncio
import inspect
import json
import pathlib
import sys
import tempfile
import textwrap
from typing import Any

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "api"))

from src.pipeline.publish import publish_to_wordpress  # noqa: E402

OUT = (
    REPO_ROOT
    / "web"
    / "src"
    / "mastra"
    / "wordpress"
    / "data"
    / "wp-media-upload-parity.json"
)

FIRST_LINE = "mime, _ = mimetypes.guess_type(img_file.name)"
LAST_LINE = "elif featured_media_id is None and not featured_filename:"
REWRITE_LINE = "for local, remote in image_map.items():"


def _loop_body() -> str:
    """Pull the per-file upload block out of the real `publish_to_wordpress`."""
    lines = inspect.getsource(publish_to_wordpress).split("\n")
    starts = [i for i, line in enumerate(lines) if line.strip() == FIRST_LINE]
    ends = [i for i, line in enumerate(lines) if line.strip() == LAST_LINE]
    if len(starts) != 1 or len(ends) != 1 or ends[0] <= starts[0]:
        raise RuntimeError(
            "the upload loop in publish_to_wordpress has moved; "
            f"found {len(starts)} start and {len(ends)} end markers"
        )
    if lines[ends[0] + 1].strip() != 'featured_media_id = media.get("id")':
        raise RuntimeError("the featured-media elif no longer assigns media['id']")
    return textwrap.dedent("\n".join(lines[starts[0] : ends[0] + 2]))


def _rewrite_body() -> str:
    """Pull the local-to-remote URL rewrite out of the real function."""
    lines = inspect.getsource(publish_to_wordpress).split("\n")
    starts = [i for i, line in enumerate(lines) if line.strip() == REWRITE_LINE]
    if len(starts) != 1:
        raise RuntimeError("the image URL rewrite in publish_to_wordpress has moved")
    if lines[starts[0] + 1].strip() != "wp_html = wp_html.replace(local, remote)":
        raise RuntimeError("the image URL rewrite no longer calls str.replace")
    return textwrap.dedent("\n".join(lines[starts[0] : starts[0] + 2]))


HARNESS = """
async def _run(
    files, manifest_by_file, featured_filename, title, post_id, wp_html, client
):
    image_map = {}
    featured_media_id = None
    for img_file in files:
{body}
{rewrite}
    return image_map, featured_media_id, wp_html
"""


class _FakeClient:
    """`WordPressClient` as far as the upload loop can see it."""

    def __init__(self, responses: dict[str, Any]):
        self._responses = responses
        self.calls: list[dict[str, Any]] = []

    async def upload_media(
        self,
        image_bytes: bytes,
        filename: str,
        mime_type: str,
        alt_text: Any = "",
    ) -> Any:
        self.calls.append(
            {
                "bytes": image_bytes.hex(),
                "filename": filename,
                "mime": mime_type,
                "alt_text": alt_text,
            }
        )
        return self._responses[filename]


# Every case writes `files` into a scratch directory in the listed order, then
# runs the loop over them in that same order: the sort is the walk's oracle, not
# this one's.
CASES: list[dict[str, Any]] = [
    {
        "name": "no files at all",
        "files": [],
        "manifest_by_file": {},
        "featured_filename": None,
        "title": "How To Roast Coffee",
        "post_id": "11111111-1111-4111-8111-111111111111",
        "html": "<p>no images here</p>",
        "responses": {},
    },
    {
        "name": "one image, no manifest entry: alt falls back to the title",
        "files": [{"name": "featured.png", "bytes": "89504e47", "mime": "image/png"}],
        "manifest_by_file": {},
        "featured_filename": None,
        "title": "How To Roast Coffee",
        "post_id": "11111111-1111-4111-8111-111111111111",
        "html": '<img src="/media/11111111-1111-4111-8111-111111111111/featured.png"/>',
        "responses": {
            "featured.png": {
                "id": 41,
                "source_url": "https://wp.example/2026/08/featured.png",
            }
        },
    },
    {
        "name": "the mime filter drops a non-image and an unknown extension",
        "files": [
            {"name": "notes.txt", "bytes": "68690a", "mime": "text/plain"},
            {"name": "shot.png", "bytes": "89504e47", "mime": "image/png"},
            {"name": "archive.unknownext", "bytes": "00", "mime": None},
        ],
        "manifest_by_file": {},
        "featured_filename": None,
        "title": "T",
        "post_id": "p1",
        "html": (
            '<a href="/media/p1/notes.txt">notes</a><img src="/media/p1/shot.png"/>'
        ),
        "responses": {
            "shot.png": {"id": 7, "source_url": "https://wp.example/shot.png"}
        },
    },
    {
        "name": "a .webp file is not an image to the deployed table, so it is skipped",
        "files": [
            {"name": "featured-082326-abc.webp", "bytes": "52494646", "mime": None},
            {"name": "inline.png", "bytes": "89504e47", "mime": "image/png"},
        ],
        "manifest_by_file": {},
        "featured_filename": "featured-082326-abc.webp",
        "title": "T",
        "post_id": "p1",
        "html": (
            '<img src="/media/p1/featured-082326-abc.webp"/>'
            '<img src="/media/p1/inline.png"/>'
        ),
        "responses": {
            "inline.png": {"id": 9, "source_url": "https://wp.example/inline.png"}
        },
    },
    {
        "name": "manifest alt text wins over the title",
        "files": [{"name": "a.png", "bytes": "89504e47", "mime": "image/png"}],
        "manifest_by_file": {"a.png": {"alt_text": "A close-up of a portafilter"}},
        "featured_filename": None,
        "title": "T",
        "post_id": "p1",
        "html": '<img src="/media/p1/a.png"/>',
        "responses": {"a.png": {"id": 1, "source_url": "https://wp.example/a.png"}},
    },
    {
        "name": "an empty manifest alt text is forwarded, not replaced by the title",
        "files": [{"name": "a.png", "bytes": "89504e47", "mime": "image/png"}],
        "manifest_by_file": {"a.png": {"alt_text": ""}},
        "featured_filename": None,
        "title": "T",
        "post_id": "p1",
        "html": "<p/>",
        "responses": {"a.png": {"id": 1, "source_url": "https://wp.example/a.png"}},
    },
    {
        "name": "a null manifest alt text is forwarded, not replaced by the title",
        "files": [{"name": "a.png", "bytes": "89504e47", "mime": "image/png"}],
        "manifest_by_file": {"a.png": {"alt_text": None}},
        "featured_filename": None,
        "title": "T",
        "post_id": "p1",
        "html": "<p/>",
        "responses": {"a.png": {"id": 1, "source_url": "https://wp.example/a.png"}},
    },
    {
        "name": "a manifest entry without alt_text falls back to the title",
        "files": [{"name": "a.png", "bytes": "89504e47", "mime": "image/png"}],
        "manifest_by_file": {"a.png": {"placement": "inline"}},
        "featured_filename": None,
        "title": "How To Roast Coffee",
        "post_id": "p1",
        "html": "<p/>",
        "responses": {"a.png": {"id": 1, "source_url": "https://wp.example/a.png"}},
    },
    {
        "name": "the featured filename picks the second file, not the first",
        "files": [
            {"name": "a.png", "bytes": "89504e47", "mime": "image/png"},
            {"name": "b.png", "bytes": "89504e48", "mime": "image/png"},
        ],
        "manifest_by_file": {},
        "featured_filename": "b.png",
        "title": "T",
        "post_id": "p1",
        "html": '<img src="/media/p1/a.png"/><img src="/media/p1/b.png"/>',
        "responses": {
            "a.png": {"id": 1, "source_url": "https://wp.example/a.png"},
            "b.png": {"id": 2, "source_url": "https://wp.example/b.png"},
        },
    },
    {
        "name": "a featured filename matching nothing leaves the featured media unset",
        "files": [{"name": "a.png", "bytes": "89504e47", "mime": "image/png"}],
        "manifest_by_file": {},
        "featured_filename": "gone.png",
        "title": "T",
        "post_id": "p1",
        "html": "<p/>",
        "responses": {"a.png": {"id": 1, "source_url": "https://wp.example/a.png"}},
    },
    {
        "name": "an empty featured filename is falsy and takes the first-image path",
        "files": [
            {"name": "a.png", "bytes": "89504e47", "mime": "image/png"},
            {"name": "b.png", "bytes": "89504e48", "mime": "image/png"},
        ],
        "manifest_by_file": {},
        "featured_filename": "",
        "title": "T",
        "post_id": "p1",
        "html": "<p/>",
        "responses": {
            "a.png": {"id": 1, "source_url": "https://wp.example/a.png"},
            "b.png": {"id": 2, "source_url": "https://wp.example/b.png"},
        },
    },
    {
        "name": "the featured file is uploaded twice over: the last match wins",
        "files": [
            {"name": "a.png", "bytes": "89504e47", "mime": "image/png"},
            {"name": "b.png", "bytes": "89504e48", "mime": "image/png"},
            {"name": "c.png", "bytes": "89504e49", "mime": "image/png"},
        ],
        "manifest_by_file": {},
        "featured_filename": "c.png",
        "title": "T",
        "post_id": "p1",
        "html": "<p/>",
        "responses": {
            "a.png": {"id": 1, "source_url": "https://wp.example/a.png"},
            "b.png": {"id": 2, "source_url": "https://wp.example/b.png"},
            "c.png": {"id": 3, "source_url": "https://wp.example/c.png"},
        },
    },
    {
        "name": "a response with no id re-arms the first-image fallback",
        "files": [
            {"name": "a.png", "bytes": "89504e47", "mime": "image/png"},
            {"name": "b.png", "bytes": "89504e48", "mime": "image/png"},
        ],
        "manifest_by_file": {},
        "featured_filename": None,
        "title": "T",
        "post_id": "p1",
        "html": "<p/>",
        "responses": {
            "a.png": {"source_url": "https://wp.example/a.png"},
            "b.png": {"id": 2, "source_url": "https://wp.example/b.png"},
        },
    },
    {
        "name": "a null id re-arms the first-image fallback the same way",
        "files": [
            {"name": "a.png", "bytes": "89504e47", "mime": "image/png"},
            {"name": "b.png", "bytes": "89504e48", "mime": "image/png"},
        ],
        "manifest_by_file": {},
        "featured_filename": None,
        "title": "T",
        "post_id": "p1",
        "html": "<p/>",
        "responses": {
            "a.png": {"id": None, "source_url": "https://wp.example/a.png"},
            "b.png": {"id": 2, "source_url": "https://wp.example/b.png"},
        },
    },
    {
        "name": "an id of zero is not None and blocks the fallback",
        "files": [
            {"name": "a.png", "bytes": "89504e47", "mime": "image/png"},
            {"name": "b.png", "bytes": "89504e48", "mime": "image/png"},
        ],
        "manifest_by_file": {},
        "featured_filename": None,
        "title": "T",
        "post_id": "p1",
        "html": "<p/>",
        "responses": {
            "a.png": {"id": 0, "source_url": "https://wp.example/a.png"},
            "b.png": {"id": 2, "source_url": "https://wp.example/b.png"},
        },
    },
    {
        "name": "a featured match with no id puts the featured media back to null",
        "files": [
            {"name": "a.png", "bytes": "89504e47", "mime": "image/png"},
            {"name": "b.png", "bytes": "89504e48", "mime": "image/png"},
        ],
        "manifest_by_file": {},
        "featured_filename": "b.png",
        "title": "T",
        "post_id": "p1",
        "html": "<p/>",
        "responses": {
            "a.png": {"id": 1, "source_url": "https://wp.example/a.png"},
            "b.png": {"source_url": "https://wp.example/b.png"},
        },
    },
    {
        "name": "a missing source_url deletes the local URL from the document",
        "files": [{"name": "a.png", "bytes": "89504e47", "mime": "image/png"}],
        "manifest_by_file": {},
        "featured_filename": None,
        "title": "T",
        "post_id": "p1",
        "html": '<img src="/media/p1/a.png" alt="x"/>',
        "responses": {"a.png": {"id": 1}},
    },
    {
        "name": "every occurrence of a local URL is rewritten",
        "files": [{"name": "a.png", "bytes": "89504e47", "mime": "image/png"}],
        "manifest_by_file": {},
        "featured_filename": None,
        "title": "T",
        "post_id": "p1",
        "html": (
            '<img src="/media/p1/a.png"/><a href="/media/p1/a.png">/media/p1/a.png</a>'
        ),
        "responses": {"a.png": {"id": 1, "source_url": "https://wp.example/a.png"}},
    },
    {
        "name": "an earlier local URL that prefixes a later one rewrites its prefix",
        "files": [
            {"name": "a.png", "bytes": "89504e47", "mime": "image/png"},
            {"name": "a.png.png", "bytes": "89504e48", "mime": "image/png"},
        ],
        "manifest_by_file": {},
        "featured_filename": None,
        "title": "T",
        "post_id": "p1",
        "html": '<img src="/media/p1/a.png"/><img src="/media/p1/a.png.png"/>',
        "responses": {
            "a.png": {"id": 1, "source_url": "https://wp.example/one.png"},
            "a.png.png": {"id": 2, "source_url": "https://wp.example/two.png"},
        },
    },
    {
        "name": "a source_url holding $& and $` is inserted literally",
        "files": [{"name": "a.png", "bytes": "89504e47", "mime": "image/png"}],
        "manifest_by_file": {},
        "featured_filename": None,
        "title": "T",
        "post_id": "p1",
        "html": '<img src="/media/p1/a.png"/>',
        "responses": {
            "a.png": {
                "id": 1,
                "source_url": "https://wp.example/$&$`$'$$$1.png",
            }
        },
    },
    {
        "name": "a filename holding regex metacharacters is matched literally",
        "files": [{"name": "a+b(c).png", "bytes": "89504e47", "mime": "image/png"}],
        "manifest_by_file": {"a+b(c).png": {"alt_text": "meta"}},
        "featured_filename": None,
        "title": "T",
        "post_id": "p1",
        "html": '<img src="/media/p1/a+b(c).png"/><img src="/media/p1/axbxcx.png"/>',
        "responses": {
            "a+b(c).png": {"id": 1, "source_url": "https://wp.example/meta.png"}
        },
    },
    {
        "name": "a manifest entry for a file that is not there changes nothing",
        "files": [{"name": "a.png", "bytes": "89504e47", "mime": "image/png"}],
        "manifest_by_file": {"ghost.png": {"alt_text": "ghost"}},
        "featured_filename": "ghost.png",
        "title": "T",
        "post_id": "p1",
        "html": "<p/>",
        "responses": {"a.png": {"id": 1, "source_url": "https://wp.example/a.png"}},
    },
    {
        "name": "a null source_url reaches the rewrite and raises there",
        "files": [
            {"name": "a.png", "bytes": "89504e47", "mime": "image/png"},
            {"name": "b.png", "bytes": "89504e48", "mime": "image/png"},
        ],
        "manifest_by_file": {},
        "featured_filename": None,
        "title": "T",
        "post_id": "p1",
        "html": '<img src="/media/p1/a.png"/>',
        "responses": {
            "a.png": {"id": 1, "source_url": None},
            "b.png": {"id": 2, "source_url": "https://wp.example/b.png"},
        },
        "raises": "TypeError",
    },
    {
        "name": "a numeric source_url reaches the rewrite and raises there",
        "files": [{"name": "a.png", "bytes": "89504e47", "mime": "image/png"}],
        "manifest_by_file": {},
        "featured_filename": None,
        "title": "T",
        "post_id": "p1",
        "html": '<img src="/media/p1/a.png"/>',
        "responses": {"a.png": {"id": 1, "source_url": 7}},
        "raises": "TypeError",
    },
    {
        "name": "a response that is not a dict raises out of the loop",
        "files": [{"name": "a.png", "bytes": "89504e47", "mime": "image/png"}],
        "manifest_by_file": {},
        "featured_filename": None,
        "title": "T",
        "post_id": "p1",
        "html": "<p/>",
        "responses": {"a.png": ["not", "a", "dict"]},
        "raises": "AttributeError",
    },
    {
        "name": "a null response raises out of the loop",
        "files": [{"name": "a.png", "bytes": "89504e47", "mime": "image/png"}],
        "manifest_by_file": {},
        "featured_filename": None,
        "title": "T",
        "post_id": "p1",
        "html": "<p/>",
        "responses": {"a.png": None},
        "raises": "AttributeError",
    },
]


def _build_runner(source: str):
    import mimetypes

    namespace: dict[str, Any] = {"mimetypes": mimetypes}
    exec(compile(source, "<publish_to_wordpress>", "exec"), namespace)  # noqa: S102
    return namespace["_run"]


async def _run_case(
    runner, case: dict[str, Any], scratch: pathlib.Path
) -> dict[str, Any]:
    import mimetypes

    files: list[pathlib.Path] = []
    for spec in case["files"]:
        path = scratch / spec["name"]
        path.write_bytes(bytes.fromhex(spec["bytes"]))
        guessed = mimetypes.guess_type(spec["name"])[0]
        if guessed != spec["mime"]:
            raise RuntimeError(
                f"this interpreter types {spec['name']!r} as {guessed!r}, not "
                f"{spec['mime']!r}; see export_mimetypes_parity.py on knownfiles"
            )
        files.append(path)

    client = _FakeClient(case["responses"])
    try:
        image_map, featured_media_id, wp_html = await runner(
            files,
            case["manifest_by_file"],
            case["featured_filename"],
            case["title"],
            case["post_id"],
            case["html"],
            client,
        )
    except Exception as exc:  # noqa: BLE001 - the recorded outcome
        if case.get("raises") != type(exc).__name__:
            raise
        return {
            "uploads": client.calls,
            "raises": type(exc).__name__,
            "message": str(exc),
        }

    if "raises" in case:
        raise RuntimeError(f"case {case['name']!r} was expected to raise")
    return {
        "uploads": client.calls,
        "image_map": list(image_map.items()),
        "featured_media_id": featured_media_id,
        "html": wp_html,
    }


def _refuse_wrong_interpreter() -> None:
    """The mime table depends on the interpreter and on `knownfiles`."""
    import mimetypes
    import os

    if sys.version_info[:2] != (3, 12):
        raise SystemExit(
            f"refusing to run: the deployed image is python 3.12 and this is "
            f"{sys.version_info.major}.{sys.version_info.minor}; 3.13 added "
            ".webp to the builtin mimetypes table. See this module's docstring."
        )
    present = [f for f in mimetypes.knownfiles if os.path.isfile(f)]
    if present:
        raise SystemExit(
            f"refusing to run: mimetypes.init() would read {present}, which "
            "grows the table well beyond the builtin one the deployed image "
            "uses. See this module's docstring for the docker invocation."
        )


async def main() -> None:
    _refuse_wrong_interpreter()
    body = _loop_body()
    rewrite = _rewrite_body()
    source = HARNESS.replace("{body}", textwrap.indent(body, " " * 8)).replace(
        "{rewrite}", textwrap.indent(rewrite, " " * 4)
    )
    runner = _build_runner(source)

    cases: list[dict[str, Any]] = []
    for case in CASES:
        with tempfile.TemporaryDirectory() as tmp:
            expected = await _run_case(runner, case, pathlib.Path(tmp))
        cases.append({**case, "expected": expected})

    OUT.write_text(
        json.dumps(
            {
                "source": "api/src/pipeline/publish.py::publish_to_wordpress",
                "loop_body": body,
                "rewrite_body": rewrite,
                "cases": cases,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    )
    print(f"wrote {OUT.relative_to(REPO_ROOT)} with {len(cases)} cases")


if __name__ == "__main__":
    asyncio.run(main())
