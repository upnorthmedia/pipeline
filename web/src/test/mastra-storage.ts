import { PostgresStore } from "@mastra/pg"

/**
 * Creates the `mastra_*` run-state tables once, before anything else opens a
 * store against the same database.
 *
 * `@mastra/pg` builds its own schema the first time a `PostgresStore` starts,
 * and that DDL is not safe to run concurrently: two stores initialising at the
 * same moment against a database that has no `mastra_*` tables both issue the
 * same `CREATE INDEX`, and the loser dies with
 * `duplicate key value violates unique constraint "pg_class_relname_nsp_index"`.
 *
 * Seven test files call `storage.init()` or `mastra.startWorkers()` in their
 * own `beforeAll`, and Vitest runs files in parallel, so a first run against a
 * freshly migrated database loses most of them. It never reproduces on a
 * developer's machine, where the tables were created months ago; it reproduces
 * every time in CI, which is the only environment where the database is always
 * new. `src/test/mastra-storage-ready.test.ts` pins both halves.
 */
export async function ensureMastraStorage(databaseUrl: string): Promise<void> {
  const store = new PostgresStore({
    id: "mastra-storage-setup",
    connectionString: databaseUrl.replace("postgresql+asyncpg://", "postgresql://"),
  })
  try {
    await store.init()
  } finally {
    await store.close()
  }
}
