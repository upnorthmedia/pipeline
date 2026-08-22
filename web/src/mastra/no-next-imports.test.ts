/**
 * `web/src/mastra/index.ts` is loaded by the worker process and by the Mastra
 * CLI, neither of which runs inside Next.js. A `next/*` import anywhere in its
 * transitive graph of first-party modules would break both, and it would break
 * them at deploy time rather than here, so pin it with a test.
 *
 * The scan follows relative imports only: third-party packages are the leaves,
 * and what matters is that no first-party module on this path reaches for Next.
 */
import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const SRC = path.resolve(__dirname, "..")
const ENTRY = path.join(SRC, "mastra/index.ts")

/** Matches `from "x"`, `import "x"` and `import("x")`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g

function resolveLocal(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

/** Walks the first-party import graph from `entry`, collecting bare specifiers. */
function importGraph(entry: string): { files: string[]; packages: string[] } {
  const files: string[] = []
  const packages = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (files.includes(file)) continue
    files.push(file)
    const source = fs.readFileSync(file, "utf8")
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1]
      if (specifier.startsWith(".")) {
        const resolved = resolveLocal(file, specifier)
        if (!resolved) throw new Error(`unresolved relative import ${specifier} in ${file}`)
        queue.push(resolved)
      } else if (specifier.startsWith("@/")) {
        const resolved = resolveLocal(path.join(SRC, "_"), `./${specifier.slice(2)}`)
        if (!resolved) throw new Error(`unresolved alias import ${specifier} in ${file}`)
        queue.push(resolved)
      } else {
        packages.add(specifier)
      }
    }
  }
  return { files, packages: [...packages].sort() }
}

describe("mastra entry point", () => {
  it("reaches no next/* module through its first-party imports", () => {
    const { packages } = importGraph(ENTRY)
    const nextish = packages.filter(
      (p) => p === "next" || p.startsWith("next/") || p === "server-only",
    )
    expect(nextish).toEqual([])
  })

  it("pulls in only the packages the registered primitives need", () => {
    const { packages } = importGraph(ENTRY)
    expect(packages).toEqual([
      "@mastra/core",
      "@mastra/core/agent",
      "@mastra/core/workflows/evented",
      "@mastra/loggers",
      "@mastra/pg",
      "@mastra/redis-streams",
      "drizzle-orm",
      "drizzle-orm/node-postgres",
      "drizzle-orm/pg-core",
      "node:crypto",
      // Registering the `images` workflow makes the stage steps reachable from
      // the entry point for the first time: `rules/*.md` is read from disk,
      // generated images are written to disk, sharp encodes them, and the
      // textstat dictionaries the `edit` analytics need are gunzipped.
      "node:fs",
      "node:fs/promises",
      "node:path",
      "node:zlib",
      "pg",
      "sharp",
      "zod",
    ])
  })

  it("negative control: the scan does see next imports when they exist", () => {
    const { files } = importGraph(ENTRY)
    const app = path.join(SRC, "app/page.tsx")
    expect(files).not.toContain(app)
    const { packages } = importGraph(app)
    expect(packages.some((p) => p === "next" || p.startsWith("next/"))).toBe(true)
  })
})
