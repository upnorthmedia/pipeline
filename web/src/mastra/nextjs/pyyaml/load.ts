/**
 * `yaml.safe_load`, ported to TypeScript (ledger item 5.3c-iii-b-2-b).
 *
 * `_apply_mapping_to_content` loads a post's frontmatter block with PyYAML's
 * `SafeLoader`, which is a YAML **1.1** reader: `yes` is a bool, `017` is
 * octal, `1:30` is sexagesimal, `2026-08-23` is a `datetime.date` and `1e3` is
 * a *string*, because PyYAML's float pattern needs both a dot and a signed
 * exponent. Every JavaScript YAML reader resolves YAML 1.2 instead and
 * disagrees with all five.
 *
 * So the `yaml` package is used for **syntax only**: `parseAllDocuments` gives
 * the node tree, and every scalar keeps its raw `source` and its `type`
 * (plain, quoted, block). Tag resolution and construction below are ports of
 * PyYAML's `resolver.py` and the `SafeConstructor` half of `constructor.py`,
 * so a plain scalar is resolved by PyYAML's own regexes against PyYAML's own
 * constructors, not by the library's schema.
 *
 * Three things are deliberately not reproduced:
 *
 * - **Error text.** A malformed document raises here as it does in Python and
 *   fails the publish the same way, but the message is the `yaml` package's,
 *   not PyYAML's scanner's. Only the fact of the failure is a contract.
 * - **Recursive anchors.** `&a [*a]` builds a self-referential list in Python.
 *   Here the alias resolves against values already constructed, so a node that
 *   aliases itself raises instead. Frontmatter cannot usefully contain one.
 * - **Duplicate-key warnings.** PyYAML overwrites silently, which is what
 *   happens here; the `yaml` package's own duplicate-key error is disabled.
 * - **NEL, LS and PS as line breaks.** YAML 1.1 counts U+0085, U+2028 and
 *   U+2029 as line breaks; the `yaml` package counts only CR and LF whatever
 *   version it is given. A *literal* one of those three inside a frontmatter
 *   scalar therefore stays content here, where PyYAML would have folded it
 *   (to a space for NEL, to itself for LS and PS). Rewriting them to newlines
 *   was tried and is worse: the `yaml` package rejects a quoted scalar whose
 *   continuation line is not indented past its parent, which PyYAML accepts,
 *   so the rewrite failed documents Python reads fine. The escaped forms
 *   (`"\\N"`, `"\\L"`, `"\\P"`) are content in both and do agree.
 */

import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Alias,
  type Document,
  type Node,
  type Scalar,
  type YAMLMap,
  type YAMLSeq,
} from "yaml"

import { PyDate, PyDateTime, PyFloat, PyTuple, pyDictSet, pyEqual, YamlError } from "./values"

const TAG_NULL = "tag:yaml.org,2002:null"
const TAG_BOOL = "tag:yaml.org,2002:bool"
const TAG_INT = "tag:yaml.org,2002:int"
const TAG_FLOAT = "tag:yaml.org,2002:float"
const TAG_STR = "tag:yaml.org,2002:str"
const TAG_MERGE = "tag:yaml.org,2002:merge"
const TAG_VALUE = "tag:yaml.org,2002:value"
const TAG_TIMESTAMP = "tag:yaml.org,2002:timestamp"
const TAG_BINARY = "tag:yaml.org,2002:binary"
const TAG_SEQ = "tag:yaml.org,2002:seq"
const TAG_MAP = "tag:yaml.org,2002:map"
const TAG_SET = "tag:yaml.org,2002:set"
const TAG_OMAP = "tag:yaml.org,2002:omap"
const TAG_PAIRS = "tag:yaml.org,2002:pairs"

/**
 * `Resolver.add_implicit_resolver` calls from `resolver.py`, in registration
 * order, each with the first characters it was registered under. PyYAML tries
 * only the resolvers registered for the scalar's first character (and then the
 * wildcard list, which is empty), so the first-character list is part of the
 * resolution and not an index.
 */
