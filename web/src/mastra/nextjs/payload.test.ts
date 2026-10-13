/**
 * Replays `data/nextjs-payload-parity.json`, which
 * `api/scripts/export_nextjs_payload_parity.py` recorded by executing the real
 * payload block out of `publish_to_nextjs` inside the deployed image.
 *
 * Every case is either the exact `json.dumps` string Python produced or the
 * exception type and message it raised, because `publish_to_nextjs` catches
 * neither. The scratch tree the walk reads is rebuilt here from the bytes the
 * export script wrote it with.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import oracle from "./data/nextjs-payload-parity.json"
import { encodeNumber, pythonJsonDumps } from "./json-dumps"
import {
  buildNextjsPayload,
  isoformatUtc,
  selectContent,
  toMapping,
  type PayloadPost,
} from "./payload"

interface OracleCase {
  name: string
  postId: string
  post: PayloadPost
  frontmatterMap: unknown
  payload?: string
  raises?: string
  message?: string
}

const DEL = ""

let root: string
let mediaDir: string

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nextjs-payload-"))
  mediaDir = path.join(root, "media")
  const postDir = path.join(mediaDir, oracle.postId)
  await mkdir(postDir, { recursive: true })
  for (const [name, bytes] of Object.entries(oracle.tree.files)) {
    await writeFile(path.join(postDir, name), Buffer.from(bytes))
  }
  for (const name of oracle.tree.dirs) {
    await mkdir(path.join(postDir, name))
  }
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function run(entry: OracleCase): Promise<string> {
  return buildNextjsPayload({
    post: entry.post,
    frontmatterMap: entry.frontmatterMap,
    postId: entry.postId,
    mediaDir,
    deliveryId: oracle.deliveryId,
    timestamp: oracle.timestamp,
  })
}

describe("nextjs payload parity", () => {
  it("has a corpus", () => {
    expect(oracle.cases.length).toBeGreaterThanOrEqual(70)
    expect(oracle.python.startsWith("3.12.")).toBe(true)
  })

  for (const entry of oracle.cases as OracleCase[]) {
    it(entry.name, async () => {
      if (entry.payload !== undefined) {
        await expect(run(entry)).resolves.toBe(entry.payload)
        return
      }
      const error = await run(entry).then(
        () => null,
        (caught: Error) => caught,
      )
      expect(error, `${entry.name} should have raised`).not.toBeNull()
      expect(error?.name).toBe(entry.raises)
      if (entry.raises === "OSError") {
        // Node reports a symbolic code where CPython reports
        // `[Errno N] <strerror>`, and the numbering is platform specific, so
        // only the code and the path are compared. See `PyOSError`.
        expect(error?.message).toMatch(
          /^ENAMETOOLONG: '.*\/media\/post-1\/a{300}\.webp'$/,
        )
        expect(entry.message).toContain("File name too long")
        return
      }
      expect(error?.message).toBe(entry.message)
    })
  }
})

/**
 * `json.dumps` over the JSON values a JSONB column can hold, recorded as the
 * raw literal so the int/float distinction survives the oracle file.
 *
 * The `pg` driver parses a JSONB column with `JSON.parse`, which erases that
 * distinction before this module sees it, so a JSON number Python read as a
 * float but whose value is integral re-emits without its `.0`, and an integer
 * past 2^53 has already lost digits. Both are listed rather than skipped.
 */
const PARSE_DIVERGENCES: Record<string, string> = {
  "1.0": "1",
  "-1.0": "-1",
  "-0.0": "0",
  "1e2": "100",
  "1e16": "10000000000000000",
  "1e21": "1000000000000000000000",
  "1e22": "10000000000000000000000",
  "9007199254740993": "9007199254740992",
  "[1, 2.0, 3]": "[1, 2, 3]",
  '{"a": 1, "b": 2.0}': '{"a": 1, "b": 2}',
  // `Number.MAX_VALUE` has no fractional part either, so the integral rule
  // spells it out in full where Python's float repr uses an exponent.
  "1.7976931348623157e308": BigInt(Number.MAX_VALUE).toString(),
}

describe("json.dumps", () => {
  for (const entry of oracle.dumps) {
    const divergent = PARSE_DIVERGENCES[entry.literal]
    it(`${entry.literal} -> ${divergent ?? entry.dumps}`, () => {
      const actual = pythonJsonDumps(JSON.parse(entry.literal))
      if (divergent === undefined) {
        expect(actual).toBe(entry.dumps)
      } else {
        expect(actual).toBe(divergent)
        expect(actual).not.toBe(entry.dumps)
      }
    })
  }

  it("escapes every character outside printable ASCII", () => {
    expect(pythonJsonDumps("café 中\u{1f600}")).toBe(
      '"caf\\u00e9 \\u4e2d\\ud83d\\ude00"',
    )
    expect(pythonJsonDumps("é")).not.toBe(JSON.stringify("é"))
  })

  it("escapes U+007F, which JSON.stringify leaves literal", () => {
    expect(pythonJsonDumps(`a${DEL}b`)).toBe('"a\\u007fb"')
    expect(JSON.stringify(`a${DEL}b`)).toBe(`"a${DEL}b"`)
  })

  it("separates with a space, which JSON.stringify does not", () => {
    expect(pythonJsonDumps({ a: 1, b: [1, 2] })).toBe('{"a": 1, "b": [1, 2]}')
    expect(JSON.stringify({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}')
  })

  it("uses Python's names for the non-finite floats", () => {
    expect(encodeNumber(Number.NaN)).toBe("NaN")
    expect(encodeNumber(Infinity)).toBe("Infinity")
    expect(encodeNumber(-Infinity)).toBe("-Infinity")
  })

  it("keeps the shortcut escapes rather than the \\u form", () => {
    expect(pythonJsonDumps('\n\t\r\b\f\\"')).toBe('"\\n\\t\\r\\b\\f\\\\\\""')
  })
})

describe("content selection", () => {
  const post = (ready: string | null, final: string | null): PayloadPost => ({
    id: "x",
    slug: "s",
    readyContent: ready,
    finalMdContent: final,
    imageManifest: null,
  })

  it("prefers ready_content", () => {
    expect(selectContent(post("R", "F"))).toBe("R")
  })

  it("treats an empty ready_content as absent", () => {
    expect(selectContent(post("", "F"))).toBe("F")
  })

  it("falls back to the empty string", () => {
    expect(selectContent(post(null, null))).toBe("")
    expect(selectContent(post("", ""))).toBe("")
  })
})

describe("toMapping", () => {
  it("keeps __proto__ as an ordinary key", () => {
    const mapping = toMapping(JSON.parse('{"__proto__": "target"}') as unknown)
    expect([...mapping]).toEqual([["__proto__", "target"]])
  })

  it("raises Python's AttributeError for a non-dict mapping", () => {
    expect(() => toMapping("abc")).toThrowError(
      "'str' object has no attribute 'items'",
    )
    expect(() => toMapping(["a"])).toThrowError(
      "'list' object has no attribute 'items'",
    )
  })
})

describe("isoformatUtc", () => {
  it("renders microseconds and the +00:00 offset", () => {
    expect(isoformatUtc(new Date("2026-08-23T12:34:56.789Z"))).toBe(
      "2026-08-23T12:34:56.789000+00:00",
    )
  })

  it("omits the fractional part when there are no microseconds", () => {
    expect(isoformatUtc(new Date("2026-08-23T12:34:56.000Z"))).toBe(
      "2026-08-23T12:34:56+00:00",
    )
  })
})
