/**
 * Parity tests for `applyFrontmatterMapping` (ledger item 5.3c-iii-b-2-a).
 *
 * The oracle in `data/nextjs-frontmatter-mapping-parity.json` is written by
 * `api/scripts/export_frontmatter_mapping_parity.py`, which asserts the fifteen
 * lines it is describing are still in `apply_frontmatter_mapping` before it
 * runs them, so the recorded answers cannot drift from the function without the
 * export failing. Nothing below asserts a hand-written expectation except the
 * structural checks and the four controls at the end, which exist to separate
 * this port from the object-shaped transcription a reader would write first.
 */
import { describe, expect, it } from "vitest"

import parity from "./data/nextjs-frontmatter-mapping-parity.json"
import { applyFrontmatterMapping } from "./frontmatter-mapping"

type OracleKey =
  | { type: "str"; value: string }
  | { type: "int"; value: number }
  | { type: "bool"; value: boolean }
  | { type: "None"; value: null }

interface Case {
  name: string
  frontmatter: [string, unknown][]
  mapping: [string, unknown][]
  result: [OracleKey, unknown][] | null
  error?: { type: string; message: string }
}

const cases = parity.cases as Case[]

/** The Python key as JavaScript sees it: `None` is `null`, the rest are equal. */
function decodeKey(key: OracleKey): unknown {
  return key.type === "None" ? null : key.value
}

function run(testCase: Case): Map<unknown, unknown> {
  return applyFrontmatterMapping(new Map(testCase.frontmatter), new Map(testCase.mapping))
}

describe("the frontmatter-mapping oracle", () => {
  it("was generated from the real service", () => {
    expect(parity.source).toContain("def apply_frontmatter_mapping(")
    expect(parity.source).toContain('if transform == "array" and not isinstance(value, list):')
    expect(cases.length).toBeGreaterThanOrEqual(50)
  })

  it("covers both branches, both `None` paths and a raise", () => {
    const strTargets = cases.filter((c) => c.mapping.some(([, t]) => typeof t === "string"))
    const dictTargets = cases.filter(
      (c) => c.mapping.some(([, t]) => typeof t === "object" && t !== null && !Array.isArray(t)),
    )
    expect(strTargets.length).toBeGreaterThan(5)
    expect(dictTargets.length).toBeGreaterThan(20)
    expect(cases.filter((c) => c.result?.length === 0).length).toBeGreaterThan(5)
    expect(cases.filter((c) => c.error).length).toBe(2)
  })
})

describe("applyFrontmatterMapping replays the oracle", () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      if (testCase.error) {
        expect(() => run(testCase)).toThrow(testCase.error.message)
        expect(() => run(testCase)).toThrow(TypeError)
        return
      }
      const expected = testCase.result!.map(([key, value]) => [decodeKey(key), value])
      expect([...run(testCase).entries()]).toEqual(expected)
    })
  }
})

describe("the shapes an object-based port would lose", () => {
  it("keeps a `__proto__` target as a field rather than a prototype write", () => {
    const result = applyFrontmatterMapping(
      new Map([["title", { nested: true }]]),
      new Map([["title", "__proto__"]]),
    )

    expect(result.get("__proto__")).toEqual({ nested: true })
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)

    // What the same write does to an object literal, which is why the result
    // is a Map: the field is silently gone and the prototype moved instead.
    const naive: Record<string, unknown> = {}
    naive["__proto__"] = { nested: true }
    expect(Object.hasOwn(naive, "__proto__")).toBe(false)
  })

  it("keeps integer-like target keys in mapping order", () => {
    const result = applyFrontmatterMapping(
      new Map([
        ["title", "a"],
        ["description", "b"],
      ]),
      new Map([
        ["title", "10"],
        ["description", "2"],
      ]),
    )

    expect([...result.keys()]).toEqual(["10", "2"])
    // Python's dict and a Map agree here; an object does not.
    expect(Object.keys(Object.fromEntries(result))).toEqual(["2", "10"])
  })

  it("stores the frontmatter's own value rather than a copy of it", () => {
    const tags = ["a", "b"]
    const result = applyFrontmatterMapping(new Map([["tags", tags]]), new Map([["tags", "tags"]]))

    expect(result.get("tags")).toBe(tags)
  })

  it("reads a frontmatter key that is not a string", () => {
    // `yaml.safe_load` will hand the caller a dict keyed by a number if the
    // frontmatter says `1: x`, and no mapping key can ever match it because
    // the mapping's keys come out of a JSONB column as strings.
    const result = applyFrontmatterMapping(
      new Map<unknown, unknown>([
        [1, "numeric"],
        ["1", "textual"],
      ]),
      new Map([["1", "one"]]),
    )

    expect([...result.entries()]).toEqual([["one", "textual"]])
  })
})
