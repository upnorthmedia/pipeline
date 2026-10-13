/**
 * Ledger item P2.77b: the pre-deploy migration runs from the Next standalone
 * output, which is a different resolution environment from `pnpm test` and from
 * a `web/` checkout. `drizzle-orm` is bundled into the server chunks rather
 * than traced as a package, so `scripts/migrate.mjs` could not start in either
 * runtime image while every gate stayed green.
 *
 * `pnpm build` alone says nothing about that: on a dev machine and in CI the
 * standalone tree sits inside `web/`, and Node's resolution walks up into
 * `web/node_modules`, where everything is installed. Only
 * `scripts/check-standalone-migrate.mjs` asks where the files physically are,
 * so this pins that CI runs it, and runs it after the build that produces the
 * tree it reads.
 *
 * The ORM itself is not traced at all, deliberately: naming `drizzle-orm` in
 * `outputFileTracingIncludes` copies it once per alias in pnpm's virtual store,
 * which is 16 of them here and takes the standalone output from 151MB to
 * 426MB. It is copied into the image by the Dockerfile instead, so this also
 * pins that no stage running the web entry point loses that `COPY`. Nothing in
 * `pnpm test` builds an image, so that half is structural: the running proof is
 * in the evidence file.
 *
 * Ledger item P2.77b-ii adds the hook that runs it: `preDeployCommand` on both
 * Railway services, pointed at a bundle `pnpm build` writes into the same tree.
 * The wiring is three separate files agreeing with each other, so it is pinned
 * here; what the bundle actually does is `src/db/predeploy.test.ts`.
 *
 * Parsing the workflow rather than running it keeps this in `pnpm test`, where
 * a full `next build` does not belong. `src/mastra/worker-bundle-gate.test.ts`
 * is the same shape for the worker bundle.
 */
import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"
import { parse } from "yaml"

import { parseStages } from "@/test/dockerfile-stages"

const WEB = path.resolve(__dirname, "../..")
const WORKFLOW = path.resolve(WEB, "../.github/workflows/ci.yml")
const CHECK_SCRIPT = "scripts/check-standalone-migrate.mjs"
const MIGRATE_SCRIPT = "scripts/migrate.mjs"
/** The bundle `pnpm build` writes into the standalone tree for the deploy hook. */
const PREDEPLOY_SCRIPT = "scripts/predeploy.mjs"
const DOCKERFILE = path.resolve(WEB, "Dockerfile")

interface Step {
  name?: string
  run?: string
}

function ciSteps(): Step[] {
  const workflow = parse(fs.readFileSync(WORKFLOW, "utf8")) as {
    jobs: Record<string, { steps: Step[] }>
  }
  return Object.values(workflow.jobs).flatMap((job) => job.steps)
}

function packageScripts(): Record<string, string> {
  return (
    JSON.parse(fs.readFileSync(path.join(WEB, "package.json"), "utf8")) as {
      scripts: Record<string, string>
    }
  ).scripts
}

describe("standalone migration gate", () => {
  it("runs the documented migration through the script an image can run", () => {
    // One implementation for the dev command and the deploy hook. drizzle-kit
    // is a devDependency, so a `db:migrate` that shells out to it is a command
    // that exists on a laptop and nowhere else.
    expect(packageScripts()["db:migrate"]).toContain(MIGRATE_SCRIPT)
    expect(fs.existsSync(path.join(WEB, MIGRATE_SCRIPT))).toBe(true)
  })

  it("has a package script that checks the built standalone tree", () => {
    expect(packageScripts()["standalone:check"]).toContain(CHECK_SCRIPT)
    expect(fs.existsSync(path.join(WEB, CHECK_SCRIPT))).toBe(true)
  })

  it("puts the ORM where the command will look, in every image that serves the app", () => {
    const stages = parseStages(fs.readFileSync(DOCKERFILE, "utf8"))
    // The Railway `web` service and the compose `web` service run the Next
    // server; the pre-deploy hook runs in that image, beside that entry point.
    const serving = [...stages.values()].filter((stage) => stage.cmd?.includes("server.js"))

    expect(serving.map((stage) => stage.name)).toEqual(["runner", "railway"])
    for (const stage of serving) {
      expect(
        stage.copies,
        `stage ${stage.name} should carry drizzle-orm for ${MIGRATE_SCRIPT}`,
      ).toContain("/app/node_modules/drizzle-orm")
    }
  })

  it("bundles the pre-deploy hook as part of the build, not beside it", () => {
    // The bundle has to be written into the same `.next/standalone` the
    // Dockerfile copies. A separate script somebody has to remember to run is a
    // script CI would skip and the image would ship without.
    expect(packageScripts().build).toContain("scripts/build-predeploy.mjs")
    expect(fs.existsSync(path.join(WEB, "scripts/build-predeploy.mjs"))).toBe(true)
    expect(fs.existsSync(path.join(WEB, "scripts/predeploy.ts"))).toBe(true)
    expect(fs.readFileSync(path.join(WEB, CHECK_SCRIPT), "utf8")).toContain("predeploy.mjs")
  })

  it("runs the hook on both Railway services, which is what closes the Mastra race", () => {
    // Parsed rather than executed: the DSL is the `railway` npm package, which
    // the CLI resolves for itself and which `web/` does not install.
    const railway = fs.readFileSync(path.resolve(WEB, "../.railway/railway.ts"), "utf8")
    expect(railway).toContain(`const preDeployCommand = "node ${PREDEPLOY_SCRIPT}"`)

    for (const name of ["web", "worker"]) {
      const block = railway.split(`service("${name}", {`)[1]?.split("\n  })")[0]
      expect(block, `.railway/railway.ts should define a ${name} service`).toBeTruthy()
      expect(block, `the ${name} service should migrate before it starts`).toContain(
        "preDeployCommand,",
      )
    }

    // `src/lib/auth.ts` throws at import without it, and the hook imports it.
    const worker = railway.split('service("worker", {')[1].split("\n  })")[0]
    expect(worker).toContain("BETTER_AUTH_SECRET: preserve()")
  })

  it("checks the standalone tree in CI, after the build that produces it", () => {
    const steps = ciSteps()
    const built = steps.findIndex((step) => step.run?.includes("pnpm build"))
    const checked = steps.findIndex((step) => step.run?.includes("standalone:check"))

    expect(built, "CI should build the app").toBeGreaterThanOrEqual(0)
    expect(checked, "CI should check the standalone migration command").toBeGreaterThanOrEqual(0)
    expect(built).toBeLessThan(checked)
  })
})
