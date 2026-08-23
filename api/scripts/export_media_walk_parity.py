"""Export the parity oracle for the media-directory walk of the WordPress publish hook.

`publish_to_wordpress` in `api/src/pipeline/publish.py` decides which files it
uploads with four lines:

    if media_dir.is_dir():
        for img_file in sorted(media_dir.iterdir()):
            if not img_file.is_file():
                continue

Each of the four diverges from the obvious JavaScript spelling:

* `Path.is_dir()` and `Path.is_file()` follow symlinks and swallow only
  `ENOENT`, `ENOTDIR`, `EBADF` and `ELOOP`; every other `OSError` propagates,
  and a `ValueError` (an embedded NUL) is `False`. `readdir(..., {
  withFileTypes: true })` answers from the directory entry instead, which gets
  a symlink to a file and a symlink to a directory exactly backwards.
* `os.listdir` decodes each name with `os.fsdecode`, which is UTF-8 with
  `surrogateescape`, so a name that is not valid UTF-8 keeps every byte as a
  lone surrogate. Node's default UTF-8 decoding replaces those bytes with
  U+FFFD, which loses the name and can collide two distinct files.
* `sorted()` over `PurePath`s compares code points, while JavaScript's default
  `Array.prototype.sort` compares UTF-16 code units, so any astral character in
  a filename sorts against everything from U+E000 up the wrong way.

The four lines are pulled out of the real function with `inspect.getsource` and
executed rather than transcribed, so the recorded answers cannot drift from the
function they describe without this script raising.

The walk cases are restricted to names that are valid UTF-8 and unique under
case folding: APFS rejects a filename that is not valid UTF-8 with `EILSEQ` and
is case-insensitive by default, so the vitest side could not rebuild such a
tree. The two behaviours that needs are covered without a filesystem instead,
by the `fsdecode` and `sorts` corpora.

Usage:
    uv run python scripts/export_media_walk_parity.py
"""

from __future__ import annotations

import inspect
import json
import os
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
    / "wp-media-walk-parity.json"
)

FIRST_LINE = "if media_dir.is_dir():"
LAST_LINE = "if not img_file.is_file():"


def _walk_block() -> str:
    """Pull the four walk lines out of the real `publish_to_wordpress`."""
    lines = inspect.getsource(publish_to_wordpress).split("\n")
    starts = [i for i, line in enumerate(lines) if line.strip() == FIRST_LINE]
    ends = [i for i, line in enumerate(lines) if line.strip() == LAST_LINE]
    if len(starts) != 1 or len(ends) != 1 or ends[0] != starts[0] + 2:
        raise RuntimeError(
            "the media walk in publish_to_wordpress has moved; "
            f"found {len(starts)} start and {len(ends)} end markers"
        )
    if lines[ends[0] + 1].strip() != "continue":
        raise RuntimeError(
            "the is_file() guard in publish_to_wordpress no longer continues"
        )
    block = textwrap.dedent("\n".join(lines[starts[0] : ends[0] + 2]))
    # The next statement in the real function is the mimetypes filter, which is
    # its own ledger item and its own oracle. Collecting the name in its place
    # records exactly what the walk yielded.
    return block + "\n        names.append(img_file.name)\n"


def _run_walk_block(block: str, media_dir: pathlib.Path) -> list[str]:
    names: list[str] = []
    exec(block, {"media_dir": media_dir, "names": names})  # noqa: S102 - our own source
    return names


