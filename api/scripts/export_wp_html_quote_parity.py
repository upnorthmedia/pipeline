"""Export the block-quote parity oracle for `markdown_to_wp_html`.

Ledger item 5.3c-iii-b-1-b-ii-1. `block_quote` is the first mistune rule with a
body of its own, and almost nothing about it is visible in
`api/src/services/wp_html.py`'s renderer: `extract_block_quote` decides how far
the quote reaches, and it does that two different ways depending on whether the
quote's first line would start a code block. When it does, only lines carrying
a `>` marker continue the quote. When it does not, an unmarked line continues it
lazily unless the line starts a block that breaks out, in which case the block
is parsed on the *outer* state and the quote token is inserted before it. So the
port is verified by replaying the real function rather than by reading it.

Every case below is deliberately written without lists, reference links, raw
HTML and inline markup, since those rules are ledger items -ii-2, -ii-3 and
-b-iii and get their own oracles.

Usage:
    uv run python scripts/export_wp_html_quote_parity.py
"""

from __future__ import annotations

import json
from pathlib import Path

import mistune
from src.services.wp_html import markdown_to_wp_html

OUT = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "src"
    / "mastra"
    / "wordpress"
    / "data"
    / "wp-html-quote-parity.json"
)

CASES: list[tuple[str, str]] = [
    ("one line quote", "> quoted text\n"),
    ("quote with no space after the marker", ">quoted text\n"),
    ("quote with several spaces after the marker", ">    quoted text\n"),
    ("quote with a tab after the marker", ">\tquoted text\n"),
    ("empty quote marker", ">\n"),
    ("quote marker then spaces only", ">   \n"),
    ("two marked lines", "> one\n> two\n"),
    ("three marked lines", "> one\n> two\n> three\n"),
    ("marked lines with a hard break", "> one  \n> two\n"),
    ("quote indented one space", " > quoted\n"),
    ("quote indented three spaces", "   > quoted\n"),
    ("quote indented four spaces", "    > quoted\n"),
    ("quote indented four spaces after a paragraph", "Para.\n\n    > quoted\n"),
    ("quote between two paragraphs", "Before.\n\n> quoted\n\nAfter.\n"),
    ("quote interrupting a paragraph", "Before.\n> quoted\n"),
    ("paragraph directly after a quote", "> quoted\nAfter.\n"),
    ("lazy continuation line", "> one\ntwo\n"),
    ("two lazy continuation lines", "> one\ntwo\nthree\n"),
    ("lazy continuation after a marked blank line", "> one\n>\ntwo\n"),
    ("blank line then paragraph after a quote", "> one\n\ntwo\n"),
    ("marked blank line inside a quote", "> one\n>\n> two\n"),
    ("quote starting with a blank marker line", ">\n> text\n"),
    ("two quotes separated by a blank line", "> one\n\n> two\n"),
    ("two quotes separated by a paragraph", "> one\n\npara\n\n> two\n"),
    ("nested quote", "> > inner\n"),
    ("nested quote, marked outer line first", "> outer\n> > inner\n"),
    ("nested quote, lazy inner", "> > inner\nlazy\n"),
    ("three levels of nesting", "> > > deep\n"),
    ("five levels of nesting", "> > > > > deep\n"),
    ("six levels of nesting", "> > > > > > deep\n"),
    ("seven levels of nesting", "> > > > > > > deep\n"),
    ("quote holding an atx heading", "> ## Title\n"),
    ("quote holding an atx heading then text", "> ## Title\n> body\n"),
    ("quote holding a setext heading", "> Title\n> =====\n"),
    ("quote holding a thematic break", "> ***\n"),
    ("quote holding a fenced code block", "> ```\n> code\n> ```\n"),
    ("quote holding a fenced code block with a language", "> ```py\n> x = 1\n> ```\n"),
    ("quote whose first line is a fence", "> ```\ncode\n```\n"),
    ("quote holding indented code", ">     code line\n>     more\n"),
    ("quote whose first line is indented code, unmarked next", ">     code\ntext\n"),
    ("quote holding two paragraphs", "> one\n>\n> two\n"),
    ("quote holding a paragraph then a heading", "> one\n>\n> ## Title\n"),
    ("lazy continuation broken by a thematic break", "> quoted\n***\n"),
    ("lazy continuation broken by a fence", "> quoted\n```\ncode\n```\n"),
    ("lazy continuation broken by a blank line then text", "> quoted\n\ntext\n"),
    ("lazy continuation not broken by an atx heading", "> quoted\n## Title\n"),
    ("quote at the end with no trailing newline", "> quoted"),
    ("quote as the only content, crlf", "> one\r\n> two\r\n"),
    ("quote after a heading", "## Title\n\n> quoted\n"),
    ("quote before a fence", "> quoted\n\n```\ncode\n```\n"),
    ("angle bracket mid line is not a quote", "a > b\n"),
    ("quote whose text ends in a hash", "> quoted #\n"),
    ("quote holding an ampersand", "> Tom & Jerry\n"),
    ("quote holding two dashes under text", "> Para.\n> --\n"),
    ("marked line, blank line, marked line", "> one\n\n> two\n\n> three\n"),
    ("quote with trailing whitespace on the marker line", "> one   \n> two\n"),
]


def main() -> None:
    cases = [
        {"name": name, "markdown": markdown, "html": markdown_to_wp_html(markdown)}
        for name, markdown in CASES
    ]
    payload = {
        "generated_by": "api/scripts/export_wp_html_quote_parity.py",
        "source": "api/src/services/wp_html.py::markdown_to_wp_html",
        "mistune_version": mistune.__version__,
        "scope": (
            "block quotes: the require-marker and lazy-continuation scans, nesting "
            "depth, the blocks a quote may hold and the blocks that break out of one"
        ),
        "cases": cases,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(cases)} cases to {OUT}")


if __name__ == "__main__":
    main()
