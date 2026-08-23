"""Export the `auto_link`, `auto_email` and `inline_html` parity oracle.

Ledger item 5.3c-iii-b-1-b-iii-b. These are the three inline rules whose whole
behaviour is decided by one flag on the inline state, `in_link`: inside an
anchor an autolink is not a link, it is the literal text it was written as.
`inline_html` is the rule that sets and clears the flag, and it is also the only
inline token `_GutenbergRenderer` has no method for, so a document containing
one raises `AttributeError` out of mistune's `BaseRenderer._get_method` instead
of rendering.

That leaves the flag with no observable effect on the rendered HTML at all, so
this script writes two corpora rather than one:

* `html_cases`: whole documents through the real `markdown_to_wp_html`. An
  autolink case pins the HTML; an `inline_html` case pins the exception.
* `token_cases`: single inline source strings through mistune's own
  `InlineParser.__call__`, pinning the token stream. This is the only place the
  `in_link` toggle is visible, and it is also what shows that the tag is kept
  verbatim in the token that later raises.

Every case is checked against the still-unported inline rules before it is
written out. A case that reaches `emphasis` or `link` is a hard error rather
than a silently pinned expectation.

Usage:
    uv run python scripts/export_wp_html_inline_autolink_parity.py
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
    / "wp-html-inline-autolink-parity.json"
)

PORTED_INLINE_RULES = {
    "linebreak",
    "softbreak",
    "escape",
    "codespan",
    "auto_link",
    "auto_email",
    "inline_html",
}

HTML_CASES: list[tuple[str, str]] = [
    # `auto_link`: the brackets come off, the inside is both href and label.
    ("plain https autolink", "<https://example.com>\n"),
    ("autolink with surrounding text", "see <https://example.com> now\n"),
    ("autolink with a path", "<https://example.com/a/b>\n"),
    ("autolink with a query string", "<https://example.com/a?b=c>\n"),
    ("autolink with a fragment", "<https://example.com/a#b>\n"),
    ("autolink with a port", "<https://example.com:8443/a>\n"),
    ("autolink with credentials", "<https://u:p@example.com/a>\n"),
    ("http autolink", "<http://example.com>\n"),
    ("ftp autolink", "<ftp://example.com/pub>\n"),
    ("mailto autolink beats auto_email", "<mailto:a@example.com>\n"),
    ("uppercase scheme", "<HTTPS://EXAMPLE.COM>\n"),
    ("mixed case scheme", "<HtTps://example.com>\n"),
    ("scheme with a plus", "<coap+tcp://example.com>\n"),
    ("scheme with a dot and a dash", "<a.b-c://example.com>\n"),
    ("shortest possible scheme is two characters", "<ab:x>\n"),
    ("one character scheme is not an autolink", "<a:x>\n"),
    ("thirty two character scheme", "<" + "a" * 32 + "://x>\n"),
    ("thirty three character scheme is not an autolink", "<" + "a" * 33 + "://x>\n"),
    ("scheme starting with a digit is not an autolink", "<1ab://x>\n"),
    ("empty body after the scheme", "<https:>\n"),
    ("a space stops the autolink", "<https://example.com/a b>\n"),
    ("a newline stops the autolink", "<https://example.com/a\nb>\n"),
    # An `<` inside the url ends the autolink pattern, and what follows is a
    # tag in its own right, so this raises rather than rendering.
    (
        "an angle bracket stops the autolink and opens a tag",
        "<https://example.com/a<b>\n",
    ),
    ("a tab stops the autolink", "<https://example.com/a\tb>\n"),
    # `escape_url` runs on the href and on the href only, and it unescapes html
    # entities first, so `&amp;` in the source becomes a bare `&` in the label
    # and a bare `&` in the href.
    ("autolink whose href needs percent encoding", "<https://example.com/caf\u00e9>\n"),
    ("autolink holding an html entity", "<https://example.com/?a=1&amp;b=2>\n"),
    ("autolink holding a numeric entity", "<https://example.com/?a=&#38;>\n"),
    ("autolink already percent encoded", "<https://example.com/a%20b>\n"),
    ("autolink with a percent that is not an escape", "<https://example.com/100%>\n"),
    ("autolink holding a double quote", '<https://example.com/a"b>\n'),
    ("autolink holding a single quote", "<https://example.com/a'b>\n"),
    ("autolink holding a bracket", "<https://example.com/a[b]>\n"),
    ("autolink holding a tilde and a plus", "<https://example.com/a~b+c>\n"),
    ("autolink holding a semicolon and a comma", "<https://example.com/a;b,c>\n"),
    # `auto_email`: the same shape, with a `mailto:` href the label never shows.
    ("plain email autolink", "<user@example.com>\n"),
    ("email with a dot in the local part", "<first.last@example.com>\n"),
    ("email with a plus tag", "<user+tag@example.com>\n"),
    ("email with punctuation in the local part", "<a!#$%&'*/=?^_`{|}~-@example.com>\n"),
    ("email with a two label domain", "<user@example.co.uk>\n"),
    ("email with a single label domain", "<user@localhost>\n"),
    ("email with a hyphenated domain", "<user@ex-ample.com>\n"),
    ("uppercase email", "<USER@EXAMPLE.COM>\n"),
    ("email with a digit only domain label", "<user@123.example>\n"),
    ("email with no local part is not an email", "<@example.com>\n"),
    ("email with no domain is not an email", "<user@>\n"),
    ("email with a trailing dot domain is not an email", "<user@example.>\n"),
    ("email with a space is not an email", "<user @example.com>\n"),
    # Where the rules sit against each other and against the block layer.
    ("autolink inside an atx heading", "# See <https://example.com>\n"),
    ("autolink inside a setext heading", "See <https://example.com>\n===\n"),
    ("autolink inside a list item", "- see <https://example.com>\n"),
    ("autolink inside an ordered list item", "1. see <https://example.com>\n"),
    ("autolink inside a block quote", "> see <https://example.com>\n"),
    ("email inside a list item", "- write <user@example.com>\n"),
    ("two autolinks on one line", "<https://a.example> <https://b.example>\n"),
    ("an autolink and an email", "<https://a.example> <u@b.example>\n"),
    ("autolink across a soft break", "a\n<https://example.com>\n"),
    ("autolink after a hard break", "a  \n<https://example.com>\n"),
    ("escaped angle bracket is not an autolink", "\\<https://example.com>\n"),
    ("autolink next to a codespan", "`a` <https://example.com>\n"),
    ("codespan swallows an autolink", "`<https://example.com>`\n"),
    (
        "autolink does not survive into a fenced code block",
        "```\n<https://x.example>\n```\n",
    ),
    (
        "autolink after frontmatter is stripped",
        "---\nt: x\n---\n<https://example.com>\n",
    ),
    ("autolink with crlf line endings", "see <https://example.com>\r\n"),
    ("autolink with no trailing newline", "see <https://example.com>"),
    # Which layer claims a `<` at the start of a line is the block `raw_html`
    # rule's decision, and it is narrower than it looks. Kind 6 fires for a
    # block tag name and swallows to the next blank line, so `<div>a</div>`
    # renders as `wp:html`. Kind 7 fires for any other complete tag but only
    # when the tag is alone on its line, so `<span>a</span>` declines, falls
    # back to a paragraph, and raises out of the inline layer instead.
    ("block tag at the start of a line is a block", "<div>a</div>\n"),
    ("block tag alone on its line is a block", "<span>\na\n</span>\n"),
    ("inline tag with text after it on the line is not a block", "<span>a</span>\n"),
    ("anchor with text after it on the line is not a block", '<a href="/x">y</a>\n'),
    # `inline_html`: everything below raises out of the renderer.
    ("open tag inside a paragraph", "a <span>b\n"),
    ("close tag inside a paragraph", "a </span> b\n"),
    ("self closing tag inside a paragraph", "a <br/> b\n"),
    ("open tag with attributes inside a paragraph", 'a <img src="x" alt="y"> b\n'),
    ("anchor inside a paragraph", 'see <a href="/x">y</a> now\n'),
    ("comment inside a paragraph", "a <!-- c --> b\n"),
    ("processing instruction inside a paragraph", "a <?php echo 1; ?> b\n"),
    ("doctype inside a paragraph", "a <!DOCTYPE html> b\n"),
    ("cdata inside a paragraph", "a <![CDATA[x]]> b\n"),
    ("tag inside a heading", "# a <span>b\n"),
    ("tag inside a list item", "- a <span>b\n"),
    ("unclosed angle bracket is not a tag", "a < b\n"),
    ("a tag name that is not html is still a tag", "a <weird-tag> b\n"),
]

TOKEN_CASES: list[tuple[str, str]] = [
    # The two token shapes, with `escape_url` visible on the href.
    ("autolink token", "<https://example.com>"),
    ("autolink token needing escaping", "<https://example.com/caf\u00e9?x=1&amp;y=2>"),
    ("email token", "<user@example.com>"),
    ("mailto autolink token", "<mailto:user@example.com>"),
    # `in_link`, which the renderer can never show because the tag that sets it
    # has no renderer method.
    ("lowercase open anchor turns in_link on", '<a href="/x"><https://e.example>'),
    ("bare open anchor turns in_link on", "<a><https://e.example>"),
    ("uppercase open anchor turns in_link on", '<A HREF="/x"><https://e.example>'),
    ("bare uppercase open anchor turns in_link on", "<A><https://e.example>"),
    ("close anchor turns in_link off", '<a href="/x"></a><https://e.example>'),
    ("spaced close anchor turns in_link off", '<a href="/x"></a ><https://e.example>'),
    (
        "uppercase close anchor turns in_link off",
        '<A HREF="/x"></A><https://e.example>',
    ),
    ("a newline after the tag name does not toggle", "<a\n><https://e.example>"),
    ("a tab after the tag name does not toggle", "<a\t><https://e.example>"),
    ("a self closing anchor does not toggle", "<a/><https://e.example>"),
    ("another tag does not toggle", "<b><https://e.example>"),
    ("an email inside an anchor is text too", '<a href="/x"><u@e.example>'),
    (
        "in_link survives text between the tag and the autolink",
        '<a href="/x">go <https://e.example>',
    ),
    (
        "in_link does not leak across two anchors",
        '<a href="/x"></a>a<https://e.example>',
    ),
    ("comment does not toggle in_link", "<!-- c --><https://e.example>"),
]


# `_GutenbergRenderer.link` takes its title from `attrs`, and no rule in this
# item ever sets one: `_add_auto_link` writes `url` alone. The branch is still
# part of the method being ported, so it is pinned here against the real
# renderer rather than left to the `link` rule's item to discover.
RENDER_CASES: list[tuple[str, dict[str, Any]]] = [
    (
        "link with no title",
        {
            "type": "link",
            "children": [{"type": "text", "raw": "label"}],
            "attrs": {"url": "https://example.com"},
        },
    ),
    (
        "link with a title",
        {
            "type": "link",
            "children": [{"type": "text", "raw": "label"}],
            "attrs": {"url": "https://example.com", "title": "t"},
        },
    ),
    (
        "link with a null title renders as no title",
        {
            "type": "link",
            "children": [{"type": "text", "raw": "label"}],
            "attrs": {"url": "https://example.com", "title": None},
        },
    ),
    (
        "link with an empty title renders as no title",
        {
            "type": "link",
            "children": [{"type": "text", "raw": "label"}],
            "attrs": {"url": "https://example.com", "title": ""},
        },
    ),
    (
        "link with no children",
        {"type": "link", "children": [], "attrs": {"url": "https://example.com"}},
    ),
    (
        "link whose url and title are interpolated raw",
        {
            "type": "link",
            "children": [{"type": "text", "raw": "a & b"}],
            "attrs": {"url": 'x"y', "title": 'a"b'},
        },
    ),
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
            # never sees what is inside it.
            state = md.inline.state_cls({})
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

    html_cases = []
    raised = 0
    for name, markdown in HTML_CASES:
        blocker = _blocker(md, frontmatter.sub("", markdown).strip())
        if blocker:
            raise SystemExit(f"{name!r} reaches the unported inline rule {blocker!r}")
        case: dict[str, Any] = {"name": name, "markdown": markdown}
        try:
            case["html"] = markdown_to_wp_html(markdown)
        except AttributeError as exc:
            case["error"] = {"type": type(exc).__name__, "message": str(exc)}
            raised += 1
        html_cases.append(case)

    token_cases = []
    for name, src in TOKEN_CASES:
        blocker = _first_unported_rule(md, src)
        if blocker:
            raise SystemExit(f"{name!r} reaches the unported inline rule {blocker!r}")
        token_cases.append({"name": name, "src": src, "tokens": md.inline(src, {})})

    renderer = _GutenbergRenderer()
    render_cases = [
        {"name": name, "token": token, "html": renderer.link(token, None)}
        for name, token in RENDER_CASES
    ]

    payload = {
        "generated_by": "api/scripts/export_wp_html_inline_autolink_parity.py",
        "source": "api/src/services/wp_html.py::markdown_to_wp_html",
        "token_source": "mistune.InlineParser.__call__",
        "mistune_version": mistune.__version__,
        "scope": (
            "the inline auto_link, auto_email and inline_html rules, the link "
            "renderer method and the in_link flag"
        ),
        "html_cases": html_cases,
        "token_cases": token_cases,
        "render_cases": render_cases,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote {len(html_cases)} html cases ({raised} of them raising) and "
        f"{len(token_cases)} token cases and {len(render_cases)} render "
        f"cases to {OUT}"
    )


if __name__ == "__main__":
    main()
