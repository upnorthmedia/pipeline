/**
 * `docker compose up` builds the `deps` target, mounts only `src`, `public`,
 * `drizzle` and `rules` over it, and runs `next dev`. Anything `next.config.ts`
 * imports from `web/` itself therefore has to be baked into that stage by a
 * `COPY`, or the container exits with "Cannot find module". The production
 * stages copy all of `web/`, so no gate that builds them notices.
 */
import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const WEB = path.resolve(__dirname, "../..")

function relativeImports(source: string): string[] {
  return [...source.matchAll(/^\s*import\s[^"']*["'](\.{1,2}\/[^"']+)["']/gm)].map((m) => m[1])
}

/** Source operands of every `COPY` in the `deps` stage, relative to the repo root. */
function depsStageCopySources(dockerfile: string): string[] {
  const sources: string[] = []
  let stage = ""
  for (const line of dockerfile.replace(/\\\n/g, " ").split("\n")) {
    const tokens = line.trim().split(/\s+/)
    const keyword = tokens[0].toUpperCase()
    if (keyword === "FROM") {
      const asIndex = tokens.findIndex((t) => t.toUpperCase() === "AS")
      stage = asIndex === -1 ? tokens[1] : tokens[asIndex + 1]
    } else if (keyword === "COPY" && stage === "deps") {
      const operands = tokens.slice(1).filter((t) => !t.startsWith("--"))
      sources.push(...operands.slice(0, -1))
    }
  }
  return sources
}

describe("deps stage of web/Dockerfile", () => {
  it("copies every local file next.config.ts imports", () => {
    const imports = relativeImports(fs.readFileSync(path.join(WEB, "next.config.ts"), "utf8"))
    expect(imports.length).toBeGreaterThan(0)

    const copied = depsStageCopySources(fs.readFileSync(path.join(WEB, "Dockerfile"), "utf8"))
    const missing = imports
      .map((specifier) => {
        const resolved = [".ts", ".mjs", ".js", ""]
          .map((ext) => path.join("web", specifier) + ext)
          .find((candidate) => fs.existsSync(path.resolve(WEB, "..", candidate)))
        return resolved ?? `${specifier} (no such file)`
      })
      .filter((file) => !copied.includes(file))

    expect(missing).toEqual([])
  })
})
