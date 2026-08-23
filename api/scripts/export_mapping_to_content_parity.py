"""Export the parity oracle for `_apply_mapping_to_content`.

`api/src/services/nextjs_publish.py` runs a post's markdown through this
function before the payload is built, so what it returns is the frontmatter the
reader's blog repo receives (ledger item 5.3c-iii-b-2-b). Sixteen lines, and
almost all of the behaviour lives inside the two PyYAML calls it makes:

- `yaml.safe_load` resolves YAML 1.1, so `yes`, `1:30`, `0o17`, `2026-08-23`
  and `~` are a bool, a sexagesimal int, an octal int, a `datetime.date` and
  `None`, none of which a YAML 1.2 reader agrees with.
- `yaml.dump(..., default_flow_style=False, allow_unicode=True)` never emits a
  block scalar, folds at column 80, sorts the keys when they are mutually
  comparable and leaves them in insertion order when they are not, and picks
  plain, then single-quoted, then double-quoted style per scalar.

Neither half is a library call the TypeScript port can borrow: js-yaml and the
`yaml` package both prefer block scalars, indent sequences under their key and
resolve YAML 1.2, so the emitted bytes differ. The real function is therefore
run over inputs chosen to reach each of those decisions and its answers are
recorded here.

`content` and the mapping pairs are the two arguments; the mapping arrives from
the `nextjs_frontmatter_map` JSONB column, so its values are JSON, while
`content` is free text. A case records either the returned string or the
exception type and message, because `publish_to_nextjs` catches neither.

Usage:
    uv run python scripts/export_mapping_to_content_parity.py
"""

from __future__ import annotations

import inspect
import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "api"))

from src.services.nextjs_publish import _apply_mapping_to_content  # noqa: E402

OUT = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "src"
    / "mastra"
    / "nextjs"
    / "data"
    / "nextjs-mapping-to-content-parity.json"
)

# The lines the port is a transcription of. If any of them changes shape the
# recorded answers describe a function that no longer exists, so fail loudly
# rather than write a stale oracle.
REQUIRED_SOURCE_LINES = [
    'if not content.startswith("---"):',
    "return content",
    'parts = content.split("---", 2)',
    "if len(parts) < 3:",
    "frontmatter = yaml.safe_load(parts[1]) or {}",
    "mapped = apply_frontmatter_mapping(frontmatter, mapping)",
    "new_frontmatter = yaml.dump(mapped, default_flow_style=False, allow_unicode=True)",
    'return f"---\\n{new_frontmatter}---{parts[2]}"',
]

Pairs = list[tuple[Any, Any]]

BODY = "\n# Heading\n\nBody text.\n"

# An identity mapping over one field: the shortest way to push a loaded value
# straight back out through the emitter.
ONE: Pairs = [("v", "v")]


def fm(body: str) -> str:
    """A document whose frontmatter block is `body`."""
    return f"---\n{body}\n---{BODY}"


