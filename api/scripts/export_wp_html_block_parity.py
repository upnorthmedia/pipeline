"""Export the block-level parity oracle for `markdown_to_wp_html`.

`api/src/services/wp_html.py` is a mistune 3 renderer, so its output is decided
as much by mistune's block tokenizer as by the renderer's format strings: which
lines become a heading, which become a paragraph, when a `---` is a thematic
break and when it retroactively turns the paragraph above it into a setext
heading, how an unclosed fence ends. None of that is visible in the renderer, so
the TypeScript port is verified by replaying the real function's output rather
than by reading the renderer.

This file covers the leaf blocks only (paragraph, ATX and setext heading,
thematic break, fenced and indented code, blank lines) plus the frontmatter
strip and the newline normalisation, which is ledger item 5.3c-iii-b-1-b-i.
Block quotes, lists, raw HTML and reference links (b-ii) and inline markup
(b-iii) get their own oracles, so every case below is deliberately written
without them.

That exclusion also rules out one block-level behaviour: a backtick fence whose
info string contains a backtick is not a fence, and the line falls back to a
paragraph that necessarily still holds those backticks, which is a codespan.
The case belongs to the b-iii corpus. The b-i test asserts the decline itself
instead, by asserting that the input reaches the inline parser at all.

Usage:
    uv run python scripts/export_wp_html_block_parity.py
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
    / "wp-html-block-parity.json"
)

CASES: list[tuple[str, str]] = [
    ("empty string", ""),
    ("blank input", "\n\n\n"),
    ("one paragraph", "Hello world.\n"),
    ("one paragraph, no trailing newline", "Hello world."),
    ("two paragraphs", "First para.\n\nSecond para.\n"),
    ("paragraph over two lines", "First line.\nSecond line.\n"),
    ("paragraph over three lines", "One.\nTwo.\nThree.\n"),
    ("hard break, two trailing spaces", "First line.  \nSecond line.\n"),
    ("hard break, three trailing spaces", "First line.   \nSecond line.\n"),
    ("hard break, trailing backslash", "First line.\\\nSecond line.\n"),
    ("several blank lines between paragraphs", "One.\n\n\n\nTwo.\n"),
    ("leading blank lines", "\n\n\nOne.\n"),
    ("trailing blank lines", "One.\n\n\n"),
    ("crlf line endings", "One.\r\n\r\nTwo.\r\n"),
    ("cr only line endings", "One.\r\rTwo.\r"),
    ("ampersand and angle bracket in a paragraph", "Tom & Jerry go 5 < 6.\n"),
    ("frontmatter stripped", "---\ntitle: Hi\n---\nBody text.\n"),
    (
        "frontmatter with trailing spaces on the fences",
        "---   \ntitle: Hi\n---   \nBody text.\n",
    ),
    ("frontmatter only", "---\ntitle: Hi\n---\n"),
    ("frontmatter not at the start", "Intro.\n\n---\ntitle: Hi\n---\nBody.\n"),
    ("unterminated frontmatter", "---\ntitle: Hi\nBody.\n"),
    ("heading level 1", "# Title\n"),
    ("heading level 2", "## Title\n"),
    ("heading level 3", "### Title\n"),
    ("heading level 4", "#### Title\n"),
    ("heading level 5", "##### Title\n"),
    ("heading level 6", "###### Title\n"),
    ("seven hashes is not a heading", "####### Title\n"),
    ("hash with no space is not a heading", "#Title\n"),
    ("empty atx heading", "##\n"),
    ("atx heading, hash then spaces only", "##   \n"),
    ("atx heading with a closing sequence", "## Title ##\n"),
    ("atx heading with a closing sequence and spaces", "## Title  ###   \n"),
    ("atx heading whose text ends in a hash", "## Title#\n"),
    ("atx heading with trailing spaces", "## Title   \n"),
    ("atx heading indented three spaces", "   ## Title\n"),
    ("atx heading indented four spaces", "    ## Title\n"),
    ("atx heading interrupting a paragraph", "Para.\n## Title\n"),
    ("paragraph directly after a heading", "## Title\nPara.\n"),
    ("setext heading level 1", "Title\n=====\n"),
    ("setext heading level 2", "Title\n-----\n"),
    ("setext heading, single equals", "Title\n=\n"),
    ("setext heading, single dash", "Title\n-\n"),
    ("setext heading over a two line paragraph", "One.\nTwo.\n=====\n"),
    ("setext underline with no paragraph above", "=====\n"),
    ("setext underline after a blank line", "Title\n\n=====\n"),
    ("setext underline indented three spaces", "Title\n   =====\n"),
    ("thematic break, three dashes", "Para.\n\n---\n\nPara two.\n"),
    ("thematic break, three asterisks", "***\n"),
    ("thematic break, three underscores", "___\n"),
    ("thematic break, spaced dashes", "Para.\n\n- - -\n\nPara two.\n"),
    ("thematic break, many dashes", "Para.\n\n--------\n\nPara two.\n"),
    ("two dashes after a paragraph", "Para.\n--\n"),
    ("fenced code with a language", "```python\nprint(1)\n```\n"),
    ("fenced code with no language", "```\nplain\n```\n"),
    ("fenced code with tildes", "~~~js\nlet a = 1;\n~~~\n"),
    ("fenced code, unclosed", "```python\nprint(1)\n"),
    ("fenced code indented two spaces", "  ```py\n  print(1)\n  ```\n"),
    ("fenced code, info string with trailing spaces", "```python   \nprint(1)\n```\n"),
    ("fenced code, info string with two words", "```python title\nprint(1)\n```\n"),
    ("fenced code, empty body", "```\n```\n"),
    ("fenced code containing angle brackets", "```html\n<p>a & b</p>\n```\n"),
    ("fenced code with four backticks", "````\n```\n````\n"),
    ("fenced code with a blank line inside", "```\na\n\nb\n```\n"),
    ("indented code block", "Para.\n\n    code line\n\nPara two.\n"),
    ("indented code, two lines", "Para.\n\n    line one\n    line two\n"),
    ("indented code with a blank line inside", "Para.\n\n    a\n\n    b\n\nEnd.\n"),
    ("indented code absorbed by the paragraph above", "Para.\n    code line\n"),
    ("tab indented code", "Para.\n\n\tcode line\n"),
    ("indented code at the very start", "    code line\n"),
    ("heading then fence then paragraph", "## Title\n\n```\ncode\n```\n\nPara.\n"),
    ("thematic break directly after a paragraph", "Para.\n\n***\nPara two.\n"),
]


def main() -> None:
    cases = [
        {"name": name, "markdown": markdown, "html": markdown_to_wp_html(markdown)}
        for name, markdown in CASES
    ]
    payload = {
        "generated_by": "api/scripts/export_wp_html_block_parity.py",
        "source": "api/src/services/wp_html.py::markdown_to_wp_html",
        "mistune_version": mistune.__version__,
        "scope": (
            "leaf blocks only: paragraph, atx and setext heading, thematic break, "
            "fenced and indented code, blank lines, frontmatter strip, newline "
            "normalisation"
        ),
        "cases": cases,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(cases)} cases to {OUT}")


if __name__ == "__main__":
    main()
