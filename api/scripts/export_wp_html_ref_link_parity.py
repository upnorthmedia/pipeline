"""Export the reference-link parity oracle for `markdown_to_wp_html`.

Ledger item 5.3c-iii-b-1-b-ii-3-b-2. `parse_ref_link` is the one block rule that
emits no token: everything it produces goes into `state.env['ref_links']`, which
the Gutenberg renderer never reads. So the rendered HTML only shows whether the
definition line was *consumed*, and the definition itself has to be captured off
the parser state. This oracle records both channels for every case.

The rule is unusually fussy about position. `append_paragraph` runs first, so a
definition directly under a paragraph line is swallowed as paragraph text rather
than parsed. The href scan has a bracketed `<...>` form that forbids backslashes
outright and a bare form whose end position is off by one depending on whether it
stopped at whitespace or at the end of the subject. The title is matched against a
subject truncated at the next blank line, and both the title and (failing that)
the href must be followed by `[ \\t]*\\n` or the whole definition is abandoned and
the line falls through to a paragraph. Only the first definition for a key wins.

Cases are bucketed by whether the TypeScript port can render them today. A
declined definition leaves a paragraph holding a `[`, which fires the inline
`link` rule, and that rule is ledger item -b-iii and still throws there. Those
inputs go in `declines` with the real Python HTML pinned for when -b-iii lands;
their `ref_links` are still asserted, since the block layer is what this item
ports. The bucketing is computed by replaying the TypeScript inline scan loop
over the parsed tokens rather than decided by hand.

Usage:
    uv run python scripts/export_wp_html_ref_link_parity.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import mistune
from src.services.wp_html import _GutenbergRenderer

OUT = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "src"
    / "mastra"
    / "wordpress"
    / "data"
    / "wp-html-ref-link-parity.json"
)

PORTED_INLINE_RULES = {"linebreak", "softbreak"}

CASES: list[tuple[str, str]] = [
    # The shape from mistune's own docstring.
    ("definition with title, referenced above", "[example]: https://example.com\n"),
    (
        "definition with a double quoted title",
        '[example]: https://example.com "Optional title"\n',
    ),
    (
        "definition with a single quoted title",
        "[example]: https://example.com 'Optional title'\n",
    ),
    ("bare definition", "[a]: /url\n"),
    ("definition then a paragraph", "[a]: /url\n\nPara.\n"),
    ("paragraph, blank line, then a definition", "Para.\n\n[a]: /url\n"),
    ("two definitions in a row", "[a]: /one\n[b]: /two\n"),
    ("three definitions in a row", "[a]: /one\n[b]: /two\n[c]: /three\n"),
    (
        "two definitions with titles in a row",
        '[a]: /one "first"\n[b]: /two "second"\n',
    ),
    ("definition with no trailing newline", "[a]: /url"),
    ("definition with a trailing blank line", "[a]: /url\n\n"),
    ("definition with several trailing blank lines", "[a]: /url\n\n\n\n"),
    # Duplicate keys: the first definition wins outright.
    ("duplicate key keeps the first url", "[a]: /first\n[a]: /second\n"),
    (
        "duplicate key keeps the first title",
        '[a]: /first "one"\n[a]: /second "two"\n',
    ),
    (
        "duplicate key does not gain a title from the second",
        '[a]: /first\n[a]: /second "two"\n',
    ),
    (
        "duplicate key does not lose a title to the second",
        '[a]: /first "one"\n[a]: /second\n',
    ),
    ("duplicate key differing only in case", "[Foo]: /first\n[FOO]: /second\n"),
    (
        "duplicate key differing only in inner whitespace",
        "[foo  bar]: /first\n[foo bar]: /second\n",
    ),
    # `unikey`: collapse runs of whitespace, strip, then lower().upper().
    ("label is case folded", "[MiXeD]: /url\n"),
    ("label inner whitespace is collapsed", "[foo   bar]: /url\n"),
    ("label leading and trailing whitespace is stripped", "[  foo  ]: /url\n"),
    ("label tabs are collapsed to a single space", "[foo\t\tbar]: /url\n"),
    ("label spanning two lines", "[foo\nbar]: /url\n"),
    ("label spanning two lines with indentation", "[foo\n  bar]: /url\n"),
    ("label with a turkish dotless i", "[ı]: /url\n"),
    ("label with a german sharp s", "[straße]: /url\n"),
    ("label with a kelvin sign", "[K]: /url\n"),
    ("label holding an escaped bracket", "[a\\]b]: /url\n"),
    ("label holding an escaped backslash", "[a\\\\b]: /url\n"),
    ("label holding punctuation", "[a.b-c_d]: /url\n"),
    ("label of exactly 500 characters", "[" + "a" * 500 + "]: /url\n"),
    # Labels that name a member of JavaScript's Object.prototype. `unikey`
    # upper-cases, so none of them can collide, but the map is keyed with `has`
    # rather than `in` so that stays true if a folding rule ever changes.
    ("label named constructor", "[constructor]: /url\n"),
    ("label named toString", "[toString]: /url\n"),
    ("label named __proto__", "[__proto__]: /url\n"),
    ("label named hasOwnProperty", "[hasOwnProperty]: /url\n"),
    (
        "duplicate label named constructor keeps the first",
        "[constructor]: /first\n[constructor]: /second\n",
    ),
    # Indentation: up to three spaces, four is indented code.
    ("definition indented one space", " [a]: /url\n"),
    ("definition indented three spaces", "   [a]: /url\n"),
    ("definition after a paragraph and a blank, indented", "Para.\n\n   [a]: /url\n"),
    # The href scan, bracketed form.
    ("href in angle brackets", "[a]: <https://example.com>\n"),
    ("href in empty angle brackets", "[a]: <>\n"),
    ("href in angle brackets holding a space", "[a]: <a b>\n"),
    ("href in angle brackets on the next line", "[a]: \n<https://example.com>\n"),
    (
        "href in angle brackets with a title",
        '[a]: <https://example.com> "t"\n',
    ),
    # The href scan, bare form.
    ("href on the line after the colon", "[a]:\n/url\n"),
    ("href on the line after the colon, indented", "[a]:\n   /url\n"),
    ("href after a tab", "[a]:\t/url\n"),
    ("href after several spaces", "[a]:     /url\n"),
    ("href holding percent encoding", "[a]: /url%20x\n"),
    ("href holding a bare percent", "[a]: /url%x\n"),
    ("href holding an ampersand", "[a]: /url?x=1&y=2\n"),
    ("href holding an html entity", "[a]: /url?x=1&amp;y=2\n"),
    ("href holding a less than entity", "[a]: /url?x=&lt;y\n"),
    ("href holding a unicode path", "[a]: /café\n"),
    ("href holding an escaped underscore", "[a]: /url\\_x\n"),
    ("href holding an escaped bracket", "[a]: /url\\[x\\]\n"),
    ("href holding a backslash before a letter", "[a]: /url\\x\n"),
    ("href holding a hash", "[a]: /url#frag\n"),
    ("href that is a bare fragment", "[a]: #frag\n"),
    ("href holding a numeric character reference", "[a]: /url?x=&#65;\n"),
    ("href holding a space entity", "[a]: /a&#32;b\n"),
    ("href holding a double quote", "[a]: /url?q=%22x%22\n"),
    ("href holding a pipe", "[a]: /url|x\n"),
    ("href holding a caret", "[a]: /url^x\n"),
    ("href holding a backtick", "[a]: /url`x\n"),
    ("href holding a tilde", "[a]: /url~x\n"),
    ("href holding a non breaking space entity", "[a]: /a&nbsp;b\n"),
    # A byte order mark is not whitespace to Python but is to JavaScript, so it
    # stays inside the href and gets percent encoded.
    ("href holding a byte order mark", "[a]: /ur\ufeffl\n"),
    # The title scan.
    ("title on the next line", '[a]: /url\n"title"\n'),
    ("title on the next line indented", '[a]: /url\n   "title"\n'),
    ("title after a tab", '[a]: /url\t"title"\n'),
    ("empty double quoted title is dropped", '[a]: /url ""\n'),
    ("empty single quoted title is dropped", "[a]: /url ''\n"),
    ("title spanning two lines", '[a]: /url "one\ntwo"\n'),
    ("title holding an escaped quote", '[a]: /url "a \\" b"\n'),
    ("title holding an escaped punctuation mark", '[a]: /url "a \\* b"\n'),
    ("title holding a backslash before a letter", '[a]: /url "a \\x b"\n'),
    ("single quoted title holding a double quote", "[a]: /url 'a \" b'\n"),
    ("double quoted title holding a single quote", '[a]: /url "a \' b"\n'),
    ("title holding an ampersand", '[a]: /url "Tom & Jerry"\n'),
    ("title holding a bracket", '[a]: /url "a [b] c"\n'),
    (
        "blank line between href and title abandons the title",
        '[a]: /url\n\n"title"\n',
    ),
    # Container blocks.
    ("definition inside a block quote", "> [a]: /url\n"),
    ("definition inside a block quote with a title", '> [a]: /url "t"\n'),
    ("definition inside a block quote then a paragraph", "> [a]: /url\n\nPara.\n"),
    ("definition inside a list item", "- [a]: /url\n"),
    ("definition inside a nested block quote", "> > [a]: /url\n"),
    (
        "definition in a block quote and another outside it",
        "> [a]: /one\n\n[b]: /two\n",
    ),
    (
        "same key defined inside and outside a block quote",
        "> [a]: /inside\n\n[a]: /outside\n",
    ),
    # Interaction with other block rules.
    ("definition then a heading", "[a]: /url\n\n# Heading\n"),
    ("heading then a definition", "# Heading\n\n[a]: /url\n"),
    ("definition then a thematic break", "[a]: /url\n\n***\n"),
    ("definition then a fenced code block", "[a]: /url\n\n```\ncode\n```\n"),
    ("definition then a list", "[a]: /url\n\n- one\n- two\n"),
    ("fenced code holding a definition is not a definition", "```\n[a]: /url\n```\n"),
    (
        "indented code holding a definition is not a definition",
        "Para.\n\n    [a]: /url\n",
    ),
    ("setext underline after a definition", "[a]: /url\n---\n"),
    ("definition with crlf line endings", "[a]: /url\r\n\r\nPara.\r\n"),
    ("definition inside frontmatter is stripped", "---\ntitle: x\n---\n[a]: /url\n"),
]

# Inputs where the definition is refused and the line falls through to the
# paragraph fallback. The paragraph then holds a `[`, which fires the inline
# `link` rule, and that rule is ledger item -b-iii, so the TypeScript port throws
# rather than rendering. Python's HTML is pinned here for when -b-iii lands; the
# `ref_links` are asserted either way, because the block layer is what is ported.
DECLINE_CASES: list[tuple[str, str]] = [
    ("empty label", "[]: /url\n"),
    ("whitespace only label", "[   ]: /url\n"),
    ("newline only label", "[\n]: /url\n"),
    ("label of 501 characters", "[" + "a" * 501 + "]: /url\n"),
    ("no href at all", "[a]:\n"),
    ("href is only whitespace", "[a]:   \n"),
    ("trailing text after the href", "[a]: /url extra\n"),
    ("trailing text after the title", '[a]: /url "t" extra\n'),
    ("unterminated angle bracket href", "[a]: <https://example.com\n"),
    ("angle bracket href holding a backslash", "[a]: <a\\b>\n"),
    ("angle bracket href holding a newline", "[a]: <a\nb>\n"),
    ("definition directly under a paragraph", "Para.\n[a]: /url\n"),
    (
        "definition directly under a paragraph, with a title",
        'Para.\n[a]: /url "t"\n',
    ),
    ("second definition directly under a paragraph", "Para.\n[a]: /one\n[b]: /two\n"),
    ("label holding an unescaped bracket", "[a[b]: /url\n"),
    ("colon missing", "[a] /url\n"),
    ("space before the colon", "[a] : /url\n"),
    ("unterminated label", "[a: /url\n"),
    ("href then an unquoted title", "[a]: /url title\n"),
    ("href holding an escaped space", "[a]: /url\\ x\n"),
    # The other half of the whitespace-class difference: `\x85` and `\x1c` are
    # whitespace to Python but not to JavaScript, so they end the href and leave
    # trailing text, which refuses the definition.
    ("href holding a next line control", "[a]: /ur\x85l\n"),
    ("href holding a file separator control", "[a]: /ur\x1cl\n"),
    ("href holding a non breaking space", "[a]: /ur\xa0l\n"),
    ("title opened but not closed", '[a]: /url "t\n'),
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


def _parse(
    md: mistune.Markdown, markdown: str
) -> tuple[dict[str, Any], str, str | None]:
    """Block-parse, classify, then render.

    Returns `(ref_links, blocker, html)`, where `html` is `None` when rendering
    raises. A refused definition can leave a paragraph holding a tag as well as a
    `[`, and `_GutenbergRenderer` has no `inline_html` method, so the real
    function raises `AttributeError` on those (see todo.md).
    """
    state = md.block.state_cls()
    src = markdown.replace("\r\n", "\n").replace("\r", "\n")
    if not src.endswith("\n"):
        src += "\n"
    state.process(src)
    md.block.parse(state)
    ref_links = json.loads(json.dumps(state.env["ref_links"]))
    blocker = _walk(md, state.tokens) or ""
    try:
        html = md.render_state(state)
    except AttributeError:
        html = None
    return ref_links, blocker, html


def main() -> None:
    md = mistune.create_markdown(renderer=_GutenbergRenderer())
    frontmatter = re.compile(r"^---\s*\n.*?\n---\s*\n", re.DOTALL)

    cases = []
    for name, markdown in CASES:
        content = frontmatter.sub("", markdown).strip()
        ref_links, blocker, html = _parse(md, content)
        if blocker:
            raise SystemExit(f"{name!r} reaches the unported inline rule {blocker!r}")
        assert html is not None
        cases.append(
            {
                "name": name,
                "markdown": markdown,
                "ref_links": ref_links,
                "html": html,
            }
        )

    declines = []
    for name, markdown in DECLINE_CASES:
        content = frontmatter.sub("", markdown).strip()
        ref_links, blocker, html = _parse(md, content)
        if blocker != "link":
            raise SystemExit(
                f"{name!r} no longer falls through to the inline link rule "
                f"(blocker={blocker!r})"
            )
        declines.append(
            {
                "name": name,
                "markdown": markdown,
                "ref_links": ref_links,
                "python_html": html,
            }
        )

    payload = {
        "generated_by": "api/scripts/export_wp_html_ref_link_parity.py",
        "source": "api/src/services/wp_html.py::markdown_to_wp_html",
        "mistune_version": mistune.__version__,
        "scope": (
            "the ref_link block rule: unikey, parse_link_href in block mode, "
            "parse_link_title, the blank-line-to-end-of-line guards and the "
            "state.env['ref_links'] map"
        ),
        "cases": cases,
        "declines": declines,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(cases)} cases and {len(declines)} declines to {OUT}")


if __name__ == "__main__":
    main()
