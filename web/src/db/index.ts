/**
 * The database client for the TypeScript stack.
 *
 * Deliberately free of `next/*` imports: the Mastra worker process imports this
 * module too, and pulling Next.js in would stop it booting.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import * as schema from "./schema"

/**
 * The repo-root `.env` states the connection twice, once for asyncpg and once
 * for psycopg. `pg` understands neither driver prefix, so normalise whichever
 * one is set.
 */
export function toNodePostgresUrl(url: string): string {
  return url.replace(/^postgresql\+\w+:\/\//, "postgresql://")
}

function connectionString(): string {
  const url = process.env.DATABASE_URL_SYNC ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error("DATABASE_URL_SYNC (or DATABASE_URL) must be set to reach the database")
  }
  return toNodePostgresUrl(url)
}

/**
 * Next.js dev recompiles this module on every edit, so cache the pool on
 * `globalThis` rather than leaking a new pool (and its connections) per reload.
 */
const globalForDb = globalThis as unknown as {
  __contentPipelinePool?: Pool
  __contentPipelineDb?: NodePgDatabase<typeof schema>
}

export function getPool(): Pool {
  if (!globalForDb.__contentPipelinePool) {
    globalForDb.__contentPipelinePool = new Pool({ connectionString: connectionString() })
  }
  return globalForDb.__contentPipelinePool
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!globalForDb.__contentPipelineDb) {
    globalForDb.__contentPipelineDb = drizzle(getPool(), { schema })
  }
  return globalForDb.__contentPipelineDb
}

/** Closes the pooled connections. For scripts and tests; the servers keep the pool open. */
export async function closeDb(): Promise<void> {
  const pool = globalForDb.__contentPipelinePool
  globalForDb.__contentPipelinePool = undefined
  globalForDb.__contentPipelineDb = undefined
  await pool?.end()
}

export * from "./schema"
