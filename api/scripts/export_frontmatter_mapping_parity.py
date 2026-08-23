"""Export the parity oracle for `apply_frontmatter_mapping`.

`api/src/services/frontmatter_mapping.py` is the transform the Next.js publish
hook runs over a post's YAML frontmatter before it signs and ships the payload
(ledger item 5.3c-iii-b-2-a). Thirty lines of it are `isinstance` checks, `in`
versus `.get`, and `is not None` versus truthiness, and each of those reads as
the same thing in JavaScript while behaving differently, so the real function is
run over inputs chosen to separate them and its answers recorded.

Both the mapping and the frontmatter arrive as pair lists rather than JSON
objects, and so does the result: `__proto__` is an ordinary dict key in Python
and does not survive a round trip through a JavaScript object literal, and the
result's keys are not all strings, because `target.get("key", jena_field)`
hands back whatever the mapping stored there.

Usage:
    uv run python scripts/export_frontmatter_mapping_parity.py
"""

from __future__ import annotations

import inspect
import json
from pathlib import Path
from typing import Any

from src.services.frontmatter_mapping import apply_frontmatter_mapping

OUT = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "src"
    / "mastra"
    / "nextjs"
    / "data"
    / "nextjs-frontmatter-mapping-parity.json"
)

# The lines the port is a transcription of. If any of them changes shape the
# recorded answers describe a function that no longer exists, so fail loudly
# rather than write a stale oracle.
REQUIRED_SOURCE_LINES = [
    "for jena_field, target in mapping.items():",
    "if isinstance(target, str):",
    "if jena_field in jena_frontmatter:",
    "result[target] = jena_frontmatter[jena_field]",
    "elif isinstance(target, dict):",
    'key = target.get("key", jena_field)',
    'transform = target.get("transform")',
    'default = target.get("default")',
    "value = jena_frontmatter.get(jena_field)",
    "if value is None and default is not None:",
    "result[key] = default",
    "if value is None:",
    'if transform == "array" and not isinstance(value, list):',
    "value = [value]",
    "result[key] = value",
]

Pairs = list[tuple[str, Any]]

# (name, frontmatter pairs, mapping pairs)
CASES: list[tuple[str, Pairs, Pairs]] = [
    # --- the `isinstance(target, str)` branch -----------------------------
    ("str target, field present", [("title", "My Post")], [("title", "title")]),
    ("str target, field absent", [], [("title", "title")]),
    (
        "str target, field present holding null",
        [("title", None)],
        [("title", "title")],
    ),
    ("str target, field holding an empty string", [("title", "")], [("title", "t")]),
    ("str target, field holding false", [("draft", False)], [("draft", "draft")]),
    ("str target, field holding zero", [("weight", 0)], [("weight", "weight")]),
    ("str target, field holding a list", [("tags", ["a", "b"])], [("tags", "tags")]),
    (
        "str target, field holding an object",
        [("author", {"name": "Cody"})],
        [("author", "author")],
    ),
    (
        "str target renames the field",
        [("description", "d")],
        [("description", "excerpt")],
    ),
    ("empty string target", [("title", "My Post")], [("title", "")]),
    (
        "two fields collapse onto one target, the last wins",
        [("title", "first"), ("heading", "second")],
        [("title", "t"), ("heading", "t")],
    ),
    (
        "two fields collapse onto one target, the last is absent",
        [("title", "first")],
        [("title", "t"), ("heading", "t")],
    ),
    (
        "mapping order is the result order",
        [("b", 2), ("a", 1)],
        [("b", "b"), ("a", "a")],
    ),
    (
        "__proto__ is an ordinary source field",
        [("__proto__", "polluted")],
        [("__proto__", "safe")],
    ),
    (
        "__proto__ is an ordinary target key",
        [("title", "My Post")],
        [("title", "__proto__")],
    ),
    (
        "a target that is a string of digits",
        [("title", "My Post"), ("description", "d")],
        [("title", "10"), ("description", "2")],
    ),
    # --- the `isinstance(target, dict)` branch ----------------------------
    (
        "dict target with an explicit key",
        [("title", "My Post")],
        [("title", {"key": "heading"})],
    ),
    (
        "dict target with no key falls back to the source field",
        [("title", "My Post")],
        [("title", {"transform": None})],
    ),
    (
        "dict target whose key is stored as null",
        [("title", "My Post")],
        [("title", {"key": None})],
    ),
    (
        "dict target whose key is a number",
        [("title", "My Post")],
        [("title", {"key": 5})],
    ),
    (
        "dict target whose key is true, beside one whose key is 1",
        [("a", "first"), ("b", "second")],
        [("a", {"key": 1}), ("b", {"key": True})],
    ),
    (
        "dict target whose key is a list",
        [("title", "My Post")],
        [("title", {"key": ["a"]})],
    ),
    (
        "dict target whose key is an object",
        [("title", "My Post")],
        [("title", {"key": {"name": "heading"}})],
    ),
    (
        "dict target, source field absent, no default",
        [],
        [("author", {"key": "author"})],
    ),
    (
        "dict target, source field present holding null, no default",
        [("author", None)],
        [("author", {"key": "author"})],
    ),
    (
        "dict target, source field absent, default present",
        [],
        [("author", {"key": "author", "default": "Cody"})],
    ),
    (
        "dict target, source field present holding null, default present",
        [("author", None)],
        [("author", {"key": "author", "default": "Cody"})],
    ),
    (
        "dict target, source field present, default ignored",
        [("author", "Real")],
        [("author", {"key": "author", "default": "Cody"})],
    ),
    (
        "dict target, default stored as null",
        [],
        [("author", {"key": "author", "default": None})],
    ),
    (
        "dict target, default is false",
        [],
        [("draft", {"key": "draft", "default": False})],
    ),
    ("dict target, default is zero", [], [("weight", {"key": "w", "default": 0})]),
    (
        "dict target, default is an empty string",
        [],
        [("author", {"key": "author", "default": ""})],
    ),
    (
        "dict target, default is an empty list",
        [],
        [("tags", {"key": "tags", "default": []})],
    ),
    (
        "dict target, source field holds false so the default is not reached",
        [("draft", False)],
        [("draft", {"key": "draft", "default": True})],
    ),
    (
        "dict target, source field holds an empty string",
        [("author", "")],
        [("author", {"key": "author", "default": "Cody"})],
    ),
    # --- the array transform ----------------------------------------------
    (
        "array transform wraps a scalar",
        [("category", "Tech")],
        [("category", {"key": "categories", "transform": "array"})],
    ),
    (
        "array transform leaves a list alone",
        [("category", ["Tech", "AI"])],
        [("category", {"key": "categories", "transform": "array"})],
    ),
    (
        "array transform wraps an empty string",
        [("category", "")],
        [("category", {"key": "categories", "transform": "array"})],
    ),
    (
        "array transform wraps an object",
        [("category", {"name": "Tech"})],
        [("category", {"key": "categories", "transform": "array"})],
    ),
    (
        "array transform leaves an empty list alone",
        [("category", [])],
        [("category", {"key": "categories", "transform": "array"})],
    ),
    (
        "array transform does not reach a default",
        [],
        [("category", {"key": "c", "transform": "array", "default": "Tech"})],
    ),
    (
        "array transform is case sensitive",
        [("category", "Tech")],
        [("category", {"key": "c", "transform": "Array"})],
    ),
    (
        "an unrecognised transform is a passthrough",
        [("image", "https://cdn.example.com/hero.webp")],
        [("image", {"key": "image", "transform": "jena-cdn-url"})],
    ),
    (
        "a transform stored as null is a passthrough",
        [("category", "Tech")],
        [("category", {"key": "c", "transform": None})],
    ),
    (
        "a transform stored as a list is a passthrough",
        [("category", "Tech")],
        [("category", {"key": "c", "transform": ["array"]})],
    ),
    (
        "unrecognised target fields are ignored",
        [("title", "My Post")],
        [("title", {"key": "t", "when": "always", "": "x"})],
    ),
    # --- targets that are neither a str nor a dict ------------------------
    ("target is null", [("title", "My Post")], [("title", None)]),
    ("target is a list", [("title", "My Post")], [("title", ["title"])]),
    ("target is a number", [("title", "My Post")], [("title", 7)]),
    ("target is true", [("title", "My Post")], [("title", True)]),
    (
        "a skipped target does not stop the fields after it",
        [("title", "My Post"), ("description", "d")],
        [("title", None), ("description", "description")],
    ),
    # --- degenerate shapes -------------------------------------------------
    ("empty mapping", [("title", "My Post")], []),
    ("empty frontmatter", [], [("title", "title"), ("description", "description")]),
    ("both empty", [], []),
    (
        "a realistic astro mapping",
        [
            ("title", "Ship Restrict"),
            ("description", "A description"),
            ("category", "Tech"),
            ("date", "2026-08-23"),
        ],
        [
            ("title", "title"),
            ("description", "excerpt"),
            ("category", {"key": "tags", "transform": "array"}),
            ("author", {"key": "author", "default": "Jena AI"}),
            ("date", {"key": "pubDate"}),
        ],
    ),
]


