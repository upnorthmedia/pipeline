"""Export the list parity oracle for `markdown_to_wp_html`.

Ledger item 5.3c-iii-b-1-b-ii-2. `list` is the only mistune rule that lives in
its own module, and the reason is that almost none of its behaviour is visible
in `api/src/services/wp_html.py`'s three-line renderer. `parse_list` computes a
continuation width from the first item's text, compiles a fresh break scanner
per item out of six other block patterns (with their `{0,3}` indent budgets
rewritten down to the item's own leading width), and decides tightness by
looking at the tokens the *child* parse produced. A tight list renders its item
bodies as `block_text`, which emits no paragraph wrapper at all, so getting the
tight/loose rule wrong changes the published HTML without changing the text.

So the port is verified by replaying the real function rather than by reading
it. Every case below is deliberately written without reference links, raw HTML
and inline markup, since those rules are ledger items -ii-3 and -b-iii and get
their own oracles.

Usage:
    uv run python scripts/export_wp_html_list_parity.py
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
    / "wp-html-list-parity.json"
)

CASES: list[tuple[str, str]] = [
    # Markers and their renderers.
    ("dash bullet list", "- one\n- two\n"),
    ("star bullet list", "* one\n* two\n"),
    ("plus bullet list", "+ one\n+ two\n"),
    ("single item list", "- only\n"),
    ("ordered list with dots", "1. one\n2. two\n"),
    ("ordered list with parens", "1) one\n2) two\n"),
    ("ordered list numbered out of sequence", "1. one\n1. two\n1. three\n"),
    ("ordered list starting at three", "3. three\n4. four\n"),
    ("ordered list starting at zero", "0. zero\n1. one\n"),
    ("ordered list with a nine digit start", "999999999. big\n"),
    ("marker change starts a second list", "- one\n+ two\n"),
    ("ordered marker change starts a second list", "1. one\n1) two\n"),
    ("bullet then ordered", "- one\n1. two\n"),
    # Item text shapes.
    ("item with no text", "-\n"),
    ("item with only spaces after the marker", "-   \n"),
    ("empty item between two full ones", "- one\n-\n- three\n"),
    ("item with a tab after the marker", "-\titem\n"),
    ("item with two spaces after the marker", "-  item\n"),
    ("item with four spaces after the marker", "-    item\n"),
    ("item with five spaces after the marker", "-     item\n"),
    ("item with six spaces after the marker", "-      item\n"),
    ("item text holding an ampersand", "- Tom & Jerry\n"),
    ("item text holding a hash", "- item # here\n"),
    # Indentation of the marker itself.
    ("list indented one space", " - one\n - two\n"),
    ("list indented three spaces", "   - one\n   - two\n"),
    ("list indented four spaces", "    - one\n"),
    ("list indented four spaces after a paragraph", "Para.\n\n    - one\n"),
    ("items at different indents", "- one\n  - two\n"),
    ("second item outdented", "  - one\n- two\n"),
    # Continuation lines.
    ("item with a lazy continuation line", "- one\ntwo\n"),
    ("item with an indented continuation line", "- one\n  two\n"),
    ("item with an over indented continuation line", "- one\n      two\n"),
    ("two items each with a continuation", "- one\n  more\n- two\n  more\n"),
    ("continuation line with a hard break", "- one  \n  two\n"),
    ("ordered item with a continuation line", "1. one\n   two\n"),
    # Tight and loose.
    ("loose list from a blank line between items", "- one\n\n- two\n"),
    ("loose list from two paragraphs in one item", "- one\n\n  two\n"),
    ("tight list then a paragraph", "- one\n- two\n\nAfter.\n"),
    ("blank line inside an item then another item", "- one\n\n  more\n- two\n"),
    ("trailing blank line after a tight list", "- one\n- two\n\n"),
    ("item beginning with a blank line", "-\n  one\n"),
    ("item beginning with two blank lines", "-\n\n  one\n"),
    # Nesting.
    ("bullet list nested in a bullet list", "- one\n  - nested\n"),
    ("ordered list nested in a bullet list", "- one\n  1. nested\n"),
    ("bullet list nested in an ordered list", "1. one\n   - nested\n"),
    ("three levels of nesting", "- a\n  - b\n    - c\n"),
    ("nested list then a sibling item", "- one\n  - nested\n- two\n"),
    (
        "seven levels of nesting",
        "- a\n  - b\n    - c\n      - d\n        - e\n          - f\n            - g\n",
    ),
    ("loose outer list with a tight inner one", "- one\n  - nested\n\n- two\n"),
    # Other blocks inside an item.
    ("heading inside an item", "- one\n  ## Title\n"),
    ("thematic break inside an item", "- one\n  ***\n"),
    ("fenced code inside an item", "- one\n  ```\n  code\n  ```\n"),
    ("indented code inside an item", "- one\n\n      code\n"),
    ("block quote inside an item", "- one\n  > quoted\n"),
    ("item whose text is indented code", "-     code\n"),
    ("setext underline inside an item", "- one\n  ===\n"),
    # Blocks that break out of an item.
    ("thematic break after a list", "- one\n***\n"),
    ("dash thematic break after a list", "- one\n---\n"),
    ("fenced code after a list", "- one\n```\ncode\n```\n"),
    ("heading after a list", "- one\n## Title\n"),
    ("quote after a list", "- one\n> quoted\n"),
    ("blank line then heading after a list", "- one\n\n## Title\n"),
    # Precedence against the other rules.
    ("three spaced dashes are a thematic break", "- - -\n"),
    ("three spaced stars are a thematic break", "* * *\n"),
    ("dash dash is a setext underline", "Para.\n--\n"),
    ("dash under a paragraph with text after it", "Para.\n- item\n"),
    ("ordered one interrupts a paragraph", "Para.\n1. item\n"),
    ("ordered three does not interrupt a paragraph", "Para.\n3. item\n"),
    ("empty item does not interrupt a paragraph", "Para.\n-\n"),
    ("list directly after a quote", "> quoted\n- item\n"),
    ("list inside a quote", "> - one\n> - two\n"),
    ("list inside a quote with a lazy item", "> - one\n- two\n"),
    # Whole document shapes.
    ("paragraph, list, paragraph", "Before.\n\n- one\n- two\n\nAfter.\n"),
    ("two lists separated by a paragraph", "- one\n\nMid.\n\n- two\n"),
    ("list at the end with no trailing newline", "- one\n- two"),
    ("list with trailing spaces on the marker line", "- one   \n- two\n"),
    ("list after a heading", "## Title\n\n- one\n- two\n"),
    ("list holding a line that looks like frontmatter", "- ---\n"),
    # The break scanner's rewritten indent budget. A one character marker gives
    # a leading width of one, which narrows every break pattern's `{0,3}` to
    # `{0,1}` for that item only.
    ("second item indented one space", "- one\n - two\n"),
    ("heading indented one space under an item", "- one\n # Title\n"),
    ("heading indented two spaces under an item", "- one\n  # Title\n"),
    ("heading indented three spaces under an item", "- one\n   # Title\n"),
    ("quote indented one space under an item", "- one\n > quoted\n"),
    ("thematic break indented one space under an item", "- one\n ***\n"),
    ("two digit ordered markers", "10. ten\n11. eleven\n"),
    ("three digit ordered marker with a nested list", "100) hundred\n     - nested\n"),
    ("nested list indented four spaces", "- one\n    - nested\n"),
    ("ordered item indented two spaces", "1. one\n  2. two\n"),
    # Tabs, which `expand_leading_tab` and `_clean_list_item_text` both touch.
    ("item with a tab continuation line", "- one\n\ttwo\n"),
    ("tab after the marker and a tab continuation", "-\tone\n\ttwo\n"),
    ("ordered item with a tab after the marker", "1.\tone\n"),
    # More tight and loose shapes.
    ("two blank lines between items", "- a\n\n\n- b\n"),
    ("blank line holding spaces inside an item", "- one\n  \n  two\n"),
    ("three loose items", "* one\n\n* two\n\n* three\n"),
    ("blank line before the last ordered item", "1. one\n2. two\n\n3. three\n"),
    ("nested list with two items then a sibling", "- one\n  - a\n  - b\n- two\n"),
    # Items whose text is itself another block's opener.
    ("item whose text is a thematic break", "- ***\n"),
    ("item whose text is a heading", "- # Title\n"),
    ("item whose text is a quote", "- > quoted\n"),
    ("item whose text is a fence", "- ```\n  code\n  ```\n"),
    ("setext underline under an indented item body", "- one\n  ---\n"),
    ("thematic break between two items", "- one\n---\n- two\n"),
    ("quote spanning two lines inside an item", "- one\n  > quoted\n  > more\n"),
    ("list then blank then quote inside a quote", "> - one\n> - two\n>\n> after\n"),
    # The only inputs where the rewritten indent budget is observable. It only
    # bites for a line indented wider than the marker but narrower than the
    # item's continuation width, which needs more than one space after the
    # marker: at one space the two budgets agree on everything the scanner ever
    # sees, because anything indented two or more is a continuation line.
    ("heading indented two, marker plus three", "-   one\n  # Title\n"),
    ("heading indented three, marker plus three", "-   one\n   # Title\n"),
    ("break indented two, marker plus three", "-   one\n  ***\n"),
    ("quote indented two, marker plus three", "-   one\n  > quoted\n"),
    ("fence indented two, marker plus three", "-   one\n  ```\n  code\n  ```\n"),
    ("sibling indented two, marker plus three", "-   one\n  - two\n"),
    ("heading indented two, marker plus two", "-  one\n  # Title\n"),
    ("heading indented three, ordered marker plus three", "1.   one\n   # Title\n"),
    ("break indented three, ordered marker plus three", "1.   one\n   ***\n"),
]


def main() -> None:
    cases = [
        {"name": name, "markdown": markdown, "html": markdown_to_wp_html(markdown)}
        for name, markdown in CASES
    ]
    payload = {
        "generated_by": "api/scripts/export_wp_html_list_parity.py",
        "source": "api/src/services/wp_html.py::markdown_to_wp_html",
        "mistune_version": mistune.__version__,
        "scope": (
            "lists: the per-item break scanner, the continuation width, the "
            "tight/loose rule, the nesting depth and the list/thematic_break and "
            "list/setext precedence cases"
        ),
        "cases": cases,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(cases)} cases to {OUT}")


if __name__ == "__main__":
    main()
