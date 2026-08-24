/**
 * The one repo-root `.env`, read by everything that runs outside Next.js.
 *
 * There is exactly one env file and it lives at the repository root, not in
 * `web/`, so every entry point that starts from `web/` has to reach up for it:
 * `next.config.ts` at import time, `vitest.config.ts` for the database tests,
 * `drizzle.config.ts` for `pnpm db:migrate`, and `src/test/global-setup.ts`
 * before the suite starts. Each of those had, or needed, its own copy of this
 * parser; this is that copy, once.
 *
 * `fromDir` is the calling file's own directory rather than `process.cwd()`,
 * because these run under four different loaders (Next's config loader, Vite,
 * drizzle-kit's esbuild bundle, Vitest's main process) and only the caller
 * knows where it is. Pass `__dirname` from a CommonJS-transpiled config and
 * `path.dirname(fileURLToPath(import.meta.url))` from an ES module.
 */
import fs from "node:fs"
import path from "node:path"

/** Parses the repo-root `.env` into a record. Returns `{}` when there is none. */
export function repoRootEnv(fromDir: string): Record<string, string> {
  const file = path.resolve(fromDir, "../.env")
  if (!fs.existsSync(file)) return {}
  const env: Record<string, string> = {}
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "")
  }
  return env
}

/**
 * Copies the repo-root `.env` into `process.env`, existing values winning.
 *
 * That precedence is what makes this safe in production: Railway and compose
 * inject their own environment and there is no root `.env` in the image, so
 * this is a no-op there.
 */
export function applyRepoRootEnv(fromDir: string): void {
  for (const [key, value] of Object.entries(repoRootEnv(fromDir))) {
    if (process.env[key] !== undefined) continue
    process.env[key] = value
  }
}
