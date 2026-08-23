"""Export the `link` and `image` inline parity oracle.

Ledger item 5.3c-iii-b-1-b-iii-d, the last rule in `markdown_to_wp_html`.

`parse_link` is the only inline rule whose scan pattern (`!?\\[`) matches
almost nothing of what it consumes: everything past the bracket is walked by
hand. It is also the only rule that can decline, so it is the only reason the
scan loop's one-character-forward fallback exists, and the only reader of
`state.env['ref_links']`, so it is where the block layer's `ref_link` output
finally becomes observable.

Three channels, because the rendered HTML cannot show everything:

* `html_cases` run whole documents through `markdown_to_wp_html`. A case whose
  paragraph ends up holding a tag raises `AttributeError` out of the renderer,
  which has no `inline_html` method, so those pin the exception instead.
* `token_cases` run one source string through `InlineParser.__call__` with an
  explicit env. A reference link carries `ref` and `label` fields the renderer
  drops, and `in_link` / `in_image` are only visible as the absence of nesting.
* `render_cases` call `_GutenbergRenderer.image` directly, for the attribute
  shapes no document can build.

Usage:
    uv run python scripts/export_wp_html_inline_link_parity.py
"""

from __future__ import annotations

import json
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
    / "wp-html-inline-link-parity.json"
)

