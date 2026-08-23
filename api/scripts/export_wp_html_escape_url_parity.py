"""Export the `escape_url` parity oracle and the HTML5 entity tables it needs.

Ledger item 5.3c-iii-b-1-b-ii-3-b-1. `mistune.util.escape_url` is two Python
library behaviours glued together, neither of which JavaScript has:

* `mistune.util.unescape`, which is `html.unescape` with a CommonMark-flavoured
  pattern (an entity reference must carry its trailing semicolon), and which
  therefore reaches into `html._replace_charref`, `html.entities.html5`,
  `html._invalid_charrefs` and `html._invalid_codepoints`.
* `urllib.parse.quote` with the safe set `:/?#@!$&()*+,;=%`, which percent
  encodes the UTF-8 bytes of everything outside that set plus `A-Za-z0-9_.-~`.

The three stdlib tables are data, not logic, so they are exported verbatim into
`html5-entities.json` rather than retyped. The oracle in
`wp-html-escape-url-parity.json` then pins the composed function on a corpus
that exercises both halves and the seams between them: `&amp;` unescapes to `&`,
which is in the safe set and survives, while `&lt;` unescapes to `<`, which is
not and becomes `%3C`.

`escape_url` is not reachable from `markdown_to_wp_html` output yet (its only
callers are `parse_ref_link` and the inline link rules, which are ledger items
-3-b-2 and -b-iii), so this oracle calls the function directly.

Usage:
    uv run python scripts/export_wp_html_escape_url_parity.py
"""

from __future__ import annotations

import html
import json
import sys
from html.entities import html5
from pathlib import Path

import mistune
from mistune.util import escape_url, unescape

DATA_DIR = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "src"
    / "mastra"
    / "wordpress"
    / "data"
)
ENTITIES_OUT = DATA_DIR / "html5-entities.json"
PARITY_OUT = DATA_DIR / "wp-html-escape-url-parity.json"

CASES: list[tuple[str, str]] = [
    # The `"&" not in s` fast path, and plain always-safe input.
    ("empty string", ""),
    ("unreserved ascii", "abcXYZ019_.-~"),
    ("a whole ordinary url", "https://example.com/a/b?c=d&e=f#frag"),
    # Every character of the safe set survives, one at a time.
    ("safe colon", "a:b"),
    ("safe slash", "a/b"),
    ("safe question mark", "a?b"),
    ("safe hash", "a#b"),
    ("safe at", "a@b"),
    ("safe bang", "a!b"),
    ("safe dollar", "a$b"),
    ("safe ampersand alone", "a&b"),
    ("safe parens", "a(b)c"),
    ("safe star", "a*b"),
    ("safe plus", "a+b"),
    ("safe comma", "a,b"),
    ("safe semicolon", "a;b"),
    ("safe equals", "a=b"),
    ("safe percent is left alone", "a%20b"),
    # Characters outside the safe set, which percent encode with upper hex.
    ("space", "a b"),
    ("double quote", 'a"b'),
    ("single quote is not safe", "a'b"),
    ("angle brackets", "a<b>c"),
    ("square brackets", "a[b]c"),
    ("curly braces", "a{b}c"),
    ("pipe", "a|b"),
    ("backslash", "a\\b"),
    ("caret", "a^b"),
    ("backtick", "a`b"),
    ("tab", "a\tb"),
    ("newline", "a\nb"),
    ("nul byte", "a\x00b"),
    ("del byte", "a\x7fb"),
    # Multi-byte UTF-8, including a codepoint above the BMP.
    ("latin-1 supplement", "café"),
    ("cjk", "中文"),
    ("astral emoji", "😀"),
    ("combining mark", "é"),
    ("idn host", "https://例え.jp/パス"),
    # Named entity references. The trailing semicolon is required by the
    # CommonMark-flavoured pattern, but the longest-prefix fallback inside
    # `_replace_charref` can still resolve a name that has no semicolon form.
    ("named entity amp stays safe", "&amp;"),
    ("named entity lt becomes percent 3c", "&lt;"),
    ("named entity gt", "&gt;"),
    ("named entity quot", "&quot;"),
    ("named entity nbsp", "&nbsp;"),
    ("named entity uppercase GT", "&GT;"),
    ("named entity not", "&not;"),
    ("longest prefix notit", "&notit;"),
    ("longest prefix noti", "&noti;"),
    ("longest prefix gtx", "&gtx;"),
    ("no semicolon is not a reference", "&gt"),
    ("unknown one character name", "&a;"),
    ("unknown name", "&nope;"),
    ("bare ampersand semicolon", "&;"),
    ("entity name at the 32 character bound", "&" + "x" * 32 + ";"),
    ("entity name past the 32 character bound", "&" + "x" * 33 + ";"),
    ("two references in one string", "&lt;a&gt;"),
    ("reference inside a url", "https://example.com/?a=1&amp;b=2"),
    # Numeric references.
    ("decimal reference to percent", "&#37;"),
    ("decimal reference to space", "&#32;"),
    ("hex reference lowercase x", "&#x26;"),
    ("hex reference uppercase X", "&#X26;"),
    ("hex reference with leading zeros", "&#x0000026;"),
    ("decimal digits past the 1 to 7 bound", "&#00000037;"),
    ("hex reference with no digits", "&#x;"),
    ("hash with no digits", "&#"),
    ("invalid charref zero", "&#0;"),
    ("invalid charref carriage return", "&#13;"),
    ("invalid charref windows 1252 euro", "&#128;"),
    ("invalid charref 159", "&#159;"),
    ("surrogate low bound", "&#xD800;"),
    ("surrogate high bound", "&#xDFFF;"),
    ("above the unicode maximum", "&#x110000;"),
    ("decimal above the unicode maximum", "&#9999999;"),
    ("invalid codepoint one is dropped", "&#1;"),
    ("invalid codepoint 0xFDD0 is dropped", "&#xFDD0;"),
    ("invalid codepoint 0xFFFE is dropped", "&#xFFFE;"),
    ("valid astral numeric reference", "&#x1F600;"),
    # The exclusion set of the entity-name class: tab, newline, form feed,
    # space, `<`, `&`, `#` and `;` all stop a name from forming.
    ("name containing a space", "&a b;"),
    ("name containing a tab", "&a\tb;"),
    ("name containing a newline", "&a\nb;"),
    ("name containing a form feed", "&a\x0cb;"),
    ("name containing a less than", "&a<b;"),
    ("name containing an ampersand", "&a&b;"),
    ("name containing a hash", "&a#b;"),
    ("name containing a carriage return is allowed", "&a\rb;"),
    ("double ampersand before a name", "&&amp;"),
    # Object.prototype keys are not entity names. A port that looks the name up
    # with `in` on a plain object resolves every one of these.
    ("prototype key constructor", "&constructor;"),
    ("prototype key toString", "&toString;"),
    ("prototype key valueOf", "&valueOf;"),
    ("prototype key hasOwnProperty", "&hasOwnProperty;"),
    ("prototype key dunder proto", "&__proto__;"),
]

