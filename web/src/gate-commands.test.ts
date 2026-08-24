/**
 * Ledger item P2.79: a gate command has to be runnable exactly as written.
 * Typechecking was the one gate that was not. `pnpm -C web tsc --noEmit` reads
 * `tsc` as a script name on pnpm 10, finds none, and exits 254 with
 * `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "web" not found`, which names
 * neither the cause nor a working form; every other gate (`test`, `lint`,
 * `build`, `db:migrate`) is a script and runs. So typechecking is a
 * `typecheck` script too, and the docs and CI both call it.
 *
 * The extraction below reads fenced code blocks only. Prose that names a
 * command is often naming one that does *not* work (CLAUDE.md's trap list is
 * exactly that), while a fenced line is an instruction to run it.
 *
 * This parses rather than executes: a second `tsc` inside `pnpm test` would
 * double the suite's runtime to re-prove what the gate itself proves.
 */
import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"
import { parse } from "yaml"

const WEB = path.resolve(__dirname, "..")
const REPO = path.resolve(WEB, "..")
const WORKFLOW = path.join(REPO, ".github/workflows/ci.yml")

/** Every document that tells someone how to run this project. */
const DOCS = ["README.md", "CLAUDE.md", "web/README.md"] as const

/** pnpm's own subcommands, which need no entry in `scripts`. */
const PNPM_BUILTINS = new Set(["exec", "install"])

const scripts: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(WEB, "package.json"), "utf8"),
).scripts

/** The first word after `pnpm -C web` on every fenced line of a document. */
function fencedInvocations(markdown: string): string[] {
  const fences = markdown.match(/```[\s\S]*?```/g) ?? []
  // A script name, stopping at the backtick a fenced comment may wrap it in.
  return fences.flatMap((fence) => [...fence.matchAll(/\bpnpm -C web ([\w:-]+)/g)].map((match) => match[1]))
}

const documented = DOCS.flatMap((doc) => fencedInvocations(fs.readFileSync(path.join(REPO, doc), "utf8")))

/** The `run:` bodies of the CI job's steps, keyed by step name. */
function ciSteps(): Map<string, string> {
  const workflow = parse(fs.readFileSync(WORKFLOW, "utf8"))
  const steps: { name?: string; run?: string }[] = workflow.jobs.gates.steps
  return new Map(steps.filter((step) => step.name && step.run).map((step) => [step.name!, step.run!.trim()]))
}

describe("the gate commands", () => {
  it("typecheck is a script, so the `-C` form runs it like every other gate", () => {
    expect(scripts.typecheck).toBe("tsc --noEmit")
  })

  it("every `pnpm -C web <name>` in the docs names something pnpm can run", () => {
    const unrunnable = [...new Set(documented)].filter(
      (name) => !PNPM_BUILTINS.has(name) && !(name in scripts),
    )
    expect(unrunnable).toEqual([])
    // Anti-vacuity: the five gates are in there, so an empty extraction (a
    // changed fence syntax, a renamed doc) cannot pass this silently.
    for (const gate of ["typecheck", "lint", "test", "build", "test:e2e"]) {
      expect(documented).toContain(gate)
    }
  })

  it("CI runs the script rather than its own spelling of the same command", () => {
    // Two spellings drift: the reason `pnpm -C web tsc --noEmit` was in the
    // docs at all is that nothing executing it ever had to agree with them.
    expect(ciSteps().get("tsc")).toBe("pnpm typecheck")
  })
})
