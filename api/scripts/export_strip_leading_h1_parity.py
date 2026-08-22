"""Export the parity oracle the TypeScript export endpoints need.

`GET /api/posts/{post_id}/export/markdown` and `/export/all` both run their
content through `strip_leading_h1` in `api/src/pipeline/helpers.py` before
returning it. That helper is four regexes and three `str` methods, and every
one of them behaves differently in JavaScript: Python's `$` under `MULTILINE`
matches only before `\n` while JavaScript's also matches before `\r`,
`str.strip("\"'")` strips a *set* of characters rather than a substring, and
`str.lstrip("\n")` strips only newlines. Rather than argue each difference, the
real function is run over a battery of inputs chosen to hit each branch and its
outputs are recorded for the TypeScript port to replay.

Usage:
    uv run python scripts/export_strip_leading_h1_parity.py
"""

from __future__ import annotations

import json
from pathlib import Path

from src.pipeline.helpers import strip_leading_h1

OUT = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "src"
    / "app"
    / "api"
    / "posts"
    / "data"
    / "strip-leading-h1-parity.json"
)


def fm(title_line: str, body: str) -> str:
    return f"---\n{title_line}\ndescription: d\n---\n{body}"


CASES: list[tuple[str, str]] = [
    ("empty", ""),
    ("no frontmatter, leading h1", "# Hello\n\nBody text.\n"),
    ("frontmatter without a title key", "---\ndescription: d\n---\n# Hello\n\nBody.\n"),
    ("title matches h1", fm("title: Hello", "# Hello\n\nBody.\n")),
    ("title does not match h1", fm("title: Hello", "# Goodbye\n\nBody.\n")),
    (
        "match differs only by case",
        fm("title: hello world", "# Hello World\n\nBody.\n"),
    ),
    ("double-quoted title, bare h1", fm('title: "Hello"', "# Hello\n\nBody.\n")),
    ("single-quoted title, bare h1", fm("title: 'Hello'", "# Hello\n\nBody.\n")),
    ("bare title, quoted h1", fm("title: Hello", '# "Hello"\n\nBody.\n')),
    ("h1 preceded by blank lines", fm("title: Hello", "\n\n# Hello\n\nBody.\n")),
    ("h1 indented by spaces", fm("title: Hello", "   # Hello\n\nBody.\n")),
    ("several blank lines after the h1", fm("title: Hello", "# Hello\n\n\n\nBody.\n")),
    ("no blank line after the h1", fm("title: Hello", "# Hello\nBody.\n")),
    ("h1 is the whole body, no trailing newline", fm("title: Hello", "# Hello")),
    ("h2 rather than h1", fm("title: Hello", "## Hello\n\nBody.\n")),
    ("hash with no space", fm("title: Hello", "#Hello\n\nBody.\n")),
    ("trailing spaces after the h1 text", fm("title: Hello", "# Hello   \n\nBody.\n")),
    ("trailing spaces after the title", fm("title: Hello   ", "# Hello\n\nBody.\n")),
    (
        "two title keys, first wins",
        fm("title: Hello\ntitle: Other", "# Other\n\nBody.\n"),
    ),
    ("title key not at line start", fm("  title: Hello", "# Hello\n\nBody.\n")),
    (
        "body contains a later thematic break",
        fm("title: Hello", "# Hello\n\nA.\n\n---\n\nB.\n"),
    ),
    (
        "frontmatter fence with trailing spaces",
        "---   \ntitle: Hello\n---   \n# Hello\n\nBody.\n",
    ),
    ("crlf line endings", "---\r\ntitle: Hello\r\n---\r\n# Hello\r\n\r\nBody.\r\n"),
    (
        "title contains a colon",
        fm('title: "Hello: A Guide"', "# Hello: A Guide\n\nBody.\n"),
    ),
    (
        "h1 text differs by trailing punctuation",
        fm("title: Hello", "# Hello.\n\nBody.\n"),
    ),
    ("body is empty", fm("title: Hello", "")),
    # The three cases below exist only to separate a literal transcription of
    # these regexes into JavaScript from a faithful one. A lone `\r` or a `\u2028`
    # is a line boundary to JavaScript's `m` flag and invisible to Python's
    # `re.MULTILINE`, and is excluded by JavaScript's `.` but matched by
    # Python's non-DOTALL `.`.
    (
        "lone carriage return inside the title and the h1",
        "---\ntitle: Hello\rWorld\ndescription: d\n---\n# Hello\rWorld\n\nBody.\n",
    ),
    (
        "title key preceded by a lone carriage return",
        "---\nx\rtitle: Hello\n---\n# Hello\n\nBody.\n",
    ),
    (
        "line separator inside the title and the h1",
        "---\ntitle: Hello\u2028World\ndescription: d\n---\n"
        "# Hello\u2028World\n\nBody.\n",
    ),
    (
        "media urls survive the strip",
        fm("title: Hello", "# Hello\n\n![a](/media/POST/a.webp)\n"),
    ),
]


def main() -> None:
    payload = [
        {"name": name, "input": content, "output": strip_leading_h1(content)}
        for name, content in CASES
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    changed = sum(1 for row in payload if row["input"] != row["output"])
    print(
        f"wrote {len(payload)} cases to {OUT} ({changed} of them modified by the strip)"
    )


if __name__ == "__main__":
    main()