# Each case builds `entries` inside a fresh scratch directory, then walks the
# path named by `walk` relative to that directory.
WALK_CASES: list[dict[str, Any]] = [
    {
        "name": "the directory does not exist",
        "entries": [],
        "walk": "missing",
    },
    {
        "name": "the media directory is empty",
        "entries": [],
        "walk": ".",
    },
    {
        "name": "the media directory is a regular file",
        "entries": [{"path": "notadir", "kind": "file"}],
        "walk": "notadir",
    },
    {
        "name": "the media directory is a symlink to a directory",
        "entries": [
            {"path": "real", "kind": "dir"},
            {"path": "real/a.webp", "kind": "file"},
            {"path": "link", "kind": "symlink", "target": "real"},
        ],
        "walk": "link",
    },
    {
        "name": "the media directory is a broken symlink",
        "entries": [{"path": "link", "kind": "symlink", "target": "nowhere"}],
        "walk": "link",
    },
    {
        "name": "the media directory is a symlink to itself",
        "entries": [{"path": "loop", "kind": "symlink", "target": "loop"}],
        "walk": "loop",
    },
    {
        "name": "the media directory is under a regular file",
        "entries": [{"path": "notadir", "kind": "file"}],
        "walk": "notadir/post",
    },
    {
        "name": "the media directory is under a missing directory",
        "entries": [],
        "walk": "missing/post",
    },
    {
        "name": "a subdirectory is skipped",
        "entries": [
            {"path": "a.webp", "kind": "file"},
            {"path": "sub", "kind": "dir"},
            {"path": "sub/nested.webp", "kind": "file"},
            {"path": "z.webp", "kind": "file"},
        ],
        "walk": ".",
    },
    {
        "name": "a symlink to a file is followed and kept",
        "entries": [
            {"path": "real.webp", "kind": "file"},
            {"path": "sym.webp", "kind": "symlink", "target": "real.webp"},
        ],
        "walk": ".",
    },
    {
        "name": "a symlink to a directory is followed and skipped",
        "entries": [
            {"path": "keep.webp", "kind": "file"},
            {"path": "sub", "kind": "dir"},
            {"path": "sym", "kind": "symlink", "target": "sub"},
        ],
        "walk": ".",
    },
    {
        "name": "a broken symlink is skipped",
        "entries": [
            {"path": "keep.webp", "kind": "file"},
            {"path": "dead.webp", "kind": "symlink", "target": "gone.webp"},
        ],
        "walk": ".",
    },
    {
        "name": "a symlink loop is skipped",
        "entries": [
            {"path": "keep.webp", "kind": "file"},
            {"path": "loop.webp", "kind": "symlink", "target": "loop.webp"},
        ],
        "walk": ".",
    },
    {
        "name": "a fifo is skipped",
        "entries": [
            {"path": "keep.webp", "kind": "file"},
            {"path": "pipe.webp", "kind": "fifo"},
        ],
        "walk": ".",
    },
    {
        "name": "an empty file is kept",
        "entries": [{"path": "empty.webp", "kind": "file"}],
        "walk": ".",
    },
    {
        "name": "a dotfile is kept",
        "entries": [
            {"path": ".hidden.webp", "kind": "file"},
            {"path": "b.webp", "kind": "file"},
        ],
        "walk": ".",
    },
    {
        "name": "uppercase sorts before lowercase",
        "entries": [
            {"path": "b.webp", "kind": "file"},
            {"path": "Z.webp", "kind": "file"},
            {"path": "_.webp", "kind": "file"},
            {"path": "-.webp", "kind": "file"},
        ],
        "walk": ".",
    },
    {
        "name": "digits sort lexicographically, not numerically",
        "entries": [
            {"path": "2.webp", "kind": "file"},
            {"path": "10.webp", "kind": "file"},
            {"path": "9.webp", "kind": "file"},
        ],
        "walk": ".",
    },
    {
        "name": "an astral filename sorts by code point",
        "entries": [
            {"path": "\U0001f600.webp", "kind": "file"},
            {"path": "\ufffd.webp", "kind": "file"},
            {"path": "\ue000.webp", "kind": "file"},
        ],
        "walk": ".",
    },
    {
        "name": "the filenames the images stage actually writes",
        "entries": [
            {"path": "featured-082326-a1b2.webp", "kind": "file"},
            {"path": "inline-082326-c3d4.webp", "kind": "file"},
            {"path": "inline-082326-e5f6.webp", "kind": "file"},
            {"path": "manifest.json", "kind": "file"},
        ],
        "walk": ".",
    },
]

