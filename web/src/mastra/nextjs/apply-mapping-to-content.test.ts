import { describe, expect, it } from "vitest"

import { applyMappingToContent } from "./apply-mapping-to-content"
import parity from "./data/nextjs-mapping-to-content-parity.json"
import { PyAttributeError, PyTypeError, YamlError } from "./pyyaml/values"

/**
 * Every case in `data/nextjs-mapping-to-content-parity.json` replayed against
 * the port (ledger item 5.3c-iii-b-2-b).
 *
 * The oracle was written by running the real `_apply_mapping_to_content` over
 * these inputs; see `api/scripts/export_mapping_to_content_parity.py`.
 *
 * PyYAML's own syntax errors are not reproduced word for word: the port reads
 * the document with a different parser, so a case that raises one of the
 * `yaml.YAMLError` subclasses in Python is only asserted to raise here. The `TypeError` and `AttributeError` cases come out
 * of the ported code rather than a parser, so those messages are asserted.
 */

interface ParityCase {
  name: string
  content: string
  mapping: [string, unknown][]
  result?: string
  error?: { type: string; message: string }
}

/** `yaml.YAMLError` subclasses: raised in both, with PyYAML's wording only. */
const YAML_ERRORS = new Set([
  "ReaderError",
  "ScannerError",
  "ParserError",
  "ComposerError",
  "ConstructorError",
])

const cases = parity.cases as ParityCase[]

describe("applyMappingToContent parity oracle", () => {
  it("replays every recorded case", () => {
    expect(cases.length).toBeGreaterThan(150)
  })

  for (const parityCase of cases) {
    it(parityCase.name, () => {
      const mapping = new Map<unknown, unknown>(parityCase.mapping)
      const run = (): string => applyMappingToContent(parityCase.content, mapping)

      if (parityCase.error) {
        if (YAML_ERRORS.has(parityCase.error.type)) {
          expect(run).toThrow(YamlError)
          return
        }
        const expected = parityCase.error.type === "TypeError" ? PyTypeError : PyAttributeError
        expect(run).toThrow(expected)
        expect(run).toThrow(parityCase.error.message)
        return
      }

      expect(run()).toBe(parityCase.result)
    })
  }
})

/**
 * The two places the port knowingly answers differently, recorded here so the
 * difference is a decision rather than a surprise. Both were found by running
 * 2400 randomly generated documents through the real function and the port and
 * comparing the bytes; nothing else diverged.
 */
describe("documented divergences from PyYAML", () => {
  const passthrough = new Map<unknown, unknown>([["v", "v"]])

  it("keeps a literal NEL inside a scalar where PyYAML folds it to a space", () => {
    // Python: "---\nv: ' nel'\n---\n" with a space, because YAML 1.1 counts
    // U+0085 as a line break and folds a single break to a space. The `yaml`
    // package counts only CR and LF, so the character stays in the value and
    // comes back out as a break plus the scalar's indent.
    const content = "---\nv: \"\u0085nel\"\n---\n"
    expect(applyMappingToContent(content, passthrough)).toBe("---\nv: '\u0085  nel'\n---\n")
  })

  it("reads a literal NEL as content where PyYAML ends the line on it", () => {
    // Python raises: `v: a<NEL>b` is a plain scalar `a` followed by a line
    // whose `b` sits at column 0, which ends the mapping and fails to scan.
    // The port sees one line and publishes `'a<NEL>b'`. Same cause as the
    // fold above, the other way round: here the port is the lenient one.
    const content = "---\nv: a\u0085b\n---\nbody"
    expect(applyMappingToContent(content, passthrough)).toBe("---\nv: 'a\u0085  b'\n---\nbody")
  })

  it("reads a surrogate pair escape as one character where Python reads two", () => {
    // Python scans `\ud83c` and `\udf89` as two lone surrogates, which are not
    // printable, and dumps them back escaped. A JavaScript string cannot hold
    // that pair as anything other than the astral character it encodes, so the
    // port emits the character. Written as the character itself, which is what
    // real frontmatter holds, the two agree; that case is in the oracle.
    const content = '---\nv: "\\ud83c\\udf89"\n---\n'
    expect(applyMappingToContent(content, passthrough)).toBe("---\nv: \u{1f389}\n---\n")
  })
})
