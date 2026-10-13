/**
 * The Python value model `yaml.safe_load` produces and `yaml.dump` consumes,
 * spelled in TypeScript (ledger item 5.3c-iii-b-2-b).
 *
 * PyYAML round trips through Python's types, and four of the distinctions it
 * makes have no JavaScript equivalent, so they are carried explicitly here:
 *
 * - `int` and `float` are different types and emit differently: `1` emits as
 *   `1` and `1.0` emits as `1.0`. A JavaScript `number` cannot tell them
 *   apart, so a loaded `int` is a `bigint` (which also keeps the value exact
 *   past 2^53, as Python does) and a loaded `float` is a {@link PyFloat}.
 *   A bare `number` reaching the dumper came from the `nextjs_frontmatter_map`
 *   JSONB column rather than from the document, and is read the way
 *   `json.loads` reads it: integral means `int`, otherwise `float`. The one
 *   case that cannot be recovered is a mapping storing `5.0`, which
 *   `json.loads` makes a float and `JSON.parse` makes an integral number.
 * - `datetime.date` and `datetime.datetime` are different types with different
 *   emitted forms (`2026-08-23` against `2026-08-23 01:02:03`) and cannot be
 *   compared with each other, so a `Date` would lose both.
 * - `tuple` is a `list` that emits under `!!python/tuple`, which is what
 *   `!!omap` loads as.
 * - `dict` keys are arbitrary hashables, and `bytes` is not a `str`.
 */

/** A Python `float`. A bare `number` is a JSON number, see the module header. */
export class PyFloat {
  constructor(readonly value: number) {}
}

/** `datetime.date`. */
export class PyDate {
  constructor(
    readonly year: number,
    readonly month: number,
    readonly day: number,
  ) {}

  /** `date.isoformat()`. */
  isoformat(): string {
    return `${pad(this.year, 4)}-${pad(this.month, 2)}-${pad(this.day, 2)}`
  }
}

/**
 * `datetime.datetime`.
 *
 * `tzOffsetMinutes` is `null` for a naive datetime, which is what a timestamp
 * without a zone loads as, and a whole number of minutes otherwise: the
 * timestamp regex only admits `Z` or `+HH[:MM]`.
 */
export class PyDateTime {
  constructor(
    readonly year: number,
    readonly month: number,
    readonly day: number,
    readonly hour: number,
    readonly minute: number,
    readonly second: number,
    readonly microsecond: number,
    readonly tzOffsetMinutes: number | null,
  ) {}

  /** `datetime.isoformat(' ')`. */
  isoformat(sep: string): string {
    const date = `${pad(this.year, 4)}-${pad(this.month, 2)}-${pad(this.day, 2)}`
    let time = `${pad(this.hour, 2)}:${pad(this.minute, 2)}:${pad(this.second, 2)}`
    if (this.microsecond !== 0) time += `.${pad(this.microsecond, 6)}`
    return date + sep + time + this.utcOffsetSuffix()
  }

  private utcOffsetSuffix(): string {
    if (this.tzOffsetMinutes === null) return ""
    const sign = this.tzOffsetMinutes < 0 ? "-" : "+"
    const total = Math.abs(this.tzOffsetMinutes)
    return `${sign}${pad(Math.floor(total / 60), 2)}:${pad(total % 60, 2)}`
  }
}

/** A Python `tuple`, which is what `!!omap` and `!!pairs` load their items as. */
export class PyTuple {
  constructor(readonly items: readonly unknown[]) {}
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0")
}

/**
 * Python's `==` for the values a document or a JSON mapping can hold, which is
 * what decides whether two dict keys are the same key. `True == 1 == 1.0`, and
 * two `date`s with the same fields are one key even though they are two
 * objects, neither of which a `Map` lookup can see.
 */
export function pyEqual(left: unknown, right: unknown): boolean {
  const leftNumber = asPythonNumber(left)
  const rightNumber = asPythonNumber(right)
  if (leftNumber !== null && rightNumber !== null) return leftNumber === rightNumber
  if (left instanceof PyDate && right instanceof PyDate) {
    return left.isoformat() === right.isoformat()
  }
  if (left instanceof PyDateTime && right instanceof PyDateTime) {
    return (
      left.isoformat(" ") === right.isoformat(" ") &&
      left.tzOffsetMinutes === right.tzOffsetMinutes
    )
  }
  return left === right
}

/** `int`, `float` and `bool` as one number, or `null` for anything else. */
function asPythonNumber(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "number") return value
  if (value instanceof PyFloat) return value.value
  return null
}

/**
 * `mapping[key] = value` with Python's key equality, which keeps the key first
 * inserted and the value written last.
 */
export function pyDictSet(mapping: Map<unknown, unknown>, key: unknown, value: unknown): void {
  for (const existing of mapping.keys()) {
    if (pyEqual(existing, key)) {
      mapping.set(existing, value)
      return
    }
  }
  mapping.set(key, value)
}

/** `key in mapping` with Python's key equality. */
export function pyDictHas(mapping: ReadonlyMap<unknown, unknown>, key: unknown): boolean {
  for (const existing of mapping.keys()) if (pyEqual(existing, key)) return true
  return false
}

/** `mapping.get(key)` with Python's key equality. */
export function pyDictGet(mapping: ReadonlyMap<unknown, unknown>, key: unknown): unknown {
  for (const [existing, value] of mapping) if (pyEqual(existing, key)) return value
  return undefined
}

/** Python's `TypeError`, which `publish_to_nextjs` does not catch. */
export class PyTypeError extends TypeError {}

/** Python's `AttributeError`, which `publish_to_nextjs` does not catch. */
export class PyAttributeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AttributeError"
  }
}

/**
 * `yaml.YAMLError`, the base of the scanner, parser, composer and constructor
 * errors `yaml.safe_load` raises, and of `yaml.representer.RepresenterError`.
 *
 * The messages differ from PyYAML's: the syntax errors come from a different
 * parser, so only the fact of the failure is preserved, not its wording.
 */
export class YamlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "YAMLError"
  }
}