ERROR_CASES: list[dict[str, Any]] = [
    {
        "name": "a name longer than NAME_MAX raises rather than reporting absence",
        "entries": [],
        "walk": "n" * 300,
        "error": "OSError",
    },
    {
        "name": "an embedded NUL is not an error, it is an absent directory",
        "entries": [],
        "walk": "a\x00b",
        "error": None,
    },
    {
        # `EACCES` is not in `pathlib._IGNORED_ERRNOS`, so an unreadable entry
        # is an error rather than a file that is not a regular file.
        "name": "a directory whose entries cannot be stat-ed raises",
        "entries": [
            {"path": "post", "kind": "dir"},
            {"path": "post/a.webp", "kind": "file"},
            {"path": "post", "kind": "chmod", "mode": 0o444},
        ],
        "walk": "post",
        "error": "OSError",
    },
]

FSDECODE_CASES: list[tuple[str, bytes]] = [
    ("empty", b""),
    ("ascii", b"featured-082326-a1b2.webp"),
    ("two byte sequence", b"caf\xc3\xa9.webp"),
    ("three byte sequence", b"\xe2\x82\xac.webp"),
    ("four byte sequence", b"\xf0\x9f\x98\x80.webp"),
    ("replacement character", b"\xef\xbf\xbd.webp"),
    ("lone 0xff", b"\xff"),
    ("lone 0x80", b"\x80"),
    ("two undecodable bytes", b"\xff\xfe"),
    ("undecodable byte between ascii", b"a\xffb"),
    ("truncated two byte sequence", b"\xc3"),
    ("truncated three byte sequence", b"\xe2\x82"),
    ("truncated four byte sequence", b"\xf0\x9f\x98"),
    ("continuation byte without a start", b"\x80\x81\x82"),
    ("start byte followed by ascii", b"\xc3a"),
    ("overlong two byte nul", b"\xc0\x80"),
    ("overlong three byte solidus", b"\xe0\x80\xaf"),
    ("overlong four byte euro", b"\xf0\x82\x82\xac"),
    ("encoded high surrogate", b"\xed\xa0\x80"),
    ("encoded low surrogate", b"\xed\xb0\x80"),
    ("encoded surrogate pair", b"\xed\xa0\xbd\xed\xb8\x80"),
    ("above U+10FFFF", b"\xf4\x90\x80\x80"),
    ("0xf5 start byte", b"\xf5\x80\x80\x80"),
    ("0xfe and 0xff", b"\xfe\xff"),
    ("smallest two byte sequence", b"\xc2\x80"),
    ("largest two byte sequence", b"\xdf\xbf"),
    ("smallest three byte sequence", b"\xe0\xa0\x80"),
    ("largest three byte sequence", b"\xef\xbf\xbf"),
    ("smallest four byte sequence", b"\xf0\x90\x80\x80"),
    ("largest four byte sequence", b"\xf4\x8f\xbf\xbf"),
    ("valid sequence after an invalid one", b"\xff\xe2\x82\xac"),
    ("invalid sequence after a valid one", b"\xe2\x82\xac\xff"),
    ("nul byte", b"a\x00b"),
    ("newline and tab", b"a\tb\nc"),
]

# `sorted()` over the names a directory could hold, as `Path` objects under a
# common parent, which is what `sorted(media_dir.iterdir())` compares.
SORT_CASES: list[tuple[str, list[str]]] = [
    ("empty", []),
    ("one name", ["a.webp"]),
    ("already sorted ascii", ["a.webp", "b.webp", "c.webp"]),
    ("reversed ascii", ["c.webp", "b.webp", "a.webp"]),
    ("case", ["a.webp", "B.webp", "A.webp", "b.webp"]),
    ("punctuation", ["-.webp", "_.webp", ".webp", "~.webp", "0.webp", "A.webp"]),
    ("digits", ["10.webp", "9.webp", "2.webp", "1.webp", "100.webp"]),
    ("prefix of another name", ["a.webp", "a", "a.web", "a.webpx"]),
    ("space and tab", ["a b.webp", "a\tb.webp", "ab.webp"]),
    ("astral against the BMP", ["\U0001f600", "\ufffd", "\ue000", "\U00010000"]),
    ("astral against a lone surrogate", ["\U0001f600", "\udcff", "\ufffd"]),
    ("lone surrogates in escape order", ["\udcff", "\udc80", "\udcfe"]),
    ("undecodable byte against a valid sequence", ["\udcff", "\ufffd", "\u00e9"]),
    ("combining marks", ["\u00e9.webp", "e\u0301.webp", "f.webp"]),
    (
        "the filenames the images stage writes",
        [
            "inline-082326-c3d4.webp",
            "featured-082326-a1b2.webp",
            "manifest.json",
            "inline-082326-e5f6.webp",
        ],
    ),
]


