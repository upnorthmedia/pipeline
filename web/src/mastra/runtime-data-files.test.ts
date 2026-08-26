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
import { parse as parseYaml } from "yaml"

import { parseStages } from "@/test/dockerfile-stages"

import { rulesDir } from "./prompts"
import { textstatDataDir } from "./textstat/hyphenator"

const DOCKERFILE = path.resolve(__dirname, "../../Dockerfile")
const REPO_ROOT = path.resolve(__dirname, "../../..")

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

/**
 * Ledger items P2.22 and P2.23, the compose half.
 *
 * The `worker` service is the one process in this repo whose working directory
 * is not `web/`: `mastra worker start` runs the bundle with its own output
 * directory as the cwd, so every default path in the app resolves somewhere
 * inside `.mastra/`. All three directories the pipeline reads off disk have to
 * be named for it explicitly, and neither compose file gets a build error or a
 * boot error if one goes missing.
 *
 * A variable counts as set if the service declares it or if the image stage the
 * service builds carries it as an `ENV`, which is how `docker-compose.prod.yml`
 * gets `TEXTSTAT_DATA_DIR`: it builds the `worker` stage, which sets it next to
 * the corpus it copies. The dev file builds `deps`, which carries none of them,
 * so it has to declare all three itself.
 */
const WORKER_RUNTIME_VARIABLES = ["RULES_DIR", "TEXTSTAT_DATA_DIR", "MEDIA_DIR"] as const

interface ComposeService {
  environment?: Record<string, string>
  build?: { target?: string }
}

const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.prod.yml"] as const

describe("the compose worker service", () => {
  for (const file of COMPOSE_FILES) {
    describe(file, () => {
      const compose = parseYaml(
        fs.readFileSync(path.join(REPO_ROOT, file), "utf8"),
      ) as { services?: Record<string, ComposeService> }
      const worker = compose.services?.worker

      it("is a service that builds a stage of this Dockerfile", () => {
        expect(worker).toBeDefined()
        expect(STAGES.has(worker?.build?.target ?? "")).toBe(true)
      })

      for (const variable of WORKER_RUNTIME_VARIABLES) {
        it(`names ${variable}, itself or through the stage it builds`, () => {
          const fromService = worker?.environment?.[variable]
          const fromImage = STAGES.get(worker?.build?.target ?? "")?.env[variable]
          expect(fromService ?? fromImage).toBeDefined()
        })
      }
    })
  }
})

/**
 * The local worker runs the same bundle as the deployed worker, so changing
 * where it is launched does not make its runtime data appear inside
 * `.mastra/worker`. The package script is the local runtime boundary: it must
 * load the repo environment and pass absolute paths for every directory the
 * bundle reads after the Mastra CLI changes its working directory.
 */
describe("the local worker command", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "web", "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> }
  const command = packageJson.scripts?.worker ?? ""

  it("loads the repo environment", () => {
    expect(command).toContain("--env ../.env")
  })

  it.each([
    ["RULES_DIR", '"$PWD/../rules"'],
    ["TEXTSTAT_DATA_DIR", '"$PWD/src/mastra/textstat/data"'],
    ["MEDIA_DIR", '"$PWD/../media"'],
  ])("sets %s to an absolute local path", (variable, directory) => {
    expect(command).toContain(`${variable}=${directory}`)
  })
})
