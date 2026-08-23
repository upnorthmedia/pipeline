"""Export the parity oracle for the image filter of the WordPress media sweep.

`publish_to_wordpress` in `api/src/pipeline/publish.py` decides whether a file in
the post's media directory is an image with::

    mime, _ = mimetypes.guess_type(img_file.name)
    if not mime or not mime.startswith("image/"):
        continue

and then hands `mime` to `WordPressClient.upload_media`. Porting that means
porting `mimetypes.guess_type`, which is four tables plus the slice of
`urllib.parse.urlparse` and `posixpath.splitext` it consumes.

**The tables are interpreter- and host-dependent, so this script must not run on
the developer's machine.** `mimetypes.init()` reads `knownfiles`, and on macOS
`/etc/apache2/mime.types` exists and grows the strict map from 152 entries to
1036 (45 extra `image/*` extensions, and `.ico` changes meaning). The deployed
interpreter is `python:3.12-slim`, where no knownfile exists and the builtin
table is the whole story, and `.webp` is not in that table at all. The oracle
records the deployed behaviour, so the script asserts both facts and refuses to
run anywhere else::

    docker run --rm -v "$PWD":/w -w /w python:3.12-slim \
        python api/scripts/export_mimetypes_parity.py

Every case is a single POSIX path component, because that is what
`Path.iterdir()` yields. A component cannot contain `/`, which makes the netloc
branch of `urlsplit` (and its IPv6 validation) unreachable; the script asserts
that so the oracle cannot drift outside the domain the port covers.
"""

from __future__ import annotations

import json
import mimetypes
import os
import sys
import urllib.parse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

OUT = (
    REPO_ROOT
    / "web"
    / "src"
    / "mastra"
    / "wordpress"
    / "data"
    / "wp-mimetypes-parity.json"
)

# (name, url) pairs. The name is only there to make a vitest failure readable.
CASES: list[tuple[str, str]] = [
    # The extensions the pipeline actually produces.
    ("webp, what the images stage writes", "featured-082326-abc.webp"),
    ("png", "a.png"),
    ("jpg", "a.jpg"),
    ("jpeg", "a.jpeg"),
    ("jpe", "a.jpe"),
    ("gif", "a.gif"),
    ("avif", "a.avif"),
    ("heic", "a.heic"),
    ("svg", "a.svg"),
    ("ico", "a.ico"),
    ("bmp", "a.bmp"),
    ("tiff", "a.tiff"),
    # Not images, so the sweep skips them.
    ("html", "a.html"),
    ("json", "a.json"),
    ("txt", "a.txt"),
    ("pdf", "a.pdf"),
    ("mp4", "a.mp4"),
    # Extension case folding: type suffixes are matched case insensitively.
    ("upper png", "a.PNG"),
    ("mixed jpg", "a.JpG"),
    ("upper jpeg", "A.JPEG"),
    # No extension at all.
    ("no dot", "noext"),
    ("empty", ""),
    ("bare dot", "."),
    ("two dots", ".."),
    ("three dots", "..."),
    ("trailing dot", "a."),
    # splitext skips leading dots, so a dotfile has no extension.
    ("dotfile", ".png"),
    ("dotfile with two leading dots", "..png"),
    ("dotfile with a real extension", ".hidden.png"),
    ("single leading dot then extension", ".a.png"),
    # encodings_map is matched case sensitively, type suffixes are not.
    ("gzipped png", "a.png.gz"),
    ("gzipped png, upper GZ", "a.png.GZ"),
    ("compressed png, upper Z", "a.png.Z"),
    ("compressed png, lower z", "a.png.z"),
    ("bzip2 png", "a.png.bz2"),
    ("xz png", "a.png.xz"),
    ("brotli png", "a.png.br"),
    ("encoding with no type left", "a.gz"),
    ("encoding twice", "a.png.gz.gz"),
    # suffix_map is matched case insensitively and runs before encodings_map.
    ("svgz", "a.svgz"),
    ("svgz, upper", "a.SVGZ"),
    ("tgz", "a.tgz"),
    ("taz", "a.taz"),
    ("tz", "a.tz"),
    ("tbz2", "a.tbz2"),
    ("txz", "a.txz"),
    ("tar.gz spelled out", "a.tar.gz"),
    ("tgz after a tar", "a.tar.tgz"),
    # suffix_map is not reapplied after the encoding is stripped.
    ("svgz behind a gz", "a.svgz.gz"),
    # Leading C0-or-space is stripped by urlsplit, but only the scheme branch
    # sees the stripped copy: the schemeless branch re-reads the raw argument.
    ("leading space", " a.png"),
    ("trailing space", "a.png "),
    ("leading NUL", "\x00a.png"),
    ("leading space before a scheme", " http:a.png#b.gif"),
    ("leading nbsp before a scheme", " http:a.png#b.gif"),
    # Tab, CR and LF are deleted from the copy urlsplit parses, so they can
    # only change the answer through scheme detection.
    ("tab inside the extension", "a.p\tng"),
    ("tab inside a scheme", "ht\ttp:a.png#b.gif"),
    ("newline inside a scheme", "ht\ntp:a.png#b.gif"),
    ("tab inside the path after a scheme", "http:a.p\tng"),
    ("trailing space after a scheme", "http:a.png "),
    # Scheme detection. A one-character scheme is rejected by guess_type, and
    # the schemeless branch keeps the fragment and query in the path.
    ("fragment, no scheme", "a.png#b.gif"),
    ("fragment, with scheme", "http:a.png#b.gif"),
    ("query, no scheme", "a.png?x=b.gif"),
    ("query, with scheme", "http:a.png?x=b.gif"),
    ("one-character scheme", "d:a.png#b.gif"),
    ("two-character scheme", "ht:a.png#b.gif"),
    ("colon first", ":a.png#b.gif"),
    ("digit before the colon", "1a:a.png#b.gif"),
    ("non-ascii before the colon", "éa:a.png#b.gif"),
    ("space in the scheme", "ht p:a.png#b.gif"),
    ("plus in the scheme", "ht+p:a.png#b.gif"),
    ("dot in the scheme", "ht.p:a.png#b.gif"),
    ("underscore in the scheme", "ht_p:a.png#b.gif"),
    # The scheme is lowercased before uses_params is consulted.
    ("uppercase http with params", "HTTP:a;b.png"),
    ("unknown scheme with params", "HTTQ:a;b.png"),
    ("http with params", "http:a;b.png"),
    ("http with a semicolon after the extension", "http:a.png;b"),
    # The data branch. A path component cannot contain a slash, so a filename
    # that looks like a data URL always falls back to text/plain.
    ("data with no comma", "data:image"),
    ("data with a comma", "data:foo,bar"),
    ("data with a semicolon", "data:foo;base64,bar"),
    ("data with an equals", "data:a=b,c"),
    ("data empty type", "data:,x"),
    ("uppercase data scheme", "DATA:foo,bar"),
    ("leading space before a data scheme", " data:foo,bar"),
    ("tab inside a data scheme", "da\tta:foo,bar"),
    # Unicode. No non-ASCII character lowercases into a table key, so the
    # Python/JavaScript lowercasing difference is unobservable here; the
    # Kelvin sign is the closest thing, and both languages fold it to "k".
    ("single uppercase letter extension", "a.K"),
    ("kelvin sign extension", "a.\u212a"),
    ("astral extension", "a.\U0001f600"),
    ("combining mark in the name", "á.png"),
    # strict=False reaches common_types.
    ("midi strict", "a.midi"),
    ("xul strict", "a.xul"),
    ("pict strict", "a.pict"),
]

