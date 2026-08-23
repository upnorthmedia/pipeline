/**
 * `yaml.dump(data, default_flow_style=False, allow_unicode=True)`, ported to
 * TypeScript (ledger item 5.3c-iii-b-2-b).
 *
 * This is what writes the frontmatter block a reader's blog repo receives, so
 * the bytes are the contract, not just the parse. No JavaScript YAML writer
 * produces them: js-yaml and the `yaml` package both prefer block scalars for
 * multi-line and long strings, indent sequences under their parent key, and
 * quote with `"` where PyYAML quotes with `'`. So `representer.py`,
 * `serializer.py` and `emitter.py` are transcribed here, at their defaults:
 *
 * - `default_style=None`, so a scalar is plain if plain re-reads as the same
 *   tag, else single-quoted, else double-quoted. A literal or folded block is
 *   only ever chosen by a representer that asks for one, which is
 *   `represent_binary`.
 * - `default_flow_style=False`, so every collection is block style except an
 *   empty one, which the emitter writes as `[]` or `{}`.
 * - `sort_keys=True`, and `represent_mapping` wraps the sort in
 *   `try/except TypeError`, so key order is sorted when the keys are mutually
 *   comparable and insertion order when they are not. See {@link pythonSorted}.
 * - `width=80` (`best_width`), `indent=2` (`best_indent`), `allow_unicode=True`
 *   from the call in `_apply_mapping_to_content`.
 * - a repeated object (a list, a dict, a date) is emitted once with an
 *   `&id001` anchor and referenced afterwards with `*id001`, because
 *   `SafeRepresenter.ignore_aliases` covers only the immutable scalars.
 *
 * The emitter is a state machine driven by an event stream in Python. Here it
 * is a recursive walk with the same state (`column`, `whitespace`,
 * `indention`, the indent stack), because the only lookahead the state machine
 * needs is "is this collection empty", which a node knows about itself.
 */

// `Resolver.resolve(ScalarNode, value, (True, False))`, which the serializer
// runs over the *emitted text* to decide whether a plain scalar would read
// back as the same tag. This is why `'yes'` and `'123'` come out quoted. The
// loader owns the table so both halves resolve identically.
import { resolveImplicitTag } from "./load"
import {
  PyDate,
  PyDateTime,
  PyFloat,
  PyTuple,
  PyTypeError,
  YamlError,
} from "./values"

const TAG_NULL = "tag:yaml.org,2002:null"
const TAG_BOOL = "tag:yaml.org,2002:bool"
const TAG_INT = "tag:yaml.org,2002:int"
const TAG_FLOAT = "tag:yaml.org,2002:float"
const TAG_STR = "tag:yaml.org,2002:str"
const TAG_TIMESTAMP = "tag:yaml.org,2002:timestamp"
const TAG_BINARY = "tag:yaml.org,2002:binary"
const TAG_SEQ = "tag:yaml.org,2002:seq"
const TAG_MAP = "tag:yaml.org,2002:map"
const TAG_SET = "tag:yaml.org,2002:set"
const TAG_PYTHON_TUPLE = "tag:yaml.org,2002:python/tuple"

// --- representation nodes ---------------------------------------------------

interface ScalarNode {
  readonly kind: "scalar"
  readonly tag: string
  readonly value: string
  readonly style: string | null
}

interface SequenceNode {
  readonly kind: "sequence"
  readonly tag: string
  readonly items: RepresentedNode[]
}

interface MappingNode {
  readonly kind: "mapping"
  readonly tag: string
  readonly items: [RepresentedNode, RepresentedNode][]
}

type RepresentedNode = ScalarNode | SequenceNode | MappingNode

// --- Python ordering --------------------------------------------------------

/**
 * The comparability classes of Python's `<`. Two values compare only inside
 * one class, and `None` compares with nothing at all, including itself.
 */
function comparabilityClass(value: unknown): string {
  if (value === null || value === undefined) return "none"
  if (
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "number" ||
    value instanceof PyFloat
  ) {
    return "number"
  }
  if (typeof value === "string") return "str"
  if (value instanceof Uint8Array) return "bytes"
  if (value instanceof PyDateTime) return "datetime"
  if (value instanceof PyDate) return "date"
  if (value instanceof PyTuple) return "tuple"
  if (Array.isArray(value)) return "list"
  return "other"
}

/** The numeric value of an `int`, `float` or `bool` key. */
function numberOf(value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "bigint") return Number(value)
  if (value instanceof PyFloat) return value.value
  return value as number
}

