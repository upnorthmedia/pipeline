/**
 * Vitest runs test files in parallel against one Postgres, so two files that
 * seed the same row id delete and re-insert it underneath each other. The
 * symptoms are nonsense: a `duplicate key value ... posts_pkey` two lines after
 * the matching delete, or a run reporting a state the file never configured.
 * It has already happened twice in this repo (`...04c1` shared by
 * `review-gates` and `pipeline-completion`, `...55d1` shared by `stage-log`
 * and `pipeline-start`), and both times it cost a full debugging session
 * because the failure surfaces in the file that lost the race rather than in
 * the one that caused it.
 *
 * Nothing in the suite made those collisions visible, so this is the registry:
 * a UUID literal belongs to exactly one test file. That is stricter than the
 * defect requires (two files may share a literal harmlessly when neither
 * inserts it, or when they insert into different tables), but the strict rule
 * is the one that can be checked without knowing what every literal is for,
 * and the escape hatch is cheap: an id that is genuinely shared moves into a
 * module under `src/test/` and is imported, which is also the only way to say
 * out loud that it is shared.
 */
import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const SRC = path.resolve(__dirname, "..")

/** Any hex UUID, in any casing, wherever it appears in the file. */
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g

/**
 * This file's own literals are fixtures for the checker below, not row ids, so
 * it is the one file the scan does not police. It seeds nothing.
 */
const SELF = "test/unique-test-ids.test.ts"

/** Every `*.test.ts`/`*.test.tsx` under `src`, as paths relative to `src`. */
function testFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...testFiles(full))
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(path.relative(SRC, full))
  }
  return found.sort()
}

/** id -> the files that spell it out, for every id spelled out more than once. */
export function sharedIds(sources: Map<string, string>): Map<string, string[]> {
  const owners = new Map<string, string[]>()
  for (const [file, source] of sources) {
    for (const id of new Set(source.match(UUID) ?? [])) {
      const lower = id.toLowerCase()
      owners.set(lower, [...(owners.get(lower) ?? []), file])
    }
  }
  return new Map([...owners].filter(([, files]) => files.length > 1))
}

describe("uuid literals in test files", () => {
  it("belong to exactly one file each", () => {
    const sources = new Map(
      testFiles(SRC)
        .filter((file) => file !== SELF)
        .map((file) => [file, fs.readFileSync(path.join(SRC, file), "utf8")]),
    )

    const shared = sharedIds(sources)
    const report = [...shared]
      .map(([id, files]) => `${id}\n    ${files.join("\n    ")}`)
      .join("\n  ")

    expect(
      report,
      "each of these UUIDs is spelled out in more than one test file, and vitest runs " +
        "files in parallel against one database. Give each file its own id, or, if the " +
        "id is genuinely shared, export it from a module under src/test/ and import it",
    ).toBe("")
  })

  it("counts a file once however often it repeats an id", () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    expect(sharedIds(new Map([["one.test.ts", `${id} ${id} ${id}`]])).size).toBe(0)
  })

  it("reports every file that spells a shared id out", () => {
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    const shared = sharedIds(
      new Map([
        ["one.test.ts", `const A = "${id}"`],
        ["two.test.ts", `const B = "${id.toUpperCase()}"`],
        ["three.test.ts", "unrelated"],
      ]),
    )
    expect([...shared]).toEqual([[id, ["one.test.ts", "two.test.ts"]]])
  })
})