def encode_key(key: Any) -> dict[str, Any]:
    """Record a result key with its Python type, which JSON alone would lose."""
    if key is None:
        return {"type": "None", "value": None}
    if isinstance(key, bool):
        return {"type": "bool", "value": key}
    if isinstance(key, str):
        return {"type": "str", "value": key}
    if isinstance(key, int):
        return {"type": "int", "value": key}
    raise AssertionError(f"unexpected result key type: {type(key).__name__}")


def main() -> None:
    source = inspect.getsource(apply_frontmatter_mapping)
    for line in REQUIRED_SOURCE_LINES:
        assert line in source, f"apply_frontmatter_mapping no longer contains: {line}"

    cases = []
    seen: set[str] = set()
    for name, frontmatter_pairs, mapping_pairs in CASES:
        assert name not in seen, f"duplicate case name: {name}"
        seen.add(name)
        frontmatter = dict(frontmatter_pairs)
        mapping = dict(mapping_pairs)
        assert len(frontmatter) == len(frontmatter_pairs), name
        assert len(mapping) == len(mapping_pairs), name

        record: dict[str, Any] = {
            "name": name,
            "frontmatter": [[k, v] for k, v in frontmatter_pairs],
            "mapping": [[k, v] for k, v in mapping_pairs],
        }
        try:
            result = apply_frontmatter_mapping(frontmatter, mapping)
        except TypeError as exc:
            # `result[key] = ...` with an unhashable key raises out of the
            # publish hook, which does not catch it. Recorded rather than
            # dropped, because a port that quietly stringifies the key would
            # publish a post Python refused to publish.
            record["result"] = None
            record["error"] = {"type": type(exc).__name__, "message": str(exc)}
        else:
            record["result"] = [[encode_key(k), v] for k, v in result.items()]
        cases.append(record)

    payload = {"source": source, "cases": cases}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    nonempty = sum(1 for case in cases if case["result"])
    errors = sum(1 for case in cases if case.get("error"))
    print(
        f"wrote {len(cases)} cases to {OUT} "
        f"({nonempty} with a non-empty result, {errors} raising)"
    )


if __name__ == "__main__":
    main()
