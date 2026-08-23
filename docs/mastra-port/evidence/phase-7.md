# Phase 7 evidence

## 7.0

The fresh-database path after Alembic is deleted.

### What landed

`web/drizzle/0000_baseline.sql` plus its journal and snapshot, generated from
`web/src/db/schema.ts` with `drizzle-kit generate --name baseline`. It creates the whole
schema in one migration rather than replaying the eleven Alembic revisions: it produces the
shape they end at. `pnpm -C web db:migrate` (`drizzle-kit migrate`) applies it.

`web/drizzle/README.md` records the three owners a fresh database needs, in order: this
baseline for the pipeline tables, `pnpm auth:migrate` for the BetterAuth tables, and the
`@mastra/pg` storage adapter (which creates its own `mastra_*` tables on first boot, with no
command to run). `schema.ts` deliberately describes only the first group, which is why the
parity helpers filter `auth_*`, `subscription` and `mastra_*` out of both sides.

### The one schema.ts change this needed

Alembic names `alembic_version`'s primary key `alembic_version_pkc`, not Postgres' default
`_pkey`. Drizzle's `.primaryKey()` shorthand cannot state a constraint name, so the table moved
to the `primaryKey({ columns, name })` form. Without it the baseline built a constraint the live
database does not carry, which the sweep below confirms is caught.

### Verification: a scratch database diffed against the live Alembic database

`web/src/db/baseline-parity.test.ts` creates `content_pipeline_baseline_check`, applies
`drizzle/` to it through the real `drizzle-orm/node-postgres` migrator, then diffs it against
the live `alembic upgrade head` database in both directions across three catalogs: columns
(type, nullability, default presence), indexes (`pg_indexes.indexdef`) and constraints
(`pg_get_constraintdef`). Index and constraint names are compared, not just their columns,
because `posts_profile_id_fkey` and `uq_settings_key_user_id` are named in error paths and in
`ON CONFLICT` arbiters. The scratch database is dropped in `afterAll`.

```
$ npx vitest run src/db/baseline-parity.test.ts
 RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web

 ✓ src/db/baseline-parity.test.ts (8 tests) 174ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Duration  521ms
```

The eight are: same table set, same columns, same indexes, same constraints, the item 6.0
settings key present verbatim, a guard that the compared catalogs are non-empty (so an empty
scratch database cannot pass by matching nothing), and two unit cases pinning `diffCatalogLines`
in both directions.

The 6.0 assertion, read back off the scratch database rather than the dev one:

```
settings | uq_settings_key_user_id | UNIQUE NULLS NOT DISTINCT (key, user_id)
```

### The CLI path, run against a scratch database

```
$ DATABASE_URL_SYNC=.../baseline_check pnpm -C web run db:migrate
> content-pipeline-dashboard@0.1.0 db:migrate
> drizzle-kit migrate

No config path provided, using default 'drizzle.config.ts'
Reading config file '.../web/drizzle.config.ts'
Using 'pg' driver for database querying
[✓] migrations applied successfully!

$ psql -tA .../baseline_check -c "select count(*) from pg_tables where schemaname='public';"
5
```

Five: the four pipeline tables plus `alembic_version`. Drizzle's own bookkeeping table lives in
a separate `drizzle` schema, so it does not appear in `public` and does not perturb parity.

### Mutation sweep, 8 of 8 killed

Each mutation edits `drizzle/0000_baseline.sql` (the artifact under test), reruns the file, and
restores from a backup. Verdict is the exit code, not a grep of the summary line.

| # | Mutation | Verdict |
| --- | --- | --- |
| 1 | drop the `posts.ready_content` column | KILLED (1 test) |
| 2 | rename index `idx_internal_links_profile` | KILLED (1 test) |
| 3 | rename constraint `uq_posts_profile_slug` | KILLED (2 tests) |
| 4 | drop `NULLS NOT DISTINCT` from the settings unique | KILLED (3 tests) |
| 5 | drop the `posts.word_count` default | KILLED (1 test) |
| 6 | weaken `posts.slug` to nullable | KILLED (1 test) |
| 7 | revert the `alembic_version` PK name to `_pkey` | KILLED (2 tests) |
| 8 | drop the `internal_links.post_id` foreign key | KILLED (1 test) |

Mutation 7 is the control for this item's only `schema.ts` edit: without that edit the baseline
fails parity, so the edit is load-bearing rather than cosmetic.

### Gates

```
$ npx tsc --noEmit          -> exit 0
$ npx eslint                -> exit 0
$ npx next build            -> exit 0
$ npx vitest run            -> exit 1
      Tests  10 failed | 4468 passed | 7 skipped (4485)
 Test Files  3 failed | 128 passed (131)
```

The ten failures are the recorded pre-existing set and nothing else: 6 in
`image-preview.test.tsx`, 3 in `PostDetail.test.tsx`, and one run of the known
`scaffold-check.test.ts` event-ordering flake ("emits the workflow lifecycle events the trace
view will read"), all documented in earlier iterations. The passing count moved from 4461 to
4468, which is this item's eight tests less one flake-affected pass. No Python file was touched,
so the pytest gate is unchanged.

### Known limitation

The baseline is a snapshot of the end state, not a replay of Alembic 001-012. A database that
is already partly migrated cannot be brought forward with it: it builds an empty database only.
That is the only case Phase 7 needs, since existing deployments already sit at Alembic head and
Drizzle takes over from there, but it means the `drizzle/` folder has no downgrade path.