def _build(scratch: pathlib.Path, entries: list[dict[str, Any]]) -> None:
    for entry in entries:
        target = scratch / entry["path"]
        if entry["kind"] == "file":
            target.write_bytes(b"")
        elif entry["kind"] == "dir":
            target.mkdir()
        elif entry["kind"] == "symlink":
            os.symlink(entry["target"], target)
        elif entry["kind"] == "fifo":
            os.mkfifo(target)
        elif entry["kind"] == "chmod":
            os.chmod(target, entry["mode"])
        else:  # pragma: no cover - guards the case table
            raise RuntimeError(f"unknown entry kind {entry['kind']!r}")


def _restore(scratch: pathlib.Path, entries: list[dict[str, Any]]) -> None:
    """Undo every chmod so the scratch directory can be removed."""
    for entry in entries:
        if entry["kind"] == "chmod":
            os.chmod(scratch / entry["path"], 0o755)


def main() -> None:
    if (
        sys.getfilesystemencoding() != "utf-8"
        or sys.getfilesystemencodeerrors() != "surrogateescape"
    ):
        raise RuntimeError(
            "this oracle records os.fsdecode, which is only utf-8/surrogateescape on "
            f"POSIX; here it is {sys.getfilesystemencoding()}/"
            f"{sys.getfilesystemencodeerrors()}"
        )

    if os.geteuid() == 0:
        raise RuntimeError(
            "root ignores the permission bits, so the EACCES case would record an "
            "empty walk rather than the error the publish hook actually sees"
        )

    block = _walk_block()

    walks: list[dict[str, Any]] = []
    for case in WALK_CASES:
        with tempfile.TemporaryDirectory() as raw:
            scratch = pathlib.Path(raw)
            _build(scratch, case["entries"])
            names = _run_walk_block(block, scratch / case["walk"])
        walks.append({**case, "expected": names})

    errors: list[dict[str, Any]] = []
    for case in ERROR_CASES:
        with tempfile.TemporaryDirectory() as raw:
            scratch = pathlib.Path(raw)
            _build(scratch, case["entries"])
            raised: str | None = None
            names = []
            try:
                names = _run_walk_block(block, scratch / case["walk"])
            except OSError:
                raised = "OSError"
            finally:
                _restore(scratch, case["entries"])
        if raised != case["error"]:
            raise RuntimeError(
                f"case {case['name']!r} expected {case['error']}, got {raised}"
            )
        errors.append({**case, "expected": None if raised else names})

    payload = {
        "walkBlockSource": block,
        # Names are emitted as code point lists because a name decoded with
        # `surrogateescape` holds lone surrogates, which do not survive a round
        # trip through JSON as text.
        "fsdecode": [
            {
                "name": name,
                "bytes": list(raw),
                "codepoints": [ord(ch) for ch in os.fsdecode(raw)],
            }
            for name, raw in FSDECODE_CASES
        ],
        "sorts": [
            {
                "name": name,
                "names": [[ord(ch) for ch in n] for n in names],
                "sorted": [
                    [ord(ch) for ch in p.name]
                    for p in sorted(
                        pathlib.PurePosixPath("/media/post") / n for n in names
                    )
                ],
            }
            for name, names in SORT_CASES
        ],
        "walks": walks,
        "errors": errors,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    kept = sum(len(row["expected"]) for row in walks)
    print(
        f"wrote {len(payload['fsdecode'])} fsdecode cases, "
        f"{len(payload['sorts'])} sort "
        f"cases and {len(walks)} walk cases keeping {kept} files, plus "
        f"{len(errors)} error cases, to {OUT}"
    )


if __name__ == "__main__":
    main()
