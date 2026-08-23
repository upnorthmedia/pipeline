"""Export the parity oracle for the Next.js webhook payload.

`publish_to_nextjs` in `api/src/services/nextjs_publish.py` builds the body it
signs in one straight-line block: pick the content, read the image manifest,
walk it reading each file off disk and base64-encoding it, then `json.dumps`
the seven-key dict (ledger item 5.3c-iii-b-2-c). The *bytes* that block
produces are what the HMAC signature covers and what `packages/create-mdx-blog`
verifies, so a port that differs by one escape sequence publishes a post the
reader's blog rejects.

Three things in there are not what a JavaScript transcription would do:

- `json.dumps` defaults to `ensure_ascii=True` and to the `', '` / `': '`
  separators, so every character outside the printable ASCII range becomes a
  ``\\uXXXX`` escape and every delimiter carries a space. `JSON.stringify` does
  neither.
- `manifest.get`, `img.get` and the `if not url` guard are Python truthiness
  and Python attribute lookup over a JSONB column whose contents are model
  output, so a manifest holding a string, a list or a null in the wrong place
  raises out of the publish rather than being skipped.
- `Path.is_file()` swallows `OSError` and `ValueError`, so a `url` whose last
  segment is `..`, a name that is a directory, or a name holding a NUL reads as
  "no file" rather than failing.

Every case records either the returned payload string or the exception type and
message, because `publish_to_nextjs` catches neither.

Run inside the deployed image so the recorded answers come from the deployed
interpreter:

    docker build -t jena-api-oracle api
    docker run --rm -v "$PWD/web:/out" jena-api-oracle \
        python scripts/export_nextjs_payload_parity.py \
        /out/src/mastra/nextjs/data/nextjs-payload-parity.json
"""

from __future__ import annotations

import base64
import inspect
import json
import sys
import tempfile
import textwrap
from pathlib import Path
from typing import Any

REPO_API = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_API))

from src.services import nextjs_publish  # noqa: E402

OUT = (
    Path(sys.argv[1])
    if len(sys.argv) > 1
    else REPO_API.parent
    / "web"
    / "src"
    / "mastra"
    / "nextjs"
    / "data"
    / "nextjs-payload-parity.json"
)

START = 'content = post.ready_content or post.final_md_content or ""'
END = "signature = sign_payload(payload, secret)"

# The lines the port is a transcription of. If any of them changes shape the
# recorded answers describe a block that no longer exists, so fail loudly
# rather than write a stale oracle.
REQUIRED_SOURCE_LINES = [
    START,
    'manifest = post.image_manifest or {"images": []}',
    "if profile.nextjs_frontmatter_map:",
    "media_dir = Path(settings.media_dir) / post_id",
    'for img in manifest.get("images", []):',
    'url = img.get("url", "")',
    "if not url:",
    'actual_filename = url.rsplit("/", 1)[-1] if "/" in url else ""',
    "if not actual_filename:",
    "img_path = media_dir / actual_filename",
    "if img_path.is_file():",
    "img_data = base64.b64encode(img_path.read_bytes()).decode()",
    '"filename": actual_filename,',
    '"public_path": url,',
    '"alt": img.get("alt_text", ""),',
    '"placement": img.get("placement", "inline"),',
    '"data": img_data,',
    "payload = json.dumps(",
    '"event": "post.published",',
    '"post_id": str(post.id),',
    '"delivery_id": str(uuid.uuid4()),',
    '"slug": post.slug,',
    '"content": content,',
    '"images": images,',
    '"timestamp": datetime.now(UTC).isoformat(),',
]


def extract_block() -> str:
    source = inspect.getsource(nextjs_publish.publish_to_nextjs)
    lines = source.splitlines()
    for required in REQUIRED_SOURCE_LINES:
        if not any(line.strip() == required for line in lines):
            raise SystemExit(f"publish_to_nextjs no longer contains: {required}")
    start = next(i for i, line in enumerate(lines) if line.strip() == START)
    end = next(i for i, line in enumerate(lines) if line.strip() == END)
    return textwrap.dedent("\n".join(lines[start:end]))


BLOCK = compile(extract_block(), "<publish_to_nextjs payload block>", "exec")