/** `left < right` for two values of the same comparability class. */
function pyLessThan(left: unknown, right: unknown): boolean {
  const kind = comparabilityClass(left)
  switch (kind) {
    case "number":
      return numberOf(left) < numberOf(right)
    case "str":
      return lessThanByCodePoint(left as string, right as string)
    case "bytes":
      return lessThanBySequence([...(left as Uint8Array)], [...(right as Uint8Array)])
    case "date":
      return (left as PyDate).isoformat() < (right as PyDate).isoformat()
    case "datetime": {
      const first = left as PyDateTime
      const second = right as PyDateTime
      if ((first.tzOffsetMinutes === null) !== (second.tzOffsetMinutes === null)) {
        throw new PyTypeError("can't compare offset-naive and offset-aware datetimes")
      }
      return first.isoformat(" ") < second.isoformat(" ")
    }
    case "tuple":
      return lessThanBySequence((left as PyTuple).items, (right as PyTuple).items)
    case "list":
      return lessThanBySequence(left as unknown[], right as unknown[])
    default:
      throw new PyTypeError(`'<' not supported between instances of ${kind}`)
  }
}

/** Python compares strings by code point; JavaScript compares UTF-16 units. */
function lessThanByCodePoint(left: string, right: string): boolean {
  return lessThanBySequence([...left].map(codePointOf), [...right].map(codePointOf))
}

function codePointOf(character: string): number {
  return character.codePointAt(0) ?? 0
}

/** Python's elementwise comparison for sequences. */
function lessThanBySequence(left: readonly unknown[], right: readonly unknown[]): boolean {
  const shared = Math.min(left.length, right.length)
  for (let index = 0; index < shared; index += 1) {
    if (!valuesEqual(left[index], right[index])) {
      if (comparabilityClass(left[index]) !== comparabilityClass(right[index])) {
        throw new PyTypeError("'<' not supported between instances of different types")
      }
      return pyLessThan(left[index], right[index])
    }
  }
  return left.length < right.length
}

function valuesEqual(left: unknown, right: unknown): boolean {
  const kind = comparabilityClass(left)
  if (kind !== comparabilityClass(right)) return false
  if (kind === "none") return true
  if (kind === "number") return numberOf(left) === numberOf(right)
  return !pyLessThan(left, right) && !pyLessThan(right, left)
}

/**
 * `sorted(mapping.items())` inside `represent_mapping`'s `try/except
 * TypeError`, which decides whether the emitted keys are sorted.
 *
 * Only the keys are ever compared: `sorted` compares tuples, and a tuple
 * comparison reaches the second element only when the first pair is equal,
 * which cannot happen for two distinct keys of one dict.
 *
 * The sort raises exactly when two keys of different comparability classes are
 * compared. For any list of two or more with mixed classes, every element is
 * compared with at least one other, so some comparison crosses the boundary
 * and the sort raises no matter which pairs the algorithm picked: mixed
 * classes is therefore the same test as "did Python's sort raise". For a
 * single key nothing is compared at all, which is why a lone `None` key sorts
 * and a `None` key beside a string does not.
 */
export function pythonSorted<T>(items: T[], keyOf: (item: T) => unknown): T[] {
  if (items.length < 2) return items
  const classes = new Set(items.map((item) => comparabilityClass(keyOf(item))))
  if (classes.size > 1) throw new PyTypeError("'<' not supported between instances")
  if (classes.has("none") || classes.has("other")) {
    throw new PyTypeError("'<' not supported between instances")
  }
  return [...items].sort((left, right) => {
    if (pyLessThan(keyOf(left), keyOf(right))) return -1
    if (pyLessThan(keyOf(right), keyOf(left))) return 1
    return 0
  })
}

// --- representer ------------------------------------------------------------

/** `repr(float)`, which decides between fixed and exponential notation. */
export function pythonFloatRepr(value: number): string {
  if (Number.isNaN(value)) return "nan"
  if (value === Infinity) return "inf"
  if (value === -Infinity) return "-inf"

  const negative = value < 0 || Object.is(value, -0)
  const [mantissa, exponentText] = Math.abs(value).toExponential().split("e")
  const digits = mantissa.replace(".", "")
  // `decpt` is the position of the decimal point among the digits, which is
  // what CPython's `format_float_short` switches on: fixed notation while
  // `-4 < decpt <= 16`, exponential outside it.
  const decpt = Number(exponentText) + 1

  let text: string
  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) text = `0.${"0".repeat(-decpt)}${digits}`
    else if (decpt >= digits.length) text = `${digits}${"0".repeat(decpt - digits.length)}.0`
    else text = `${digits.slice(0, decpt)}.${digits.slice(decpt)}`
  } else {
    const exponent = decpt - 1
    const sign = exponent < 0 ? "-" : "+"
    const size = String(Math.abs(exponent)).padStart(2, "0")
    text = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits[0]
    text += `e${sign}${size}`
  }
  return negative ? `-${text}` : text
}

