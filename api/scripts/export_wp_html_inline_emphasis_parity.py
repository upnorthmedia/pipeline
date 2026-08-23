"""Export the `emphasis`, `strong` and `precedence_scan` parity oracle.

Ledger item 5.3c-iii-b-1-b-iii-c. One rule, `parse_emphasis`, produces both the
`emphasis` and the `strong` token, and it is the first inline rule that recurses
into itself, so the two nesting flags on the inline state finally have an
observable effect. It is also the first caller of `precedence_scan`, which is
what stops an emphasis run from cutting a codespan, an autolink or a tag in
half.

Two things make this corpus awkward:

* `precedence_scan`'s default rule set includes `link`, which is not ported yet.
  A case whose scan resolves to `link` is refused rather than pinned.
* `inline_html` has no renderer method, so a case that wins the precedence scan
  with a tag raises `AttributeError` instead of rendering. Those cases pin the
  exception, and the token corpus is what shows the tokens behind it.

Every case is checked before it is written out by wrapping mistune's
`_methods` table, which both `parse_method` and `precedence_scan` dispatch
through, so the check sees the rules the precedence scan reaches as well as the
ones the top level scan reaches.

Usage:
    uv run python scripts/export_wp_html_inline_emphasis_parity.py
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
    / "wp-html-inline-emphasis-parity.json"
)

PORTED_INLINE_RULES = {
    "linebreak",
    "softbreak",
    "escape",
    "codespan",
    "emphasis",
    "auto_link",
    "auto_email",
    "inline_html",
}

HTML_CASES: list[tuple[str, str]] = [
    # The six markers, each producing its own token shape.
    ("single star emphasis", "*em*\n"),
    ("single underscore emphasis", "_em_\n"),
    ("double star strong", "**strong**\n"),
    ("double underscore strong", "__strong__\n"),
    ("triple star is strong inside emphasis", "***both***\n"),
    ("triple underscore is strong inside emphasis", "___both___\n"),
    ("emphasis with surrounding text", "a *em* b\n"),
    ("two emphasis runs in one paragraph", "*a* and *b*\n"),
    ("emphasis at the very end", "a *em*\n"),
    # The opening pattern: the marker has to be followed by a non space that is
    # not another marker character, and `_` needs a word boundary before it.
    ("star followed by a space does not open", "* a*\n"),
    ("double star followed by a space does not open", "** a**\n"),
    ("underscore followed by a space does not open", "_ a_\n"),
    ("four stars are not a marker", "****a****\n"),
    ("underscore inside a word does not open", "a_b_c\n"),
    ("snake case identifier", "snake_case_word here\n"),
    ("underscore after punctuation does open", "(_a_)\n"),
    ("underscore after a digit does not open", "1_a_\n"),
    ("underscore after a non ascii letter does not open", "café_a_\n"),
    ("underscore after a non ascii digit does not open", "١_a_\n"),
    ("underscore after a combining mark does open", "á_b_\n"),
    ("star after a word does open", "a*b*\n"),
    # Python's `\s` is not JavaScript's. `\x1c` is whitespace to Python only and
    # `\ufeff` is whitespace to JavaScript only, so these four cases are the ones
    # that decide whether the port spelled the class out or reached for `\s`.
    ("a file separator counts as whitespace after the marker", "a *\x1cb* c\n"),
    (
        "a byte order mark does not count as whitespace after the marker",
        "a *\ufeffb* c\n",
    ),
    ("a file separator counts as whitespace before the closer", "*a\x1c*\n"),
    ("a byte order mark does not count as whitespace before the closer", "*a\ufeff*\n"),
    # The closing pattern.
    ("no closing marker at all", "*a\n"),
    ("closing marker preceded by a space does not close", "*a *\n"),
    ("closing star followed by another star does not close", "*a**\n"),
    ("double star closed by three", "**a***\n"),
    ("closing underscore followed by a word character", "_a_b\n"),
    ("closing underscore followed by punctuation closes", "_a_.\n"),
    ("closing underscore followed by a non ascii letter", "_a_é\n"),
    ("escaped closing star does not close", "*a\\*b*\n"),
    ("an even backslash run leaves the star closing", "*a\\\\* b\n"),
    ("escaped closing underscore does not close", "_a\\_b_\n"),
    ("emphasis holding an escaped star only", "*\\**\n"),
    # Nesting and the two flags.
    ("strong inside emphasis", "*a **b** c*\n"),
    ("emphasis inside strong", "**a *b* c**\n"),
    ("single marker inside an emphasis is text", "*a *b* c*\n"),
    ("double marker inside a strong is text", "**a **b** c**\n"),
    ("double marker inside an emphasis still opens", "*a **b** c*\n"),
    ("single marker inside a strong still opens", "**a *b* c**\n"),
    ("triple opens both flags", "***a *b* c***\n"),
    ("triple then a double inside", "***a **b** c***\n"),
    ("underscore emphasis inside star strong", "**a _b_ c**\n"),
    ("star emphasis inside underscore strong", "__a *b* c__\n"),
    ("emphasis inside emphasis by mixing markers", "*a _b_ c*\n"),
    # Where the run lands against the block layer and the other inline rules.
    ("emphasis in an atx heading", "# a *em* b\n"),
    ("emphasis in a setext heading", "a *em* b\n===\n"),
    ("emphasis in a list item", "- a *em* b\n"),
    ("emphasis in a block quote", "> a *em* b\n"),
    ("emphasis spanning a soft break", "*a\nb*\n"),
    ("emphasis spanning a hard break", "*a  \nb*\n"),
    ("emphasis is not looked for inside a fenced code block", "```\n*a*\n```\n"),
    ("emphasis around an escape", "*a \\* b*\n"),
    ("escaped stars are not emphasis", "\\*a\\*\n"),
    ("emphasis around an autolink", "*a <https://example.com> b*\n"),
    ("emphasis around an email autolink", "*a <user@example.com> b*\n"),
    ("emphasis around a codespan", "*a `b` c*\n"),
    ("emphasis whose text is only a codespan", "*`a`*\n"),
    # `precedence_scan`: a construct that starts inside the run and ends at or
    # past the closer takes the run's characters with it.
    ("codespan outruns the emphasis", "*a `b* c` d*\n"),
    ("codespan ends exactly at the closer", "*a `b*`\n"),
    ("codespan ends before the closer so the emphasis wins", "*a `b` c*\n"),
    ("unclosed codespan inside an emphasis loses", "*a `b* c\n"),
    ("codespan outruns a strong", "**a `b** c` d**\n"),
    ("codespan outruns a triple", "***a `b*** c` d***\n"),
    ("autolink outruns the emphasis", "*a <https://example.com/*b> c*\n"),
    ("autolink ends before the closer so the emphasis wins", "*a <https://x.co> b*\n"),
    ("a failed autolink start leaves the emphasis alone", "*a <https:b* c*\n"),
    ("codespan outruns an underscore emphasis", "_a `b_ c` d_\n"),
    # `prec_inline_html` wins and the resulting token has no renderer.
    ("tag outruns the emphasis", '*a <span x="*"> b*\n'),
    ("closing tag outruns the emphasis", "*a </span* b> c*\n"),
    ("comment outruns the emphasis", "*a <!-- b* --> c*\n"),
    # Cases the scan looks at and rejects, so the emphasis stands.
    ("a lone left angle bracket is not a tag start", "*a < b*\n"),
    ("a bare question mark tag start that never ends", "*a <? b*\n"),
]

# Single inline sources through `InlineParser.__call__`. The rendered HTML
# cannot show a token whose type has no renderer method, and it flattens the
# `emphasis` wrapping a `strong` that a triple marker builds, so the token
# stream is pinned for the shapes the HTML corpus cannot describe.
TOKEN_CASES: list[tuple[str, str]] = [
    ("triple star token shape", "***a***"),
    ("triple underscore token shape", "___a___"),
    ("nested strong inside emphasis token shape", "*a **b** c*"),
    ("single marker inside an emphasis is a text token", "*a *b* c*"),
    ("double marker inside a strong is a text token", "**a **b** c**"),
    ("emphasis children are parsed, not raw", "*a `b` c*"),
    ("precedence scan emits the scanned text then the winner", "*a `b* c` d*"),
    ("precedence scan with a tag winner", '*a <span x="*"> b*'),
    ("precedence scan with an autolink winner", "*a <https://example.com/*b> c*"),
    ("precedence scan that loses leaves an emphasis", "*a `b` c*"),
    ("unclosed emphasis is a text token", "*a"),
    ("emphasis over a soft break", "*a\nb*"),
    ("emphasis inside an anchor still nests", '<a href="/x">*a*</a>'),
    ("triple marker sets both flags for the children", "***a *b* **c** d***"),
]

# `_GutenbergRenderer.emphasis` and `.strong` take their text from the children
# and nothing else, so an empty child list is the only branch a document cannot
# produce.
RENDER_CASES: list[tuple[str, str, dict[str, Any]]] = [
    (
        "emphasis with one text child",
        "emphasis",
        {"type": "emphasis", "children": [{"type": "text", "raw": "a"}]},
    ),
    ("emphasis with no children", "emphasis", {"type": "emphasis", "children": []}),
    ("emphasis with a missing children key", "emphasis", {"type": "emphasis"}),
    (
        "strong with one text child",
        "strong",
        {"type": "strong", "children": [{"type": "text", "raw": "a"}]},
    ),
    ("strong with no children", "strong", {"type": "strong", "children": []}),
    ("strong with a missing children key", "strong", {"type": "strong"}),
    (
        "emphasis text is interpolated raw",
        "emphasis",
        {"type": "emphasis", "children": [{"type": "text", "raw": "a < b & c"}]},
    ),
]


def _tracked_markdown() -> tuple[mistune.Markdown, set[str]]:
    """A markdown instance that records every inline rule its methods dispatch.

    `parse_method` and `precedence_scan` both go through `_methods`, so wrapping
    that table catches the rules the precedence scan reaches too.
    """
    md = mistune.create_markdown(renderer=_GutenbergRenderer())
    seen: set[str] = set()

    def wrap(name: str, func: Any) -> Any:
        def tracked(m: Any, state: Any) -> Any:
            seen.add(name)
            return func(m, state)

        return tracked

    md.inline._methods = {
        name: wrap(name, func) for name, func in md.inline._methods.items()
    }
    return md, seen


def _unported(markdown: str) -> set[str]:
    md, seen = _tracked_markdown()
    try:
        md(markdown)
    except AttributeError:
        # `_GutenbergRenderer` has no `inline_html` method. The parse that
        # matters already happened by the time the renderer raises.
        pass
    return seen - PORTED_INLINE_RULES


def main() -> None:
    frontmatter = re.compile(r"^---\s*\n.*?\n---\s*\n", re.DOTALL)

    html_cases = []
    raised = 0
    for name, markdown in HTML_CASES:
        blocker = _unported(frontmatter.sub("", markdown).strip())
        if blocker:
            raise SystemExit(
                f"{name!r} reaches unported inline rules {sorted(blocker)}"
            )
        case: dict[str, Any] = {"name": name, "markdown": markdown}
        try:
            case["html"] = markdown_to_wp_html(markdown)
        except AttributeError as exc:
            case["error"] = {"type": type(exc).__name__, "message": str(exc)}
            raised += 1
        html_cases.append(case)

    md = mistune.create_markdown(renderer=_GutenbergRenderer())
    token_cases = []
    for name, src in TOKEN_CASES:
        blocker = _unported(src)
        if blocker:
            raise SystemExit(
                f"{name!r} reaches unported inline rules {sorted(blocker)}"
            )
        token_cases.append({"name": name, "src": src, "tokens": md.inline(src, {})})

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
        "generated_by": "api/scripts/export_wp_html_inline_emphasis_parity.py",
        "source": "api/src/services/wp_html.py::markdown_to_wp_html",
        "token_source": "mistune.InlineParser.__call__",
        "mistune_version": mistune.__version__,
        "scope": (
            "the inline emphasis rule, the emphasis and strong renderer methods "
            "and precedence_scan"
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
