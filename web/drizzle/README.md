# Drizzle migrations

`0000_baseline.sql` is the whole schema in one migration, generated from
`src/db/schema.ts`. It replaced the twelve-revision Python migration chain the
port deleted, and it, with `0001_schema_version_row.sql`, is the only thing in
this repo that can build an empty database. The second migration inserts the
`alembic_version` row the first only makes room for; see below.

Everything after those two is an ordinary change on top of the baseline.
`0002_post_media.sql` adds `post_media`, the table the images stage mirrors its
generated files into so the web process can serve them without sharing the
worker's disk (`src/mastra/images/media-store.ts`).

The baseline is a snapshot, not a translation. It does not replay those twelve
revisions step by step, it creates the shape they end at. That shape is
verified rather than asserted: `src/db/baseline-parity.test.ts` builds a scratch
database from this folder and diffs it against the live dev database column by
column, index by index and constraint by constraint, in both directions.

## Creating a fresh database

Three owners, applied in this order. Only the first is in this folder.

1. **Pipeline tables** (`posts`, `website_profiles`, `internal_links`,
   `settings`): `pnpm db:migrate`, which walks this folder's `meta/_journal.json`
   against `DATABASE_URL_SYNC`. It runs `scripts/migrate.mjs` rather than
   `drizzle-kit migrate` so that the same command exists in the runtime images,
   where drizzle-kit (a devDependency) does not; the two write the same
   `drizzle.__drizzle_migrations` rows, so a database built by either is
   migrated for both. The script loads the repo-root `.env` if there is one and
   an already-set `DATABASE_URL_SYNC` still wins, which is what the compose,
   Railway and pre-deploy paths rely on.
2. **Auth tables** (`auth_users`, `auth_sessions`, `auth_accounts`,
   `auth_verifications`): `pnpm auth:migrate`. BetterAuth owns these, so they
   are deliberately absent from `schema.ts` and from the baseline. The Stripe
   plugin adds one column, `auth_users.stripeCustomerId`, and no table: its
   `subscription` table appears only under `subscription: { enabled: true }`,
   which `src/lib/auth.ts` does not set (P2.100).
3. **Workflow run state** (`mastra_*`): created by the `@mastra/pg` storage
   adapter the first time the Mastra instance starts. No command to run, but
   note that this DDL is not safe to run concurrently: two stores initialising
   at the same moment against a database with no `mastra_*` tables issue the
   same `CREATE INDEX` and the loser dies on `pg_class_relname_nsp_index`. The
   test suite creates them once up front for that reason
   (`src/test/mastra-storage.ts`).

## Posts with no profile

`posts.profile_id` is nullable and there is no `posts.user_id`, so a row with no
profile has no owner: every read handler reaches the account by inner-joining
`website_profiles`, which means such a row cannot be listed, opened, run or
deleted through the app. Both writers that produced them are closed, the create
path (ledger item P2.97) and `DELETE /api/profiles/{id}`, which now refuses a
profile that still has posts rather than nulling the column (P4.7).

Rows written before those fixes are still there. `pnpm posts:orphans` lists
them, with `--delete` to remove them:

```sh
pnpm posts:orphans              # list, write nothing
pnpm posts:orphans --delete     # remove them
```

The column is deliberately still nullable. Making it `NOT NULL` would mean a
migration that first deletes rows whose owner cannot be determined, and a
schema constraint is not worth destroying somebody's drafts without asking.

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