/** `SafeRepresenter.represent_float`. */
function representFloatValue(value: number): string {
  if (Number.isNaN(value)) return ".nan"
  if (value === Infinity) return ".inf"
  if (value === -Infinity) return "-.inf"
  const text = pythonFloatRepr(value).toLowerCase()
  if (!text.includes(".") && text.includes("e")) return text.replace("e", ".0e")
  return text
}

/** `base64.encodebytes`: base64 wrapped at 76 characters, with a final break. */
function encodeBase64Bytes(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const encoded = btoa(binary)
  let wrapped = ""
  for (let index = 0; index < encoded.length; index += 76) {
    wrapped += `${encoded.slice(index, index + 76)}\n`
  }
  return wrapped
}

class Representer {
  /** `represented_objects`, which is what turns a repeat into an alias. */
  private readonly represented = new Map<object, RepresentedNode>()

  represent(data: unknown): RepresentedNode {
    const aliasKey = this.aliasKeyOf(data)
    if (aliasKey !== null) {
      const seen = this.represented.get(aliasKey)
      if (seen) return seen
    }
    const node = this.representData(data, aliasKey)
    // `represent_scalar` records the node too, which is what gives a repeated
    // `date` an anchor; a collection records itself before its children so a
    // cycle resolves, so this only has scalars left to do.
    if (node.kind === "scalar") this.keep(aliasKey, node)
    return node
  }

  /** `id(data)` unless `ignore_aliases`, which covers the immutable scalars. */
  private aliasKeyOf(data: unknown): object | null {
    if (data === null || data === undefined) return null
    if (typeof data !== "object") return null
    if (data instanceof PyFloat || data instanceof Uint8Array) return null
    if (data instanceof PyTuple && data.items.length === 0) return null
    return data
  }

  private keep(aliasKey: object | null, node: RepresentedNode): RepresentedNode {
    if (aliasKey !== null) this.represented.set(aliasKey, node)
    return node
  }

  private representData(data: unknown, aliasKey: object | null): RepresentedNode {
    if (data === null || data === undefined) return this.scalar(TAG_NULL, "null")
    if (typeof data === "string") return this.scalar(TAG_STR, data)
    if (typeof data === "boolean") return this.scalar(TAG_BOOL, data ? "true" : "false")
    if (typeof data === "bigint") return this.scalar(TAG_INT, String(data))
    if (typeof data === "number") {
      // A bare number came from JSON, where `json.loads` reads an integral
      // literal as `int` and everything else as `float`.
      return Number.isInteger(data)
        ? this.scalar(TAG_INT, String(data))
        : this.scalar(TAG_FLOAT, representFloatValue(data))
    }
    if (data instanceof PyFloat) return this.scalar(TAG_FLOAT, representFloatValue(data.value))
    if (data instanceof Uint8Array) {
      return this.scalar(TAG_BINARY, encodeBase64Bytes(data), "|")
    }
    if (data instanceof PyDate) return this.scalar(TAG_TIMESTAMP, data.isoformat())
    if (data instanceof PyDateTime) return this.scalar(TAG_TIMESTAMP, data.isoformat(" "))
    if (data instanceof PyTuple) {
      return this.representSequence(TAG_PYTHON_TUPLE, data.items, aliasKey)
    }
    if (Array.isArray(data)) return this.representSequence(TAG_SEQ, data, aliasKey)
    if (data instanceof Set) {
      // `represent_set` builds `{value: None}` and represents that as a
      // mapping, so a set is sorted by the same rule as a dict.
      const pairs: [unknown, unknown][] = [...data].map((item) => [item, null])
      return this.representMapping(TAG_SET, pairs, aliasKey)
    }
    if (data instanceof Map) {
      return this.representMapping(TAG_MAP, [...data.entries()], aliasKey)
    }
    if (typeof data === "object") {
      // A plain object is a JSON object out of the mapping column, which
      // `json.loads` made a dict.
      return this.representMapping(TAG_MAP, Object.entries(data), aliasKey)
    }
    throw new YamlError("cannot represent an object")
  }

  private scalar(tag: string, value: string, style: string | null = null): ScalarNode {
    return { kind: "scalar", tag, value, style }
  }

  private representSequence(
    tag: string,
    items: readonly unknown[],
    aliasKey: object | null,
  ): SequenceNode {
    const node: SequenceNode = { kind: "sequence", tag, items: [] }
    this.keep(aliasKey, node)
    for (const item of items) node.items.push(this.represent(item))
    return node
  }

  private representMapping(
    tag: string,
    pairs: [unknown, unknown][],
    aliasKey: object | null,
  ): MappingNode {
    const node: MappingNode = { kind: "mapping", tag, items: [] }
    this.keep(aliasKey, node)

    let ordered = pairs
    try {
      ordered = pythonSorted(pairs, (pair) => pair[0])
    } catch (error) {
      if (!(error instanceof PyTypeError)) throw error
    }

    for (const [key, value] of ordered) {
      node.items.push([this.represent(key), this.represent(value)])
    }
    return node
  }
}

