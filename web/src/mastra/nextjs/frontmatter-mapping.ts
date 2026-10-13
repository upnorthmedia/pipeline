/**
 * TypeScript port of `apply_frontmatter_mapping` in
 * `api/src/services/frontmatter_mapping.py` (ledger item 5.3c-iii-b-2-a).
 *
 * The Next.js publish hook runs a post's YAML frontmatter through this
 * transform before it serialises, signs and ships the payload, so the mapping a
 * user saved on their profile decides the frontmatter their blog repo receives.
 * The function is thirty lines and almost every one of them is a distinction
 * JavaScript spells the same way as its Python opposite:
 *
 * - `jena_field in jena_frontmatter` is key membership, so a field stored as
 *   `null` is copied through, while `jena_frontmatter.get(jena_field)` in the
 *   other branch cannot tell a stored `null` from an absent key. Both branches
 *   are reachable for the same field and they disagree about it.
 * - `value is None` and `default is not None` are identity against `None`, not
 *   truthiness: `false`, `0`, `""` and `[]` are all values, and all defaults.
 * - `isinstance(target, dict)` excludes a list, so a target stored as an array
 *   is skipped entirely rather than read for a `key`.
 * - the `continue` after a default is taken means a default is never wrapped by
 *   `transform: "array"`, only a real value is.
 *
 * Both the mapping and the frontmatter are `Map`s rather than objects, and so
 * is the result. `__proto__` is an ordinary dict key in Python and writing it
 * into an object literal would be a prototype write rather than a field, the
 * result's keys are not all strings because `target.get("key", jena_field)`
 * hands back whatever the mapping stored there, and an object reorders
 * integer-like keys ahead of the rest while Python and `Map` both keep
 * insertion order. The mapping's *values* are not converted: they come
 * straight out of the `nextjs_frontmatter_map` JSONB column, so a nested target
 * is a plain object.
 *
 * Verified against `data/nextjs-frontmatter-mapping-parity.json`, written by
 * `api/scripts/export_frontmatter_mapping_parity.py` from the real function.
 */

import { pyDictGet, pyDictHas, pyDictSet, PyTypeError } from "./pyyaml/values"

/** `value is None`: an absent `Map` key and a stored `null` are both `None`. */
function isNone(value: unknown): boolean {
  return value === null || value === undefined
}

/** `isinstance(value, dict)` for a value decoded from the JSONB column. */
function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** `mapping.get(key)`, which is `None` for an absent key. */
function dictGet(target: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(target, key) ? target[key] : undefined
}

/**
 * `result[key] = value`.
 *
 * Two things a `Map.set` does not do on its own. Python refuses an unhashable
 * key, and the hook does not catch the `TypeError`, so a mapping that stores a
 * list or an object under `key` fails the publish rather than writing a
 * stringified key into the reader's frontmatter. And Python's key equality is
 * not a `Map`'s: `True`, `1` and `1.0` are one key, so two targets that write
 * them write one entry, keeping the key first inserted and the value written
 * last. `pyDictSet` is that assignment.
 */
function setResultKey(result: Map<unknown, unknown>, key: unknown, value: unknown): void {
  if (Array.isArray(key)) throw new PyTypeError("unhashable type: 'list'")
  if (isDict(key)) throw new PyTypeError("unhashable type: 'dict'")
  pyDictSet(result, key, value)
}

/** Transform Jena AI's frontmatter into the target blog's schema. */
export function applyFrontmatterMapping(
  jenaFrontmatter: ReadonlyMap<unknown, unknown>,
  mapping: ReadonlyMap<unknown, unknown>,
): Map<unknown, unknown> {
  const result = new Map<unknown, unknown>()

  for (const [jenaField, target] of mapping) {
    if (typeof target === "string") {
      if (pyDictHas(jenaFrontmatter, jenaField)) {
        setResultKey(result, target, pyDictGet(jenaFrontmatter, jenaField))
      }
    } else if (isDict(target)) {
      const key = Object.hasOwn(target, "key") ? target.key : jenaField
      const transform = dictGet(target, "transform")
      const fallback = dictGet(target, "default")

      let value = pyDictGet(jenaFrontmatter, jenaField)

      if (isNone(value) && !isNone(fallback)) {
        setResultKey(result, key, fallback)
        continue
      }

      if (isNone(value)) continue

      if (transform === "array" && !Array.isArray(value)) value = [value]

      setResultKey(result, key, value)
    }
  }

  return result
}
