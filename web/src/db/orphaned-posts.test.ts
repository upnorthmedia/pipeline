// @vitest-environment node
/**
 * Ledger item P4.7. `posts` rows with no `profile_id` are unreachable through
 * the app: the table carries no `user_id`, so ownership is only reachable by
 * joining `website_profiles`, and every read handler inner-joins it. Both
 * writers are now closed (P2.97 at `POST /api/posts`, P4.7 at
 * `DELETE /api/profiles/{id}`), which leaves the rows already written, and
 * `pnpm posts:orphans` is the only way to see or remove them.
 *
 * The script deletes every orphan in the database it is pointed at, which is
 * the whole point of it and also why these cases build a scratch database
 * rather than using the dev one: a test must not decide the fate of somebody's
 * rows. `scripts/migrate.mjs` fills it, so the schema under test is the real
 * one.
 *
 * Requires the dev database from `docker compose up -d db redis`; the
 * connection string comes from the repo-root `.env` (`DATABASE_URL_SYNC`).
 */
import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { Pool } from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

const run = promisify(execFile)

const SCRATCH_DB = "content_pipeline_orphans_check"

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const devUrl =
  process.env.DATABASE_URL_SYNC?.replace("postgresql+asyncpg://", "postgresql://") ??
  "postgresql://pipeline:pipeline@localhost:5433/content_pipeline"

function withDatabase(name: string): string {
  const url = new URL(devUrl)
  url.pathname = `/${name}`
  return url.toString()
}

const scratchUrl = withDatabase(SCRATCH_DB)

/** The child must not be able to reach the dev database, whatever `.env` says. */
function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DATABASE_URL_SYNC: scratchUrl, DATABASE_URL: scratchUrl }
}

function orphans(...args: string[]) {
  return run("node", [path.join(webDir, "scripts/orphaned-posts.mjs"), ...args], {
    cwd: webDir,
    env: childEnv(),
  })
}

let pool: Pool
let profileId: string

beforeAll(async () => {
  const admin = new Pool({ connectionString: withDatabase("postgres") })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`)
  } finally {
    await admin.end()
  }
  await run("node", [path.join(webDir, "scripts/migrate.mjs")], { cwd: webDir, env: childEnv() })
  pool = new Pool({ connectionString: scratchUrl })
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO website_profiles (user_id, name, website_url)
     VALUES ('orphan-check-user', 'Attached', 'https://example.com') RETURNING id`,
  )
  profileId = rows[0].id
}, 180_000)

afterAll(async () => {
  await pool?.end()
  const admin = new Pool({ connectionString: withDatabase("postgres") })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`)
  } finally {
    await admin.end()
  }
})

beforeEach(async () => {
  await pool.query(`DELETE FROM posts`)
})

/** One row with no profile, and one attached to `profileId`, as a control. */
async function seedPair(): Promise<{ orphan: string; attached: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO posts (profile_id, slug, topic, current_stage, ready_content)
     VALUES (NULL, 'stranded-draft', 'A post nobody owns', 'ready', '# body'),
            ($1, 'attached-draft', 'A post with a profile', 'pending', NULL)
     RETURNING id`,
    [profileId],
  )
  return { orphan: rows[0].id, attached: rows[1].id }
}

async function slugsLeft(): Promise<string[]> {
  const { rows } = await pool.query<{ slug: string }>(`SELECT slug FROM posts ORDER BY slug`)
  return rows.map((row) => row.slug)
}

describe("pnpm posts:orphans", () => {
  it("names every post with no profile, and no post that has one", async () => {
    const { orphan, attached } = await seedPair()

    const { stdout } = await orphans()

    expect(stdout).toContain("1 post without a profile")
    expect(stdout).toContain(orphan)
    expect(stdout).toContain("stranded-draft")
    expect(stdout).toContain("A post nobody owns")
    // Enough to tell a row worth keeping from an empty shell.
    expect(stdout).toContain("has content")
    expect(stdout).not.toContain(attached)
  }, 60_000)

  it("writes nothing without --delete", async () => {
    await seedPair()

    const { stdout } = await orphans()

    expect(stdout).toContain("Re-run with --delete to remove them.")
    expect(await slugsLeft()).toEqual(["attached-draft", "stranded-draft"])
  }, 60_000)

  it("removes them with --delete, and leaves the attached post alone", async () => {
    await seedPair()

    const { stdout } = await orphans("--delete")

    expect(stdout).toContain("deleted 1")
    expect(await slugsLeft()).toEqual(["attached-draft"])
  }, 60_000)

  it("says so when there are none, which is the state to keep the table in", async () => {
    await pool.query(
      `INSERT INTO posts (profile_id, slug, topic) VALUES ($1, 'only-attached', 'Owned')`,
      [profileId],
    )

    const { stdout } = await orphans("--delete")

    expect(stdout).toBe("no posts without a profile\n")
    expect(await slugsLeft()).toEqual(["only-attached"])
  }, 60_000)
})