// --- resolver (the emitter's half) -----------------------------------------

// --- emitter ----------------------------------------------------------------

interface ScalarAnalysis {
  scalar: readonly string[]
  empty: boolean
  multiline: boolean
  allowFlowPlain: boolean
  allowBlockPlain: boolean
  allowSingleQuoted: boolean
  allowDoubleQuoted: boolean
  allowBlock: boolean
}

const WHITESPACE_OR_BREAK = new Set(["\0", " ", "\t", "\r", "\n", "\u0085", "\u2028", "\u2029"])
const BREAKS = new Set(["\n", "\u0085", "\u2028", "\u2029"])

/** `Emitter.ESCAPE_REPLACEMENTS`. */
const ESCAPE_REPLACEMENTS: Record<string, string> = {
  "\0": "0",
  "\x07": "a",
  "\b": "b",
  "\t": "t",
  "\n": "n",
  "\v": "v",
  "\f": "f",
  "\r": "r",
  "\x1b": "e",
  '"': '"',
  "\\": "\\",
  "\u0085": "N",
  "\u00a0": "_",
  "\u2028": "L",
  "\u2029": "P",
}

class Emitter {
  private readonly out: string[] = []
  private column = 0
  private whitespace = true
  private indention = true
  private openEnded = false
  private indent: number | null = null
  private readonly indents: (number | null)[] = []
  private readonly bestIndent = 2
  private readonly bestWidth = 80
  private readonly lineBreak = "\n"
  private readonly allowUnicode = true

  /** Node to anchor name, from `Serializer.anchor_node`. */
  private readonly anchors = new Map<RepresentedNode, string | null>()
  private lastAnchorId = 0
  private readonly serialized = new Set<RepresentedNode>()

  emitDocument(root: RepresentedNode): string {
    this.anchorNode(root)
    // `expect_document_start` writes no `---`: the document is implicit unless
    // a version, tag directives or an explicit start were asked for.
    this.emitNode(root, { root: true })
    // `expect_document_end`.
    this.writeIndent()
    // `expect_document_start` again, this time with the stream end.
    if (this.openEnded) {
      this.writeIndicator("...", true)
      this.writeIndent()
    }
    return this.out.join("")
  }

  /** `Serializer.anchor_node`. */
  private anchorNode(node: RepresentedNode): void {
    if (this.anchors.has(node)) {
      if (this.anchors.get(node) === null) {
        this.lastAnchorId += 1
        this.anchors.set(node, `id${String(this.lastAnchorId).padStart(3, "0")}`)
      }
      return
    }
    this.anchors.set(node, null)
    if (node.kind === "sequence") {
      for (const item of node.items) this.anchorNode(item)
    } else if (node.kind === "mapping") {
      for (const [key, value] of node.items) {
        this.anchorNode(key)
        this.anchorNode(value)
      }
    }
  }

  // --- node emission --------------------------------------------------------

  private emitNode(
    node: RepresentedNode,
    context: { root?: boolean; sequence?: boolean; mapping?: boolean; simpleKey?: boolean },
  ): void {
    const rootContext = context.root === true
    const mappingContext = context.mapping === true
    const simpleKeyContext = context.simpleKey === true

    const anchor = this.anchors.get(node) ?? null
    if (this.serialized.has(node)) {
      // `AliasEvent`.
      this.writeIndicator(`*${anchor}`, true)
      return
    }
    this.serialized.add(node)

    if (anchor !== null) this.writeIndicator(`&${anchor}`, true)

    if (node.kind === "scalar") {
      const analysis = analyzeScalar(node.value, this.allowUnicode)
      const detected = resolveImplicitTag(node.value)
      const implicit: [boolean, boolean] = [node.tag === detected, node.tag === TAG_STR]
      const style = chooseScalarStyle(node.style, implicit, analysis, simpleKeyContext)
      this.processTag(node.tag, style, implicit)
      // `expect_scalar` indents one level deeper than its parent, which is the
      // indent a folded line or a break inside a quoted scalar continues at.
      this.increaseIndent(true, false)
      this.processScalar(analysis, style, simpleKeyContext, rootContext)
      this.indent = this.indents.pop() ?? null
      return
    }

    if (node.kind === "sequence") {
      this.processTag(node.tag, null, [node.tag === TAG_SEQ, false])
      if (node.items.length === 0) {
        this.writeIndicator("[", true, true)
        this.writeIndicator("]", false)
        return
      }
      this.emitBlockSequence(node, mappingContext)
      return
    }

    this.processTag(node.tag, null, [node.tag === TAG_MAP, false])
    if (node.items.length === 0) {
      this.writeIndicator("{", true, true)
      this.writeIndicator("}", false)
      return
    }
    this.emitBlockMapping(node)
  }