const IMPLICIT_RESOLVERS: { tag: string; pattern: RegExp; first: string[] }[] = [
  {
    tag: TAG_BOOL,
    pattern: /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/,
    first: [..."yYnNtTfFoO"],
  },
  {
    tag: TAG_FLOAT,
    pattern:
      /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/,
    first: [..."-+0123456789."],
  },
  {
    tag: TAG_INT,
    pattern:
      /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/,
    first: [..."-+0123456789"],
  },
  { tag: TAG_MERGE, pattern: /^(?:<<)$/, first: ["<"] },
  { tag: TAG_NULL, pattern: /^(?:~|null|Null|NULL|)$/, first: ["~", "n", "N", ""] },
  {
    tag: TAG_TIMESTAMP,
    pattern:
      /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/,
    first: [..."0123456789"],
  },
  { tag: TAG_VALUE, pattern: /^(?:=)$/, first: ["="] },
  // Registered by PyYAML "for documentation purposes": a plain scalar cannot
  // start with any of these three, so the entry never matches.
  { tag: "tag:yaml.org,2002:yaml", pattern: /^(?:!|&|\*)$/, first: [..."!&*"] },
]

/** `Resolver.resolve(ScalarNode, value, (True, False))` for a plain scalar. */
export function resolveImplicitTag(value: string): string {
  const first = value === "" ? "" : value[0]
  for (const resolver of IMPLICIT_RESOLVERS) {
    if (!resolver.first.includes(first)) continue
    if (resolver.pattern.test(value)) return resolver.tag
  }
  return TAG_STR
}

/** `SafeConstructor.bool_values`. */
const BOOL_VALUES: Record<string, boolean> = {
  yes: true,
  no: false,
  true: true,
  false: false,
  on: true,
  off: false,
}

// `tsconfig.json` targets ES2017, where a `0n` literal is a compile error, so
// the `bigint`s below are built with `BigInt()`.
const ZERO = BigInt(0)
const ONE = BigInt(1)
const SIXTY = BigInt(60)

/** `SafeConstructor.construct_yaml_int`. */
export function constructInt(raw: string): bigint {
  let value = raw.replaceAll("_", "")
  let sign = ONE
  if (value[0] === "-") sign = -ONE
  if (value[0] === "+" || value[0] === "-") value = value.slice(1)
  if (value === "0") return ZERO
  if (value.startsWith("0b")) return sign * BigInt(value)
  if (value.startsWith("0x")) return sign * BigInt(value)
  if (value[0] === "0") return sign * BigInt(`0o${value}`)
  if (value.includes(":")) {
    let total = ZERO
    let base = ONE
    for (const part of value.split(":").reverse()) {
      total += BigInt(part) * base
      base *= SIXTY
    }
    return sign * total
  }
  return sign * BigInt(value)
}

/** `SafeConstructor.construct_yaml_float`. */
export function constructFloat(raw: string): number {
  let value = raw.replaceAll("_", "").toLowerCase()
  let sign = 1
  if (value[0] === "-") sign = -1
  if (value[0] === "+" || value[0] === "-") value = value.slice(1)
  if (value === ".inf") return sign * Infinity
  if (value === ".nan") return NaN
  if (value.includes(":")) {
    let total = 0
    let base = 1
    for (const part of value.split(":").reverse()) {
      total += Number(part) * base
      base *= 60
    }
    return sign * total
  }
  return sign * Number(value)
}

