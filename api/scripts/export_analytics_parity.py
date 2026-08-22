"""Export the parity oracle the TypeScript `compute_analytics` port needs.

`api/src/services/analytics.py` turns a draft into the numbers the edit stage
prints into its prompt: word count, Flesch reading ease, average sentence
length, keyword density and the SEO checklist. Every one of those lands in the
rendered prompt as a literal, so the TypeScript port has to agree with Python
digit for digit, and the places where the two languages disagree are not the
arithmetic but the primitives underneath it:

* `round()` is round-half-to-even over the exact binary value of the double,
  where JavaScript's `Math.round` is half-up and `toFixed` breaks ties away
  from zero,
* `re.MULTILINE`'s `^` only matches after `\\n`, where JavaScript's `m` flag
  also matches after `\\r`, `U+2028` and `U+2029`,
* `.` excludes `\\n` in Python and additionally excludes `\\r`, `U+2028` and
  `U+2029` in JavaScript,
* `str.split()` and `str.strip()` use Python's whitespace class, not
  JavaScript's.

The golden fixtures pin the real-draft numbers on their own (their rendered
edit prompts carry them as literals), so this file exists for the cases the
fixtures cannot reach: empty input, code fences, frontmatter, link
classification, `\\r\\n` line endings, line separators JavaScript treats as
newlines and Python does not, and exact rounding ties.

Usage:
    uv run python scripts/export_analytics_parity.py
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path
from urllib.parse import urlparse

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "api"))

from src.services.analytics import (  # noqa: E402
    _strip_markdown,
    compute_analytics,
)

OUT = (
    REPO_ROOT
    / "web"
    / "src"
    / "mastra"
    / "analytics"
    / "data"
    / "analytics-parity.json"
)
GOLDEN = REPO_ROOT / "docs" / "mastra-port" / "golden"


def _unwrap_fence(content: str) -> str:
    """The two substitutions `compute_analytics` runs before `_strip_markdown`."""
    import re

    content = re.sub(r"^```(?:markdown|md)?\s*\n", "", content.strip())
    return re.sub(r"\n```\s*$", "", content)


def case(name: str, content: str, **kwargs: object) -> dict:
    args = {
        "content": content,
        "primary_keyword": kwargs.get("primary_keyword", ""),
        "secondary_keywords": kwargs.get("secondary_keywords", []),
        "title": kwargs.get("title", ""),
        "website_url": kwargs.get("website_url", ""),
    }
    analytics = compute_analytics(**args)  # type: ignore[arg-type]
    return {
        "name": name,
        "args": args,
        "plain": _strip_markdown(_unwrap_fence(content)) if content else "",
        "expected": asdict(analytics),
    }


def golden_cases() -> list[dict]:
    """The two captured drafts and the two captured edit outputs."""
    out: list[dict] = []
    for slug in sorted(p.name for p in GOLDEN.iterdir() if p.is_dir()):
        edit = json.loads((GOLDEN / slug / "edit.json").read_text())
        state = edit["state_input"]
        keywords = state.get("related_keywords") or []
        common = {
            "primary_keyword": keywords[0] if keywords else "",
            "secondary_keywords": keywords[1:],
            "title": state.get("topic", ""),
            "website_url": state.get("website_url", ""),
        }
        out.append(case(f"golden:{slug}:draft", state["draft"], **common))
        out.append(
            case(
                f"golden:{slug}:edit-output", edit["stage_output"]["final_md"], **common
            )
        )
    return out


LINKS_DOC = """---
title: Link classification
description: has a meta description
---

# Heading one