  private emitBlockSequence(node: SequenceNode, mappingContext: boolean): void {
    const indentless = mappingContext && !this.indention
    this.increaseIndent(false, indentless)
    for (const item of node.items) {
      this.writeIndent()
      this.writeIndicator("-", true, false, true)
      this.emitNode(item, { sequence: true })
    }
    this.indent = this.indents.pop() ?? null
  }

  private emitBlockMapping(node: MappingNode): void {
    this.increaseIndent(false, false)
    for (const [key, value] of node.items) {
      this.writeIndent()
      if (this.checkSimpleKey(key)) {
        this.emitNode(key, { mapping: true, simpleKey: true })
        this.writeIndicator(":", false)
        this.emitNode(value, { mapping: true })
      } else {
        this.writeIndicator("?", true, false, true)
        this.emitNode(key, { mapping: true })
        this.writeIndent()
        this.writeIndicator(":", true, false, true)
        this.emitNode(value, { mapping: true })
      }
    }
    this.indent = this.indents.pop() ?? null
  }

  /** `Emitter.check_simple_key`. */
  private checkSimpleKey(node: RepresentedNode): boolean {
    let length = 0
    if (this.serialized.has(node)) {
      // An alias key: `check_simple_key` counts the anchor and stops there.
      const anchor = this.anchors.get(node) ?? ""
      return anchor.length < 128
    }
    const anchor = this.anchors.get(node) ?? null
    if (anchor !== null) length += anchor.length
    // The tag is measured whether or not it ends up being written, because
    // `check_simple_key` prepares it from `event.tag`, which is never None for
    // a represented node.
    length += prepareTag(node.tag).length

    if (node.kind === "scalar") {
      const analysis = analyzeScalar(node.value, this.allowUnicode)
      length += analysis.scalar.length
      return length < 128 && !analysis.empty && !analysis.multiline
    }
    return length < 128 && node.items.length === 0
  }

  /** `Emitter.process_tag`. */
  private processTag(tag: string, style: string | null, implicit: [boolean, boolean]): void {
    if (style !== null) {
      if ((style === "" && implicit[0]) || (style !== "" && implicit[1])) return
    } else if (implicit[0]) {
      return
    }
    const prepared = prepareTag(tag)
    if (prepared) this.writeIndicator(prepared, true)
  }

  /** `Emitter.process_scalar`. */
  private processScalar(
    analysis: ScalarAnalysis,
    style: string,
    simpleKeyContext: boolean,
    rootContext: boolean,
  ): void {
    const split = !simpleKeyContext
    if (style === '"') this.writeDoubleQuoted(analysis.scalar, split)
    else if (style === "'") this.writeSingleQuoted(analysis.scalar, split)
    else if (style === "|") this.writeLiteral(analysis.scalar)
    else if (style === ">") this.writeFolded(analysis.scalar)
    else this.writePlain(analysis.scalar, split, rootContext)
  }

  // --- writers --------------------------------------------------------------

  private increaseIndent(flow: boolean, indentless: boolean): void {
    this.indents.push(this.indent)
    if (this.indent === null) this.indent = flow ? this.bestIndent : 0
    else if (!indentless) this.indent += this.bestIndent
  }

  private write(data: string, columns: number): void {
    this.column += columns
    this.out.push(data)
  }

  private writeIndicator(
    indicator: string,
    needWhitespace: boolean,
    whitespace = false,
    indention = false,
  ): void {
    const data = this.whitespace || !needWhitespace ? indicator : ` ${indicator}`
    this.whitespace = whitespace
    this.indention = this.indention && indention
    this.openEnded = false
    this.write(data, [...data].length)
  }

  private writeIndent(): void {
    const indent = this.indent ?? 0
    if (
      !this.indention ||
      this.column > indent ||
      (this.column === indent && !this.whitespace)
    ) {
      this.writeLineBreak()
    }
    if (this.column < indent) {
      this.whitespace = true
      const data = " ".repeat(indent - this.column)
      this.column = indent
      this.out.push(data)
    }
  }

  private writeLineBreak(data?: string): void {
    this.whitespace = true
    this.indention = true
    this.column = 0
    this.out.push(data ?? this.lineBreak)
  }

