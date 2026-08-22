/**
 * Port of `pyphen`'s `HyphDict` / `Pyphen.positions`, the Liang hyphenation
 * algorithm `textstat` falls back to when a word is not in the CMU pronouncing
 * dictionary.
 *
 * Only `positions()` is ported. `textstat.backend.counts.count_syllables` uses
 * nothing else: it takes `len(pyphen.positions(word)) + 1` as the syllable
 * estimate, so `iterate`, `wrap` and `inserted` have no consumer here and are
 * left out rather than carried along untested.
 *
 * The pattern file this reads is `data/hyph_en_US.dic`, copied verbatim out of
 * the installed `pyphen` by `api/scripts/export_textstat_data.py` along with its
 * licence notice. Freezing the file rather than depending on an npm hyphenation
 * package is what makes the port's output provably identical to Python's: an
 * npm package carrying a different revision of the TeX patterns would shift
 * syllable counts, and syllable counts move the Flesch score that the edit
 * stage prints into its prompt.
 *
 * Nonstandard hyphenation (`pattern/change,index,cut`) is parsed only far enough
 * to discard the alternative: `AlternativeParser` returns values numerically
 * equal to `int()`, so the positions are the same with or without the data that
 * rides on them. `hyph_en_US.dic` contains no such patterns today.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

/** Lines pyphen skips: comments and the hunspell hyphen-minimum directives. */
const IGNORED_PREFIXES = [
  "%",
  "#",
  "LEFTHYPHENMIN",
  "RIGHTHYPHENMIN",
  "COMPOUNDLEFTHYPHENMIN",
  "COMPOUNDRIGHTHYPHENMIN",
]

/**
 * `pyphen.Pyphen(left=2, right=2)`. These are the constructor defaults, and
 * pyphen deliberately ignores the `LEFTHYPHENMIN` / `RIGHTHYPHENMIN` directives
 * inside the dictionary file, so `hyph_en_US.dic`'s `RIGHTHYPHENMIN 3` does not
 * apply. `textstat` never overrides them.
 */
const LEFT_HYPHEN_MIN = 2
const RIGHT_HYPHEN_MIN = 2

/**
 * Where the frozen data files live. Every entry point in this repo (`next dev`,
 * `next start`, `vitest`, the Mastra CLI) runs with `web/` as its working
 * directory, which is the same assumption `rulesDir()` in `../prompts.ts`
 * makes. `TEXTSTAT_DATA_DIR` is the escape hatch for anything that does not.
 */
export function textstatDataDir(): string {
  return process.env.TEXTSTAT_DATA_DIR ?? path.resolve(process.cwd(), "src/mastra/textstat/data")
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9"
}

/**
 * `re.findall(r"(\d?)(\D?)", pattern)`.
 *
 * The pattern always matches, so Python's scanner walks the string consuming at
 * most one digit and one non-digit per step, and then emits one final
 * zero-length pair at the end of the string. That trailing pair is reproduced
 * for faithfulness only: it contributes an empty tag and a zero value, and the
 * caller chops trailing zeros off, so removing it changes no pattern in
 * `hyph_en_US.dic`. It is kept so this function can be read against
 * `re.findall` without a caveat.
 */
function parsePattern(pattern: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  let i = 0
  while (i < pattern.length) {
    let digit = ""
    let nonDigit = ""
    if (isDigit(pattern[i])) {
      digit = pattern[i]
      i += 1
    }
    if (i < pattern.length && !isDigit(pattern[i])) {
      nonDigit = pattern[i]
      i += 1
    }
    pairs.push([digit, nonDigit])
  }
  pairs.push(["", ""])
  return pairs
}

