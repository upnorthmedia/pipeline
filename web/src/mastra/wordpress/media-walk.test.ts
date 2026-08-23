// @vitest-environment node
/**
 * Parity tests for the media-directory walk of the WordPress publish hook
 * (ledger item 5.3c-iii-b-1-c-ii-2).
 *
 * The oracle in `data/wp-media-walk-parity.json` is written by
 * `api/scripts/export_media_walk_parity.py`, which pulls the four walk lines
 * out of the real `publish_to_wordpress` with `inspect.getsource` and executes
 * them against a scratch directory it builds from the same case table this
 * file rebuilds. Nothing here asserts a hand-written expectation except the
 * provenance checks and the four naive-port controls at the end.
 *
 * The walk corpus holds only names that are valid UTF-8 and unique under case
 * folding, because APFS rejects a filename that is not valid UTF-8 with
 * `EILSEQ` and is case-insensitive by default. The two behaviours that
 * restriction hides, `surrogateescape` decoding and sorting a lone surrogate,
 * are covered by the `fsdecode` and `sorts` corpora, which need no filesystem.
 */
import { execFileSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import parity from "./data/wp-media-walk-parity.json"
import { comparePythonStrings, decodeFsName, listMediaFiles } from "./media-walk"

interface Entry {
  path: string
  kind: "file" | "dir" | "symlink" | "fifo" | "chmod"
  target?: string
  mode?: number
}

interface WalkCase {
  name: string
  entries: Entry[]
  walk: string
  expected: string[]
}

interface ErrorCase {
  name: string
  entries: Entry[]
  walk: string
  error: string | null
  expected: string[] | null
}

const fsdecodeCases = parity.fsdecode as { name: string; bytes: number[]; codepoints: number[] }[]
const sortCases = parity.sorts as { name: string; names: number[][]; sorted: number[][] }[]
const walkCases = parity.walks as WalkCase[]
const errorCases = parity.errors as ErrorCase[]

const text = (codepoints: number[]): string => String.fromCodePoint(...codepoints)

let scratch: string
/** Paths a case chmod-ed, put back before the scratch directory is removed. */
let restore: string[] = []

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "media-walk-"))
})

afterEach(async () => {
  for (const entry of restore) await chmod(entry, 0o755)
  restore = []
  await rm(scratch, { recursive: true, force: true })
})

async function build(entries: Entry[]): Promise<void> {
  for (const entry of entries) {
    const target = path.join(scratch, entry.path)
    if (entry.kind === "file") await writeFile(target, "")
    else if (entry.kind === "dir") await mkdir(target)
    else if (entry.kind === "symlink") await symlink(entry.target as string, target)
    else if (entry.kind === "fifo") execFileSync("mkfifo", [target])
    else {
      restore.push(target)
      await chmod(target, entry.mode as number)
    }
  }
}

describe("the wp-media-walk oracle", () => {
  it("was generated from the real publish hook", () => {
    expect(parity.walkBlockSource).toContain("if media_dir.is_dir():")
    expect(parity.walkBlockSource).toContain("for img_file in sorted(media_dir.iterdir()):")
    expect(parity.walkBlockSource).toContain("if not img_file.is_file():")
    expect(fsdecodeCases.length).toBeGreaterThanOrEqual(30)
    expect(sortCases.length).toBeGreaterThanOrEqual(15)
    expect(walkCases.length).toBeGreaterThanOrEqual(20)
    expect(errorCases.length).toBeGreaterThanOrEqual(3)
  })

  it("covers both a kept and a skipped entry, and both an empty and a full walk", () => {
    expect(walkCases.some((c) => c.expected.length === 0)).toBe(true)
    expect(walkCases.some((c) => c.expected.length > 1)).toBe(true)
    expect(
      walkCases.some((c) => c.entries.length > c.expected.length && c.expected.length > 0),
    ).toBe(true)
    expect(fsdecodeCases.some((c) => c.codepoints.some((p) => p >= 0xdc80 && p <= 0xdcff))).toBe(
      true,
    )
  })
})