  /** `Emitter.write_single_quoted`. */
  private writeSingleQuoted(text: readonly string[], split: boolean): void {
    this.writeIndicator("'", true)
    let spaces = false
    let breaks = false
    let start = 0
    let end = 0
    while (end <= text.length) {
      const ch: string | null = end < text.length ? text[end] : null
      if (spaces) {
        if (ch === null || ch !== " ") {
          if (start + 1 === end && this.column > this.bestWidth && split && start !== 0 && end !== text.length) {
            this.writeIndent()
          } else {
            const data = text.slice(start, end)
            this.write(data.join(""), data.length)
          }
          start = end
        }
      } else if (breaks) {
        if (ch === null || !BREAKS.has(ch)) {
          if (text[start] === "\n") this.writeLineBreak()
          for (const br of text.slice(start, end)) {
            if (br === "\n") this.writeLineBreak()
            else this.writeLineBreak(br)
          }
          this.writeIndent()
          start = end
        }
      } else if (ch === null || ch === " " || BREAKS.has(ch) || ch === "'") {
        if (start < end) {
          const data = text.slice(start, end)
          this.write(data.join(""), data.length)
          start = end
        }
      }
      if (ch === "'") {
        this.write("''", 2)
        start = end + 1
      }
      if (ch !== null) {
        spaces = ch === " "
        breaks = BREAKS.has(ch)
      }
      end += 1
    }
    this.writeIndicator("'", false)
  }

  /** `Emitter.write_double_quoted`. */
  private writeDoubleQuoted(text: readonly string[], split: boolean): void {
    this.writeIndicator('"', true)
    let start = 0
    let end = 0
    while (end <= text.length) {
      const ch: string | null = end < text.length ? text[end] : null
      if (ch === null || needsEscape(ch, this.allowUnicode)) {
        if (start < end) {
          const data = text.slice(start, end)
          this.write(data.join(""), data.length)
          start = end
        }
        if (ch !== null) {
          const code = ch.codePointAt(0) ?? 0
          let data: string
          if (ch in ESCAPE_REPLACEMENTS) data = `\\${ESCAPE_REPLACEMENTS[ch]}`
          else if (code <= 0xff) data = `\\x${hex(code, 2)}`
          else if (code <= 0xffff) data = `\\u${hex(code, 4)}`
          else data = `\\U${hex(code, 8)}`
          this.write(data, data.length)
          start = end + 1
        }
      }
      if (
        end > 0 &&
        end < text.length - 1 &&
        (ch === " " || start >= end) &&
        this.column + (end - start) > this.bestWidth &&
        split
      ) {
        const chunk = text.slice(start, end)
        const data = `${chunk.join("")}\\`
        if (start < end) start = end
        this.write(data, chunk.length + 1)
        this.writeIndent()
        this.whitespace = false
        this.indention = false
        if (text[start] === " ") this.write("\\", 1)
      }
      end += 1
    }
    this.writeIndicator('"', false)
  }

  /** `Emitter.determine_block_hints`. */
  private determineBlockHints(text: readonly string[]): string {
    let hints = ""
    if (text.length > 0) {
      if (text[0] === " " || BREAKS.has(text[0])) hints += String(this.bestIndent)
      if (!BREAKS.has(text[text.length - 1])) hints += "-"
      else if (text.length === 1 || BREAKS.has(text[text.length - 2])) hints += "+"
    }
    return hints
  }

  /** `Emitter.write_literal`. */
  private writeLiteral(text: readonly string[]): void {
    const hints = this.determineBlockHints(text)
    this.writeIndicator(`|${hints}`, true)
    if (hints.endsWith("+")) this.openEnded = true
    this.writeLineBreak()
    let breaks = true
    let start = 0
    let end = 0
    while (end <= text.length) {
      const ch: string | null = end < text.length ? text[end] : null
      if (breaks) {
        if (ch === null || !BREAKS.has(ch)) {
          for (const br of text.slice(start, end)) {
            if (br === "\n") this.writeLineBreak()
            else this.writeLineBreak(br)
          }
          if (ch !== null) this.writeIndent()
          start = end
        }
      } else if (ch === null || BREAKS.has(ch)) {
        // `write_literal` writes the run without touching `column`, which is
        // what PyYAML does: the following break resets it anyway.
        this.out.push(text.slice(start, end).join(""))
        if (ch === null) this.writeLineBreak()
        start = end
      }
      if (ch !== null) breaks = BREAKS.has(ch)
      end += 1
    }
  }

