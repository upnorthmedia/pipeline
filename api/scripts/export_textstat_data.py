"""Export the data and the parity oracle the TypeScript `textstat` port needs.

`api/src/services/analytics.py` reads two numbers out of `textstat` that land
verbatim in the edit stage's prompt: the sentence count (through
`avg_sentence_length`) and the Flesch reading ease. Byte-exact prompt parity for
that stage therefore requires the TypeScript port to reproduce `textstat`'s
arithmetic exactly, and that arithmetic bottoms out in two data files:

* the CMU pronouncing dictionary, which `textstat` reaches through `nltk`, and
* `hyph_en_US.dic`, the TeX hyphenation patterns `pyphen` falls back to for
  words the CMU dictionary does not contain.

Neither has a JavaScript distribution that is guaranteed to carry the same
revision of the data, and both disappear from this repo when `api/` is deleted,
so this script freezes them into `web/src/mastra/textstat/data/` and freezes the
expected results alongside them.

The parity oracle is a SHA-256 over an exhaustive table rather than a sample:
every word in the CMU dictionary, with the syllable count `textstat` derives for
it and the hyphenation positions `pyphen` finds in it. The TypeScript test
rebuilds the same table from the same two data files and compares digests, so a
20 KB fixture proves the port over 123k real words. A small readable sample and
a set of whole-text expectations (drawn from the golden fixtures' real drafts)
ride along so a mismatch is debuggable rather than just red.

Usage:
    uv run python scripts/export_textstat_data.py
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import random
import shutil
import sys
from pathlib import Path

import pyphen
import textstat
from nltk.corpus import cmudict
from textstat.backend import counts, metrics, selections

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "web" / "src" / "mastra" / "textstat" / "data"
GOLDEN_DIR = REPO_ROOT / "docs" / "mastra-port" / "golden"

LANG = "en_US"
SAMPLE_SEED = 20260821
SAMPLE_SIZE = 150


def syllables_of(phones: list[str]) -> int:
    """`count_syllables`' reading of a CMU pronunciation: stressed phones."""
    return sum(1 for phone in phones if phone[-1].isdigit())


def export_cmudict(out: Path) -> dict:
    """Freeze `word -> syllable count of the first pronunciation`, gzipped."""
    entries = cmudict.dict()
    lines = [
        f"{word} {syllables_of(prons[0])}" for word, prons in sorted(entries.items())
    ]
    raw = ("\n".join(lines) + "\n").encode("utf-8")
    out.write_bytes(gzip.compress(raw, 9, mtime=0))
    return {
        "entries": len(entries),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "bytes_gzipped": out.stat().st_size,
    }


def export_hyphenation_dict(out_dir: Path) -> dict:
    """Copy `pyphen`'s en_US patterns and their licence notice verbatim."""
    source_dir = Path(pyphen.__file__).parent / "dictionaries"
    copied = {}
    for name in ("hyph_en_US.dic", "README_hyph_en_US.txt"):
        source = source_dir / name
        shutil.copyfile(source, out_dir / name)
        copied[name] = hashlib.sha256(source.read_bytes()).hexdigest()
    return {"pyphen_version": pyphen.__version__, "sha256": copied}


def build_word_table() -> tuple[str, list[dict]]:
    """The exhaustive oracle: every CMU word, its syllables, its hyphen points.

    `positions` is the `pyphen.Pyphen(lang="en_US")` result with its default
    `left=2` / `right=2`, which is exactly the object `count_syllables` measures
    the length of. Recording the positions themselves rather than their count
    means a port that gets the right count for the wrong reason still fails.
    """
    entries = cmudict.dict()
    hyphenator = pyphen.Pyphen(lang=LANG)
    rows = []
    for word in sorted(entries):
        positions = [int(p) for p in hyphenator.positions(word)]
        rows.append((word, syllables_of(entries[word][0]), positions))

    table = "\n".join(
        f"{word}\t{syllables}\t{','.join(str(p) for p in positions)}"
        for word, syllables, positions in rows
    )

    rng = random.Random(SAMPLE_SEED)
    sample = [
        {"word": word, "syllables": syllables, "positions": positions}
        for word, syllables, positions in rng.sample(rows, SAMPLE_SIZE)
    ]
    return table, sample


def oov_words(limit: int = 400) -> list[str]:
    """Words from the golden fixtures that the CMU dictionary does not know.

    These are the only words that reach the `pyphen` fallback in real content,
    so they are the sample worth pinning explicitly on top of the digest.
    """
    entries = cmudict.dict()
    seen: dict[str, None] = {}
    for path in sorted(GOLDEN_DIR.glob("*/*.json")):
        fixture = json.loads(path.read_text())
        blobs = [
            json.dumps(fixture.get("state_input", {})),
            json.dumps(fixture.get("stage_output", {})),
        ]
        for blob in blobs:
            for word in selections.list_words(blob, lowercase=True):
                if word not in entries:
                    seen.setdefault(word, None)
    return sorted(seen)[:limit]


