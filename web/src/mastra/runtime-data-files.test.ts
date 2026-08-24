/**
 * Ledger item P2.7: the two directories the Mastra graph reads off disk at
 * runtime, `rules/*.md` and the textstat corpus, are invisible to `next build`
 * and to `mastra worker build`. Both are reached through a `path.resolve` on
 * `process.cwd()` inside `rulesDir()` and `textstatDataDir()`, so no bundler
 * traces them and every runtime image has to copy them in and point an
 * environment variable at where they landed.
 *
 * Nothing else checks that, and the failure would not be a build error: the
 * image builds, boots and serves, and then the first request that needs a
 * syllable count throws `ENOENT` out of `readFileSync`.
 * `GET /api/posts/{id}/analytics` is that request in the web process, through
 * `computeAnalytics` -> `fleschReadingEase`, which is why the web entry point
 * needs the corpus as much as the worker does.
 *
 * The `runner` image happened to carry the corpus anyway before item P2.7,
 * because the Next standalone output copies the whole `src/` tree and
 * `textstatDataDir()` falls back to `process.cwd()`. That is a property of what
 * Next copies rather than one anything declares, which is what this pins.
 *
 * This walks `web/Dockerfile`, resolves stage inheritance, and asserts that
 * every stage carrying a `CMD` both sets each variable and has a `COPY` that
 * puts a directory at the path the variable names.
 */
import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { rulesDir } from "./prompts"
import { textstatDataDir } from "./textstat/hyphenator"

const DOCKERFILE = path.resolve(__dirname, "../../Dockerfile")

interface Stage {
  name: string
  base: string
  workdir: string
  env: Record<string, string>
  /** Absolute destinations, resolved against the WORKDIR in force. */
  copies: string[]
  cmd: string | null
}

/**
 * The subset of Dockerfile syntax this file uses: `FROM ... AS`, `WORKDIR`,
 * `ENV KEY=value`, `COPY [--flags] src... dest` and `CMD`. Line continuations
 * are joined first so a wrapped instruction is read as one.
 */
function parseStages(source: string): Map<string, Stage> {
  const stages = new Map<string, Stage>()
  let current: Stage | null = null

  const lines = source
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))

  for (const line of lines) {
    const [instruction, ...rest] = line.split(/\s+/)
    const keyword = instruction.toUpperCase()

    if (keyword === "FROM") {
      const asIndex = rest.findIndex((token) => token.toUpperCase() === "AS")
      const name = asIndex === -1 ? rest[0] : rest[asIndex + 1]
      const base = rest[0]
      const parent = stages.get(base)
      current = {
        name,
        base,
        workdir: parent?.workdir ?? "/",
        env: { ...(parent?.env ?? {}) },
        copies: [...(parent?.copies ?? [])],
        cmd: null,
      }
      stages.set(name, current)
      continue
    }

    if (!current) continue

    if (keyword === "WORKDIR") {
      current.workdir = path.posix.resolve(current.workdir, rest[0])
    } else if (keyword === "ENV") {
      const assignment = rest.join(" ")
      const equals = assignment.indexOf("=")
      if (equals !== -1) {
        const key = assignment.slice(0, equals)
        const value = assignment.slice(equals + 1).replace(/^["']|["']$/g, "")
        current.env[key] = value
      }
    } else if (keyword === "COPY") {
      const operands = rest.filter((token) => !token.startsWith("--"))
      const destination = operands[operands.length - 1]
      if (destination) current.copies.push(path.posix.resolve(current.workdir, destination))
    } else if (keyword === "CMD") {
      current.cmd = rest.join(" ")
    }
  }

  return stages
}

const STAGES = parseStages(fs.readFileSync(DOCKERFILE, "utf8"))
const RUNTIME_STAGES = [...STAGES.values()].filter((stage) => stage.cmd !== null)

/**
 * The variable each accessor reads, paired with a file the directory must hold
 * so a `COPY` of an empty or wrong directory cannot satisfy the check.
 */
const RUNTIME_DATA = [
  { variable: "RULES_DIR", accessor: rulesDir, marker: "blog-research.md" },
  {
    variable: "TEXTSTAT_DATA_DIR",
    accessor: textstatDataDir,
    marker: "cmudict-syllables.txt.gz",
  },
] as const

describe("runtime data files", () => {
  it("finds the runtime stages, so an unparsed Dockerfile cannot pass vacuously", () => {
    expect(RUNTIME_STAGES.map((stage) => stage.name).sort()).toEqual([
      "railway",
      "runner",
      "worker",
    ])
  })

  for (const { variable, accessor, marker } of RUNTIME_DATA) {
    describe(variable, () => {
      it("is what the accessor reads", () => {
        const previous = process.env[variable]
        process.env[variable] = "/somewhere/else"
        try {
          expect(accessor()).toBe("/somewhere/else")
        } finally {
          if (previous === undefined) delete process.env[variable]
          else process.env[variable] = previous
        }
      })

      it("names a directory this repo actually ships", () => {
        const previous = process.env[variable]
        delete process.env[variable]
        try {
          expect(fs.existsSync(path.join(accessor(), marker))).toBe(true)
        } finally {
          if (previous !== undefined) process.env[variable] = previous
        }
      })

      for (const stage of RUNTIME_STAGES) {
        it(`is set in the \`${stage.name}\` stage and points at a copied directory`, () => {
          const target = stage.env[variable]
          expect(target).toBeDefined()
          expect(stage.copies).toContain(target)
        })
      }
    })
  }
})