# (name, content, mapping pairs)
CASES: list[tuple[str, str, Pairs]] = [
    # --- the two guards ---------------------------------------------------
    ("no leading fence", "# Heading\n\nBody.\n", ONE),
    ("leading fence on a later line", "text\n---\nv: 1\n---\n", ONE),
    ("fence but no closing fence", "---\nv: 1\n", ONE),
    ("exactly the fence", "---", ONE),
    ("fence twice, nothing after", "------", ONE),
    ("fence three times", "---------", ONE),
    ("empty frontmatter block", "---\n---\n", ONE),
    ("frontmatter block is one newline", "---\n\n---\n", ONE),
    ("frontmatter block is blank", "------\n", ONE),
    ("fence run of four dashes", "----\nv: 1\n----\n", ONE),
    ("a third fence stays in the tail", "---\nv: 1\n---\nbody\n---\nmore\n", ONE),
    ("mid-line fence closes the block", "---\nv: 1\n--- inline ---\n", ONE),
    ("no trailing newline after the block", "---\nv: 1\n---", ONE),
    ("tail starts immediately", "---\nv: 1\n---tail", ONE),
    # --- what `yaml.safe_load(...) or {}` returns -------------------------
    ("frontmatter loads to none", "---\n\n---\nbody", ONE),
    ("frontmatter is a comment only", "---\n# just a comment\n---\nbody", ONE),
    ("frontmatter is an empty flow map", "---\n{}\n---\nbody", ONE),
    ("frontmatter is an empty flow list", "---\n[]\n---\nbody", ONE),
    ("frontmatter is a bare scalar string", "---\nhello\n---\nbody", []),
    ("frontmatter is a bare scalar int", "---\n7\n---\nbody", []),
    ("frontmatter is a list", "---\n- a\n- b\n---\nbody", []),
    (
        "frontmatter is a string, str target hits",
        "---\nhello\n---\nbody",
        [("ell", "x")],
    ),
    ("frontmatter is a string, str target misses", "---\nhello\n---\nbody", ONE),
    (
        "frontmatter is a string, dict target",
        "---\nhello\n---\nbody",
        [("v", {"key": "x"})],
    ),
    ("frontmatter is a list, str target hits", "---\n- a\n---\nbody", [("a", "x")]),
    ("frontmatter is an int, str target", "---\n7\n---\nbody", ONE),
    ("frontmatter is invalid yaml", "---\nv: [1, 2\n---\nbody", ONE),
    ("frontmatter has a duplicate key", "---\nv: one\nv: two\n---\nbody", ONE),
    ("frontmatter has a tab indent", "---\nv:\n\t- a\n---\nbody", ONE),
    # --- YAML 1.1 scalar resolution ---------------------------------------
    ("yes resolves to a bool", fm("v: yes"), ONE),
    ("no resolves to a bool", fm("v: no"), ONE),
    ("on resolves to a bool", fm("v: on"), ONE),
    ("off resolves to a bool", fm("v: off"), ONE),
    ("true resolves to a bool", fm("v: true"), ONE),
    ("y is a plain string", fm("v: y"), ONE),
    ("tilde is null", fm("v: ~"), ONE),
    ("bare null keyword", fm("v: null"), ONE),
    ("empty value is null", fm("v:"), ONE),
    ("Null capitalised", fm("v: Null"), ONE),
    ("decimal int", fm("v: 42"), ONE),
    ("negative int", fm("v: -42"), ONE),
    ("int with underscores", fm("v: 1_000"), ONE),
    ("hex int", fm("v: 0x1f"), ONE),
    ("octal int", fm("v: 0o17"), ONE),
    ("yaml 1.1 octal int", fm("v: 017"), ONE),
    ("sexagesimal int", fm("v: 1:30"), ONE),
    ("big int beyond float precision", fm("v: 9007199254740993"), ONE),
    ("float", fm("v: 1.5"), ONE),
    ("float that is integral", fm("v: 1.0"), ONE),
    ("float in exponent form", fm("v: 1e3"), ONE),
    ("negative zero float", fm("v: -0.0"), ONE),
    ("infinity", fm("v: .inf"), ONE),
    ("negative infinity", fm("v: -.inf"), ONE),
    ("not a number", fm("v: .nan"), ONE),
    ("a date", fm("v: 2026-08-23"), ONE),
    ("a datetime with a space", fm("v: 2026-08-23 01:02:03"), ONE),
    ("a datetime in iso form", fm("v: 2026-08-23T01:02:03"), ONE),
    ("a datetime with fractional seconds", fm("v: 2026-08-23T01:02:03.500"), ONE),
    ("a datetime with an offset", fm("v: 2026-08-23T01:02:03+02:00"), ONE),
    ("a datetime in utc", fm("v: 2026-08-23T01:02:03Z"), ONE),
    ("an explicit str tag over a number", fm("v: !!str 5"), ONE),
    ("a quoted number stays a string", fm('v: "5"'), ONE),
    ("a single quoted string", fm("v: 'it''s'"), ONE),
    ("a literal block scalar", fm("v: |\n  line one\n  line two"), ONE),
    ("a folded block scalar", fm("v: >\n  line one\n  line two"), ONE),
    ("a literal block scalar, chomped", fm("v: |-\n  line one\n  line two"), ONE),
    ("a flow sequence", fm("v: [a, b]"), ONE),
    ("a flow mapping", fm("v: {a: 1, b: 2}"), ONE),
    ("a nested block mapping", fm("v:\n  a: 1\n  b:\n    c: 2"), ONE),
    ("a sequence of mappings", fm("v:\n  - a: 1\n  - b: 2"), ONE),
    ("an anchor and an alias inside one value", fm("v:\n  a: &x [1, 2]\n  b: *x"), ONE),
    ("a merge key", fm("base: &b {a: 1}\nv:\n  <<: *b\n  c: 2"), ONE),
    ("a binary value", fm("v: !!binary aGk="), ONE),
    ("a set", fm("v: !!set {a, b}"), ONE),
    ("an omap", fm("v: !!omap\n  - a: 1\n  - b: 2"), ONE),
    ("an unknown tag", fm("v: !custom hi"), ONE),
    ("unicode in a value", fm("v: caf\u00e9 na\u00efve \u2014 \U0001f389"), ONE),
    ("an escaped unicode value", fm('v: "\\u00e9\\u2028"'), ONE),
    # --- the emitter, reached with an identity mapping --------------------
    ("a plain string", fm("v: Hello world"), ONE),
    ("a string with a colon", fm("v: 'Hello: world'"), ONE),
    ("a string with a hash", fm("v: 'tag #1'"), ONE),
    ("a string with an apostrophe", fm("v: it's a test"), ONE),
    ("a string with double quotes", fm('v: say "hi"'), ONE),
    ("an empty string", fm("v: ''"), ONE),
    ("a padded string", fm("v: '  padded  '"), ONE),
    ("a string that looks like a bool", fm("v: 'yes'"), ONE),
    ("a string that looks like a number", fm("v: '123'"), ONE),
    ("a string that looks like a date", fm("v: '2026-08-23'"), ONE),
    ("a string starting with an indicator", fm("v: '- dash'"), ONE),
    ("a string starting with a question mark", fm("v: '? q'"), ONE),
    ("a string that is a lone dash", fm("v: '-'"), ONE),
    ("a string with a trailing colon", fm("v: 'ends:'"), ONE),
    ("a string with a colon then space", fm("v: 'a: b'"), ONE),
    ("a string with a comma", fm("v: 'a, b'"), ONE),
    ("a string with brackets", fm("v: '[a]'"), ONE),
    ("a string with a leading percent", fm("v: '%x'"), ONE),
    ("a string with a leading at sign", fm("v: '@x'"), ONE),
    ("a string with a leading backtick", fm("v: '`x'"), ONE),
    ("a string with a tab", fm('v: "a\\tb"'), ONE),
    ("a string with a carriage return", fm('v: "a\\rb"'), ONE),
    ("a string with an escape char", fm('v: "a\\eb"'), ONE),
    ("a string with a del char", fm('v: "a\\x7fb"'), ONE),
    ("a string with a nel char", fm('v: "a\\x85b"'), ONE),
    ("a string with a line separator", fm('v: "a\\u2028b"'), ONE),
    ("a string with a bom", fm('v: "a\\ufeffb"'), ONE),
    ("a two line string", fm("v: |-\n  line one\n  line two"), ONE),
    (
        "a two line string with a trailing break",
        fm("v: |\n  line one\n  line two"),
        ONE,
    ),
    ("a three line string", fm("v: |-\n  one\n  two\n  three"), ONE),
    ("a string with a blank line inside", fm("v: |-\n  one\n\n  two"), ONE),
    ("a string with leading whitespace on a line", fm("v: |-\n  one\n   two"), ONE),
    ("a long unbroken string", fm("v: " + "x" * 120), ONE),
    ("a long string of words", fm("v: " + " ".join(["word"] * 30)), ONE),
    (
        "a long string of words with a colon",
        fm("v: '" + " ".join(["word"] * 30) + ": x'"),
        ONE,
    ),
    ("a long quoted string with a tab", fm('v: "' + "word " * 25 + '\\tend"'), ONE),
    ("a long string in a nested map", fm("v:\n  k: " + " ".join(["word"] * 30)), ONE),
    ("a long string in a sequence", fm("v:\n  - " + " ".join(["word"] * 30)), ONE),
    ("a long unicode string", fm("v: " + "caf\u00e9 " * 25), ONE),
    ("an empty sequence value", fm("v: []"), ONE),
    ("an empty mapping value", fm("v: {}"), ONE),
    ("a nested empty collection", fm("v:\n  a: []\n  b: {}"), ONE),
    (
        "a deeply nested structure",
        fm("v:\n  a:\n    b:\n      c:\n        - d\n        - e: f"),
        ONE,
    ),
    ("a sequence of sequences", fm("v:\n  - - x\n  - - y"), ONE),
    # --- key ordering, key types and key shapes ---------------------------
    (
        "three string keys sort",
        fm("z: 1\na: 2\nm: 3"),
        [("z", "z"), ("a", "a"), ("m", "m")],
    ),
    (
        "uppercase sorts before lowercase",
        fm("b: 1\nA: 2"),
        [("b", "b"), ("A", "A")],
    ),
    ("a lone null key", fm("v: x"), [("v", {"key": None})]),
    (
        "true and 1 are the same key",
        fm("a: one\nb: two"),
        [("a", {"key": True}), ("b", {"key": 1})],
    ),
    ("an empty string key", fm("v: x"), [("v", "")]),
    ("a key of 127 chars", fm("v: x"), [("v", "k" * 127)]),
    ("a key of 128 chars", fm("v: x"), [("v", "k" * 128)]),
    ("a key of 129 chars", fm("v: x"), [("v", "k" * 129)]),
    ("a two line key", fm("v: x"), [("v", "one\ntwo")]),
    ("a key that needs quoting", fm("v: x"), [("v", "yes")]),
    ("a key with a colon", fm("v: x"), [("v", "a:b")]),
    ("a key with a space", fm("v: x"), [("v", "a b")]),
    ("a key that is a number string", fm("v: x"), [("v", "5")]),
    ("a list key raises", fm("v: x"), [("v", {"key": ["a"]})]),
    ("an object key raises", fm("v: x"), [("v", {"key": {"a": 1}})]),
    (
        "keys from a loaded map are dropped unless mapped",
        fm("kept: 1\ndropped: 2"),
        [("kept", "kept")],
    ),
    (
        "a key loaded as an int",
        fm("2026: a year\nv: x"),
        [(2026, "year"), ("v", "v")],
    ),
    # --- values that arrive from the mapping rather than the content ------
    ("a default string", fm("other: 1"), [("v", {"key": "v", "default": "fallback"})]),
    ("a default list", fm("other: 1"), [("v", {"key": "v", "default": ["a", "b"]})]),
    ("a default object", fm("other: 1"), [("v", {"key": "v", "default": {"a": 1}})]),
    ("a default number", fm("other: 1"), [("v", {"key": "v", "default": 5})]),
    ("a default float", fm("other: 1"), [("v", {"key": "v", "default": 1.5})]),
    ("a default bool", fm("other: 1"), [("v", {"key": "v", "default": True})]),
    (
        "the array transform wraps a scalar",
        fm("v: x"),
        [("v", {"key": "v", "transform": "array"})],
    ),
    (
        "the array transform leaves a list",
        fm("v: [x]"),
        [("v", {"key": "v", "transform": "array"})],
    ),
    (
        "the array transform wraps a date",
        fm("v: 2026-08-23"),
        [("v", {"key": "v", "transform": "array"})],
    ),
    (
        "one loaded list reaches two keys",
        fm("a: &x [p, q]\nb: *x"),
        [("a", "first"), ("b", {"key": "second"})],
    ),
    (
        "one loaded map reaches two keys",
        fm("a: &x {p: 1}\nb: *x"),
        [("a", "first"), ("b", {"key": "second"})],
    ),
    (
        "one loaded date reaches two keys",
        fm("a: &x 2026-08-23\nb: *x"),
        [("a", "first"), ("b", {"key": "second"})],
    ),
    (
        "one loaded string reaches two keys",
        fm("a: &x hello\nb: *x"),
        [("a", "first"), ("b", {"key": "second"})],
    ),
    (
        "one loaded list reaches three keys",
        fm("a: &x [p]\nb: *x\nc: *x"),
        [("a", "a"), ("b", "b"), ("c", "c")],
    ),
    (
        "an aliased list is also a key's value",
        fm("a: &x [p]\nb: *x"),
        [("a", "first"), ("b", {"key": "second", "transform": "array"})],
    ),
    (
        "the array transform wraps the same list twice",
        fm("a: &x q\nb: *x"),
        [
            ("a", {"key": "first", "transform": "array"}),
            ("b", {"key": "second", "transform": "array"}),
        ],
    ),
    (
        "int keys from two fields sort numerically",
        fm("a: one\nb: two\nc: three"),
        [("a", {"key": 10}), ("b", {"key": 9}), ("c", {"key": 2})],
    ),
    (
        "an int key beside a string key keeps insertion order",
        fm("a: one\nb: two"),
        [("a", {"key": "z"}), ("b", {"key": 2})],
    ),
    (
        "a null key beside a string key keeps insertion order",
        fm("a: one\nb: two"),
        [("a", {"key": "z"}), ("b", {"key": None})],
    ),
    (
        "a bool key beside an int key sorts",
        fm("a: one\nb: two"),
        [("a", {"key": 2}), ("b", {"key": True})],
    ),
    (
        "a float key beside an int key sorts",
        fm("a: one\nb: two"),
        [("a", {"key": 3}), ("b", {"key": 1.5})],
    ),
    (
        "a nested list shared with its parent",
        fm("v:\n  inner: &x [1]\n  other: *x"),
        [("v", "v")],
    ),
    # --- the reader's printable check, which runs before any scanning ------
    ("a literal nul in the block", "---\nv: a\x00b\n---\nbody", ONE),
    ("a literal escape char in the block", '---\nv: "a\x1bb"\n---\nbody', ONE),
    ("a literal del char in the block", "---\nv: a\x7fb\n---\nbody", ONE),
    ("a literal vertical tab in the block", "---\nv: a\x0bb\n---\nbody", ONE),
    ("a literal nul only in the body", "---\nv: 1\n---\nbody\x00\n", ONE),
    ("a literal c1 control in the block", "---\nv: a\x9fb\n---\nbody", ONE),
    # --- cases that separate the guards from a near miss -------------------
    ("content starting with two dashes", "-- x\n---\nv: 1\n---\nbody", ONE),
    (
        "frontmatter is an empty string, dict target",
        "---\n''\n---\nbody",
        [("v", {"key": "x"})],
    ),
    ("frontmatter is zero, dict target", "---\n0\n---\nbody", [("v", {"key": "x"})]),
    ("frontmatter is false, str target", "---\nfalse\n---\nbody", ONE),
    (
        "a merge key overridden locally",
        fm("base: &b {a: 1, d: 4}\nv:\n  <<: *b\n  a: 2"),
        ONE,
    ),
    ("a multi line plain scalar", fm("v: line one\n  line two"), ONE),
    ("a multi line plain scalar in a list", fm("v:\n  - line one\n    line two"), ONE),
    # --- the simple key threshold, which counts the tag as well as the key -
    ("a key of 122 chars", fm("v: x"), [("v", "k" * 122)]),
    ("a key of 123 chars", fm("v: x"), [("v", "k" * 123)]),
    ("a key of 122 chars that needs quoting", fm("v: x"), [("v", "9" * 122)]),
    (
        "a nested key of 123 chars",
        fm("v: x"),
        [("v", {"key": "n", "default": {"k" * 123: 1}})],
    ),
    # --- more of the emitter ----------------------------------------------
    ("a document with crlf line endings", "---\r\nv: 1\r\n---\r\nbody\r\n", ONE),
    ("a value with a trailing space", fm('v: "x "'), ONE),
    ("a list item with a trailing space", fm('v: ["x "]'), ONE),
    ("a value that is only spaces", fm("v: '   '"), ONE),
    ("a value starting with a break", fm('v: "\\nx"'), ONE),
    ("a sequence inside a sequence inside a map", fm("v:\n- - - x"), ONE),
    ("a map inside a sequence inside a map", fm("v:\n- k:\n  - x"), ONE),
    (
        "a long string three levels deep",
        fm("v:\n  a:\n    b: " + " ".join(["word"] * 30)),
        ONE,
    ),
    ("a long key inside a nested map", fm("v:\n  " + "k" * 100 + ": x"), ONE),
    ("a float in exponent form on output", fm("v: 1.0e+16"), ONE),
    ("a small float", fm("v: 0.0001"), ONE),
    ("a smaller float", fm("v: 1.0e-5"), ONE),
    ("a float at the fixed notation boundary", fm("v: 1.0e+15"), ONE),
    ("a float with many digits", fm("v: 0.1"), ONE),
    ("a sexagesimal float", fm("v: 1:30.5"), ONE),
    ("a date as a key", fm("2026-08-23: x\nv: y"), [("v", "v")]),
    ("a set with three members", fm("v: !!set {c, a, b}"), ONE),
    ("a nested map with an int key", fm("v: {3: c, 1: a}"), ONE),
    ("a nested map with mixed keys", fm("v: {a: 1, 2: b}"), ONE),
    ("a value that is a whole document", fm("v: |-\n  ---\n  a: 1\n  ---"), ONE),
    ("a value starting with three dashes", fm("v: '--- x'"), ONE),
    ("a value starting with three dots", fm("v: '... x'"), ONE),
    # --- a realistic post -------------------------------------------------
    (
        "a realistic frontmatter through a realistic mapping",
        "---\n"
        "title: How to Choose a Metal Roof\n"
        "description: A buyer's guide to metal roofing, with costs.\n"
        "date: 2026-08-23\n"
        "tags:\n"
        "  - roofing\n"
        "  - metal\n"
        "author: Jena AI\n"
        "draft: false\n"
        "---\n\n"
        "# How to Choose a Metal Roof\n\nBody.\n",
        [
            ("title", "title"),
            ("description", {"key": "excerpt"}),
            ("date", {"key": "publishedAt"}),
            ("tags", {"key": "categories", "transform": "array"}),
            ("author", {"key": "author", "default": "Staff"}),
            ("missing", {"key": "layout", "default": "post"}),
            ("draft", "draft"),
        ],
    ),
]


def check_source() -> None:
    source = inspect.getsource(_apply_mapping_to_content)
    for line in REQUIRED_SOURCE_LINES:
        if line not in source:
            raise SystemExit(
                f"source line missing from _apply_mapping_to_content: {line!r}"
            )


def main() -> None:
    check_source()

    seen: set[str] = set()
    records: list[dict[str, Any]] = []

    for name, content, mapping_pairs in CASES:
        if name in seen:
            raise SystemExit(f"duplicate case name: {name!r}")
        seen.add(name)

        record: dict[str, Any] = {
            "name": name,
            "content": content,
            "mapping": [list(pair) for pair in mapping_pairs],
        }
        try:
            record["result"] = _apply_mapping_to_content(content, dict(mapping_pairs))
        except Exception as exc:  # noqa: BLE001 - the caller catches nothing either
            record["error"] = {"type": type(exc).__name__, "message": str(exc)}
        records.append(record)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"cases": records}, ensure_ascii=False, indent=2) + "\n")
    errors = sum(1 for r in records if "error" in r)
    print(f"wrote {len(records)} cases ({errors} raising) to {OUT}")


if __name__ == "__main__":
    main()
