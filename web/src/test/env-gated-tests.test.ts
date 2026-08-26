/**
 * What a green CI run does not certify.
 *
 * Eleven files in this suite gate tests on the environment rather than on the
 * code: ten on an environment variable, one on the process uid. Nine of those
 * tests skip on a developer machine and three more skip in CI, because the only
 * provider credential the repo `.env` carries is `GEMINI_API_KEY` and
 * `.github/workflows/ci.yml` writes its `.env` from scratch with no provider
 * key in it at all. A skipped test reports as a pass at the summary line, so
 * the difference is one digit in `9 skipped` that nobody reads.
 *
 * The decision recorded at ledger item P2.103 is to leave it that way and state
 * the gap rather than give CI repository secrets: every one of these tests
 * bills a real provider call, two of them bill an image, and secrets are not
 * available to a `pull_request` run from a fork, so the green tick would mean
 * different things on different events. This file is what keeps the statement
 * true. It fails when a new environment gate appears without being listed here,
 * and when CI starts supplying a provider key, which is the moment the gap
 * changes and the wording in `docs/polish/SUMMARY.md` has to change with it.
 *
 * It does not run any of the gated tests, and cannot: proving a gate would need
 * the credential the gate exists for.
 */
import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"
import { parse } from "yaml"

const SRC = path.resolve(__dirname, "..")
const WEB = path.resolve(SRC, "..")
const WORKFLOW = path.resolve(WEB, "../.github/workflows/ci.yml")

/** This file names every gate in prose and in a table, so it is not scanned. */
const SELF = "src/test/env-gated-tests.test.ts"

/**
 * Every file that decides at collection time whether to run a test, with the
 * environment variables its gate reads.
 *
 * `runs` is the polarity: `set` means the tests run only where the variable has
 * a value, which is the live-provider shape, and `unset` means they run only
 * where it has none, which is `stripe-signup.test.ts`, whose whole premise is
 * an unconfigured Stripe. CI satisfies every `unset` gate and no `set` gate.
 */
const GATES: { file: string; env: string[]; runs: "set" | "unset" | "uid" }[] = [
  // Credential validation calls each provider's real endpoint.
  {
    file: "src/mastra/api-key-validator.test.ts",
    env: ["ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY"],
    runs: "set",
  },
  // A model-id lookup on the key, plus the generation probe behind a second
  // gate because it bills about $0.134 an image.
  { file: "src/mastra/images/gemini.test.ts", env: ["GEMINI_API_KEY", "GEMINI_IMAGE_QUOTA"], runs: "set" },
  { file: "src/mastra/perplexity/agent-api.test.ts", env: ["PERPLEXITY_API_KEY"], runs: "set" },
  { file: "src/mastra/agents/research.test.ts", env: ["PERPLEXITY_API_KEY"], runs: "set" },
  { file: "src/mastra/agents/outline.test.ts", env: ["ANTHROPIC_API_KEY"], runs: "set" },
  { file: "src/mastra/agents/write.test.ts", env: ["ANTHROPIC_API_KEY"], runs: "set" },
  { file: "src/mastra/agents/edit.test.ts", env: ["ANTHROPIC_API_KEY"], runs: "set" },
  { file: "src/mastra/agents/images.test.ts", env: ["ANTHROPIC_API_KEY"], runs: "set" },
  { file: "src/lib/stripe-signup.test.ts", env: ["STRIPE_SECRET_KEY"], runs: "unset" },
  // Not an environment gate: the permission cases it skips cannot fail for
  // root, which can read a directory it has just chmod-ed to 000.
  { file: "src/mastra/wordpress/media-walk.test.ts", env: [], runs: "uid" },
]

/** The credentials a live call needs, which CI is deliberately not given. */
const PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY", "GEMINI_IMAGE_QUOTA"]

function testFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...testFiles(full))
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(full)
  }
  return found
}

/**
 * The environment variables one gate expression reads.
 *
 * A gate is written either against `process.env` directly
 * (`describe.skipIf(!process.env.GEMINI_API_KEY)`) or against a module constant
 * that holds it (`const LIVE_KEY = process.env.ANTHROPIC_API_KEY`), so an
 * identifier in the expression is resolved one level, against the `const` that
 * declares it in the same file. One level is enough for every gate in this
 * suite and a second one would be a parser rather than a guard.
 */
function envNamesIn(expression: string, source: string): string[] {
  const names = [...expression.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1])
  for (const [, identifier] of expression.matchAll(/(?<!\.)\b([A-Za-z_$][\w$]*)\b/g)) {
    if (identifier === "process") continue
    const declaration = new RegExp(`\\bconst ${identifier}\\s*=\\s*(.*)`).exec(source)
    if (!declaration) continue
    names.push(...[...declaration[1].matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]))
  }
  return [...new Set(names)].sort()
}

/** Every `skipIf` in the suite, keyed by file, with the variables it reads. */
function scannedGates(): Map<string, string[]> {
  const gates = new Map<string, string[]>()
  for (const file of testFiles(SRC)) {
    const relative = path.relative(WEB, file)
    if (relative === SELF) continue
    const source = fs.readFileSync(file, "utf8")
    const expressions = [...source.matchAll(/\b(?:describe|it|test)\.skipIf\(([^)]*(?:\([^)]*\))?[^)]*)\)/g)]
    if (expressions.length === 0) continue
    const names = expressions.flatMap((match) => envNamesIn(match[1], source))
    gates.set(relative, [...new Set(names)].sort())
  }
  return gates
}

const workflow = fs.readFileSync(WORKFLOW, "utf8")

/**
 * The workflow with its comment lines removed.
 *
 * The `test` step's comment names the three credentials CI is not given, which
 * is the statement this file guards, so a plain substring search over the whole
 * document would read that sentence as the thing it warns about. Every comment
 * in that file is a whole line.
 */
const workflowCode = workflow
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n")

describe("the tests a green CI run does not include", () => {
  it("gates the suite on the environment in exactly the files listed here", () => {
    expect([...scannedGates().keys()].sort()).toEqual(GATES.map((gate) => gate.file).sort())
  })

  it("reads the environment variables listed against each of those files", () => {
    const scanned = scannedGates()
    for (const gate of GATES) {
      expect({ file: gate.file, env: scanned.get(gate.file) }).toEqual({
        file: gate.file,
        env: [...gate.env].sort(),
      })
    }
  })

  it("names every provider credential in the table, so the gap list is the table", () => {
    const live = GATES.filter((gate) => gate.runs === "set").flatMap((gate) => gate.env)
    expect([...new Set(live)].sort()).toEqual([...PROVIDER_KEYS].sort())
  })

  /**
   * The whole workflow text, not just the `.env` it writes: a repository secret
   * can reach a step through `env:` at any of three levels, and any of them
   * would put these tests back in the run and make the paragraph above wrong.
   */
  it("gives CI none of them, which is what makes the live provider paths uncertified", () => {
    const supplied = PROVIDER_KEYS.filter((name) => workflowCode.includes(name))
    expect(supplied).toEqual([])
  })

  it("gives CI no Stripe key either, so the sign-up guard is one gate CI does satisfy", () => {
    expect(workflowCode.includes("STRIPE_SECRET_KEY")).toBe(false)
    expect(GATES.find((gate) => gate.file === "src/lib/stripe-signup.test.ts")?.runs).toBe("unset")
  })

  it("still runs the whole suite in CI, so a skip is the only way a test can be absent", () => {
    const steps: { name?: string; run?: string }[] = parse(workflow).jobs.gates.steps
    expect(steps.find((step) => step.name === "test")?.run?.trim()).toBe("pnpm test")
  })
})