HTML_CASES: list[tuple[str, str]] = [
    # The three link shapes and the three image shapes.
    ("inline link", "[a](/b)\n"),
    ("inline link with a double quoted title", '[a](/b "t")\n'),
    ("inline link with a single quoted title", "[a](/b 't')\n"),
    ("inline link with an empty title", '[a](/b "")\n'),
    ("inline link with an angle bracketed href", "[a](</b c>)\n"),
    ("inline link with an angle bracketed href and a title", '[a](</b> "t")\n'),
    ("inline link with an empty href", "[a]()\n"),
    ("inline image", "![alt](/b.png)\n"),
    ("inline image with a title", '![alt](/b.png "t")\n'),
    (
        "image among text nests a block comment inside the paragraph",
        "a ![x](/b.png) c\n",
    ),
    ("image alone in a paragraph", "![x](/b.png)\n"),
    # Reference links, all three CommonMark spellings.
    ("shortcut reference link", "[a]\n\n[a]: /b\n"),
    ("collapsed reference link", "[a][]\n\n[a]: /b\n"),
    ("full reference link", "[a][b]\n\n[b]: /c\n"),
    ("shortcut reference image", "![a]\n\n[a]: /b.png\n"),
    ("full reference image", "![a][b]\n\n[b]: /c.png\n"),
    ("reference link with a title", '[a]\n\n[a]: /b "t"\n'),
    ("reference link resolved case insensitively", "[FOO]\n\n[foo]: /b\n"),
    ("reference label folds whitespace runs", "[a   b]\n\n[a b]: /c\n"),
    ("reference label folds a newline", "[a\nb]\n\n[a b]: /c\n"),
    ("definition after the reference still resolves", "[a]\n\n[a]: /b\n"),
    ("definition before the reference", "[a]: /b\n\n[a]\n"),
    ("first definition of a key wins", "[a]\n\n[a]: /b\n\n[a]: /c\n"),
    # Declines: the rule returns None and the scan emits the bracket as text.
    ("shortcut with no definition at all", "[a]\n"),
    ("full reference with an undefined label", "[a][b]\n\n[c]: /d\n"),
    ("shortcut with an undefined label but other definitions", "[a]\n\n[b]: /c\n"),
    ("unclosed bracket", "[a\n"),
    ("unclosed parenthesis", "[a](/b\n"),
    ("bracket at the very end of the source", "a [\n"),
    ("empty brackets with no definition", "[]\n"),
    ("bang bracket with no definition", "![a]\n"),
    ("a declined link leaves its bracket and rescans from one past it", "[[a](/b)\n"),
    # `parse_link_text` versus `parse_link_label`: LINK_LABEL admits no bare
    # bracket, so nested brackets go through the bracket counter instead, and a
    # bracket-counted text can never be a reference.
    ("nested brackets in the link text", "[a [b] c](/d)\n"),
    ("nested brackets cannot resolve as a reference", "[a [b] c]\n\n[a [b] c]: /d\n"),
    ("escaped bracket stays in the label", "[a\\]b](/c)\n"),
    ("escaped opening bracket in the label", "[a\\[b](/c)\n"),
    (
        "an even backslash run before a bracket raises the nesting level",
        "[a\\\\](/b)\n",
    ),
    ("unbalanced closing bracket inside the text", "[a]b](/c)\n"),
    (
        "an even backslash run before a bracket, reached through the counter",
        "[a[b] c\\\\](/d)\n",
    ),
    ("an escaped bracket is invisible to the bracket counter", "[a[b] c\\] d](/e)\n"),
    ("an unclosed second label leaves its bracket behind", "[a][b\n\n[a]: /c\n"),
    # `end_pos >= len(src) and label is None`: a counted text that ran to the
    # end of the source has nothing left to be a link with.
    ("counted text ending exactly at the end of the source", "[a [b] c]\n"),
    # The href scan, which is `LINK_HREF_INLINE_RE` and not the block pattern.
    ("href stops at the first space", "[a](/b c)\n"),
    ("href with an escaped closing parenthesis", "[a](/b\\)c)\n"),
    ("href with a balanced parenthesis is not balanced by mistune", "[a](/b(c))\n"),
    ("href split across a newline", "[a](\n/b)\n"),
    ("href followed by a newline before the parenthesis", "[a](/b\n)\n"),
    ("href with an escaped space", "[a](/b\\ c)\n"),
    ("href holding a percent sign is escaped", "[a](/b%c)\n"),
    ("href holding a space inside angle brackets", "[a](</b c>)\n"),
    ("href holding a non ascii character is percent encoded", "[a](/caf\xe9)\n"),
    ("angle bracketed href holding a backslash refuses", "[a](</b\\c>)\n"),
    ("title spanning a newline", '[a](/b\n"t")\n'),
    ("title holding an escaped quote", '[a](/b "t\\"u")\n'),
    ("title holding an escaped punctuation character", '[a](/b "t\\-u")\n'),
    # `PAREN_END_RE` is Python's `\s`, which is not JavaScript's: a file separator
    # closes the parenthesis and a byte order mark does not.
    ("a file separator before the closing parenthesis", '[a](/b "t"\x1c)\n'),
    ("a byte order mark before the closing parenthesis", '[a](/b "t"\ufeff)\n'),
    # The `in_link` and `in_image` guards, which are deliberately asymmetric.
    ("a link inside a link text is literal text", "[a [b](/c) d](/e)\n"),
    ("an image inside a link text still nests", "[a ![b](/c.png) d](/e)\n"),
    ("an image inside an image alt is literal text", "![a ![b](/c.png) d](/e.png)\n"),
    ("a link inside an image alt still nests", "![a [b](/c) d](/e.png)\n"),
    ("an autolink inside a link text is not a link", "[a <https://x.co> b](/c)\n"),
    ("an email autolink inside a link text is not a link", "[a <u@x.co> b](/c)\n"),
    # Interaction with the other inline rules.
    ("emphasis inside a link text", "[a *b* c](/d)\n"),
    ("a link inside an emphasis", "*a [b](/c) d*\n"),
    ("an emphasis flag carries into the link text", "_a [b *c* d](/e) f_\n"),
    ("strong inside an image alt", "![a **b** c](/d.png)\n"),
    ("a codespan inside a link text", "[a `b` c](/d)\n"),
    ("an escape inside a link text", "[a \\* b](/c)\n"),
    ("an escaped opening bracket is not a link at all", "\\[a](/b)\n"),
    ("an escaped bang leaves a link", "\\![a](/b)\n"),
    ("a soft break inside a link text", "[a\nb](/c)\n"),
    ("a hard break inside a link text", "[a  \nb](/c)\n"),
    ("two links in one paragraph", "[a](/b) and [c](/d)\n"),
    ("a link immediately followed by another", "[a](/b)[c](/d)\n"),
    # `precedence_scan`, with `codespan`, `prec_auto_link` and
    # `prec_inline_html` but deliberately not `link` itself.
    ("a codespan outruns the link", "[a `b](/c)` d](/e)\n"),
    ("a codespan ending inside the link text loses", "[a `b` c](/d)\n"),
    ("an autolink outruns the link", "[a <https://x.co/](/b)> c](/d)\n"),
    ("an unclosed codespan inside a link text loses", "[a `b](/c)\n"),
    # Where a link lands against the block layer.
    ("link in an atx heading", "# a [b](/c) d\n"),
    ("link in a setext heading", "a [b](/c) d\n===\n"),
    ("link in a list item", "- a [b](/c) d\n"),
    ("link in a block quote", "> a [b](/c) d\n"),
    ("image in a list item", "- ![a](/b.png)\n"),
    ("link is not looked for inside a fenced code block", "```\n[a](/b)\n```\n"),
    ("reference definition inside a quote is visible outside it", "> [a]: /b\n\n[a]\n"),
    (
        "reference definition inside a list item is visible outside it",
        "- [a]: /b\n\n[a]\n",
    ),
    # Python's `.` in LINK_LABEL is `[^\n]`; JavaScript's also refuses these two,
    # so a backslash before one of them ends the label there instead.
    (
        "a backslash before a line separator stays inside the label",
        "[a\\\u2028b]: /c\n\n[a\\\u2028b]\n",
    ),
    (
        "a backslash before a paragraph separator stays inside the label",
        "[a\\\u2029b]: /c\n\n[a\\\u2029b]\n",
    ),
    # The label is not unescaped before it is folded into a key, but the href is
    # unescaped before it is percent encoded.
    ("escaped punctuation in a reference label", "[a\\-b]\n\n[a\\-b]: /c\n"),
    ("escaped punctuation in an inline href", "[a](/b\\-c)\n"),
]

