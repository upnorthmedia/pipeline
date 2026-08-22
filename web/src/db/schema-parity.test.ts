// @vitest-environment node
/**
 * Proves `src/db/schema.ts` still describes exactly what Alembic produces.
 *
 * Requires the dev database from `docker compose up -d db redis`, migrated with
 * `alembic upgrade head`. The connection string comes from the repo-root `.env`
 * (`DATABASE_URL_SYNC`), loaded by `vitest.config.ts`.
 */
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"

import * as schema from "./schema"
import {
  describeDatabase,
  describeDrizzleSchema,
  diffSchemas,
  isAlembicOwned,
  toPostgresType,
  type SchemaShape,
} from "./schema-parity"

/** The newest revision under `api/alembic/versions/`. */
const ALEMBIC_HEAD = "011"

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

  it("reports a column Alembic has and schema.ts lacks", () => {
    const drizzle = structuredClone(base)
    delete drizzle.posts.slug
    expect(diffSchemas(base, drizzle)).toEqual(["posts.slug: in database, missing from schema.ts"])
  })

  it("reports a column schema.ts has and Alembic lacks", () => {
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

  it("excludes tables Alembic does not own", () => {
    expect(isAlembicOwned("posts")).toBe(true)
    expect(isAlembicOwned("alembic_version")).toBe(true)
    expect(isAlembicOwned("auth_users")).toBe(false)
    expect(isAlembicOwned("subscription")).toBe(false)
    expect(isAlembicOwned("mastra_workflow_snapshot")).toBe(false)
  })
})

describe("schema.ts against the live Alembic database", () => {
  it("is comparing against a database at Alembic head", async () => {
    const { rows } = await pool.query<{ version_num: string }>(
      "SELECT version_num FROM alembic_version",
    )
    expect(rows.map((r) => r.version_num)).toEqual([ALEMBIC_HEAD])
  })

  it("describes every Alembic table and column, and no others", async () => {
    const alembic = await describeDatabase(pool)
    const drizzle = describeDrizzleSchema(schema)
    expect(diffSchemas(alembic, drizzle)).toEqual([])
    expect(Object.keys(drizzle).sort()).toEqual([
      "alembic_version",
      "internal_links",
      "posts",
      "settings",
      "website_profiles",
    ])
  })
})