NON_STRICT_CASES: list[tuple[str, str]] = [
    ("midi non-strict", "a.midi"),
    ("mid non-strict", "a.mid"),
    ("jpg non-strict, strict map wins", "a.jpg"),
    ("pict non-strict", "a.pict"),
    ("pct non-strict", "a.pct"),
    ("xul non-strict", "a.xul"),
    ("rtf non-strict", "a.rtf"),
    ("gzipped pict non-strict", "a.pict.gz"),
    ("unknown non-strict", "a.zzz"),
]


def _pairs(mapping: dict[str, str]) -> list[list[str]]:
    return [[k, v] for k, v in mapping.items()]


def main() -> None:
    if sys.version_info[:2] != (3, 12):
        raise SystemExit(
            "refusing to run on Python "
            f"{sys.version_info.major}.{sys.version_info.minor}: the deployed "
            "image is python:3.12-slim and the builtin table differs between "
            "versions (3.13 added .webp). See this module's docstring for the "
            "docker invocation."
        )
    present = [f for f in mimetypes.knownfiles if os.path.isfile(f)]
    if present:
        raise SystemExit(
            f"refusing to run: mimetypes.init() would read {present}, which "
            "grows the table well beyond the builtin one the deployed image "
            "uses. See this module's docstring for the docker invocation."
        )

    mimetypes.init()
    builtin = mimetypes.MimeTypes()
    if mimetypes.types_map != builtin.types_map[True]:
        raise SystemExit("the module table is not the builtin table")

    for _name, url in [*CASES, *NON_STRICT_CASES]:
        if "/" in url:
            raise SystemExit(
                f"case {url!r} contains a slash: every case must be a single "
                "POSIX path component, which is what Path.iterdir() yields"
            )

    cases = []
    for name, url in CASES:
        mime, encoding = mimetypes.guess_type(url)
        cases.append(
            {
                "name": name,
                "url": url,
                "strict": True,
                "type": mime,
                "encoding": encoding,
                "isImage": bool(mime) and mime.startswith("image/"),
            }
        )
    for name, url in NON_STRICT_CASES:
        mime, encoding = mimetypes.guess_type(url, strict=False)
        cases.append(
            {
                "name": name,
                "url": url,
                "strict": False,
                "type": mime,
                "encoding": encoding,
                "isImage": bool(mime) and mime.startswith("image/"),
            }
        )

    payload = {
        "pythonVersion": ".".join(str(p) for p in sys.version_info[:3]),
        "knownfilesPresent": present,
        "typesMap": _pairs(mimetypes.types_map),
        "commonTypes": _pairs(mimetypes.common_types),
        "encodingsMap": _pairs(mimetypes.encodings_map),
        "suffixMap": _pairs(mimetypes.suffix_map),
        "usesParams": list(urllib.parse.uses_params),
        "schemeChars": urllib.parse.scheme_chars,
        "cases": cases,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    images = sum(1 for row in cases if row["isImage"])
    print(
        f"wrote {len(payload['typesMap'])} strict types, "
        f"{len(payload['commonTypes'])} common types and {len(cases)} cases "
        f"({images} classified as images) to {OUT}"
    )


if __name__ == "__main__":
    main()
