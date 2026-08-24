// @vitest-environment node
/**
 * The `mastra_*` run-state tables exist before the suite's seven event-driven
 * files start opening stores against them.
 *
 * `drizzle/README.md` records that nothing in this repo creates those tables:
 * the `@mastra/pg` adapter builds them the first time a Mastra instance
 * starts. On a database that already has them that is a no-op, which is why a
 * developer's machine never sees the problem. On a freshly migrated one, seven
 * Vitest files racing into the same `CREATE INDEX` take each other down.
 */
import { PostgresStore } from "@mastra/pg"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { ensureMastraStorage } from "./mastra-storage"

/** Rebuilt on every run, so its name must never collide with a real database. */
const SCRATCH_DB = "content_pipeline_mastra_storage_check"

/** What `@mastra/pg` 1.21.1 races on: the index, not the table. */
const RACED_INDEX = "idx_knowledge_nodes_identity"

const devUrl = (
  process.env.DATABASE_URL_SYNC ?? "postgresql://pipeline:pipeline@localhost:5433/content_pipeline"
).replace("postgresql+asyncpg://", "postgresql://")

function withDatabase(name: string): string {
  const url = new URL(devUrl)
  url.pathname = `/${name}`
  return url.toString()
}

const devPool = new Pool({ connectionString: devUrl })

afterAll(async () => {
  await devPool.end()
})

describe("Mastra run-state tables", () => {
  it("is measuring against a real connection string", () => {
    expect(process.env.DATABASE_URL_SYNC, "the repo-root .env must set DATABASE_URL_SYNC").toBeTruthy()
  })

  it("exist before any test file opens a store", async () => {
    // Global setup created these. Without it the winner of the race creates
    // them at some unpredictable point during the run instead.
    const { rows } = await devPool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('mastra_workflow_snapshot', 'mastra_knowledge_nodes')
       ORDER BY table_name`,
    )
    expect(rows.map((r) => r.table_name)).toEqual([
      "mastra_knowledge_nodes",
      "mastra_workflow_snapshot",
    ])

    const { rows: indexes } = await devPool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1",
      [RACED_INDEX],
    )
    expect(indexes.map((r) => r.indexname)).toEqual([RACED_INDEX])
  })
})

describe("four stores initialising at once, which is what the suite does", () => {
  let scratchPool: Pool

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
  }, 60_000)

  afterAll(async () => {
    await scratchPool?.end()
    const admin = new Pool({ connectionString: withDatabase("postgres") })
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`)
    } finally {
      await admin.end()
    }
  })

  it("all succeed once the schema is already there", async () => {
    // Deleting this line is the kill check: the four inits below then race on
    // `CREATE INDEX ${RACED_INDEX}` and three of them reject with
    // `duplicate key value violates unique constraint "pg_class_relname_nsp_index"`.
    await ensureMastraStorage(withDatabase(SCRATCH_DB))

    const stores = [0, 1, 2, 3].map(
      (n) =>
        new PostgresStore({
          id: `concurrent-init-${n}`,
          connectionString: withDatabase(SCRATCH_DB),
        }),
    )
    try {
      const results = await Promise.allSettled(stores.map((store) => store.init()))
      expect(results.map((r) => r.status)).toEqual([
        "fulfilled",
        "fulfilled",
        "fulfilled",
        "fulfilled",
      ])
    } finally {
      await Promise.all(stores.map((store) => store.close()))
    }

    const { rows } = await scratchPool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1",
      [RACED_INDEX],
    )
    expect(rows.map((r) => r.indexname)).toEqual([RACED_INDEX])
  }, 120_000)
})