/** `^^hh` escapes for characters outside the file's encoding. */
function decodeHexEscapes(pattern: string): string {
  return pattern.replace(/\^{2}([0-9a-f]{2})/g, (_match, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  )
}

/** Decode the dictionary body using the encoding named on its first line. */
function decodeDictionary(buffer: Buffer): string {
  const firstLineEnd = buffer.indexOf(0x0a)
  const declared = buffer.subarray(0, firstLineEnd === -1 ? buffer.length : firstLineEnd)
  const encoding = declared.toString("utf8").trim().toLowerCase()
  if (encoding === "utf-8" || encoding === "utf8") return buffer.toString("utf8")
  if (encoding === "iso8859-1" || encoding === "iso-8859-1" || encoding === "latin1") {
    return buffer.toString("latin1")
  }
  // pyphen also handles microsoft-cp1251 and a handful of legacy codepages.
  // Node has no built-in decoder for those, and no dictionary this port ships
  // uses one, so fail loudly rather than mis-decode a pattern table.
  throw new Error(`unsupported hyphenation dictionary encoding: ${encoding}`)
}

export class HyphenationDictionary {
  /** pattern tag string -> [offset of the first non-zero value, values]. */
  private readonly patterns = new Map<string, { offset: number; values: number[] }>()
  private readonly maxLength: number
  private readonly cache = new Map<string, number[]>()

  constructor(text: string) {
    for (const rawLine of text.split("\n").slice(1)) {
      let pattern = rawLine.trim()
      if (!pattern || IGNORED_PREFIXES.some((prefix) => pattern.startsWith(prefix))) continue

      pattern = decodeHexEscapes(pattern)
      if (pattern.includes("/") && pattern.includes("=")) {
        pattern = pattern.split("/", 1)[0]
      }

      const pairs = parsePattern(pattern)
      const tags = pairs.map(([, tag]) => tag).join("")
      const values = pairs.map(([digit]) => (digit === "" ? 0 : Number(digit)))

      if (Math.max(...values) === 0) continue

      let start = 0
      let end = values.length
      while (values[start] === 0) start += 1
      while (values[end - 1] === 0) end -= 1

      this.patterns.set(tags, { offset: start, values: values.slice(start, end) })
    }

    if (this.patterns.size === 0) throw new Error("hyphenation dictionary contained no patterns")
    this.maxLength = Math.max(...[...this.patterns.keys()].map((key) => key.length))
  }

  /** Unfiltered hyphenation points, `HyphDict.positions`. */
  rawPositions(word: string): number[] {
    const lowered = word.toLowerCase()
    const cached = this.cache.get(lowered)
    if (cached) return cached

    const pointed = `.${lowered}.`
    const references = new Array<number>(pointed.length + 1).fill(0)

    for (let i = 0; i < pointed.length - 1; i += 1) {
      const stop = Math.min(i + this.maxLength, pointed.length) + 1
      for (let j = i + 1; j < stop; j += 1) {
        const pattern = this.patterns.get(pointed.slice(i, j))
        if (!pattern) continue
        for (let k = 0; k < pattern.values.length; k += 1) {
          const at = i + pattern.offset + k
          // Python's slice assignment zips against the (never shorter) tail of
          // `references`, so it can only ever write inside the array.
          if (at >= references.length) break
          references[at] = Math.max(pattern.values[k], references[at])
        }
      }
    }

    const points: number[] = []
    for (let i = 0; i < references.length; i += 1) {
      if (references[i] % 2) points.push(i - 1)
    }
    this.cache.set(lowered, points)
    return points
  }

  /** `Pyphen.positions`: points too close to either end are dropped. */
  positions(word: string): number[] {
    const right = word.length - RIGHT_HYPHEN_MIN
    return this.rawPositions(word).filter((i) => LEFT_HYPHEN_MIN <= i && i <= right)
  }
}

let cached: HyphenationDictionary | undefined

/** The en_US hyphenator, read from disk once per process. */
export function englishHyphenator(): HyphenationDictionary {
  if (!cached) {
    const buffer = readFileSync(path.join(textstatDataDir(), "hyph_en_US.dic"))
    cached = new HyphenationDictionary(decodeDictionary(buffer))
  }
  return cached
}
