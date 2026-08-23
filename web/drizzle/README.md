# Drizzle migrations

`0000_baseline.sql` is the whole schema in one migration, generated from
`src/db/schema.ts`. It is the replacement for the Alembic chain
(`api/alembic/versions/001` through `012`), which Phase 7 deletes along with
`api/`: after that point nothing else in this repo can build an empty database.

The baseline is a snapshot, not a translation. It does not replay the eleven
Alembic revisions step by step, it creates the shape they end at. That shape is
verified rather than asserted: `src/db/baseline-parity.test.ts` builds a scratch
database from this folder and diffs it against the live Alembic-migrated
database column by column, index by index and constraint by constraint, in both
directions.

## Creating a fresh database

Three owners, applied in this order. Only the first is in this folder.

1. **Pipeline tables** (`posts`, `website_profiles`, `internal_links`,
   `settings`): `pnpm db:migrate`, which runs `drizzle-kit migrate` against
   `DATABASE_URL_SYNC`.
2. **Auth tables** (`auth_users`, `auth_sessions`, `auth_accounts`,
   `auth_verifications`, `subscription`): `pnpm auth:migrate`. BetterAuth owns
   these, so they are deliberately absent from `schema.ts` and from the
   baseline.
3. **Workflow run state** (`mastra_*`): created by the `@mastra/pg` storage
   adapter the first time the Mastra instance starts. No command to run.

## Changing the schema

`src/db/schema.ts` is the source. Edit it, then regenerate:

```sh
pnpm exec drizzle-kit generate --name <change>
```

While `api/` still exists the same change also needs an Alembic revision, or
`baseline-parity.test.ts` fails: the two sides must agree until the cutover.

## The `alembic_version` table

The baseline still creates it, because the live database has it and parity is
measured against the live database. Its primary key is named
`alembic_version_pkc` rather than Postgres' default `_pkey`, which is why
`schema.ts` states the constraint name explicitly. Phase 7 removes the table
along with the tool that owns it.
