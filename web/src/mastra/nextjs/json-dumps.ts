/**
 * `json.dumps` with CPython's defaults, ported for the Next.js webhook payload
 * (ledger item 5.3c-iii-b-2-c).
 *
 * `publish_to_nextjs` signs the *bytes* this produces and
 * `packages/create-mdx-blog` verifies that signature over the body it received,
 * so a port that differs by one space or one escape sequence publishes a post
 * the reader's blog rejects. `JSON.stringify` differs from `json.dumps` in two
 * ways that both show up on ordinary content:
 *
 * - `ensure_ascii` defaults to true, so every character outside the printable
 *   ASCII range `\x20`-`\x7e` becomes a `\uXXXX` escape. That includes
 *   `\x7f`, which `JSON.stringify` emits literally, and every accented letter,
 *   CJK character and emoji an article contains.
 * - With no `indent`, the separators are `", "` and `": "`, not `","` and
 *   `":"`.
 *
 * Divergences, all of them upstream of this module in the `pg` driver, which
 * parses a JSONB column with `JSON.parse`:
 *
 * - Python reads a JSON number without a fraction or exponent as an `int` and
 *   any other as a `float`, and re-emits them differently: `1.0` stays `1.0`
 *   and `1e2` becomes `100.0`, where a JavaScript number carries no such tag
 *   and both come back as `1` and `100`. Integers beyond 2^53 have already
 *   lost digits by the time this module sees them.
 * - JavaScript reorders integer-like keys to the front of an object, so a
 *   nested `{"2": …, "a": …, "1": …}` inside `image_manifest` emits in a
 *   different order than Python's insertion-ordered dict.
 *
 * Neither is reachable from the payload's own seven keys or from an image
 * record's five: both are fixed, non-numeric and string valued. They are only
 * reachable through a manifest whose `alt_text` or `placement` holds a nested
 * object or a number, which is model output, not something the pipeline
 * writes. Recorded in `todo.md`.
 */
import { pythonFloatRepr } from "./pyyaml/dump"
import { PyTypeError } from "./pyyaml/values"

const SHORTCUTS: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
}

/**
 * `c_encode_basestring_ascii`. Iterating by UTF-16 code unit is what emits an
 * astral character as the surrogate pair Python also writes.
 */
export function encodeBasestringAscii(value: string): string {
  let out = '"'
  for (const char of splitCodeUnits(value)) {
    const shortcut = SHORTCUTS[char]
    if (shortcut !== undefined) {
      out += shortcut
      continue
    }
    const code = char.charCodeAt(0)
    // `ESCAPE_ASCII` is `[^\ -~]`: printable ASCII passes through, everything
    // else escapes, `\x7f` included.
    out += code >= 0x20 && code <= 0x7e
      ? char
      : `\\u${code.toString(16).padStart(4, "0")}`
  }
  return `${out}"`
}

function splitCodeUnits(value: string): string[] {
  const units: string[] = []
  for (let index = 0; index < value.length; index += 1) units.push(value[index])
  return units
}

/**
 * `float.__repr__` for a float and `int.__repr__` for an int, chosen by
 * `Number.isInteger` because that is all a JavaScript number carries.
 *
 * `int.__repr__` is exact digits at every magnitude where `String(n)` switches
 * to exponential notation at 1e21, so the integral arm goes through `BigInt`,
 * which agrees with `String(n)` below that and stays exact above it. Reading
 * every integral value as an int is the side of the int/float ambiguity worth
 * being right about: a manifest number that large is far likelier to have been
 * written as digits than as a float.
 */
export function encodeNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN"
  if (value === Infinity) return "Infinity"
  if (value === -Infinity) return "-Infinity"
  if (!Number.isInteger(value)) return pythonFloatRepr(value)
  return BigInt(value).toString()
}

/** `json.dumps(value)`: `ensure_ascii=True`, `", "` / `": "`, insertion order. */
export function pythonJsonDumps(value: unknown): string {
  if (value === null) return "null"
  if (value === true) return "true"
  if (value === false) return "false"
  if (typeof value === "string") return encodeBasestringAscii(value)
  if (typeof value === "number") return encodeNumber(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => pythonJsonDumps(item)).join(", ")}]`
  }
  if (typeof value === "object") {
    return encodeEntries(Object.entries(value as Record<string, unknown>))
  }
  throw new PyTypeError(
    `Object of type ${typeof value} is not JSON serializable`,
  )
}

function encodeEntries(entries: [unknown, unknown][]): string {
  const parts = entries.map(([key, item]) => {
    if (typeof key !== "string") {
      // Python coerces int, float, bool and None keys and raises on the rest.
      // A JSONB object only ever has string keys, so anything else here is a
      // caller bug rather than data.
      throw new PyTypeError(`keys must be str, not ${typeof key}`)
    }
    return `${encodeBasestringAscii(key)}: ${pythonJsonDumps(item)}`
  })
  return `{${parts.join(", ")}}`
}
