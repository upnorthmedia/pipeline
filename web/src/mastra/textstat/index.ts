/**
 * Port of the `textstat` primitives `api/src/services/analytics.py` depends on,
 * pinned to the installed `textstat` 0.7.13 with `lang = "en_US"`.
 *
 * `compute_analytics` calls exactly two textstat entry points,
 * `sentence_count()` and `flesch_reading_ease()`, and both numbers are printed
 * into the edit stage's prompt. Prompt parity for that stage therefore needs
 * this arithmetic reproduced exactly, not approximately, which rules out the
 * usual JavaScript syllable heuristics: they disagree with the CMU pronouncing
 * dictionary on ordinary words, and one syllable moves the Flesch score by
 * enough to change the rendered digit.
 *
 * The two data files this reads are frozen copies of what Python reads, written
 * by `api/scripts/export_textstat_data.py`. See `hyphenator.ts` for why.
 *
 * Two deliberate deviations from Python's regex engine, both immaterial to
 * English prose and both asserted against the parity fixture:
 *
 * 1. Python's `\w` and Node's `\p{L}\p{N}_` are built from different Unicode
 *    revisions, so ~4k code points added after Python 3.13's tables count as
 *    word characters here and do not there. No character in that set is
 *    reachable from a blog draft.
 * 2. Python's `\s` and `str.isspace()` are the same set, spelled out below as
 *    `PY_WHITESPACE` rather than borrowed from JavaScript's `\s`, which both
 *    omits `\x1c`-`\x1f` and `\x85` and adds `﻿`.
 */
import { gunzipSync } from "node:zlib"
import { readFileSync } from "node:fs"
import path from "node:path"

import { englishHyphenator, textstatDataDir } from "./hyphenator"

/** Python's `\s` for `str` patterns, which is also `str.isspace()`'s set. */
const PY_WHITESPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"
/** Python's `\w` for `str` patterns. */
const PY_WORD = "\\p{L}\\p{N}_"

const LEADING_WHITESPACE = new RegExp(`^[${PY_WHITESPACE}]+`, "u")
const TRAILING_WHITESPACE = new RegExp(`[${PY_WHITESPACE}]+$`, "u")
const WHITESPACE_RUN = new RegExp(`[${PY_WHITESPACE}]+`, "u")

/** `textstat.backend.utils.constants.RE_NONCONTRACTION_APOSTROPHE`. */
const NON_CONTRACTION_APOSTROPHE = /'(?![tsd]|ve|ll|re)/g
const ALL_PUNCTUATION = new RegExp(`[^${PY_WORD}${PY_WHITESPACE}]`, "gu")
const PUNCTUATION_KEEPING_APOSTROPHES = new RegExp(`[^${PY_WORD}${PY_WHITESPACE}']`, "gu")
const CONTRACTION_APOSTROPHE = /'(?=[tsd]|ve|ll|re)/g

/**
 * `re.findall(r"\b[^.!?]+[.!?]*", text, re.UNICODE)`. JavaScript's `\b` is
 * defined against ASCII `\w`, so the boundary is spelled out with lookaround
 * against the Unicode word class instead.
 */
const SENTENCE = new RegExp(
  `(?:(?<![${PY_WORD}])(?=[${PY_WORD}])|(?<=[${PY_WORD}])(?![${PY_WORD}]))[^.!?]+[.!?]*`,
  "gu",
)

/** Flesch coefficients from `LANG_CONFIGS["en"]`. */
const FRE_BASE = 206.835
const FRE_SENTENCE_LENGTH = 1.015
const FRE_SYLL_PER_WORD = 84.6

/**
 * Python's `str.split()` with no argument: split on runs of whitespace, with
 * leading and trailing whitespace producing no empty fields.
 */
export function pythonSplit(text: string): string[] {
  const trimmed = text.replace(LEADING_WHITESPACE, "").replace(TRAILING_WHITESPACE, "")
  if (trimmed === "") return []
  return trimmed.split(WHITESPACE_RUN)
}