FIXED_DELIVERY_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"
FIXED_TIMESTAMP = "2026-08-23T12:34:56.789012+00:00"


class Stub:
    def __init__(self, **fields: Any) -> None:
        self.__dict__.update(fields)


class StubUUID:
    @staticmethod
    def uuid4() -> str:
        return FIXED_DELIVERY_ID


class StubDateTime:
    @staticmethod
    def now(_tz: Any) -> Any:
        return Stub(isoformat=lambda: FIXED_TIMESTAMP)


class StubLogger:
    def warning(self, *_args: Any, **_kwargs: Any) -> None:
        pass


def run_block(
    *,
    post_id: str,
    post: Any,
    profile: Any,
    media_dir: str,
) -> dict[str, Any]:
    namespace = {
        "post": post,
        "profile": profile,
        "post_id": post_id,
        "settings": Stub(media_dir=media_dir),
        "Path": Path,
        "base64": base64,
        "json": json,
        "uuid": StubUUID,
        "datetime": StubDateTime,
        "UTC": None,
        "logger": StubLogger(),
        "_apply_mapping_to_content": nextjs_publish._apply_mapping_to_content,
    }
    try:
        exec(BLOCK, namespace)  # noqa: S102
    except Exception as exc:  # noqa: BLE001
        return {"raises": type(exc).__name__, "message": str(exc)}
    return {"payload": namespace["payload"]}


# The scratch tree every case walks. `media_dir` is `<root>/media` and the block
# joins `post_id` onto it, so these live under `<root>/media/post-1/`.
TREE_FILES: dict[str, bytes] = {
    # Binary, holding a NUL and bytes that are not valid UTF-8, because the
    # block base64-encodes raw bytes and a port that reads text corrupts them.
    "featured.webp": bytes(
        [0x52, 0x49, 0x46, 0x46, 0x00, 0xFF, 0xFE, 0x80, 0x0A, 0x7F]
    ),
    "inline-1.png": b"\x89PNG\r\n\x1a\n",
    "empty.webp": b"",
}
TREE_DIRS = ["adir.webp"]

POST_ID = "post-1"

FRONTMATTER = "---\ntitle: Hello\ndate: 2026-08-23\n---\n\n# Body\n"


def post_stub(
    *,
    ready: Any = None,
    final: Any = None,
    manifest: Any = None,
    slug: str = "hello-world",
    post_id: str = "11111111-2222-3333-4444-555555555555",
) -> Stub:
    return Stub(
        id=post_id,
        slug=slug,
        ready_content=ready,
        final_md_content=final,
        image_manifest=manifest,
    )


def images(*entries: Any) -> dict[str, Any]:
    return {"images": list(entries)}