describe("decodeFsName", () => {
  it.each(fsdecodeCases.map((c) => [c.name, c] as const))(
    "matches os.fsdecode on %s",
    (_name, testCase) => {
      const decoded = decodeFsName(Uint8Array.from(testCase.bytes))
      expect([...decoded].map((ch) => ch.codePointAt(0))).toEqual(testCase.codepoints)
    },
  )
})

describe("comparePythonStrings", () => {
  it.each(sortCases.map((c) => [c.name, c] as const))(
    "sorts like Python on %s",
    (_name, testCase) => {
      const names = testCase.names.map(text)
      const sorted = [...names].sort(comparePythonStrings)
      expect(sorted).toEqual(testCase.sorted.map(text))
    },
  )
})

describe("listMediaFiles", () => {
  it.each(walkCases.map((c) => [c.name, c] as const))(
    "matches the Python walk when %s",
    async (_name, testCase) => {
      await build(testCase.entries)
      const files = await listMediaFiles(path.join(scratch, testCase.walk))
      expect(files.map((file) => file.name)).toEqual(testCase.expected)
    },
  )

  it("returns a byte path that opens the file it names", async () => {
    const testCase = walkCases.find((c) => c.name === "an astral filename sorts by code point")
    expect(testCase).toBeDefined()
    await build((testCase as WalkCase).entries)
    const files = await listMediaFiles(path.join(scratch, "."))
    for (const file of files) {
      expect(file.path.toString("utf8")).toBe(path.join(scratch, file.name))
    }
  })

  // Root ignores the permission bits, so the EACCES case would prove nothing
  // there. The export script refuses to run as root for the same reason.
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0
  it.skipIf(asRoot).each(errorCases.map((c) => [c.name, c] as const))(
    "%s",
    async (_name, testCase) => {
      await build(testCase.entries)
      const target = path.join(scratch, testCase.walk)
      if (testCase.error === null) {
        await expect(listMediaFiles(target)).resolves.toEqual(testCase.expected)
      } else {
        await expect(listMediaFiles(target)).rejects.toThrow()
      }
    },
  )
})

/**
 * The four shapes a port written from the Python without reading `pathlib`
 * would take. Each asserts against the oracle's own answer, so they document
 * the trap rather than restating an expectation.
 */
describe("the naive ports", () => {
  it("readdir withFileTypes gets both symlink cases backwards", async () => {
    const toFile = walkCases.find((c) => c.name === "a symlink to a file is followed and kept")
    const toDir = walkCases.find(
      (c) => c.name === "a symlink to a directory is followed and skipped",
    )
    expect(toFile?.expected).toContain("sym.webp")
    expect(toDir?.expected).not.toContain("sym")

    const { readdir } = await import("node:fs/promises")
    await build((toFile as WalkCase).entries)
    const entries = await readdir(scratch, { withFileTypes: true })
    expect(entries.find((entry) => entry.name === "sym.webp")?.isFile()).toBe(false)
  })

  it("the default sort orders an astral filename first, Python orders it last", () => {
    const astral = walkCases.find((c) => c.name === "an astral filename sorts by code point")
    const names = (astral as WalkCase).expected
    expect([...names].sort()).not.toEqual(names)
    expect([...names].sort()[0]).toBe(names[names.length - 1])
  })

  it("localeCompare puts lowercase first, Python puts uppercase first", () => {
    const cased = walkCases.find((c) => c.name === "uppercase sorts before lowercase")
    const names = (cased as WalkCase).expected
    expect([...names].sort((left, right) => left.localeCompare(right))).not.toEqual(names)
  })

  it("Buffer.toString collides two names that surrogateescape keeps apart", () => {
    const first = Uint8Array.from([0xff])
    const second = Uint8Array.from([0xfe])
    expect(Buffer.from(first).toString("utf8")).toBe(Buffer.from(second).toString("utf8"))
    expect(decodeFsName(first)).not.toBe(decodeFsName(second))
  })
})
