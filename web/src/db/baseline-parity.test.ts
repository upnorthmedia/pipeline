// @vitest-environment node
/**
 * Proves the Drizzle baseline migration builds the database the dev one is.
 *
 * `drizzle/` is the only thing in the repo that can create an empty database.
 * This test applies it to a scratch database and diffs the result against the
 * live dev database, column by column, index by index and constraint by
 * constraint. A drift in either direction fails.
 *
 * Requires the dev database from `docker compose up -d db redis`, migrated with
 * `pnpm -C web db:migrate`. The connection string comes from the repo-root `.env`
 * (`DATABASE_URL_SYNC`), loaded by `vitest.config.ts`.
 */
import path from "node:path"
import { fileURLToPath } from "node:url"

import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  SCHEMA_VERSION,
  describeConstraints,
  describeDatabase,
  describeIndexes,
  diffCatalogLines,
  diffSchemas,
  type CatalogLines,
  type SchemaShape,
} from "./schema-parity"

/** Rebuilt from scratch on every run, so its name must never collide with a real database. */
const SCRATCH_DB = "content_pipeline_baseline_check"

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle")

const devUrl =
  process.env.DATABASE_URL_SYNC?.replace("postgresql+asyncpg://", "postgresql://") ??
  "postgresql://pipeline:pipeline@localhost:5433/content_pipeline"

/** Swap the database name on the dev connection string, keeping host and credentials. */
function withDatabase(name: string): string {
  const url = new URL(devUrl)
  url.pathname = `/${name}`
  return url.toString()
}

const devPool = new Pool({ connectionString: devUrl })
let scratchPool: Pool

let devColumns: SchemaShape
let scratchColumns: SchemaShape
let devIndexes: CatalogLines
let scratchIndexes: CatalogLines
let devConstraints: CatalogLines
let scratchConstraints: CatalogLines

beforeAll(async () => {
  // CREATE DATABASE cannot run inside the target database, so drive it from `postgres`.
  const admin = new Pool({ connectionString: withDatabase("postgres") })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`)
  } finally {
    await admin.end()
  }

  scratchPool = new Pool({ connectionString: withDatabase(SCRATCH_DB) })
  await migrate(drizzle(scratchPool), { migrationsFolder })

  devColumns = await describeDatabase(devPool)
  scratchColumns = await describeDatabase(scratchPool)
  devIndexes = await describeIndexes(devPool)
  scratchIndexes = await describeIndexes(scratchPool)
  devConstraints = await describeConstraints(devPool)
  scratchConstraints = await describeConstraints(scratchPool)
}, 60_000)

afterAll(async () => {
  await scratchPool?.end()
  const admin = new Pool({ connectionString: withDatabase("postgres") })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`)
  } finally {
    await admin.end()
  }
  await devPool.end()
})

describe("drizzle baseline migration", () => {
  it("creates every table the Alembic chain creates, and no others", () => {
    expect(Object.keys(scratchColumns).sort()).toEqual(Object.keys(devColumns).sort())
  })

  it("creates the same columns with the same types, nullability and defaults", () => {
    expect(diffSchemas(devColumns, scratchColumns)).toEqual([])
  })

  it("creates the same indexes under the same names", () => {
    expect(diffCatalogLines(devIndexes, scratchIndexes, "dev", "baseline")).toEqual([])
  })

  it("creates the same constraints under the same names", () => {
    expect(diffCatalogLines(devConstraints, scratchConstraints, "dev", "baseline")).toEqual([])
  })

  it("carries the settings key from item 6.0", () => {
    expect(scratchConstraints).toContain(
      "settings | uq_settings_key_user_id | UNIQUE NULLS NOT DISTINCT (key, user_id)",
    )
  })

  it("stamps the recorded schema version, so a fresh database is not left blank", async () => {
    // The table alone is not the marker. `schema-parity.test.ts` reads this row
    // to prove it is comparing against a database at the recorded version, so a
    // database this folder builds has to carry it too.
    const { rows } = await scratchPool.query<{ version_num: string }>(
      "SELECT version_num FROM alembic_version",
    )
    expect(rows.map((r) => r.version_num)).toEqual([SCHEMA_VERSION])
  })

  it("compares a non-empty catalog, so an empty scratch database cannot pass", () => {
    expect(Object.keys(devColumns).length).toBeGreaterThan(0)
    expect(devIndexes.length).toBeGreaterThan(0)
    expect(devConstraints.length).toBeGreaterThan(0)
  })
})

describe("diffCatalogLines", () => {
  it("passes when both sides agree", () => {
    expect(diffCatalogLines(["a", "b"], ["b", "a"], "dev", "baseline")).toEqual([])
  })

  it("reports a line only the baseline has and one only the dev database has", () => {
    expect(diffCatalogLines(["a"], ["b"], "dev", "baseline")).toEqual([
      "only in baseline: b",
      "only in dev: a",
    ])
  })
})
