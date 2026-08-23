/**
 * Schema parity between the live database and the TypeScript schema.
 *
 * The database is the source of truth for this port: `src/db/schema.ts`
 * mirrors it and must never drift from it. The
 * helpers here describe both sides in the same shape so a diff can prove, in
 * both directions, that no table or column exists on one side only.
 */
import { is } from "drizzle-orm"
import { PgTable, getTableConfig } from "drizzle-orm/pg-core"
import type { Pool } from "pg"

/** A single column reduced to the properties both sides can state exactly. */
export interface ColumnShape {
  /** Postgres type as `format_type` renders it, e.g. `character varying(255)`. */
  type: string
  notNull: boolean
  hasDefault: boolean
}

/** table name -> column name -> shape. */
export type SchemaShape = Record<string, Record<string, ColumnShape>>

/**
 * Tables in the `public` schema that the pipeline schema does not own, so the
 * parity check must not report them as unexpected. BetterAuth creates `auth_*`
 * (see `src/lib/auth.ts`) plus `subscription` from its Stripe plugin, and Mastra's
 * Postgres storage adapter creates `mastra_*` for workflow run state.
 */
export function isPipelineTable(table: string): boolean {
  if (table.startsWith("auth_")) return false
  if (table.startsWith("mastra_")) return false
  if (table === "subscription") return false
  return true
}

/**
 * Drizzle prints `varchar(255)`; Postgres' `format_type` prints
 * `character varying(255)`. Every other type the schema uses is spelled the
 * same on both sides.
 */
export function toPostgresType(drizzleType: string): string {
  const t = drizzleType.toLowerCase().trim()
  if (t === "varchar") return "character varying"
  if (t.startsWith("varchar(")) return `character varying${t.slice("varchar".length)}`
  return t
}

/** Describe the TypeScript schema: every `pgTable` exported from a schema module. */
export function describeDrizzleSchema(module: Record<string, unknown>): SchemaShape {
  const shape: SchemaShape = {}
  for (const value of Object.values(module)) {
    if (!is(value, PgTable)) continue
    const config = getTableConfig(value)
    const columns: Record<string, ColumnShape> = {}
    for (const column of config.columns) {
      columns[column.name] = {
        type: toPostgresType(column.getSQLType()),
        notNull: column.notNull,
        hasDefault: column.hasDefault,
      }
    }
    shape[config.name] = columns
  }
  return shape
}

/** Describe the live database's `public` schema from the Postgres catalog. */
export async function describeDatabase(pool: Pool): Promise<SchemaShape> {
  const { rows } = await pool.query<{
    table_name: string
    column_name: string
    type: string
    not_null: boolean
    has_default: boolean
  }>(
    `SELECT c.relname            AS table_name,
            a.attname            AS column_name,
            format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull         AS not_null,
            a.atthasdef          AS has_default
       FROM pg_attribute a
       JOIN pg_class c     ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
  )
  const shape: SchemaShape = {}
  for (const row of rows) {
    if (!isPipelineTable(row.table_name)) continue
    shape[row.table_name] ??= {}
    shape[row.table_name][row.column_name] = {
      type: row.type,
      notNull: row.not_null,
      hasDefault: row.has_default,
    }
  }
  return shape
}

/** One human-readable difference between the two descriptions. */
export type ParityDiff = string

/**
 * Compare the database against the TypeScript schema ("drizzle")
 * in both directions. An empty result means the two describe the same tables
 * and columns with the same types, nullability and default presence.
 */
export function diffSchemas(database: SchemaShape, drizzle: SchemaShape): ParityDiff[] {
  const diffs: ParityDiff[] = []
  const tables = [...new Set([...Object.keys(database), ...Object.keys(drizzle)])].sort()

  for (const table of tables) {
    const inDb = database[table]
    const inTs = drizzle[table]
    if (!inTs) {
      diffs.push(`table ${table}: in database, missing from schema.ts`)
      continue
    }
    if (!inDb) {
      diffs.push(`table ${table}: in schema.ts, missing from database`)
      continue
    }
    const columns = [...new Set([...Object.keys(inDb), ...Object.keys(inTs)])].sort()
    for (const column of columns) {
      const dbCol = inDb[column]
      const tsCol = inTs[column]
      if (!tsCol) {
        diffs.push(`${table}.${column}: in database, missing from schema.ts`)
        continue
      }
      if (!dbCol) {
        diffs.push(`${table}.${column}: in schema.ts, missing from database`)
        continue
      }
      if (dbCol.type !== tsCol.type) {
        diffs.push(`${table}.${column}: type database=${dbCol.type} schema.ts=${tsCol.type}`)
      }
      if (dbCol.notNull !== tsCol.notNull) {
        diffs.push(
          `${table}.${column}: notNull database=${dbCol.notNull} schema.ts=${tsCol.notNull}`,
        )
      }
      if (dbCol.hasDefault !== tsCol.hasDefault) {
        diffs.push(
          `${table}.${column}: hasDefault database=${dbCol.hasDefault} schema.ts=${tsCol.hasDefault}`,
        )
      }
    }
  }
  return diffs
}

/**
 * One `table | name | definition` line per index or constraint, sorted. Names
 * are part of the shape: `posts_profile_id_fkey` and `uq_settings_key_user_id`
 * are quoted in error paths and in `ON CONFLICT` arbiters, so a database that
 * carries the same columns under different constraint names is not the same
 * database.
 */
export type CatalogLines = string[]

/** Index definitions from `pg_indexes`, Alembic-owned tables only. */
export async function describeIndexes(pool: Pool): Promise<CatalogLines> {
  const { rows } = await pool.query<{ table_name: string; line: string }>(
    `SELECT tablename AS table_name,
            tablename || ' | ' || indexname || ' | ' || indexdef AS line
       FROM pg_indexes
      WHERE schemaname = 'public'`,
  )
  return rows
    .filter((row) => isPipelineTable(row.table_name))
    .map((row) => row.line)
    .sort()
}

/** Constraint definitions from `pg_constraint`, Alembic-owned tables only. */
export async function describeConstraints(pool: Pool): Promise<CatalogLines> {
  const { rows } = await pool.query<{ table_name: string; line: string }>(
    `SELECT conrelid::regclass::text AS table_name,
            conrelid::regclass::text || ' | ' || conname || ' | ' ||
              pg_get_constraintdef(oid) AS line
       FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace`,
  )
  return rows
    .filter((row) => isPipelineTable(row.table_name))
    .map((row) => row.line)
    .sort()
}

/** Lines present on one side only, tagged with which side has them. */
export function diffCatalogLines(
  expected: CatalogLines,
  actual: CatalogLines,
  expectedLabel: string,
  actualLabel: string,
): ParityDiff[] {
  const inActual = new Set(actual)
  const inExpected = new Set(expected)
  return [
    ...expected
      .filter((line) => !inActual.has(line))
      .map((line) => `only in ${expectedLabel}: ${line}`),
    ...actual
      .filter((line) => !inExpected.has(line))
      .map((line) => `only in ${actualLabel}: ${line}`),
  ].sort()
}
