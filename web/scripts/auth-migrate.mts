/**
 * Creates or updates the BetterAuth tables (`auth_users`, `auth_sessions`,
 * `auth_accounts`, `auth_verifications`).
 *
 * Alembic deliberately does not own these: revision 010 adds the `user_id`
 * columns but leaves a comment saying BetterAuth creates its own tables
 * separately. Nothing in this repo ever ran that step, so a fresh database has
 * the multi-tenancy columns and no table to scope them against, and every
 * authenticated route handler 401s.
 *
 * The DDL comes from `getMigrations()` in the installed better-auth package
 * rather than from a checked-in SQL file, so it always matches the version in
 * `node_modules` and the field mappings in `src/lib/auth.ts`. `@better-auth/cli`
 * is not used because its newest published version lags the installed core.
 *
 * Usage, from `web/`:
 *   node --env-file=../.env scripts/auth-migrate.mts          # print the SQL
 *   node --env-file=../.env scripts/auth-migrate.mts --apply  # run it
 */
import { getMigrations } from "better-auth/db/migration"

import { auth } from "../src/lib/auth.ts"

const apply = process.argv.includes("--apply")

const { toBeCreated, toBeAdded, compileMigrations, runMigrations } = await getMigrations(
  auth.options,
)

const created = toBeCreated.map((t) => t.table)
const added = toBeAdded.map((t) => `${t.table}.{${Object.keys(t.fields).join(", ")}}`)
console.log(`tables to create: ${created.length ? created.join(", ") : "(none)"}`)
console.log(`columns to add:   ${added.length ? added.join(", ") : "(none)"}`)

if (!created.length && !added.length) {
  console.log("schema is up to date")
  process.exit(0)
}

if (!apply) {
  console.log("\n" + (await compileMigrations()))
  console.log("re-run with --apply to execute")
  process.exit(0)
}

await runMigrations()
console.log("applied")
process.exit(0)