  /** `Emitter.write_folded`. */
  private writeFolded(text: readonly string[]): void {
    const hints = this.determineBlockHints(text)
    this.writeIndicator(`>${hints}`, true)
    if (hints.endsWith("+")) this.openEnded = true
    this.writeLineBreak()
    let leadingSpace = true
    let spaces = false
    let breaks = true
    let start = 0
    let end = 0
    while (end <= text.length) {
      const ch: string | null = end < text.length ? text[end] : null
      if (breaks) {
        if (ch === null || !BREAKS.has(ch)) {
          if (!leadingSpace && ch !== null && ch !== " " && text[start] === "\n") {
            this.writeLineBreak()
          }
          leadingSpace = ch === " "
          for (const br of text.slice(start, end)) {
            if (br === "\n") this.writeLineBreak()
            else this.writeLineBreak(br)
          }
          if (ch !== null) this.writeIndent()
          start = end
        }
      } else if (spaces) {
        if (ch !== " ") {
          if (start + 1 === end && this.column > this.bestWidth) this.writeIndent()
          else {
            const data = text.slice(start, end)
            this.write(data.join(""), data.length)
          }
          start = end
        }
      } else if (ch === null || ch === " " || BREAKS.has(ch)) {
        const data = text.slice(start, end)
        this.write(data.join(""), data.length)
        if (ch === null) this.writeLineBreak()
        start = end
      }
      if (ch !== null) {
        breaks = BREAKS.has(ch)
        spaces = ch === " "
      }
      end += 1
    }
  }

  /** `Emitter.write_plain`. */
  private writePlain(text: readonly string[], split: boolean, rootContext: boolean): void {
    // A plain scalar at the root leaves the document open ended, which is what
    // makes `yaml.dump('hello')` end with a `...` line.
    if (rootContext) this.openEnded = true
    if (text.length === 0) return
    if (!this.whitespace) this.write(" ", 1)
    this.whitespace = false
    this.indention = false
    let spaces = false
    let breaks = false
    let start = 0
    let end = 0
    while (end <= text.length) {
      const ch: string | null = end < text.length ? text[end] : null
      if (spaces) {
        if (ch !== " ") {
          if (start + 1 === end && this.column > this.bestWidth && split) {
            this.writeIndent()
            this.whitespace = false
            this.indention = false
          } else {
            const data = text.slice(start, end)
            this.write(data.join(""), data.length)
          }
          start = end
        }
      } else if (breaks) {
        if (ch === null || !BREAKS.has(ch)) {
          if (text[start] === "\n") this.writeLineBreak()
          for (const br of text.slice(start, end)) {
            if (br === "\n") this.writeLineBreak()
            else this.writeLineBreak(br)
          }
          this.writeIndent()
          this.whitespace = false
          this.indention = false
          start = end
        }
      } else if (ch === null || ch === " " || BREAKS.has(ch)) {
        const data = text.slice(start, end)
        this.write(data.join(""), data.length)
        start = end
      }
      if (ch !== null) {
        spaces = ch === " "
        breaks = BREAKS.has(ch)
      }
      end += 1
    }
  }
}

function hex(code: number, width: number): string {
  return code.toString(16).toUpperCase().padStart(width, "0")
}

/** The `write_double_quoted` test for a character that cannot be written raw. */
function needsEscape(ch: string, allowUnicode: boolean): boolean {
  if (ch === '"' || ch === "\\" || ch === "\u0085" || ch === "\u2028" || ch === "\u2029") return true
  if (ch === "\ufeff") return true
  const code = ch.codePointAt(0) ?? 0
  if (code >= 0x20 && code <= 0x7e) return false
  if (
    allowUnicode &&
    ((code >= 0xa0 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd))
  ) {
    return false
  }
  return true
}

