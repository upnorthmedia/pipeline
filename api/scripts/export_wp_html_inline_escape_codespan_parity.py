"""Export the `escape` and `codespan` parity oracle for `markdown_to_wp_html`.

Ledger item 5.3c-iii-b-1-b-iii-a. These are the two inline rules that need
nothing from the inline state: no nesting flag, no precedence scan, no
reference-link env. Everything interesting about them is in their patterns.

`escape` matches a *run* of escaped punctuation and emits one text token with the
backslashes removed, so it is what keeps `\\*` from reaching the emphasis rule.
`codespan` matches an opening run of backticks and then compiles a closing
pattern out of that exact run, which is why three backticks do not close two, and
why the character before the closing run may not itself be a backtick. The code
it captures has its newlines folded to spaces and one space taken off each end,
but only when the code is not entirely whitespace.

The two rules also decide a block-level behaviour: a backtick fence whose info
string holds a backtick is not a fence, and the line falls back to a paragraph
that still holds those backticks. That case was moved out of the -b-i corpus for
exactly this item and is included here.

Every case is checked against the still-unported inline rules before it is
written out, by replaying the TypeScript scan loop over the parsed tokens. A case
that reaches `emphasis`, `link`, `auto_link`, `auto_email` or `inline_html` is a
hard error rather than a silently pinned expectation.

Usage:
    uv run python scripts/export_wp_html_inline_escape_codespan_parity.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import mistune
from src.services.wp_html import _GutenbergRenderer, markdown_to_wp_html

OUT = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "src"
    / "mastra"
    / "wordpress"
    / "data"
    / "wp-html-inline-escape-codespan-parity.json"
)

PORTED_INLINE_RULES = {"linebreak", "softbreak", "escape", "codespan"}

CASES: list[tuple[str, str]] = [
    # `escape`: a run of backslash + punctuation, emitted as text without them.
    ("escaped asterisks around a word", "\\*not emphasis\\*\n"),
    ("escaped double asterisks", "\\*\\*not strong\\*\\*\n"),
    ("escaped underscores", "\\_not emphasis\\_\n"),
    ("escaped brackets", "\\[not a link\\]\n"),
    ("escaped bang and brackets", "\\!\\[not an image\\]\n"),
    ("escaped backtick", "\\`not code\\`\n"),
    ("escaped backslash", "a \\\\ b\n"),
    ("escaped backslash then an asterisk", "a \\\\\\*b\n"),
    ("escaped hash", "\\# not a heading\n"),
    ("escaped angle brackets", "\\<not html\\>\n"),
    ("escaped ampersand", "Tom \\& Jerry\n"),
    ("escaped pipe", "a \\| b\n"),
    ("escaped tilde", "a \\~ b\n"),
    ("escaped dollar", "\\$5\n"),
    ("escaped parentheses", "\\(a\\)\n"),
    ("escaped braces", "\\{a\\}\n"),
    ("escaped quotes", "\\\"a\\' b\n"),
    ("escaped colon and semicolon", "a\\:b\\;c\n"),
    ("escaped comma and period", "a\\,b\\.c\n"),
    ("escaped plus equals", "a\\+b\\=c\n"),
    ("escaped at and caret", "a\\@b\\^c\n"),
    ("escaped question and slash", "a\\?b\\/c\n"),
    ("run of three escapes", "\\*\\_\\` end\n"),
    ("run of escapes at the start of a paragraph", "\\*\\*a\n"),
    ("escape at the very end of a paragraph", "end \\*\n"),
    ("backslash before a letter is not an escape", "a \\x b\n"),
    ("backslash before a digit is not an escape", "a \\1 b\n"),
    ("backslash before a space is not an escape", "a \\ b\n"),
    ("lone trailing backslash on the only line", "a b \\\n"),
    ("backslash at end of line is a hard break", "a\\\nb\n"),
    ("escaped backslash at end of line is a soft break", "a\\\\\nb\n"),
    ("two trailing spaces are a hard break", "a  \nb\n"),
    ("escape inside a heading", "# A \\* B\n"),
    ("escape inside a list item", "- a \\* b\n"),
    ("escape inside a block quote", "> a \\* b\n"),
    ("escape inside a setext heading", "A \\* B\n===\n"),
    ("escape does not survive into a fenced code block", "```\na \\* b\n```\n"),
    ("escape does not survive into an indented code block", "Para.\n\n    a \\* b\n"),
    # `codespan`: the marker run, the closing scan, and the space folding.
    ("simple codespan", "`code`\n"),
    ("codespan with surrounding text", "a `code` b\n"),
    ("codespan at the start of a paragraph", "`code` after\n"),
    ("codespan at the end of a paragraph", "before `code`\n"),
    ("two codespans on one line", "`a` and `b`\n"),
    ("double backtick codespan", "``code``\n"),
    ("triple backtick codespan", "```code```\n"),
    ("double backticks holding a single backtick", "`` a ` b ``\n"),
    ("single backtick cannot close a double backtick run", "``a`b``\n"),
    ("triple backticks do not close a double backtick run", "``a```\n"),
    ("unclosed codespan is literal text", "`code\n"),
    ("unclosed double backtick run is literal text", "``code\n"),
    ("empty double backtick run is literal text", "``\n"),
    ("one space is taken off each end", "` a `\n"),
    ("only a leading space is kept", "` a`\n"),
    ("only a trailing space is kept", "`a `\n"),
    ("two spaces each side lose only one", "`  a  `\n"),
    ("all whitespace code keeps its spaces", "`  `\n"),
    ("single space code keeps its space", "` `\n"),
    ("codespan spanning two lines folds the newline", "`a\nb`\n"),
    ("codespan spanning two lines with indentation", "`a\n  b`\n"),
    ("codespan holding a tab", "`a\tb`\n"),
    ("codespan holding an asterisk", "`a*b`\n"),
    ("codespan holding an underscore", "`a_b`\n"),
    ("codespan holding a bracket", "`[a]`\n"),
    ("codespan holding a bang bracket", "`![a]`\n"),
    ("codespan holding an angle bracket tag", "`<div>`\n"),
    ("codespan holding an autolink", "`<https://example.com>`\n"),
    ("codespan holding an email", "`<a@example.com>`\n"),
    ("codespan holding an ampersand is not escaped", "`a & b`\n"),
    ("codespan holding an html entity is not decoded", "`a &amp; b`\n"),
    ("codespan holding a backslash escape stays literal", "`a \\* b`\n"),
    ("codespan holding a double quote", '`a "b" c`\n'),
    ("codespan holding a unicode character", "`café`\n"),
    ("codespan inside a heading", "# A `b` C\n"),
    ("codespan inside a list item", "- a `b` c\n"),
    ("codespan inside an ordered list item", "1. a `b` c\n"),
    ("codespan inside a block quote", "> a `b` c\n"),
    ("codespan inside a setext heading", "A `b` C\n===\n"),
    ("codespan does not survive into a fenced code block", "```\na `b` c\n```\n"),
    # The leftmost match wins, then the rule order breaks ties at one offset.
    ("codespan starting before an escape wins", "`a\\*b`\n"),
    ("escape starting before a codespan wins", "\\`a`\n"),
    ("escape and codespan side by side", "\\* `a`\n"),
    ("codespan then an escape", "`a` \\*\n"),
    # The block-level half: a backtick in a backtick fence's info string.
    ("backtick fence with a backtick in its info string", "```ru`by\ncode\n```\n"),
    ("backtick fence with a backtick info string and no body", "```a`b\n"),
    ("tilde fence with a backtick in its info string", "~~~ru`by\ncode\n~~~\n"),
    # Line endings and frontmatter, the two things the wrapper normalises.
    ("codespan with crlf line endings", "a `b` c\r\n"),
    ("escape with crlf line endings", "a \\* b\r\n"),
    ("escape after frontmatter is stripped", "---\ntitle: x\n---\na \\* b\n"),
    ("codespan after frontmatter is stripped", "---\ntitle: x\n---\na `b` c\n"),
    ("no trailing newline", "a `b` c"),
    # `_iter_render` strips the inline source with `.strip(" \r\n\t\f")`, a
    # narrower set than `str.strip()` and much narrower than JavaScript's
    # `String.prototype.trim`, and mistune says so in a comment. A paragraph
    # ending in a unicode space keeps it; one ending in a vertical tab does too.
    # The outer `content.strip()` eats a unicode space at either end of the
    # whole document, so these have a second paragraph to sit against.
    ("paragraph ending in a non breaking space", "a `b`\xa0\n\nsecond\n"),
    ("paragraph ending in an em space", "a `b`\u2003\n\nsecond\n"),
    ("paragraph starting with an em space", "first\n\n\u2003a \\* b\n"),
    ("paragraph ending in a vertical tab", "a \\* b\x0b\n\nsecond\n"),
    ("paragraph ending in a zero width no break space", "a `b`\ufeff\n"),
]


def _first_unported_rule(md: mistune.Markdown, src: str) -> str | None:
    """Replay the TypeScript `parseInline` loop and name the rule it throws on."""
    sc = md.inline.compile_sc()
    pos = 0
    while pos < len(src):
        m = sc.search(src, pos)
        if not m:
            break
        if m.lastgroup not in PORTED_INLINE_RULES:
            return m.lastgroup
        if m.lastgroup == "codespan":
            # The codespan handler consumes to its closing run, so the scan
            # never sees what is inside it. Skipping the scan past the token is
            # what makes `` `<div>` `` a case rather than an inline_html blocker.
            state = md.inline.state_cls(dict(md.block.state_cls().env))
            state.src = src
            pos = md.inline.parse_codespan(m, state)
            continue
        pos = m.end()
    return None


def _walk(md: mistune.Markdown, tokens: list[dict[str, Any]]) -> str | None:
    for token in tokens:
        if "children" in token:
            found = _walk(md, token["children"])
        elif "text" in token:
            found = _first_unported_rule(md, token["text"].strip(" \r\n\t\f"))
        else:
            found = None
        if found:
            return found
    return None


def _blocker(md: mistune.Markdown, markdown: str) -> str | None:
    state = md.block.state_cls()
    src = markdown.replace("\r\n", "\n").replace("\r", "\n")
    if not src.endswith("\n"):
        src += "\n"
    state.process(src)
    md.block.parse(state)
    return _walk(md, state.tokens)


def main() -> None:
    md = mistune.create_markdown(renderer=_GutenbergRenderer())
    frontmatter = re.compile(r"^---\s*\n.*?\n---\s*\n", re.DOTALL)

    cases = []
    for name, markdown in CASES:
        blocker = _blocker(md, frontmatter.sub("", markdown).strip())
        if blocker:
            raise SystemExit(f"{name!r} reaches the unported inline rule {blocker!r}")
        cases.append(
            {
                "name": name,
                "markdown": markdown,
                "html": markdown_to_wp_html(markdown),
            }
        )

    payload = {
        "generated_by": ("api/scripts/export_wp_html_inline_escape_codespan_parity.py"),
        "source": "api/src/services/wp_html.py::markdown_to_wp_html",
        "mistune_version": mistune.__version__,
        "scope": (
            "the inline escape and codespan rules, the inline scan loop and "
            "the codespan renderer method"
        ),
        "cases": cases,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(cases)} cases to {OUT}")


if __name__ == "__main__":
    main()