# `_GutenbergRenderer` has no `inline_html` method, so these raise rather than
# render. The tokens behind them are in the token corpus.
HTML_RAISING_CASES: list[tuple[str, str]] = [
    (
        "a tag winning the precedence scan has no renderer",
        '[a <span x="](/b)"> c](/d)\n',
    ),
    ("a tag inside a link text has no renderer", "[a <span> b](/c)\n"),
]

# `InlineParser.__call__(src, env)`. The third member of each tuple is the env's
# `ref_links` map, which is what the block layer would have filled in.
TOKEN_CASES: list[tuple[str, str, dict[str, Any]]] = [
    ("inline link token shape", "[a](/b)", {}),
    ("inline link with a title token shape", '[a](/b "t")', {}),
    ("an empty title is absent from the attrs, not empty", '[a](/b "")', {}),
    ("image token shape", "![a](/b.png)", {}),
    (
        "reference link carries ref and label",
        "[a]",
        {"A": {"url": "/b", "label": "a"}},
    ),
    (
        "reference link title is null when the definition has none",
        "[a]",
        {"A": {"url": "/b", "label": "a"}},
    ),
    (
        "reference link title is carried through when present",
        "[a]",
        {"A": {"url": "/b", "label": "a", "title": "t"}},
    ),
    (
        "full reference keeps the second label",
        "[text][a]",
        {"A": {"url": "/b", "label": "a"}},
    ),
    (
        "collapsed reference keeps the first label",
        "[a][]",
        {"A": {"url": "/b", "label": "a"}},
    ),
    (
        "reference image carries ref and label",
        "![a]",
        {"A": {"url": "/b.png", "label": "a"}},
    ),
    (
        "the raw label is kept unfolded on the token",
        "[a   b]",
        {"A B": {"url": "/c", "label": "a b"}},
    ),
    (
        "a carriage return in a label is a label character to Python",
        "[a\\\rb][x]",
        {"A\\ B": {"url": "/c", "label": "a b"}},
    ),
    (
        "an empty ref_links map declines every shortcut",
        "[a]",
        {},
    ),
    ("a link inside a link text is a text token", "[a [b](/c) d](/e)", {}),
    ("an image inside a link text is an image token", "[a ![b](/c.png) d](/e)", {}),
    ("an image inside an image alt is a text token", "![a ![b](/c.png) d](/e.png)", {}),
    ("a link inside an image alt is a link token", "![a [b](/c) d](/e.png)", {}),
    ("an autolink inside a link text is a text token", "[a <https://x.co> b](/c)", {}),
    ("a declined link emits its bracket as text", "[a", {}),
    ("a declined bang bracket emits both characters", "![a", {}),
    ("a tag inside a link text nests an inline_html token", "[a <span> b](/c)", {}),
    (
        "precedence scan emits the scanned text then the winner",
        "[a `b](/c)` d](/e)",
        {},
    ),
    ("link children are parsed, not raw", "[a *b* `c`](/d)", {}),
]