def text_cases() -> list[dict]:
    """Whole-text expectations, mostly real drafts from the golden fixtures."""
    cases: list[dict] = []

    for path in sorted(GOLDEN_DIR.glob("*/*.json")):
        fixture = json.loads(path.read_text())
        state_input = fixture.get("state_input") or {}
        for key in ("draft", "research", "outline", "final_md"):
            text = state_input.get(key)
            if isinstance(text, str) and text.strip():
                name = f"{path.parent.name}/{path.name}:{key}"
                cases.append({"name": name, "text": text})

    # Hand-written edge cases: the ones where the Python and JavaScript regex
    # engines are most likely to part company.
    cases.extend(
        {"name": name, "text": text}
        for name, text in [
            ("empty", ""),
            ("whitespace-only", "   \n\t  "),
            ("no-terminator", "one two three four five"),
            ("short-sentences-ignored", "Hi. Yes. This one has enough words to count."),
            (
                "contractions",
                "They aren't sure it's done, and we'd rather they didn't guess.",
            ),
            ("hyphenated-words", "A well-known, state-of-the-art result, mostly."),
            ("unicode-letters", "Naïve résumé café straße élève."),
            # A one-letter non-ASCII word at the start of a sentence is the case
            # that separates Python's Unicode-aware `\b` from JavaScript's
            # ASCII-only one: JavaScript finds no boundary before the letter, so
            # its first fragment loses a word, drops to two, and stops counting.
            (
                "unicode-initial-single-letter-word",
                "Ä ist gut. Das war alles was wir sagen wollten.",
            ),
            ("nbsp-separated", "one two three. Four five six seven eight."),
            ("digits-and-symbols", "In 2024, 45% of teams (n=1,200) spent $3.50/user."),
            ("underscores", "snake_case_name and __dunder__ tokens appear here often."),
            ("bare-punctuation", "... !!! ??? ---"),
            ("single-word", "extraordinarily"),
        ]
    )

    out = []
    for case in cases:
        text = case["text"]
        out.append(
            {
                "name": case["name"],
                "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "text_length": len(text),
                "text": text,
                "expected": {
                    "count_words": counts.count_words(text),
                    "count_sentences": counts.count_sentences(text),
                    "count_syllables": counts.count_syllables(text, LANG),
                    "words_per_sentence": metrics.words_per_sentence(text),
                    "syllables_per_word": metrics.syllables_per_word(text, LANG),
                    "flesch_reading_ease": textstat.flesch_reading_ease(text),
                    "python_split_length": len(text.split()),
                },
            }
        )
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=DATA_DIR,
        help="directory to write the frozen data and fixtures into",
    )
    args = parser.parse_args()
    out_dir: Path = args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    cmu = export_cmudict(out_dir / "cmudict-syllables.txt.gz")
    hyph = export_hyphenation_dict(out_dir)
    table, sample = build_word_table()

    fixture = {
        "generated_by": "api/scripts/export_textstat_data.py",
        "lang": LANG,
        "textstat_version": ".".join(str(part) for part in textstat.__version__),
        "pyphen_version": hyph["pyphen_version"],
        "cmudict": cmu,
        "hyphenation_dict_sha256": hyph["sha256"],
        "word_table": {
            "description": (
                "sha256 of '<word>\\t<syllables>\\t<comma-joined positions>' for "
                "every CMU word, sorted, joined by \\n with no trailing newline"
            ),
            "words": len(table.splitlines()),
            "sha256": hashlib.sha256(table.encode("utf-8")).hexdigest(),
            "sample_seed": SAMPLE_SEED,
            "sample": sample,
        },
        "out_of_vocabulary_words": [
            {
                "word": word,
                "positions": [int(p) for p in pyphen.Pyphen(lang=LANG).positions(word)],
                "syllables": counts.count_syllables(word, LANG),
            }
            for word in oov_words()
        ],
        "texts": text_cases(),
    }

    target = out_dir / "textstat-parity.json"
    body = json.dumps(fixture, ensure_ascii=False, indent=2, sort_keys=False)
    target.write_text(body + "\n")

    print(f"cmudict entries: {cmu['entries']} ({cmu['bytes_gzipped']} bytes gzipped)")
    table_meta = fixture["word_table"]
    print(f"word table words: {table_meta['words']} sha256={table_meta['sha256']}")
    print(f"oov words: {len(fixture['out_of_vocabulary_words'])}")
    print(f"text cases: {len(fixture['texts'])}")
    print(f"wrote {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
