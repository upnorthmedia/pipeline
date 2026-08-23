# Drizzle migrations

`0000_baseline.sql` is the whole schema in one migration, generated from
`src/db/schema.ts`. It replaced the twelve-revision Python migration chain the
port deleted, and it is now the only thing in this repo that can build an empty
database.

The baseline is a snapshot, not a translation. It does not replay those twelve
revisions step by step, it creates the shape they end at. That shape is
verified rather than asserted: `src/db/baseline-parity.test.ts` builds a scratch
database from this folder and diffs it against the live dev database column by
column, index by index and constraint by constraint, in both directions.

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

`baseline-parity.test.ts` then proves the regenerated baseline still builds
the database the dev one is.

## The `alembic_version` table

This one-column table is the only thing the deleted migration chain left
behind. It is kept, not dropped: every existing database has it, parity is
measured against those databases, and the row it holds (`012`) is the marker
that says which schema version they are at. Its primary key is named
`alembic_version_pkc` rather than Postgres' default `_pkey`, which is why
`schema.ts` states the constraint name explicitly. Dropping it would be a
schema change made for tidiness, which the port does not do.
