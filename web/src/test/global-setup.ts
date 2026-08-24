import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { applyRepoRootEnv } from "../../repo-env"
import { ensureMastraStorage } from "./mastra-storage"
import { testMediaRoot } from "./test-media-root"

// Global setup runs in Vitest's own process, which never sees `test.env`, so
// the repo-root `.env` has to be loaded again here.
const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

export async function setup(): Promise<void> {
  await rm(testMediaRoot(), { recursive: true, force: true })
  await mkdir(testMediaRoot(), { recursive: true })

  applyRepoRootEnv(webDir)
  const databaseUrl = process.env.DATABASE_URL_SYNC
  if (!databaseUrl) return
  try {
    await ensureMastraStorage(databaseUrl)
  } catch (error) {
    // An unreachable database is not this hook's failure to report: the
    // database suites say so themselves, and failing here would stop the
    // component tests running without Docker up. What must not pass silently
    // is the tables being absent, and `mastra-storage-ready.test.ts` asserts
    // that directly.
    process.stderr.write(`global setup could not prepare the Mastra tables: ${String(error)}\n`)
  }
}

export async function teardown(): Promise<void> {
  await rm(testMediaRoot(), { recursive: true, force: true })
}
