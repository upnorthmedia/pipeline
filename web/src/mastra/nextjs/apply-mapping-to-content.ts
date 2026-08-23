/**
 * TypeScript port of `_apply_mapping_to_content` in
 * `api/src/services/nextjs_publish.py` (ledger item 5.3c-iii-b-2-b).
 *
 * Sixteen lines that rewrite a post's YAML frontmatter block through the
 * user's saved mapping. Four of them decide the bytes a reader's blog repo
 * receives:
 *
 * - `content.split("---", 2)` splits on the *substring*, not on a fence line,
 *   so `----` is two splits with an empty middle part and a `---` inside the
 *   body is what ends the block. Three parts are required; anything else
 *   returns the content untouched.
 * - `yaml.safe_load(parts[1]) or {}` reads YAML 1.1, and the `or {}` means a
 *   frontmatter block that loads to any falsy value (`None`, `''`, `[]`, `0`)
 *   is replaced by an empty dict, which then emits as `{}`.
 * - A frontmatter block that loads to a *truthy non-dict* is not replaced, and
 *   `apply_frontmatter_mapping` then runs `in`, `[]` and `.get` against a
 *   string or a list. Those raise `TypeError` and `AttributeError`, and
 *   `publish_to_nextjs` catches neither, so the publish fails. See
 *   {@link applyMappingToNonDict}.
 * - `yaml.dump(mapped, default_flow_style=False, allow_unicode=True)` is what
 *   {@link dump} ports.
 *
 * Verified against `data/nextjs-mapping-to-content-parity.json`, written by
 * `api/scripts/export_mapping_to_content_parity.py` from the real function.
 */

import { applyFrontmatterMapping } from "./frontmatter-mapping"
import { dump } from "./pyyaml/dump"
import { safeLoad } from "./pyyaml/load"
import { PyAttributeError, PyDate, PyDateTime, PyFloat, PyTuple, PyTypeError } from "./pyyaml/values"

/** `text.split(separator, maxsplit)`. */
function pySplit(text: string, separator: string, maxsplit: number): string[] {
  const parts: string[] = []
  let rest = text
  while (parts.length < maxsplit) {
    const index = rest.indexOf(separator)
    if (index === -1) break
    parts.push(rest.slice(0, index))
    rest = rest.slice(index + separator.length)
  }
  parts.push(rest)
  return parts
}

/**
 * `bool(value)` for a value `yaml.safe_load` can return, and for the JSON
 * values `payload.ts` tests the same way. Exported for the latter.
 */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === "boolean") return value
  if (typeof value === "bigint") return value !== BigInt(0)
  if (typeof value === "number") return value !== 0
  if (value instanceof PyFloat) return value.value !== 0
  if (typeof value === "string") return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  if (value instanceof PyTuple) return value.items.length > 0
  if (value instanceof Uint8Array) return value.length > 0
  if (value instanceof Map) return value.size > 0
  if (value instanceof Set) return value.size > 0
  // A decoded JSON object, which `yaml.safe_load` never returns but the
  // `image_manifest` and `nextjs_frontmatter_map` columns do. An empty dict is
  // falsy in Python where every JavaScript object is truthy.
  if (isPlainObject(value)) return Object.keys(value).length > 0
  return true
}

function isPlainObject(value: unknown): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** `type(value).__name__`, for the error messages Python raises. */
function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType"
  if (typeof value === "boolean") return "bool"
  if (typeof value === "bigint") return "int"
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float"
  if (value instanceof PyFloat) return "float"
  if (typeof value === "string") return "str"
  if (Array.isArray(value)) return "list"
  if (value instanceof PyTuple) return "tuple"
  if (value instanceof Uint8Array) return "bytes"
  if (value instanceof Map) return "dict"
  if (value instanceof Set) return "set"
  if (value instanceof PyDateTime) return "datetime.datetime"
  if (value instanceof PyDate) return "datetime.date"
  return "object"
}

/** `needle in haystack`. */
function pyContains(haystack: unknown, needle: unknown): boolean {
  if (typeof haystack === "string") {
    if (typeof needle !== "string") {
      throw new PyTypeError(
        `'in <string>' requires string as left operand, not ${pyTypeName(needle)}`,
      )
    }
    return haystack.includes(needle)
  }
  if (Array.isArray(haystack)) return haystack.some((item) => pyItemEqual(item, needle))
  if (haystack instanceof PyTuple) return haystack.items.some((item) => pyItemEqual(item, needle))
  if (haystack instanceof Set) {
    for (const item of haystack) if (pyItemEqual(item, needle)) return true
    return false
  }
  throw new PyTypeError(`argument of type '${pyTypeName(haystack)}' is not iterable`)
}

/** `haystack[key]` for the sequence types a loaded document can hold. */
function pyGetItem(haystack: unknown, key: unknown): unknown {
  if (typeof haystack === "string") {
    throw new PyTypeError(`string indices must be integers, not '${pyTypeName(key)}'`)
  }
  if (Array.isArray(haystack) || haystack instanceof PyTuple) {
    const items = Array.isArray(haystack) ? haystack : haystack.items
    const kind = Array.isArray(haystack) ? "list" : "tuple"
    if (typeof key !== "bigint") {
      throw new PyTypeError(
        `${kind} indices must be integers or slices, not ${pyTypeName(key)}`,
      )
    }
    const index = key < BigInt(0) ? items.length + Number(key) : Number(key)
    if (index < 0 || index >= items.length) throw new PyTypeError(`${kind} index out of range`)
    return items[index]
  }
  throw new PyTypeError(`'${pyTypeName(haystack)}' object is not subscriptable`)
}

/** Python's `==` between a container's item and the key being looked up. */
function pyItemEqual(item: unknown, needle: unknown): boolean {
  if (typeof item === "string" || typeof needle === "string") return item === needle
  if (typeof item === "bigint" && typeof needle === "bigint") return item === needle
  return item === needle
}

/**
 * `apply_frontmatter_mapping` when the frontmatter is a truthy non-dict.
 *
 * Python does not type check its arguments, so this is the same loop reaching
 * `str.__contains__`, `str.__getitem__` and a missing `.get` instead of the
 * dict versions. It either returns an empty dict (nothing matched) or raises,
 * which is why the publish fails on a body whose first line is `---`.
 */
function applyMappingToNonDict(
  frontmatter: unknown,
  mapping: ReadonlyMap<unknown, unknown>,
): Map<unknown, unknown> {
  const result = new Map<unknown, unknown>()

  for (const [jenaField, target] of mapping) {
    if (typeof target === "string") {
      if (pyContains(frontmatter, jenaField)) {
        result.set(target, pyGetItem(frontmatter, jenaField))
      }
    } else if (typeof target === "object" && target !== null && !Array.isArray(target)) {
      throw new PyAttributeError(
        `'${pyTypeName(frontmatter)}' object has no attribute 'get'`,
      )
    }
  }

  return result
}

/** Apply a frontmatter mapping to the markdown content's YAML frontmatter. */
export function applyMappingToContent(
  content: string,
  mapping: ReadonlyMap<unknown, unknown>,
): string {
  if (!content.startsWith("---")) return content

  const parts = pySplit(content, "---", 2)
  if (parts.length < 3) return content

  const loaded = safeLoad(parts[1])
  const frontmatter = pyTruthy(loaded) ? loaded : new Map<unknown, unknown>()

  const mapped =
    frontmatter instanceof Map
      ? applyFrontmatterMapping(frontmatter, mapping)
      : applyMappingToNonDict(frontmatter, mapping)

  const newFrontmatter = dump(mapped)
  return `---\n${newFrontmatter}---${parts[2]}`
}
