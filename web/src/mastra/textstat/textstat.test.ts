/**
 * Parity tests for the `textstat` port (ledger item 3.4a).
 *
 * The oracle is `data/textstat-parity.json`, written by
 * `api/scripts/export_textstat_data.py` from the installed Python `textstat`
 * 0.7.13 / `pyphen` 0.17.2. Its centrepiece is a SHA-256 over an exhaustive
 * table (every CMU dictionary word, its syllable count and its hyphenation
 * positions), so a 500 KB fixture proves the port over 123,455 real words
 * instead of over a sample somebody chose.
 *
 * The whole-text expectations are the real drafts, research documents and
 * outlines captured in `docs/mastra-port/golden/`, which is the content the
 * edit stage actually measures.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { englishHyphenator, HyphenationDictionary, textstatDataDir } from "./hyphenator"
import {
  cmuSyllables,
  countSentences,
  countSyllables,
  countWords,
  fleschReadingEase,
  listWords,
  pythonSplit,
  removePunctuation,
  syllablesPerWord,
  wordsPerSentence,
} from "./index"

interface ParityFixture {
  lang: string
  textstat_version: string
  pyphen_version: string
  cmudict: { entries: number; sha256: string; bytes_gzipped: number }
  hyphenation_dict_sha256: Record<string, string>
  word_table: {
    words: number
    sha256: string
    sample: Array<{ word: string; syllables: number; positions: number[] }>
  }
  out_of_vocabulary_words: Array<{ word: string; positions: number[]; syllables: number }>
  texts: Array<{
    name: string
    sha256: string
    text: string
    expected: {
      count_words: number
      count_sentences: number
      count_syllables: number
      words_per_sentence: number
      syllables_per_word: number
      flesch_reading_ease: number
      python_split_length: number
    }
  }>
}

const fixture: ParityFixture = JSON.parse(
  readFileSync(path.join(textstatDataDir(), "textstat-parity.json"), "utf8"),
)

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

describe("frozen data files", () => {
  it("carries the same hyphenation patterns pyphen shipped", () => {
    for (const [name, digest] of Object.entries(fixture.hyphenation_dict_sha256)) {
      expect(sha256(readFileSync(path.join(textstatDataDir(), name)))).toBe(digest)
    }
  })

  it("carries every CMU dictionary entry Python read", () => {
    const table = cmuSyllables()
    expect(table.size).toBe(fixture.cmudict.entries)
    const lines = [...table.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([word, syllables]) => `${word} ${syllables}`)
    expect(sha256(`${lines.join("\n")}\n`)).toBe(fixture.cmudict.sha256)
  })
})

describe("hyphenator", () => {
  it("reproduces pyphen's positions for every CMU dictionary word", () => {
    const hyphenator = englishHyphenator()
    const table = cmuSyllables()
    const rows = [...table.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([word, syllables]) => `${word}\t${syllables}\t${hyphenator.positions(word).join(",")}`)

    expect(rows.length).toBe(fixture.word_table.words)
    expect(sha256(rows.join("\n"))).toBe(fixture.word_table.sha256)
  })

  it("matches the readable sample drawn from that table", () => {
    const hyphenator = englishHyphenator()
    for (const { word, positions } of fixture.word_table.sample) {
      expect({ word, positions: hyphenator.positions(word) }).toEqual({ word, positions })
    }
  })

  it("matches pyphen on the fixture words that miss the CMU dictionary", () => {
    const hyphenator = englishHyphenator()
    const table = cmuSyllables()
    expect(fixture.out_of_vocabulary_words.length).toBeGreaterThan(100)
    for (const { word, positions, syllables } of fixture.out_of_vocabulary_words) {
      expect(table.has(word)).toBe(false)
      expect({ word, positions: hyphenator.positions(word) }).toEqual({ word, positions })
      expect({ word, syllables: countSyllables(word) }).toEqual({ word, syllables })
    }
  })

  it("refuses to run against a pattern table that parsed to nothing", () => {
    expect(() => new HyphenationDictionary("")).toThrow(/no patterns/)
  })
})

describe("textstat primitives against the golden fixtures", () => {
  it("covers the real stage content, not only hand-written strings", () => {
    const fromGolden = fixture.texts.filter((entry) => entry.name.includes(".json:"))
    expect(fromGolden.length).toBeGreaterThanOrEqual(12)
    expect(Math.max(...fromGolden.map((entry) => entry.text.length))).toBeGreaterThan(5000)
  })

  for (const entry of fixture.texts) {
    it(`matches Python on ${entry.name}`, () => {
      expect(sha256(entry.text)).toBe(entry.sha256)
      expect({
        count_words: countWords(entry.text),
        count_sentences: countSentences(entry.text),
        count_syllables: countSyllables(entry.text),
        words_per_sentence: wordsPerSentence(entry.text),
        syllables_per_word: syllablesPerWord(entry.text),
        flesch_reading_ease: fleschReadingEase(entry.text),
        python_split_length: pythonSplit(entry.text).length,
      }).toEqual(entry.expected)
    })
  }
})

describe("word list transformations", () => {
  it("keeps apostrophes before a contraction ending and drops the rest", () => {
    // `'s` is in the contraction set, so a possessive survives too; `'a` is not.
    expect(removePunctuation("they aren't Bob's d'Artagnan, they're ours.", false)).toBe(
      "they aren't Bob's dArtagnan they're ours",
    )
    expect(removePunctuation("they aren't Bob's d'Artagnan, they're ours.", true)).toBe(
      "they arent Bobs dArtagnan theyre ours",
    )
  })

  it("joins hyphenated words unless asked to split them", () => {
    expect(listWords("state-of-the-art")).toEqual(["stateoftheart"])
    expect(listWords("state-of-the-art", { splitHyphens: true })).toEqual([
      "state",
      "of",
      "the",
      "art",
    ])
  })

  it("splits contractions only when asked", () => {
    expect(listWords("they aren't")).toEqual(["they", "aren't"])
    expect(listWords("they aren't", { splitContractions: true })).toEqual(["they", "aren", "t"])
  })

  it("splits on the whitespace set Python splits on, not JavaScript's", () => {
    expect(pythonSplit("  abc  d ")).toEqual(["abc", "d"])
    expect(pythonSplit("   ")).toEqual([])
    expect(pythonSplit("")).toEqual([])
    // Python's whitespace covers the C0 separators and NEL; JavaScript's does not.
    expect(pythonSplit("a\u001cb\u0085c")).toEqual(["a", "b", "c"])
    // JavaScript's covers the byte order mark; Python's does not.
    expect(pythonSplit("a\ufeffb")).toEqual(["a\ufeffb"])
  })
})