# `_GutenbergRenderer.image` reads only `attrs['url']` and the children.
RENDER_CASES: list[tuple[str, str, dict[str, Any]]] = [
    (
        "image with one text child",
        "image",
        {
            "type": "image",
            "children": [{"type": "text", "raw": "a"}],
            "attrs": {"url": "/b.png"},
        },
    ),
    (
        "image with no children",
        "image",
        {"type": "image", "children": [], "attrs": {"url": "/b.png"}},
    ),
    (
        "image with a missing children key",
        "image",
        {"type": "image", "attrs": {"url": "/b.png"}},
    ),
    (
        "image ignores the title attribute",
        "image",
        {
            "type": "image",
            "children": [{"type": "text", "raw": "a"}],
            "attrs": {"url": "/b.png", "title": "t"},
        },
    ),
    (
        "image alt text is interpolated raw",
        "image",
        {
            "type": "image",
            "children": [{"type": "text", "raw": 'a " b & c'}],
            "attrs": {"url": "/b.png"},
        },
    ),
    (
        "image src is interpolated raw",
        "image",
        {"type": "image", "children": [], "attrs": {"url": '/b.png" onerror="x'}},
    ),
    (
        "link title branch, which no reference definition without a title reaches",
        "link",
        {
            "type": "link",
            "children": [{"type": "text", "raw": "a"}],
            "attrs": {"url": "/b", "title": "t"},
        },
    ),
]


def main() -> None:
    html_cases = []
    for name, markdown in HTML_CASES:
        html_cases.append(
            {"name": name, "markdown": markdown, "html": markdown_to_wp_html(markdown)}
        )

    raising_cases = []
    for name, markdown in HTML_RAISING_CASES:
        try:
            markdown_to_wp_html(markdown)
        except AttributeError as exc:
            raising_cases.append(
                {
                    "name": name,
                    "markdown": markdown,
                    "error": {"type": type(exc).__name__, "message": str(exc)},
                }
            )
        else:
            raise SystemExit(f"{name!r} no longer raises out of the renderer")

    md = mistune.create_markdown(renderer=_GutenbergRenderer())
    token_cases = []
    for name, src, ref_links in TOKEN_CASES:
        env: dict[str, Any] = {"ref_links": dict(ref_links)}
        token_cases.append(
            {
                "name": name,
                "src": src,
                "ref_links": ref_links,
                "tokens": md.inline(src, env),
            }
        )

    renderer = _GutenbergRenderer()
    render_cases = [
        {
            "name": name,
            "method": method,
            "token": token,
            "html": getattr(renderer, method)(token, None),
        }
        for name, method, token in RENDER_CASES
    ]

    payload = {
        "generated_by": "api/scripts/export_wp_html_inline_link_parity.py",
        "source": "api/src/services/wp_html.py::markdown_to_wp_html",
        "token_source": "mistune.InlineParser.__call__",
        "mistune_version": mistune.__version__,
        "scope": (
            "the inline link and image rules, parse_link_label, parse_link_text, "
            "parse_link, the in_link and in_image guards, the "
            "state.env['ref_links'] lookup and the image renderer method"
        ),
        "html_cases": html_cases,
        "raising_cases": raising_cases,
        "token_cases": token_cases,
        "render_cases": render_cases,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote {len(html_cases)} html cases, {len(raising_cases)} raising "
        f"cases, {len(token_cases)} token cases and {len(render_cases)} render "
        f"cases to {OUT}"
    )


if __name__ == "__main__":
    main()
