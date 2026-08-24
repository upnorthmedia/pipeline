// @vitest-environment node
/**
 * `pnpm db:migrate` is the only thing in this repo that can build an empty
 * database, and drizzle-kit ships no env loader, so `drizzle.config.ts` has to
 * read the repo-root `.env` itself. Without that it falls through to its
 * hardcoded fallback and fails to connect on any machine whose Postgres is not
 * the compose default on 5433, which is every fresh checkout and every CI run.
 */
import path from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { repoRootEnv } from "../../repo-env"

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const inherited = process.env.DATABASE_URL_SYNC

afterEach(() => {
  if (inherited === undefined) delete process.env.DATABASE_URL_SYNC
  else process.env.DATABASE_URL_SYNC = inherited
})

describe("drizzle.config.ts", () => {
  it("resolves the migration target from the repo-root .env when the environment carries none", async () => {
    const expected = repoRootEnv(webDir).DATABASE_URL_SYNC
    expect(expected, "the repo-root .env must set DATABASE_URL_SYNC").toBeTruthy()

    delete process.env.DATABASE_URL_SYNC
    const config = (await import("../../drizzle.config")).default

    // `Config` is a union whose credential shape varies by driver, so the
    // migration target is only reachable through the shape this config uses.
    const credentials = (config as unknown as { dbCredentials: { url?: string } }).dbCredentials
    expect(credentials.url).toBe(expected)
  })
})
