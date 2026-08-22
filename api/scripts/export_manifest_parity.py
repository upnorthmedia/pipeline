"""Export the parity oracle the TypeScript `_parse_manifest` port needs.

`api/src/pipeline/stages/images.py::_parse_manifest` is the only thing standing
between Claude's prose-wrapped answer and the `image_manifest` JSONB column, so
the TypeScript port has to agree with it on every input, not just on the happy
path the golden fixtures happen to cover. The disagreements are in the
primitives rather than the control flow:

* `str.strip()` uses Python's whitespace class, which omits `\\ufeff` and
  includes `\\x1c`-`\\x1f` and `\\x85`, where JavaScript's `String.trim()` does
  the reverse,
* `\\s` inside the fenced-block pattern is that same Python class,
* `.` under `re.DOTALL` matches every character, which in JavaScript is
  `[\\s\\S]` rather than `.`,
* `json.loads` accepts the `NaN`, `Infinity` and `-Infinity` literals that
  `JSON.parse` rejects.

Both golden fixtures captured a bare-JSON manifest, so every fenced, prose-
wrapped and unparseable branch below is reachable in production but absent from
them. That is what this corpus is for.

Cases whose Python result is not representable as strict JSON are exported
under `divergences` instead of `cases`, with the Python `repr` recorded, so the
port can assert the divergence rather than quietly inherit it.

Usage:
    uv run python scripts/export_manifest_parity.py
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "api"))

from src.pipeline.stages.images import _parse_manifest  # noqa: E402

OUT = REPO_ROOT / "web" / "src" / "mastra" / "images" / "data" / "manifest-parity.json"
GOLDEN = REPO_ROOT / "docs" / "mastra-port" / "golden"

MANIFEST = (
    '{"images": [{"filename": "a.png", "prompt": "p"}], '
    '"style_brief": {"palette": "warm"}}'
)


def _golden_cases() -> list[dict]:
    """The two real Claude manifest responses, straight off the wire."""
    cases: list[dict] = []
    for path in sorted(GOLDEN.glob("*/images.json")):
        fixture = json.loads(path.read_text())
        anthropic = [
            c for c in fixture["provider_calls"] if c["provider"] == "anthropic"
        ]
        if not anthropic:
            continue
        content = anthropic[0]["response"]["content"]
        text = "".join(b.get("text", "") for b in content if b.get("type") == "text")
        cases.append(
            {
                "name": f"golden/{path.parent.name}",
                "why": "the raw Claude manifest response the capture recorded",
                "input": text,
            }
        )
    return cases


def _synthetic_cases() -> list[dict]:
    return [
        {
            "name": "bare json",
            "why": "the branch both golden fixtures took",
            "input": MANIFEST,
        },
        {
            "name": "fenced json with trailing commentary",
            "why": "the reason the fenced pattern is preferred over the whole response",
            "input": (
                f"Here is the manifest:\n\n```json\n{MANIFEST}\n```\n\n"
                "Let me know if you want different placements."
            ),
        },
        {
            "name": "fenced block with no language tag",
            "why": "`(?:json)?` is optional",
            "input": f"```\n{MANIFEST}\n```",
        },
        {
            "name": "two fenced blocks",
            "why": "`search` takes the first match, so the second block is ignored",
            "input": (
                f"```json\n{MANIFEST}\n```\n\n"
                '```json\n{"images": [], "note": "second"}\n```'
            ),
        },
        {
            "name": "blank lines between the fence and the json",
            "why": "`\\s*\\n` is greedy and backtracks to the last newline",
            "input": f"```json\n\n\n{MANIFEST}\n```",
        },
        {
            "name": "trailing spaces after the language tag",
            "why": "`\\s*` swallows the run before the newline",
            "input": f"```json   \n{MANIFEST}\n```",
        },
        {
            "name": "unterminated fence",
            "why": "no fenced match, so the `startswith` line filter runs instead",
            "input": f"```json\n{MANIFEST}",
        },
        {
            "name": "unterminated fence with indented closing marker",
            "why": (
                "the closing marker must follow a newline directly, so this is the "
                "line-filter branch"
            ),
            "input": f"```json\n{MANIFEST}\n  ```",
        },
        {
            "name": "line filter drops indented fence markers",
            "why": "the filter strips each line before testing it",
            "input": f"```json\n{MANIFEST}\n   ```json\nignored",
        },
        {
            "name": "pretty printed fenced json with braces in the trailing prose",
            "why": (
                "the fence body spans newlines, and the prose braces make the brace "
                "fallback give a different answer"
            ),
            "input": (
                "Here you go:\n\n```json\n"
                '{\n  "images": [],\n  "style_brief": {}\n}\n```\n\n'
                "Note: I skipped {the featured image}."
            ),
        },
        {
            "name": "indented closing fence followed by braces",
            "why": (
                "the line filter strips before testing, and the line it drops carries "
                "a brace the fallback would trip over"
            ),
            "input": '```json\n{"a": 1}\n   ``` {"b": 2}',
        },
        {
            "name": "json embedded in prose",
            "why": "the outermost-braces fallback",
            "input": (
                f"I could not use a code block, sorry. {MANIFEST} That is the manifest."
            ),
        },
        {
            "name": "prose braces around the json",
            "why": "`find`/`rfind` take the outermost pair, not the nearest",
            "input": f"{{ {MANIFEST} }}",
        },
        {
            "name": "fenced block containing prose and json",
            "why": (
                "after the fence match the brace fallback runs on the fence body only"
            ),
            "input": f"```\nSure thing.\n{MANIFEST}\n```",
        },
        {
            "name": "fenced invalid json with valid json outside the fence",
            "why": (
                "the fence body replaces the text, so json after the fence is "
                "unreachable"
            ),
            "input": f"```json\n{{not json}}\n```\n{MANIFEST}",
        },
        {
            "name": "crlf fenced block",
            "why": "`\\r` survives into the fence body as json whitespace",
            "input": f"```json\r\n{MANIFEST}\r\n```",
        },
        {
            "name": "python-only whitespace around the json",
            "why": (
                "`\\x1c` and `\\x85` are stripped by Python and not by String.trim()"
            ),
            "input": f"\x1c\x85 {MANIFEST} \x85\x1c",
        },
        {
            "name": "python-only whitespace around a json array",
            "why": (
                "strip decides the branch here: Python parses it directly, a "
                "String.trim() port finds no brace and falls back"
            ),
            "input": '\x85["a", "b"]\x85',
        },
        {
            "name": "byte order mark before a json scalar",
            "why": (
                "the mirror image: String.trim() would strip it and parse, Python does "
                "not and falls back"
            ),
            "input": '\ufeff"just a string"',
        },
        {
            "name": "python-only whitespace inside the fence header",
            "why": (
                "`\\s` inside the fenced pattern is Python's class, so `\\x1c` keeps "
                "the fence matchable"
            ),
            "input": '```json\x1c\n{"a": 1}\n```\ntrailing {"b": 2}',
        },
        {
            "name": "byte order mark before the json",
            "why": (
                "`\\ufeff` is stripped by String.trim() and not by Python, and "
                "json.loads rejects it"
            ),
            "input": f"﻿{MANIFEST}",
        },
        {
            "name": "non-breaking space around the json",
            "why": "whitespace in both classes, so the strip agrees",
            "input": f" {MANIFEST} ",
        },
        {
            "name": "json array",
            "why": (
                "`json.loads` is not constrained to objects, and the annotation lies"
            ),
            "input": '["a", "b"]',
        },
        {
            "name": "json string scalar",
            "why": "same, for a non-container",
            "input": '"just a string"',
        },
        {
            "name": "duplicate keys",
            "why": "last key wins in both languages",
            "input": '{"images": [], "images": [{"filename": "b.png"}]}',
        },
        {
            "name": "big integer",
            "why": (
                "Python keeps it exact and JavaScript rounds it, which the oracle "
                "normalises"
            ),
            "input": '{"n": 12345678901234567890}',
        },
        {
            "name": "float that is an integer",
            "why": "`1.0` is a float in Python and a number in JavaScript",
            "input": '{"n": 1.0}',
        },
        {
            "name": "literal newline inside a string",
            "why": (
                "a control character both parsers reject, so both fall through to the "
                "fallback"
            ),
            "input": '{"a": "b\nc"}',
        },
        {
            "name": "manifest that already carries an error key",
            "why": (
                "the stage branches on `error`, so it must survive the parse untouched"
            ),
            "input": '{"images": [], "style_brief": {}, "error": "model refused"}',
        },
        {
            "name": "emoji before the json",
            "why": (
                "`find` is code-point indexed in Python and code-unit indexed in "
                "JavaScript"
            ),
            "input": f"\U0001f5bc️ Manifest: {MANIFEST}",
        },
        {
            "name": "braces but not json",
            "why": "the last-resort slice fails and the fallback manifest is returned",
            "input": "I cannot generate images {sorry}.",
        },
        {
            "name": "no braces at all",
            "why": "`find` returns -1",
            "input": "I cannot generate images.",
        },
        {
            "name": "empty string",
            "why": "the degenerate input",
            "input": "",
        },
        {
            "name": "whitespace only",
            "why": "strips to empty",
            "input": "   \n\t  ",
        },
        {
            "name": "closing brace before the opening brace",
            "why": "`end > start` guards the slice",
            "input": "} then {",
        },
    ]


DIVERGENCE_CASES = [
    {
        "name": "NaN literal",
        "why": "`json.loads` accepts it and `JSON.parse` does not",
        "input": '{"images": [], "score": NaN}',
    },
    {
        "name": "Infinity literal",
        "why": "same, for the infinities",
        "input": '{"images": [], "score": -Infinity}',
    },
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()

    cases = []
    for case in _golden_cases() + _synthetic_cases():
        result = _parse_manifest(case["input"])
        cases.append({**case, "expected": json.dumps(result, allow_nan=False)})

    divergences = []
    for case in DIVERGENCE_CASES:
        result = _parse_manifest(case["input"])
        try:
            json.dumps(result, allow_nan=False)
        except ValueError:
            pass
        else:
            raise SystemExit(f"{case['name']} is representable, move it to `cases`")
        divergences.append({**case, "python_repr": repr(result)})

    payload = {
        "generated_by": "api/scripts/export_manifest_parity.py",
        "source": "api/src/pipeline/stages/images.py::_parse_manifest",
        "python_version": sys.version.split()[0],
        "cases": cases,
        "divergences": divergences,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(
        f"wrote {args.out.relative_to(REPO_ROOT)}: {len(cases)} cases, "
        f"{len(divergences)} divergences"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