# `str.encode('utf-8')` is strict, so a lone surrogate raises rather than
# encoding. Recorded so the port can state what it does instead.
RAISE_CASES: list[tuple[str, str]] = [
    ("lone high surrogate", "\ud800"),
    ("lone low surrogate", "\udfff"),
]


def main() -> None:
    entities = {
        "generated_by": "api/scripts/export_wp_html_escape_url_parity.py",
        "source": "python stdlib html.entities.html5 and html._invalid_*",
        "python_version": sys.version.split()[0],
        "html5": dict(html5),
        "invalid_charrefs": {str(k): v for k, v in html._invalid_charrefs.items()},
        "invalid_codepoints": sorted(html._invalid_codepoints),
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ENTITIES_OUT.write_text(json.dumps(entities, indent=2) + "\n", encoding="utf-8")

    cases = [
        {
            "name": name,
            "input": text,
            "unescaped": unescape(text),
            "escaped": escape_url(text),
        }
        for name, text in CASES
    ]
    raises = []
    for name, text in RAISE_CASES:
        try:
            escape_url(text)
        except UnicodeEncodeError as exc:
            raises.append(
                {
                    "name": name,
                    "input": text,
                    "raises": type(exc).__name__,
                    "message": str(exc),
                }
            )
        else:
            raise SystemExit(f"{name!r} no longer raises")
    payload = {
        "generated_by": "api/scripts/export_wp_html_escape_url_parity.py",
        "source": "mistune.util.escape_url and mistune.util.unescape",
        "mistune_version": mistune.__version__,
        "python_version": sys.version.split()[0],
        "safe_set": ":/?#@!$&()*+,;=%",
        "scope": (
            "the CommonMark-flavoured html.unescape and urllib.parse.quote that "
            "escape_url composes, and the seam between them"
        ),
        "cases": cases,
        "raises": raises,
    }
    PARITY_OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote {len(html5)} entities, {len(html._invalid_charrefs)} invalid charrefs "
        f"and {len(html._invalid_codepoints)} invalid codepoints to {ENTITIES_OUT}"
    )
    print(f"wrote {len(cases)} cases and {len(raises)} raises to {PARITY_OUT}")


if __name__ == "__main__":
    main()
