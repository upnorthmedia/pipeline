/**
 * Lists, and on request removes, the `posts` rows that carry no `profile_id`.
 *
 * Such a row is unreachable through the app and always was. `posts` has no
 * `user_id`: ownership is only reachable by joining `website_profiles` through
 * `profile_id`, and every read handler inner-joins it, so a post with no
 * profile belongs to nobody. It cannot be listed, opened, run or deleted from
 * the dashboard, and nothing in the app can work out who it belonged to.
 *
 * Both writers that produced these rows are closed: `POST /api/posts` requires
 * `profile_id` (ledger item P2.97) and `DELETE /api/profiles/{id}` now refuses
 * a profile that still has posts instead of nulling the column (P4.7). What is
 * left is the rows already in the table, and no migration can decide their
 * fate: the content may matter to whoever wrote it, and this process cannot
 * ask. So the decision stays with the operator and this is the tool for it,
 * which is also why the delete is opt-in and prints what it is about to do.
 *
 * Usage, from `web/`:
 *   pnpm posts:orphans              # list them, write nothing
 *   pnpm posts:orphans --delete     # remove them
 */
import { Pool } from "pg"

import { databaseUrl } from "./migrate-lib.mjs"

/** The columns worth seeing before deciding: enough to recognise the row. */
const SELECT_ORPHANS = `
  SELECT id, slug, topic, current_stage, created_at,
         (ready_content IS NOT NULL OR final_md_content IS NOT NULL
          OR draft_content IS NOT NULL) AS has_content
  FROM posts
  WHERE profile_id IS NULL
  ORDER BY created_at
`

/**
 * @param {import("pg").Pool} pool
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function listOrphanedPosts(pool) {
  const { rows } = await pool.query(SELECT_ORPHANS)
  return rows
}

/**
 * @param {import("pg").Pool} pool
 * @returns {Promise<number>} rows removed
 */
export async function deleteOrphanedPosts(pool) {
  const { rowCount } = await pool.query(`DELETE FROM posts WHERE profile_id IS NULL`)
  return rowCount ?? 0
}

function describe(row) {
  const when = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
  const content = row.has_content ? "has content" : "empty"
  return `  ${row.id}  ${when}  ${row.current_stage}  ${content}  ${row.slug}\n    ${row.topic}`
}

const remove = process.argv.includes("--delete")
const pool = new Pool({ connectionString: databaseUrl() })
try {
  const rows = await listOrphanedPosts(pool)
  if (rows.length === 0) {
    console.log("no posts without a profile")
  } else {
    const noun = rows.length === 1 ? "post" : "posts"
    console.log(`${rows.length} ${noun} without a profile, unreachable through the app:`)
    for (const row of rows) console.log(describe(row))
    if (remove) {
      const removed = await deleteOrphanedPosts(pool)
      console.log(`deleted ${removed}`)
    } else {
      console.log("nothing written. Re-run with --delete to remove them.")
    }
  }
} finally {
  await pool.end()
}