def build_cases(root: Path) -> list[dict[str, Any]]:
    media_dir = str(root / "media")
    cases: list[dict[str, Any]] = []

    def add(
        name: str,
        *,
        post: Stub,
        profile: Stub | None = None,
        post_id: str = POST_ID,
    ) -> None:
        prof = profile if profile is not None else Stub(nextjs_frontmatter_map=None)
        result = run_block(
            post_id=post_id, post=post, profile=prof, media_dir=media_dir
        )
        # `OSError` from `Path.is_file()` carries the absolute path, and the
        # scratch root differs between this run and the test that replays it.
        if "message" in result:
            result["message"] = result["message"].replace(media_dir, "<MEDIA>")
        cases.append(
            {
                "name": name,
                "postId": post_id,
                "post": {
                    "id": post.id,
                    "slug": post.slug,
                    "readyContent": post.ready_content,
                    "finalMdContent": post.final_md_content,
                    "imageManifest": post.image_manifest,
                },
                "frontmatterMap": prof.nextjs_frontmatter_map,
                **result,
            }
        )

    # --- content selection -------------------------------------------------
    add("content: ready wins", post=post_stub(ready="R", final="F"))
    add("content: empty ready falls through", post=post_stub(ready="", final="F"))
    add("content: null ready falls through", post=post_stub(ready=None, final="F"))
    add("content: ready only", post=post_stub(ready="R", final=None))
    add("content: both null", post=post_stub())
    add("content: both empty", post=post_stub(ready="", final=""))

    # --- manifest shapes ---------------------------------------------------
    add("manifest: null", post=post_stub(final="F", manifest=None))
    add("manifest: empty dict", post=post_stub(final="F", manifest={}))
    add("manifest: empty images", post=post_stub(final="F", manifest=images()))
    add("manifest: no images key", post=post_stub(final="F", manifest={"other": 1}))
    add("manifest: images null", post=post_stub(final="F", manifest={"images": None}))
    add("manifest: images string", post=post_stub(final="F", manifest={"images": "ab"}))
    # An empty string and an empty dict are both iterable and both yield
    # nothing, which is what separates iterating a string from wrapping it.
    add(
        "manifest: images empty string",
        post=post_stub(final="F", manifest={"images": ""}),
    )
    add(
        "manifest: images empty dict",
        post=post_stub(final="F", manifest={"images": {}}),
    )
    add("manifest: empty list", post=post_stub(final="F", manifest=[]))
    add("manifest: non-empty list", post=post_stub(final="F", manifest=[1]))
    add("manifest: string", post=post_stub(final="F", manifest="x"))
    add("manifest: zero", post=post_stub(final="F", manifest=0))
    add("manifest: false", post=post_stub(final="F", manifest=False))
    add(
        "manifest: images dict iterates keys",
        post=post_stub(final="F", manifest={"images": {"a": {"url": "/x/a.webp"}}}),
    )
    add("manifest: images holds null", post=post_stub(final="F", manifest=images(None)))
    add(
        "manifest: images holds a list",
        post=post_stub(final="F", manifest=images(["/x/a.webp"])),
    )

    # --- url guard ---------------------------------------------------------
    for label, url in [
        ("missing", ...),
        ("null", None),
        ("empty", ""),
        ("zero", 0),
        ("false", False),
        ("empty list", []),
        ("empty dict", {}),
        ("int", 5),
        ("list holding a slash", ["/"]),
        ("list without a slash", ["/x"]),
        ("no slash", "featured.webp"),
        ("trailing slash", "/media/post-1/"),
        ("bare slashes", "//"),
        ("relative parent", "/x/.."),
        ("relative self", "/x/."),
        ("directory", "/x/adir.webp"),
        ("embedded nul", "/x/a\x00b.webp"),
        ("too long", "/x/" + "a" * 300 + ".webp"),
        ("missing file", "/media/post-1/missing.webp"),
        ("present file", "/media/post-1/featured.webp"),
        ("empty file", "/media/post-1/empty.webp"),
        ("nested path", "/a/b/inline-1.png"),
        ("true", True),
    ]:
        img: dict[str, Any] = {} if url is ... else {"url": url}
        add(f"url: {label}", post=post_stub(final="F", manifest=images(img)))

    # --- alt text and placement -------------------------------------------
    base = {"url": "/media/post-1/featured.webp"}
    for label, extra in [
        ("defaults", {}),
        ("both set", {"alt_text": "A cat", "placement": "hero"}),
        ("alt null", {"alt_text": None}),
        ("placement null", {"placement": None}),
        ("alt empty", {"alt_text": ""}),
        ("placement empty", {"placement": ""}),
        ("alt number", {"alt_text": 5}),
        ("alt bool", {"alt_text": True}),
        ("alt object", {"alt_text": {"en": "cat", "fr": "chat"}}),
        ("alt array", {"alt_text": ["a", 1, None]}),
        ("alt non-ascii", {"alt_text": "café 中\U0001f600"}),
        ("placement object", {"placement": {"after": 2}}),
    ]:
        add(
            f"alt/placement: {label}",
            post=post_stub(final="F", manifest=images({**base, **extra})),
        )

    # --- several images ----------------------------------------------------
    add(
        "multiple images, mixed",
        post=post_stub(
            final="F",
            manifest=images(
                {"url": "/media/post-1/featured.webp", "placement": "featured"},
                {"url": ""},
                {"url": "/media/post-1/missing.webp", "alt_text": "gone"},
                {
                    "url": "/a/b/inline-1.png",
                    "alt_text": "inline",
                    "placement": "inline",
                },
            ),
        ),
    )
    add(
        "media dir absent",
        post=post_stub(final="F", manifest=images({"url": "/x/featured.webp"})),
        post_id="no-such-post",
    )

    # --- json.dumps escaping ----------------------------------------------
    for label, content in [
        ("quotes and backslash", 'he said "hi" \\ bye'),
        ("newlines and tabs", "a\nb\tc\rd"),
        ("backspace and formfeed", "a\bb\fc"),
        ("control characters", "".join(chr(i) for i in range(0x20))),
        ("delete character", "a\x7fb"),
        ("latin-1", "café naïve"),
        ("cjk", "中文文字"),
        ("astral", "\U0001f600\U0001f1fa\U0001f1f8"),
        ("line separators", "a\u2028b\u2029c\u0085d"),
        ("nbsp and soft hyphen", "a\u00a0b\u00adc"),
        ("printable ascii boundary", "".join(chr(i) for i in range(0x20, 0x80))),
        ("forward slash", "a/b</script>"),
    ]:
        add(f"escaping: {label}", post=post_stub(final=content))

    add("slug: non-ascii", post=post_stub(final="F", slug="café-中"))
    add("slug: empty", post=post_stub(final="F", slug=""))

    # --- frontmatter mapping ----------------------------------------------
    add(
        "mapping: applied",
        post=post_stub(final=FRONTMATTER),
        profile=Stub(nextjs_frontmatter_map={"title": "heading"}),
    )
    add(
        "mapping: empty dict is skipped",
        post=post_stub(final=FRONTMATTER),
        profile=Stub(nextjs_frontmatter_map={}),
    )
    add(
        "mapping: null is skipped",
        post=post_stub(final=FRONTMATTER),
        profile=Stub(nextjs_frontmatter_map=None),
    )
    add(
        "mapping: runs before the manifest walk",
        post=post_stub(
            final=FRONTMATTER,
            manifest=images({"url": "/media/post-1/featured.webp"}),
        ),
        profile=Stub(nextjs_frontmatter_map={"title": {"key": "seo_title"}}),
    )
    add(
        "mapping: raises out of the payload",
        post=post_stub(final=FRONTMATTER),
        profile=Stub(nextjs_frontmatter_map={"title": {"key": ["a"]}}),
    )
    return cases


