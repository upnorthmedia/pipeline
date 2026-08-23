"""Export the raw-HTML parity oracle for `markdown_to_wp_html`.

Ledger item 5.3c-iii-b-1-b-ii-3-a. CommonMark has seven kinds of HTML block and
mistune implements all seven in one `parse_raw_html` method, so which one fires
is decided entirely by the few characters after the `<`. Rules 1 to 5 scan for a
literal end marker (`</script>`, `-->`, `?>`, `>`, `]]>`) and swallow everything
up to the end of the line that marker sits on, so they cross blank lines. Rule 6
(a known block tag) and rule 7 (any other complete tag alone on its line) stop at
the next blank line instead. Rule 7 is the only one that cannot interrupt a
paragraph, and it is the only one that can decline the match and leave the line
to the paragraph fallback.

None of that is visible in `api/src/services/wp_html.py`, whose `block_html`
method is a single format string, so the port is verified by replaying the real
function rather than by reading it.

Every case below is deliberately written without reference-link definitions and
without inline markup, since those are ledger items -ii-3-b and -b-iii and get
their own oracles.

Usage:
    uv run python scripts/export_wp_html_html_parity.py
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
    / "wp-html-html-parity.json"
)

CASES: list[tuple[str, str]] = [
    # Rule 1: pre, script, style, textarea run to their own closing tag.
    ("rule 1 script block", "<script>\nvar x = 1;\n</script>\n"),
    (
        "rule 1 script with attributes",
        '<script type="text/javascript">\nx();\n</script>\n',
    ),
    (
        "rule 1 script spanning a blank line",
        "<script>\nvar x = 1;\n\nvar y = 2;\n</script>\n",
    ),
    ("rule 1 unclosed script runs to the end", "<script>\nvar x = 1;\n"),
    ("rule 1 pre block", "<pre>\n  literal\n</pre>\n"),
    ("rule 1 style block", "<style>\np { color: red; }\n</style>\n"),
    ("rule 1 textarea block", "<textarea>\ntyped\n</textarea>\n"),
    ("rule 1 uppercase script tag", "<SCRIPT>\nx();\n</SCRIPT>\n"),
    (
        "rule 1 uppercase script spanning a blank line",
        "<SCRIPT>\nx();\n\nmore\n</SCRIPT>\n",
    ),
    ("rule 1 text after the close tag on the same line", "<script>x()</script> tail\n"),
    ("rule 1 paragraph after the block", "<script>\nx();\n</script>\n\nAfter.\n"),
    ("rule 1 interrupts a paragraph", "Before.\n<script>\nx();\n</script>\n"),
    # Rule 2: comments run to `-->`.
    ("rule 2 comment", "<!-- a comment -->\n"),
    ("rule 2 multi line comment", "<!-- one\ntwo -->\n"),
    ("rule 2 comment across a blank line", "<!-- one\n\ntwo -->\n"),
    ("rule 2 unclosed comment runs to the end", "<!-- one\ntwo\n"),
    ("rule 2 comment then text on the same line", "<!-- c --> tail\n"),
    ("rule 2 comment interrupts a paragraph", "Before.\n<!-- c -->\n"),
    ("rule 2 comment indented three spaces", "   <!-- c -->\n"),
    ("rule 2 comment indented four spaces", "    <!-- c -->\n"),
    # Rule 3: processing instructions run to `?>`.
    ("rule 3 processing instruction", "<?php echo 1; ?>\n"),
    ("rule 3 multi line processing instruction", "<?php\necho 1;\n?>\n"),
    ("rule 3 unclosed processing instruction", "<?php echo 1;\n"),
    # Rule 4: declarations run to `>`.
    ("rule 4 doctype", "<!DOCTYPE html>\n"),
    ("rule 4 multi line declaration", "<!DOCTYPE\nhtml>\n"),
    ("rule 4 unclosed declaration", "<!DOCTYPE html\n"),
    # Rule 5: CDATA runs to `]]>`.
    ("rule 5 cdata", "<![CDATA[ raw ]]>\n"),
    ("rule 5 cdata holding a bare closing angle", "<![CDATA[ a > b ]]>\n"),
    ("rule 5 multi line cdata", "<![CDATA[\none\ntwo\n]]>\n"),
    (
        "rule 5 multi line cdata with a bare angle on an earlier line",
        "<![CDATA[\na > b\nc ]]>\n",
    ),
    ("rule 5 unclosed cdata", "<![CDATA[ raw\n"),
    # Rule 6: a known block tag runs to the next blank line.
    ("rule 6 div open tag alone", "<div>\ncontent\n</div>\n"),
    ("rule 6 div stops at a blank line", "<div>\ncontent\n</div>\n\nAfter.\n"),
    ("rule 6 close tag first", "</div>\n"),
    ("rule 6 close tag interrupting a paragraph", "Before.\n</div>\ncontent\n"),
    ("rule 6 close tag with no closing angle", "</div\ncontent\n"),
    ("rule 6 table", "<table>\n<tr><td>a</td></tr>\n</table>\n"),
    ("rule 6 open tag with attributes", '<div class="x" id="y">\ncontent\n</div>\n'),
    ("rule 6 open tag with no closing angle", "<div\ncontent\n"),
    ("rule 6 uppercase block tag", "<DIV>\ncontent\n</DIV>\n"),
    (
        "rule 6 uppercase block tag interrupting a paragraph",
        "Before.\n<DIV>\ncontent\n",
    ),
    ("rule 6 uppercase block tag with no closing angle", "<DIV\ncontent\n"),
    ("rule 6 interrupts a paragraph", "Before.\n<div>\ncontent\n</div>\n"),
    ("rule 6 indented three spaces", "   <div>\ncontent\n</div>\n"),
    ("rule 6 indented four spaces", "    <div>\ncontent\n</div>\n"),
    ("rule 6 hr tag", "<hr>\n"),
    ("rule 6 hr self closing", "<hr />\n"),
    (
        "rule 6 markdown inside a block tag is not parsed",
        "<div>\n## Not a heading\n</div>\n",
    ),
    ("rule 6 blank line inside splits the block", "<div>\n\n## Heading\n\n</div>\n"),
    ("rule 6 block tag prefix that is not a block tag", "<divx>\ncontent\n"),
    ("rule 6 li tag", "<li>item</li>\n"),
    # Rule 7: any other complete tag alone on its line.
    ("rule 7 unknown open tag alone", "<custom-tag>\ncontent\n"),
    ("rule 7 unknown open tag with attributes", '<custom-tag data-x="1">\ncontent\n'),
    ("rule 7 unknown close tag alone", "</custom-tag>\n"),
    ("rule 7 declines when the tag is unclosed", "<custom-tag\ncontent\n"),
    ("rule 7 trailing spaces after the tag still count", "<custom-tag>   \ncontent\n"),
    ("rule 7 stops at a blank line", "<custom-tag>\ncontent\n\nAfter.\n"),
    ("rule 7 at the very end with no newline", "<custom-tag>"),
    ("rule 7 close tag with trailing spaces", "</custom-tag>  \n"),
    ("rule 7 hyphenated tag name", "<my-widget>\n"),
    ("rule 7 digit in the tag name", "<x1>\n"),
    # Not HTML at all.
    ("a lone angle bracket", "< not a tag\n"),
    ("an angle bracket mid paragraph", "a < b\n"),
    ("tag inside a fenced code block", "```\n<div>\n```\n"),
    ("tag inside indented code", "    <div>\n"),
    ("tag inside indented code after a paragraph", "Para.\n\n    <div>\n"),
    # Interaction with the rules already ported.
    ("block html then heading", "<div>\nx\n</div>\n\n## Title\n"),
    ("heading then block html", "## Title\n\n<div>\nx\n</div>\n"),
    ("block html inside a block quote", "> <div>\n> x\n> </div>\n"),
    ("comment inside a block quote", "> <!-- c -->\n"),
    # `BLOCK_HTML` requires whitespace or a line end straight after the tag
    # name, which `<div>` and `<script>` do not have, so neither ends a lazy
    # block-quote continuation and both are parsed inside the quote instead.
    (
        "closed block tag does not break a lazy quote continuation",
        "> quoted\n<div>\nx\n",
    ),
    (
        "script does not break a lazy quote continuation",
        "> quoted\n<script>\nx();\n</script>\n",
    ),
    (
        "block tag then a space breaks a lazy quote continuation",
        '> quoted\n<div class="x">\nx\n',
    ),
    (
        "block tag then a newline breaks a lazy quote continuation",
        "> quoted\n<div\nx\n",
    ),
    ("comment breaks a lazy quote continuation", "> quoted\n<!-- c -->\n"),
    ("block html inside a list item", "- <div>\n  x\n"),
    ("block html after a list", "- one\n\n<div>\nx\n</div>\n"),
    ("comment between two list items", "- one\n\n<!-- c -->\n\n- two\n"),
    ("block html between two paragraphs", "One.\n\n<div>\nx\n</div>\n\nTwo.\n"),
    ("two block html blocks in a row", "<div>\na\n</div>\n\n<div>\nb\n</div>\n"),
    ("block html holding an ampersand", "<div>\nTom & Jerry\n</div>\n"),
    ("block html holding a quote character", '<div title="a">\nx\n</div>\n'),
    ("block html as the whole document, crlf", "<div>\r\nx\r\n</div>\r\n"),
    ("comment as the whole document with no trailing newline", "<!-- c -->"),
    ("thematic break after block html", "<div>\nx\n</div>\n\n***\n"),
    ("setext underline inside block html", "<div>\nPara.\n--\n</div>\n"),
]

# Inputs where `parse_raw_html` declines and the line falls through to the
# paragraph fallback, whose inline parse then produces an `inline_html` token.
# `_GutenbergRenderer` has no `inline_html` method, so the real function raises
# `AttributeError` rather than rendering. That is recorded here as the expected
# outcome: it is the only evidence available that the decline path was taken,
# and it is the same evidence the TypeScript port can produce, since its inline
# layer is ledger item -b-iii and throws there too.
DECLINE_CASES: list[tuple[str, str]] = [
    ("rule 7 self closing unknown tag", "<custom-tag />\n"),
    ("rule 7 cannot interrupt a paragraph", "Before.\n<custom-tag>\ncontent\n"),
    ("rule 7 declines when text follows on the line", "<custom-tag> tail\n"),
    ("rule 7 closing angle on the next line", "<custom-tag\nfoo>\n"),
    (
        "unknown tag does not break a lazy quote continuation",
        "> quoted\n<custom-tag>\n",
    ),
]


def main() -> None:
    cases = [
        {"name": name, "markdown": markdown, "html": markdown_to_wp_html(markdown)}
        for name, markdown in CASES
    ]
    declines = []
    for name, markdown in DECLINE_CASES:
        try:
            markdown_to_wp_html(markdown)
        except AttributeError as exc:
            declines.append(
                {
                    "name": name,
                    "markdown": markdown,
                    "raises": type(exc).__name__,
                    "message": str(exc),
                }
            )
        else:
            raise SystemExit(f"{name!r} no longer reaches the inline layer")
    payload = {
        "generated_by": "api/scripts/export_wp_html_html_parity.py",
        "source": "api/src/services/wp_html.py::markdown_to_wp_html",
        "mistune_version": mistune.__version__,
        "scope": (
            "raw HTML blocks: the seven CommonMark HTML block rules, the end-marker "
            "and blank-line scans, and rule 7's decline path"
        ),
        "cases": cases,
        "declines": declines,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(cases)} cases and {len(declines)} declines to {OUT}")


if __name__ == "__main__":
    main()
