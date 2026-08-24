/**
 * Ledger item P2.18: `mastra worker build` is a different module-resolution
 * environment from `next build`, `vitest` and `mastra dev`, and nothing in the
 * gate list runs it. Two packages reaching the Mastra instance have already
 * been unresolvable there while every other gate stayed green
 * (`@opentelemetry/api`, undeclared by anything in the tree, and `sharp`, whose
 * native `.node` binary cannot be inlined).
 *
 * Building the bundle is not enough on its own. `mastra worker build` exits 0
 * for a bundle that cannot boot: dropping `sharp` from `bundler.externals`
 * inlines it, the build succeeds, and the artifact throws `Could not load the
 * "sharp" module` on its first import. So the gate is build *then* boot, and
 * this pins that CI carries both halves in that order against a clean output
 * directory.
 *
 * Parsing the workflow rather than running it keeps this in `pnpm test`, where
 * a 12-second bundle build does not belong. The gate itself is
 * `scripts/check-worker-bundle.mjs`, which is what actually imports the
 * artifact.
 */
import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"
import { parse } from "yaml"

const WEB = path.resolve(__dirname, "../..")
const WORKFLOW = path.resolve(WEB, "../.github/workflows/ci.yml")
const CHECK_SCRIPT = "scripts/check-worker-bundle.mjs"

interface Step {
  name?: string
  run?: string
  "working-directory"?: string
}

function ciSteps(): Step[] {
  const workflow = parse(fs.readFileSync(WORKFLOW, "utf8")) as {
    jobs: Record<string, { steps: Step[] }>
  }
  return Object.values(workflow.jobs).flatMap((job) => job.steps)
}

/** The one step that builds the worker bundle, as a list of its commands. */
function bundleStepCommands(): string[] {
  const steps = ciSteps().filter((step) => step.run?.includes("worker:build"))
  expect(
    steps,
    "exactly one CI step should build the worker bundle",
  ).toHaveLength(1)
  return (steps[0].run ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
}

describe("worker bundle gate", () => {
  it("has a package script that boots the built bundle", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(WEB, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> }

    expect(pkg.scripts["worker:check"]).toContain(CHECK_SCRIPT)
    // The bundle reads `DATABASE_URL_SYNC` and `REDIS_URL` at module scope and
    // throws without them, and a bare `node` does not read the repo-root
    // `.env`. `auth:migrate` solves the same problem the same way.
    expect(pkg.scripts["worker:check"]).toContain("--env-file=../.env")
    expect(fs.existsSync(path.join(WEB, CHECK_SCRIPT))).toBe(true)
  })

  it("builds the bundle from a clean output directory in CI", () => {
    const commands = bundleStepCommands()

    // A stale `.mastra/worker` from a previous step would let a bundle that no
    // longer builds still be present and still boot.
    const cleaned = commands.findIndex((line) => /^rm -rf .*\.mastra/.test(line))
    const built = commands.findIndex((line) => line.includes("worker:build"))

    expect(cleaned, "the CI step should remove .mastra before building").toBeGreaterThanOrEqual(0)
    expect(cleaned).toBeLessThan(built)
  })

  it("boots the bundle in CI after building it", () => {
    const commands = bundleStepCommands()

    const built = commands.findIndex((line) => line.includes("worker:build"))
    const booted = commands.findIndex((line) => line.includes("worker:check"))

    expect(booted, "the CI step should boot the bundle it built").toBeGreaterThanOrEqual(0)
    expect(built).toBeLessThan(booted)
  })
})