Body copy with an [internal link](/pricing) and an [anchor](#section) and a
[same-domain absolute](https://example.com/blog/post) plus an
[external](https://other.example.org/page) and an
![image](https://cdn.example.net/a.png).

## Second heading

More copy.
"""

CRLF_DOC = "# Title\r\n\r\n## A heading\r\n\r\nBody one.\r\nBody two.\r\n"

# `\r`, `U+2028` and `U+2029` all start a new line to JavaScript's `m` flag and
# none of them does to Python's `re.MULTILINE`, so every marker after one of
# them must survive `_strip_markdown` and must not register as a heading.
SEPARATOR_DOC = (
    "Intro paragraph.\n\n## Real heading\n\n"
    "Carriage return\r## not a heading in Python\n"
    "Line separator\u2028## also not a heading\n"
    "Paragraph separator\u2029> not a blockquote\n"
    "Bare return\rdescription: not a meta description\n\n"
    "## Another real heading\n\nEnd of the document.\n"
)

FENCED_DOC = """```markdown
# Fenced title

Some body copy that lives inside an outer markdown fence.

```
"""

MARKUP_DOC = """# Title with **bold** and _italic_

> A blockquote line.

Inline `code_span` here and a block:

```python
print("hello")
```

<div class="raw">HTML block</div>

Trailing paragraph.
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()

    cases: list[dict] = [
        case("empty", ""),
        case("whitespace-only", "   \n\n  "),
        case("single-sentence", "The cat sat on the mat."),
        case("fenced-markdown", FENCED_DOC),
        case(
            "links-and-frontmatter",
            LINKS_DOC,
            primary_keyword="link classification",
            title="Link classification guide",
            website_url="https://example.com",
        ),
        case("links-no-website-url", LINKS_DOC, primary_keyword="heading"),
        case(
            "links-bare-domain-website-url",
            LINKS_DOC,
            primary_keyword="heading",
            website_url="example.com",
        ),
        case(
            "crlf-line-endings", CRLF_DOC, primary_keyword="heading", title="A Heading"
        ),
        case("unicode-line-separators", SEPARATOR_DOC, primary_keyword="real heading"),
        case("markup-stripping", MARKUP_DOC, primary_keyword="title"),
        case(
            "python-whitespace-classes",
            "Alpha\x85beta gamma.\x1cDelta epsilon zeta. Eta theta iota.",
            primary_keyword="beta gamma",
        ),
        case(
            "multi-word-keyword-density",
            "small business crm " * 40 + "and then some other words entirely.",
            primary_keyword="small business crm",
            secondary_keywords=["other words", "missing phrase", ""],
            title="Small Business CRM",
            website_url="https://example.com",
        ),
        case(
            "keyword-in-h2-and-first-100",
            "# Small Business CRM\n\nsmall business crm opens the article.\n\n"
            "## Choosing a small business crm\n\nBody.\n",
            primary_keyword="small business crm",
            title="Small Business CRM",
        ),
        *golden_cases(),
    ]

    # `round()` ties: a double is an exact tie at `n` decimals only when it is
    # `odd / 2**k` with `k <= n + 1`, so these are the values where Python's
    # round-half-to-even and JavaScript's `toFixed` disagree, plus ordinary
    # values either side of them.
    round_inputs = [
        0.125,
        0.375,
        0.625,
        0.875,
        1.125,
        2.675,
        2.665,
        0.005,
        0.015,
        0.025,
        20.25,
        20.75,
        21.25,
        2.5,
        3.5,
        -0.125,
        -20.25,
        47.75,
        65.749,
        65.75,
        0.0,
        100.0,
        1234.5678,
        1 / 3,
        2 / 3,
        206.835 - 1.015 * 15.1,
    ]
    round_cases = [
        {"value": value, "ndigits": ndigits, "expected": round(value, ndigits)}
        for value in round_inputs
        for ndigits in (1, 2)
    ]

    # `_seo_checklist` classifies a link by whether the profile's domain is a
    # substring of `urlparse(url).netloc`, so the port needs Python's parse and
    # not a permissive one: a bare host with no `//` has no netloc at all.
    netloc_inputs = [
        "https://example.com",
        "https://example.com/blog/post",
        "http://sub.example.com:8443/x?y=1#z",
        "example.com",
        "example.com/blog/post",
        "//example.com/path",
        "/relative/path",
        "#anchor",
        "mailto:someone@example.com",
        "HTTPS://Example.COM/Path",
        "  https://example.com/padded  ",
        "https://user:pw@example.com/path",
        "not a scheme:https://example.com",
        "ht!tp://example.com",
        "https://example.com?query",
        "https://example.com#frag",
        "",
    ]
    netloc_cases = [
        {"url": url, "expected": urlparse(url).netloc} for url in netloc_inputs
    ]

    payload = {
        "generated_by": "api/scripts/export_analytics_parity.py",
        "source": "api/src/services/analytics.py",
        "python_version": sys.version.split()[0],
        "round_cases": round_cases,
        "netloc_cases": netloc_cases,
        "cases": cases,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(
        f"wrote {args.out.relative_to(REPO_ROOT)}: {len(cases)} cases, "
        f"{len(round_cases)} round cases, {len(netloc_cases)} netloc cases"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
