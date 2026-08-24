// @vitest-environment node
/**
 * Proves `src/db/schema.ts` still describes exactly what the database holds.
 *
 * Requires the dev database from `docker compose up -d db redis`, migrated with
 * `pnpm -C web db:migrate`. The connection string comes from the repo-root `.env`
 * (`DATABASE_URL_SYNC`), loaded by `vitest.config.ts`.
 */
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"

import * as schema from "./schema"
import {
  SCHEMA_VERSION,
  describeDatabase,
  describeDrizzleSchema,
  diffSchemas,
  isPipelineTable,
  toPostgresType,
  type SchemaShape,
} from "./schema-parity"

const connectionString =
  process.env.DATABASE_URL_SYNC?.replace("postgresql+asyncpg://", "postgresql://") ??
  "postgresql://pipeline:pipeline@localhost:5433/content_pipeline"

const pool = new Pool({ connectionString })

afterAll(async () => {
  await pool.end()
})

const base: SchemaShape = {
  posts: {
    id: { type: "uuid", notNull: true, hasDefault: true },
    slug: { type: "character varying(255)", notNull: true, hasDefault: false },
  },
}

/** The diff must catch drift, not just report success, so exercise both directions. */
describe("diffSchemas", () => {
  it("passes when both sides agree", () => {
    expect(diffSchemas(base, structuredClone(base))).toEqual([])
  })

  it("reports a column the database has and schema.ts lacks", () => {
    const drizzle = structuredClone(base)
    delete drizzle.posts.slug
    expect(diffSchemas(base, drizzle)).toEqual(["posts.slug: in database, missing from schema.ts"])
  })

  it("reports a column schema.ts has and the database lacks", () => {
    const drizzle = structuredClone(base)
    drizzle.posts.invented = { type: "text", notNull: false, hasDefault: false }
    expect(diffSchemas(base, drizzle)).toEqual([
      "posts.invented: in schema.ts, missing from database",
    ])
  })

  it("reports a table missing from each side", () => {
    const drizzle = structuredClone(base)
    delete drizzle.posts
    drizzle.settings = {}
    expect(diffSchemas(base, drizzle)).toEqual([
      "table posts: in database, missing from schema.ts",
      "table settings: in schema.ts, missing from database",
    ])
  })

  it("reports type, nullability and default drift", () => {
    const drizzle = structuredClone(base)
    drizzle.posts.id = { type: "text", notNull: false, hasDefault: false }
    expect(diffSchemas(base, drizzle)).toEqual([
      "posts.id: type database=uuid schema.ts=text",
      "posts.id: notNull database=true schema.ts=false",
      "posts.id: hasDefault database=true schema.ts=false",
    ])
  })
})

describe("type and ownership normalisation", () => {
  it("maps drizzle varchar spellings onto format_type spellings", () => {
    expect(toPostgresType("varchar(255)")).toBe("character varying(255)")
    expect(toPostgresType("varchar")).toBe("character varying")
    expect(toPostgresType("timestamp with time zone")).toBe("timestamp with time zone")
    expect(toPostgresType("jsonb")).toBe("jsonb")
    expect(toPostgresType("json")).toBe("json")
  })

  it("excludes tables the pipeline schema does not own", () => {
    expect(isPipelineTable("posts")).toBe(true)
    expect(isPipelineTable("alembic_version")).toBe(true)
    expect(isPipelineTable("auth_users")).toBe(false)
    expect(isPipelineTable("subscription")).toBe(false)
    expect(isPipelineTable("mastra_workflow_snapshot")).toBe(false)
  })
})

describe("schema.ts against the live database", () => {
  it("is comparing against a database at the recorded schema version", async () => {
    const { rows } = await pool.query<{ version_num: string }>(
      "SELECT version_num FROM alembic_version",
    )
    expect(rows.map((r) => r.version_num)).toEqual([SCHEMA_VERSION])
  })

  it("describes every pipeline table and column, and no others", async () => {
    const database = await describeDatabase(pool)
    const drizzle = describeDrizzleSchema(schema)
    expect(diffSchemas(database, drizzle)).toEqual([])
    expect(Object.keys(drizzle).sort()).toEqual([
      "alembic_version",
      "internal_links",
      "posts",
      "settings",
      "website_profiles",
    ])
  })

  /**
   * The column diff above cannot see constraints, and this one carries meaning
   * the port depends on: `NULLS NOT DISTINCT` is what makes a null `user_id`
   * exactly one global row per key rather than an unbounded set, which is the
   * assumption `getApiKeys()` and `src/test/api-keys-row.ts` are built on.
   */
  it("keys settings on (key, user_id) with nulls treated as equal", async () => {
    const { rows } = await pool.query<{
      conname: string
      contype: string
      columns: string[]
      indnullsnotdistinct: boolean
    }>(
      `SELECT c.conname,
              c.contype,
              array_agg(a.attname::text ORDER BY a.attname) AS columns,
              i.indnullsnotdistinct
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
         LEFT JOIN pg_index i ON i.indexrelid = c.conindid
        WHERE c.conrelid = 'settings'::regclass AND c.contype IN ('p', 'u')
        GROUP BY c.conname, c.contype, i.indnullsnotdistinct
        ORDER BY c.contype`,
    )

    expect(rows).toEqual([
      { conname: "settings_pkey", contype: "p", columns: ["id"], indnullsnotdistinct: false },
      {
        conname: "uq_settings_key_user_id",
        contype: "u",
        columns: ["key", "user_id"],
        indnullsnotdistinct: true,
      },
    ])
  })

  /** The behaviour that constraint buys, exercised rather than described. */
  it("allows one settings row per key without an owner", async () => {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("INSERT INTO settings (key, value) VALUES ($1, $2)", [
        "schema-parity-global",
        JSON.stringify({ first: true }),
      ])
      await expect(
        client.query("INSERT INTO settings (key, value) VALUES ($1, $2)", [
          "schema-parity-global",
          JSON.stringify({ second: true }),
        ]),
      ).rejects.toMatchObject({ code: "23505", constraint: "uq_settings_key_user_id" })
    } finally {
      await client.query("ROLLBACK")
      client.release()
    }
  })
})