/** `Emitter.prepare_tag` with the default tag prefixes. */
function prepareTag(tag: string): string {
  if (!tag) throw new YamlError("tag must not be empty")
  if (tag === "!") return tag

  let handle: string | null = null
  let suffix = tag
  // `sorted(self.tag_prefixes.keys())` is ['!', 'tag:yaml.org,2002:'], and the
  // loop keeps the last prefix that matches.
  for (const prefix of ["!", "tag:yaml.org,2002:"]) {
    if (tag.startsWith(prefix) && (prefix === "!" || prefix.length < tag.length)) {
      handle = prefix === "!" ? "!" : "!!"
      suffix = tag.slice(prefix.length)
    }
  }

  let text = ""
  for (const ch of suffix) {
    if (/[0-9A-Za-z\-;/?:@&=+$,_.~*'()[\]]/.test(ch) || (ch === "!" && handle !== "!")) {
      text += ch
    } else {
      for (const byte of new TextEncoder().encode(ch)) {
        text += `%${hex(byte, 2)}`
      }
    }
  }
  return handle ? `${handle}${text}` : `!<${text}>`
}

/** `Emitter.choose_scalar_style`. */
function chooseScalarStyle(
  style: string | null,
  implicit: [boolean, boolean],
  analysis: ScalarAnalysis,
  simpleKeyContext: boolean,
): string {
  if (style === '"') return '"'
  if (!style && implicit[0]) {
    if (!(simpleKeyContext && (analysis.empty || analysis.multiline)) && analysis.allowBlockPlain) {
      return ""
    }
  }
  if (style && (style === "|" || style === ">")) {
    if (!simpleKeyContext && analysis.allowBlock) return style
  }
  if (!style || style === "'") {
    if (analysis.allowSingleQuoted && !(simpleKeyContext && analysis.multiline)) return "'"
  }
  return '"'
}

/** `Emitter.analyze_scalar`. */
export function analyzeScalar(value: string, allowUnicode: boolean): ScalarAnalysis {
  const scalar = [...value]
  if (scalar.length === 0) {
    return {
      scalar,
      empty: true,
      multiline: false,
      allowFlowPlain: false,
      allowBlockPlain: true,
      allowSingleQuoted: true,
      allowDoubleQuoted: true,
      allowBlock: false,
    }
  }

  let blockIndicators = false
  let flowIndicators = false
  let lineBreaks = false
  let specialCharacters = false

  let leadingSpace = false
  let leadingBreak = false
  let trailingSpace = false
  let trailingBreak = false
  let breakSpace = false
  let spaceBreak = false

  if (value.startsWith("---") || value.startsWith("...")) {
    blockIndicators = true
    flowIndicators = true
  }

  let precededByWhitespace = true
  let followedByWhitespace = scalar.length === 1 || WHITESPACE_OR_BREAK.has(scalar[1])
  let previousSpace = false
  let previousBreak = false

  let index = 0
  while (index < scalar.length) {
    const ch = scalar[index]

    if (index === 0) {
      if ("#,[]{}&*!|>'\"%@`".includes(ch)) {
        flowIndicators = true
        blockIndicators = true
      }
      if (ch === "?" || ch === ":") {
        flowIndicators = true
        if (followedByWhitespace) blockIndicators = true
      }
      if (ch === "-" && followedByWhitespace) {
        flowIndicators = true
        blockIndicators = true
      }
    } else {
      if (",?[]{}".includes(ch)) flowIndicators = true
      if (ch === ":") {
        flowIndicators = true
        if (followedByWhitespace) blockIndicators = true
      }
      if (ch === "#" && precededByWhitespace) {
        flowIndicators = true
        blockIndicators = true
      }
    }

    if (BREAKS.has(ch)) lineBreaks = true
    if (!(ch === "\n" || (ch >= "\x20" && ch <= "\x7e"))) {
      const code = ch.codePointAt(0) ?? 0
      if (
        (ch === "\x85" ||
          (code >= 0xa0 && code <= 0xd7ff) ||
          (code >= 0xe000 && code <= 0xfffd) ||
          (code >= 0x10000 && code < 0x10ffff)) &&
        ch !== "\ufeff"
      ) {
        if (!allowUnicode) specialCharacters = true
      } else {
        specialCharacters = true
      }
    }

    if (ch === " ") {
      if (index === 0) leadingSpace = true
      if (index === scalar.length - 1) trailingSpace = true
      if (previousBreak) breakSpace = true
      previousSpace = true
      previousBreak = false
    } else if (BREAKS.has(ch)) {
      if (index === 0) leadingBreak = true
      if (index === scalar.length - 1) trailingBreak = true
      if (previousSpace) spaceBreak = true
      previousSpace = false
      previousBreak = true
    } else {
      previousSpace = false
      previousBreak = false
    }

    index += 1
    precededByWhitespace = WHITESPACE_OR_BREAK.has(ch)
    followedByWhitespace =
      index + 1 >= scalar.length || WHITESPACE_OR_BREAK.has(scalar[index + 1])
  }

  let allowFlowPlain = true
  let allowBlockPlain = true
  let allowSingleQuoted = true
  const allowDoubleQuoted = true
  let allowBlock = true

  if (leadingSpace || leadingBreak || trailingSpace || trailingBreak) {
    allowFlowPlain = false
    allowBlockPlain = false
  }
  if (trailingSpace) allowBlock = false
  if (breakSpace) {
    allowFlowPlain = false
    allowBlockPlain = false
    allowSingleQuoted = false
  }
  if (spaceBreak || specialCharacters) {
    allowFlowPlain = false
    allowBlockPlain = false
    allowSingleQuoted = false
    allowBlock = false
  }
  if (lineBreaks) {
    allowFlowPlain = false
    allowBlockPlain = false
  }
  if (flowIndicators) allowFlowPlain = false
  if (blockIndicators) allowBlockPlain = false

  return {
    scalar,
    empty: false,
    multiline: lineBreaks,
    allowFlowPlain,
    allowBlockPlain,
    allowSingleQuoted,
    allowDoubleQuoted,
    allowBlock,
  }
}

/** `yaml.dump(data, default_flow_style=False, allow_unicode=True)`. */
export function dump(data: unknown): string {
  const node = new Representer().represent(data)
  return new Emitter().emitDocument(node)
}