# `json.dumps` over values a JSONB column can hold, recorded as the raw JSON
# literal so the number cases keep the int/float distinction the file format
# would otherwise erase.
NUMBER_LITERALS = [
    "0",
    "-0",
    "1",
    "1.0",
    "-1.0",
    "1.5",
    "-0.0",
    "0.1",
    "1e2",
    "1e16",
    "1e21",
    "1e22",
    "10000000000000000000000",
    "9007199254740993",
    "1e-5",
    "1e-7",
    "0.0001",
    "0.00001",
    "3.141592653589793",
    "1.7976931348623157e308",
    "[1, 2.0, 3]",
    '{"a": 1, "b": 2.0}',
    "true",
    "false",
    "null",
    '"s"',
    "[]",
    "{}",
    '{"a": [], "b": {}}',
    '[[1], {"k": null}]',
]


def build_numbers() -> list[dict[str, str]]:
    return [
        {"literal": literal, "dumps": json.dumps(json.loads(literal))}
        for literal in NUMBER_LITERALS
    ]


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        post_dir = root / "media" / POST_ID
        post_dir.mkdir(parents=True)
        for name, data in TREE_FILES.items():
            (post_dir / name).write_bytes(data)
        for name in TREE_DIRS:
            (post_dir / name).mkdir()
        cases = build_cases(root)

    document = {
        "generated_by": "api/scripts/export_nextjs_payload_parity.py",
        "python": sys.version.split()[0],
        "postId": POST_ID,
        "deliveryId": FIXED_DELIVERY_ID,
        "timestamp": FIXED_TIMESTAMP,
        "tree": {
            "files": {name: list(data) for name, data in TREE_FILES.items()},
            "dirs": TREE_DIRS,
        },
        "cases": cases,
        "dumps": build_numbers(),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(document, indent=2) + "\n")
    print(f"wrote {len(cases)} cases and {len(document['dumps'])} dumps cases to {OUT}")


if __name__ == "__main__":
    main()