/** `textstat.backend.transformations.remove_punctuation`. */
export function removePunctuation(text: string, rmApostrophe: boolean): string {
  if (rmApostrophe) return text.replace(ALL_PUNCTUATION, "")
  return text.replace(NON_CONTRACTION_APOSTROPHE, "").replace(PUNCTUATION_KEEPING_APOSTROPHES, "")
}

export interface ListWordsOptions {
  rmPunctuation?: boolean
  rmApostrophe?: boolean
  lowercase?: boolean
  splitContractions?: boolean
  splitHyphens?: boolean
}

/** `textstat.backend.selections.list_words`. */
export function listWords(text: string, options: ListWordsOptions = {}): string[] {
  const {
    rmPunctuation = true,
    rmApostrophe = false,
    lowercase = false,
    splitContractions = false,
    splitHyphens = false,
  } = options

  let working = text
  if (splitHyphens) working = working.replace(/-/g, " ")
  if (rmPunctuation) working = removePunctuation(working, rmApostrophe)
  if (lowercase) working = working.toLowerCase()
  if (splitContractions) working = working.replace(CONTRACTION_APOSTROPHE, " ")
  return pythonSplit(working)
}

/** `textstat.backend.counts.count_words`. */
export function countWords(text: string, options: ListWordsOptions = {}): number {
  return listWords(text, options).length
}

/**
 * `textstat.backend.counts.count_sentences`.
 *
 * Fragments of two words or fewer do not count, which is why a heading-heavy
 * markdown draft does not report one "sentence" per heading.
 */
export function countSentences(text: string): number {
  if (text.length === 0) return 0
  let total = 0
  let ignored = 0
  for (const match of text.matchAll(SENTENCE)) {
    total += 1
    if (countWords(match[0]) <= 2) ignored += 1
  }
  return Math.max(1, total - ignored)
}

let syllableTable: Map<string, number> | undefined

/**
 * `word -> syllables in its first CMU pronunciation`, the table
 * `count_syllables` looks words up in before falling back to the hyphenator.
 * Read and parsed once per process; ~123k entries, about 40 ms.
 */
export function cmuSyllables(): Map<string, number> {
  if (!syllableTable) {
    const raw = gunzipSync(readFileSync(path.join(textstatDataDir(), "cmudict-syllables.txt.gz")))
    const table = new Map<string, number>()
    for (const line of raw.toString("utf8").split("\n")) {
      if (!line) continue
      const split = line.lastIndexOf(" ")
      table.set(line.slice(0, split), Number(line.slice(split + 1)))
    }
    syllableTable = table
  }
  return syllableTable
}

/** `textstat.backend.counts.count_syllables`. */
export function countSyllables(text: string): number {
  if (!text) return 0
  const table = cmuSyllables()
  const hyphenator = englishHyphenator()
  let count = 0
  for (const word of listWords(text, { lowercase: true })) {
    const known = table.get(word)
    count += known === undefined ? hyphenator.positions(word).length + 1 : known
  }
  return count
}

/** `textstat.backend.metrics.words_per_sentence`, with Python's `ZeroDivisionError` guard. */
export function wordsPerSentence(text: string): number {
  const sentences = countSentences(text)
  if (sentences === 0) return 0
  return countWords(text) / sentences
}

/** `textstat.backend.metrics.syllables_per_word`, with Python's `ZeroDivisionError` guard. */
export function syllablesPerWord(text: string): number {
  const words = countWords(text)
  if (words === 0) return 0
  return countSyllables(text) / words
}

/**
 * `textstat.flesch_reading_ease`. `textstat`'s own rounding is disabled by
 * default (`__round_points is None`), so this returns the raw score and the
 * caller rounds, matching `compute_analytics`.
 */
export function fleschReadingEase(text: string): number {
  const sentenceLength = wordsPerSentence(text)
  const syllables = syllablesPerWord(text)
  if (sentenceLength === 0 || syllables === 0) return 0
  return FRE_BASE - FRE_SENTENCE_LENGTH * sentenceLength - FRE_SYLL_PER_WORD * syllables
}