/** `SafeConstructor.timestamp_regexp`. */
const TIMESTAMP_RE =
  /^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:(?:[Tt]|[ \t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\.([0-9]*))?(?:[ \t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?)?$/

/** `SafeConstructor.construct_yaml_timestamp`. */
export function constructTimestamp(raw: string): PyDate | PyDateTime {
  const match = TIMESTAMP_RE.exec(raw)
  if (!match) throw new YamlError(`failed to construct a timestamp from ${raw}`)
  const [, year, month, day, hour, minute, second, fractionText, tz, tzSign, tzHour, tzMinute] =
    match
  if (!hour) return new PyDate(Number(year), Number(month), Number(day))

  let microsecond = 0
  if (fractionText) microsecond = Number(fractionText.slice(0, 6).padEnd(6, "0"))

  let tzOffsetMinutes: number | null = null
  if (tzSign) {
    const delta = Number(tzHour) * 60 + Number(tzMinute ?? 0)
    tzOffsetMinutes = tzSign === "-" ? -delta : delta
  } else if (tz) {
    tzOffsetMinutes = 0
  }

  return new PyDateTime(
    Number(year),
    Number(month),
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    microsecond,
    tzOffsetMinutes,
  )
}

/** `SafeConstructor.construct_yaml_binary`, which is `base64.decodebytes`. */
function constructBinary(raw: string): Uint8Array {
  const cleaned = raw.replace(/\s+/g, "")
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new YamlError("failed to decode base64 data")
  }
  const binary = atob(cleaned)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** `isinstance(key, collections.abc.Hashable)` for a constructed value. */
function isHashable(value: unknown): boolean {
  return !Array.isArray(value) && !(value instanceof Map) && !(value instanceof Set)
}

/**
 * `Reader.check_printable`, which rejects a document holding a control
 * character before any of it is scanned. The `yaml` package accepts them, so
 * without this a frontmatter block containing NUL, ESC or DEL would publish
 * where Python failed the publish.
 */
const NON_PRINTABLE =
  /[^\t\n\r\u0020-\u007e\u0085\u00a0-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u

/** `yaml.safe_load(text)`. */
export function safeLoad(text: string): unknown {
  const unacceptable = NON_PRINTABLE.exec(text)
  if (unacceptable) {
    const code = (unacceptable[0].codePointAt(0) ?? 0).toString(16).padStart(4, "0")
    throw new YamlError(`unacceptable character #x${code}: special characters are not allowed`)
  }

  const documents = parseAllDocuments(text, { version: "1.1", uniqueKeys: false })

  for (const document of documents) {
    if (document.errors.length > 0) {
      throw new YamlError(document.errors[0].message)
    }
  }
  if (documents.length === 0) return null
  if (documents.length > 1) {
    throw new YamlError("expected a single document in the stream")
  }

  const document = documents[0] as Document
  for (const warning of document.warnings) {
    // The `yaml` package reports an unresolved tag as a warning and falls back
    // to a string; PyYAML raises a ConstructorError and loads nothing.
    throw new YamlError(warning.message)
  }
  if (document.contents === null || document.contents === undefined) return null

  return new Loader().construct(document.contents as Node)
}

/** A mapping entry, either half of which can be missing from the tree. */
type MappingPair = [Node | null, Node | null]

class Loader {
  /** Anchor name to constructed value, for `Alias` nodes. */
  private readonly values = new Map<string, unknown>()
  /** Anchor name to node, for a `<<` whose value is an alias. */
  private readonly nodes = new Map<string, Node>()

  construct(node: Node): unknown {
    return this.constructNode(node)
  }

  /**
   * `key:` with nothing after it has no value node in the `yaml` package's
   * tree, where PyYAML composes an empty plain scalar that resolves to null.
   */
  private constructNode(node: Node | null | undefined): unknown {
    if (node === null || node === undefined) return null
    if (isAlias(node)) return this.resolveAliasValue(node)

    const anchor = (node as { anchor?: string }).anchor
    if (anchor) this.nodes.set(anchor, node)

    let value: unknown
    if (isScalar(node)) value = this.constructScalar(node)
    else if (isSeq(node)) value = this.constructSequence(node)
    else if (isMap(node)) value = this.constructMapping(node)
    else throw new YamlError("unexpected node in the document")

    if (anchor) this.values.set(anchor, value)
    return value
  }

  private resolveAliasValue(node: Alias): unknown {
    if (!this.values.has(node.source)) {
      throw new YamlError(`found undefined alias ${node.source}`)
    }
    return this.values.get(node.source)
  }

  private resolveAliasNode(node: Node): Node {
    if (!isAlias(node)) return node
    const target = this.nodes.get(node.source)
    if (!target) throw new YamlError(`found undefined alias ${node.source}`)
    return target
  }

  /** The scalar's text as PyYAML's scanner would have produced it. */
  private scalarText(node: Scalar): string {
    if (typeof node.value === "string") return node.value
    return node.source ?? ""
  }

  private constructScalar(node: Scalar): unknown {
    const text = this.scalarText(node)
    const plain = node.type === undefined || node.type === "PLAIN"
    const tag = node.tag ?? (plain ? resolveImplicitTag(text) : TAG_STR)
    return this.constructByTag(tag, text)
  }

  private constructByTag(tag: string, text: string): unknown {
    switch (tag) {
      case TAG_NULL:
        return null
      case TAG_BOOL: {
        const resolved = BOOL_VALUES[text.toLowerCase()]
        if (resolved === undefined) throw new YamlError(`could not construct a bool from ${text}`)
        return resolved
      }
      case TAG_INT:
        return constructInt(text)
      case TAG_FLOAT:
        return new PyFloat(constructFloat(text))
      case TAG_TIMESTAMP:
        return constructTimestamp(text)
      case TAG_BINARY:
        return constructBinary(text)
      case TAG_STR:
      case TAG_VALUE:
      case TAG_MERGE:
        return text
      default:
        throw new YamlError(`could not determine a constructor for the tag '${tag}'`)
    }
  }

  private constructSequence(node: YAMLSeq): unknown[] {
    const tag = node.tag
    if (tag === TAG_OMAP || tag === TAG_PAIRS) return this.constructPairs(node, tag)
    if (tag !== undefined && tag !== null && tag !== TAG_SEQ) {
      throw new YamlError(`could not determine a constructor for the tag '${tag}'`)
    }
    return node.items.map((item) => this.constructNode(item as Node))
  }

  /**
   * `construct_yaml_omap` / `construct_yaml_pairs`: a list of 2-tuples.
   *
   * A tagged `!!omap` or `!!pairs` sequence holds `Pair` nodes directly in the
   * `yaml` package's tree, where an untagged one holds single-entry maps.
   */
  private constructPairs(node: YAMLSeq, tag: string): PyTuple[] {
    const kind = tag === TAG_OMAP ? "an ordered map" : "pairs"
    return node.items.map((item) => {
      if (isPair(item)) {
        return new PyTuple([
          this.constructNode(item.key as Node),
          this.constructNode(item.value as Node),
        ])
      }
      const entry = this.resolveAliasNode(item as Node)
      if (!isMap(entry)) {
        throw new YamlError(`while constructing ${kind}, expected a mapping`)
      }
      if (entry.items.length !== 1) {
        throw new YamlError(`while constructing ${kind}, expected a single mapping item`)
      }
      const pair = entry.items[0]
      return new PyTuple([
        this.constructNode(pair.key as Node),
        this.constructNode(pair.value as Node),
      ])
    })
  }

  private constructMapping(node: YAMLMap): Map<unknown, unknown> | Set<unknown> {
    const tag = node.tag
    if (tag !== undefined && tag !== null && tag !== TAG_MAP && tag !== TAG_SET) {
      throw new YamlError(`could not determine a constructor for the tag '${tag}'`)
    }

    const pairs = this.flattenMapping(node)
    if (tag === TAG_SET) {
      const result = new Set<unknown>()
      for (const [keyNode] of pairs) {
        const key = this.constructNode(keyNode)
        if (!isHashable(key)) throw new YamlError("found unhashable key")
        let seen = false
        for (const existing of result) if (pyEqual(existing, key)) seen = true
        if (!seen) result.add(key)
      }
      return result
    }

    const result = new Map<unknown, unknown>()
    for (const [keyNode, valueNode] of pairs) {
      const key = this.constructNode(keyNode)
      if (!isHashable(key)) throw new YamlError("found unhashable key")
      pyDictSet(result, key, this.constructNode(valueNode))
    }
    return result
  }

  /** `SafeConstructor.flatten_mapping`: `<<` pairs are prepended, in order. */
  private flattenMapping(node: YAMLMap): MappingPair[] {
    const own: MappingPair[] = []
    const merged: MappingPair[] = []

    for (const item of node.items) {
      const keyNode = item.key as Node | null
      const valueNode = item.value as Node | null
      if (keyNode !== null && keyNode !== undefined && this.isMergeKey(keyNode)) {
          merged.push(...this.mergePairs(valueNode))
        continue
      }
      own.push([keyNode, valueNode])
    }

    return [...merged, ...own]
  }

  private isMergeKey(node: Node): boolean {
    if (!isScalar(node)) return false
    if (node.tag !== undefined && node.tag !== null) return node.tag === TAG_MERGE
    const plain = node.type === undefined || node.type === "PLAIN"
    return plain && resolveImplicitTag(this.scalarText(node)) === TAG_MERGE
  }

  private mergePairs(valueNode: Node | null): MappingPair[] {
    if (valueNode === null || valueNode === undefined) {
      throw new YamlError("expected a mapping or list of mappings for merging")
    }
    const target = this.resolveAliasNode(valueNode)
    if (isMap(target)) return this.flattenMapping(target)
    if (isSeq(target)) {
      const submerge: MappingPair[][] = []
      for (const item of target.items) {
        const entry = this.resolveAliasNode(item as Node)
        if (!isMap(entry)) {
          throw new YamlError("expected a mapping for merging")
        }
        submerge.push(this.flattenMapping(entry))
      }
      submerge.reverse()
      return submerge.flat()
    }
    throw new YamlError("expected a mapping or list of mappings for merging")
  }
}

