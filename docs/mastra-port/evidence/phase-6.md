# Phase 6 evidence

Commands and their real output for the checked items in Phase 6 of
`docs/mastra-port/LEDGER.md`.

## 6.0

### The defect, reproduced first

`src/app/api/settings/route.test.ts` previously asserted the defect
(`refuses to write over a key another user already owns`). That assertion was replaced
with the two cases the fix has to satisfy, and they failed for the expected reason before
any schema change:

```
$ cd web && pnpm vitest run src/app/api/settings/route.test.ts
 FAIL  src/app/api/settings/route.test.ts > PATCH /api/settings > keeps one value per user for the same key
 FAIL  src/app/api/settings/route.test.ts > PATCH /api/settings > coexists with the global row for the same key, which is where api_keys lives
Caused by: error: duplicate key value violates unique constraint "settings_pkey"
Serialized Error: { length: 215, severity: 'ERROR', code: '23505', detail: 'Key (key)=(settings-route-test-shared) already exists.', ..., constraint: 'settings_pkey', file: 'nbtinsert.c', routine: '_bt_check_unique' }

 Test Files  1 failed (1)
      Tests  2 failed | 11 passed (13)
```

### `UNIQUE NULLS NOT DISTINCT` verified against the running server first

```
$ psql "$DATABASE_URL_SYNC" -c "select version();"
                                            version
-----------------------------------------------------------------------------------------------
 PostgreSQL 17.8 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit

$ psql "$DATABASE_URL_SYNC"   # in a transaction, rolled back
BEGIN
CREATE TABLE
ALTER TABLE
INSERT 0 1     -- ('api_keys', NULL)
INSERT 0 1     -- ('api_keys', 'u1')
INSERT 0 1     -- ('api_keys', 'u2')
SAVEPOINT
ERROR:  duplicate key value violates unique constraint "uq_nnd"
DETAIL:  Key (key, user_id)=(api_keys, null) already exists.
ROLLBACK
 rows_kept
-----------
         3
ROLLBACK
```

So one global row per key, any number of per-user rows: the shape the objective specifies.

### Where the migration lands

**Both stacks, but only one migration file: Alembic revision `012`.** Alembic still owns
the schema until Phase 7 deletes it, `web/src/db/schema.ts` mirrors what Alembic produced
(see the header of that file and `drizzle.config.ts`, which deliberately has no generate
workflow), and pytest's `conftest.py` builds its database from `metadata.create_all()`
rather than migrations, so `api/src/models/setting.py` had to change in lockstep or the
two would silently diverge. Adding a Drizzle migration now would create a second source of
truth for a schema Drizzle does not yet own.

After the cutover a fresh database is created from `schema.ts`, which already carries the
new shape (`id` surrogate primary key plus `unique(...).nullsNotDistinct()`), so the
mechanism to build one belongs with the rest of the Drizzle ownership handover in Phase 7.
That is now ledger item 7.0 rather than an assumption left implicit here.

### Applied to the dev database, with the `api_keys` row byte-identical

Fingerprint taken before:

```
$ psql "$DATABASE_URL_SYNC" -tAc "select md5(value::text), length(value::text), updated_at from settings where key='api_keys' and user_id is null;"
0ebf110838ac6928df37c170e8ad8d2f|605|2026-08-23 16:08:07.661389+00
```

```
$ cd api && uv run alembic current
011
$ cd api && uv run alembic upgrade head
INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.
INFO  [alembic.runtime.migration] Will assume transactional DDL.
INFO  [alembic.runtime.migration] Running upgrade 011 -> 012, Give the settings table a per-user key.
```

```
$ psql "$DATABASE_URL_SYNC" -c "\d settings"
                             Table "public.settings"
   Column   |           Type           | Collation | Nullable |      Default
------------+--------------------------+-----------+----------+-------------------
 key        | character varying(255)   |           | not null |
 value      | jsonb                    |           | not null |
 updated_at | timestamp with time zone |           |          | now()
 user_id    | character varying        |           |          |
 id         | uuid                     |           | not null | gen_random_uuid()
Indexes:
    "settings_pkey" PRIMARY KEY, btree (id)
    "ix_settings_user_id" btree (user_id)
    "uq_settings_key_user_id" UNIQUE CONSTRAINT, btree (key, user_id) NULLS NOT DISTINCT
```

```
$ psql "$DATABASE_URL_SYNC" -c "select key, user_id, md5(value::text), length(value::text), updated_at from settings;"
   key    | user_id |               md5                | length |          updated_at
----------+---------+----------------------------------+--------+-------------------------------
 api_keys |         | 0ebf110838ac6928df37c170e8ad8d2f |    605 | 2026-08-23 16:08:07.661389+00
```

Same md5, same length, same `updated_at`. `ADD COLUMN` with a volatile default rewrites the
table, so the row was physically moved and still came out identical.

### Replayable from scratch

```
$ psql ".../postgres" -c "CREATE DATABASE settings_pk_replay;"
CREATE DATABASE
$ cd api && DATABASE_URL_SYNC=".../settings_pk_replay" DATABASE_URL="postgresql+asyncpg://.../settings_pk_replay" uv run alembic upgrade head
INFO  [alembic.runtime.migration] Running upgrade 007 -> 008, Add WordPress integration fields.
INFO  [alembic.runtime.migration] Running upgrade 008 -> 009, Add article_type and additional_info columns to posts.
INFO  [alembic.runtime.migration] Running upgrade 009 -> 010, Add user_id to website_profiles and settings for multi-tenancy.
INFO  [alembic.runtime.migration] Running upgrade 010 -> 011, Add Next.js publishing fields to profiles and posts.
INFO  [alembic.runtime.migration] Running upgrade 011 -> 012, Give the settings table a per-user key.

$ psql ".../settings_pk_replay" -c "\d settings"
Indexes:
    "settings_pkey" PRIMARY KEY, btree (id)
    "ix_settings_user_id" btree (user_id)
    "uq_settings_key_user_id" UNIQUE CONSTRAINT, btree (key, user_id) NULLS NOT DISTINCT
$ psql ".../postgres" -c "DROP DATABASE settings_pk_replay;"
DROP DATABASE
```

`0 -> 012` on an empty database produces the same shape as `011 -> 012` on the live one.

### SQLAlchemy agrees, so pytest's `create_all()` database matches

```
$ cd api && uv run python -c "from sqlalchemy.schema import CreateTable; from sqlalchemy.dialects import postgresql; from src.models.setting import Setting; print(CreateTable(Setting.__table__).compile(dialect=postgresql.dialect()))"
CREATE TABLE settings (
	key VARCHAR(255) NOT NULL,
	user_id VARCHAR,
	value JSONB NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	id UUID NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_settings_key_user_id UNIQUE NULLS NOT DISTINCT (key, user_id),
	FOREIGN KEY(user_id) REFERENCES auth_users (id)
)
```

### Callers that keyed on `settings.key`

Four call sites broke on the new key and were fixed rather than worked around:

- `session.get(Setting, "api_keys")` in `api/src/services/api_keys.py` (four calls) now
  goes through `_get_global_setting()`, which selects on `key` plus `user_id IS NULL`.
- The same `session.get()` in `tests/phase11/test_api_keys{,_service}.py` and
  `tests/phase1/test_models.py`, replaced with the same key lookup. Those assertions are
  unchanged in meaning: the constraint still allows only one row per key without an owner.
- `onConflictDoUpdate({ target: settings.key })` in `web/src/mastra/api-keys.ts` and in
  nine test files, retargeted to `[settings.key, settings.userId]`. Postgres infers the
  arbiter from the column list and the constraint is NULLS NOT DISTINCT, so the upsert
  still matches the null-`user_id` row.
- `getApiKeys()` and `getValidationResults()` gained an explicit `user_id IS NULL`
  predicate. Before this revision a bare `key` predicate could only match the global row;
  now `PATCH /api/settings` can write a same-key row for a user, so without it the reader
  would pick an arbitrary one.

### pytest, unchanged against its own before-and-after

The gate is that this item adds no failure, so the comparison is against the same tree
with only `src/models/setting.py` and `tests/phase1/test_models.py` reverted:

```
$ cd api && uv run pytest -q          # with the item's changes
120 failed, 241 passed, 25 errors in 13.29s
$ diff <(before) <(after)             # FAILED/ERROR lines, sorted
$ echo $?
0
```

An identical failure set, line for line. Note this tree reports 120 failed / 241 passed
where `evidence/phase-0.md` recorded 125 / 236; that 5-test difference is present in the
*reverted* run too, so it predates this item and is not something it introduced.

```
$ cd api && uv run ruff check .
Found 32 errors.
$ cd api && uv run ruff format --check .
9 files would be reformatted, 153 files already formatted
```

Both at the Phase 0 baseline (32 errors, 9 files). Revision `012` needed its imports
ordered to hold the 32; none of the files this item touched are among the 9.

### Frontend gates

```
$ pnpm -C web tsc --noEmit ; echo EXIT=$?
EXIT=0
$ pnpm -C web lint ; echo EXIT=$?
EXIT=0
$ pnpm -C web test
 Test Files  2 failed | 124 passed (126)
      Tests  9 failed | 4391 passed | 7 skipped (4407)
$ pnpm -C web build ; echo EXIT=$?
EXIT=0
```

The 9 are the recorded baseline: 6 in `image-preview.test.tsx` and 3 in
`PostDetail.test.tsx`.

The four suites this item touched:

```
$ cd web && pnpm vitest run src/db/schema-parity.test.ts src/app/api/settings src/mastra/api-keys.test.ts
 ✓ src/db/schema-parity.test.ts (11 tests) 31ms
 ✓ src/mastra/api-keys.test.ts (26 tests) 78ms
 ✓ src/app/api/settings/route.test.ts (13 tests) 68ms
 ✓ src/app/api/settings/api-keys/route.test.ts (18 tests) 90ms

 Test Files  4 passed (4)
      Tests  68 passed (68)
```

### The `api_keys` row was destroyed mid-item and recovered

Worth recording in full, because it nearly cost the run its live provider credentials and
because the hazard is still there.

`web/src/mastra/api-keys.test.ts` deletes the global `api_keys` row in `afterEach` and
writes the developer's saved value back only in `afterAll`, against the **dev** database.
Its restore is an upsert that still targeted `settings.key`, so the first run after the
migration deleted the row and then threw `42P10: there is no unique or exclusion
constraint matching the ON CONFLICT specification` on the way out. The row was gone.

Recovery, verified rather than assumed:

- The heap held nothing: the table is one page and no dead tuple was near the row's size.
- The Docker volume's WAL still covered the window. Scanning it needs two things that are
  easy to get wrong: WAL data is interrupted by an 8192-byte page header every page (24
  bytes, 40 on a segment's first page), so tokens split across a boundary are invisible
  unless the headers are stripped first; and a greedy base64 match runs past the end of a
  Fernet token, so decryption has to be attempted at each *valid* token length
  (`4 * ceil((57 + 16n) / 3)`) rather than on the whole match.
- With both handled, exactly one candidate token decrypted to each provider's key under
  the real `WP_ENCRYPTION_KEY`. Reassembled in jsonb's key order (by length, then bytes:
  `gemini`, `anthropic`, `perplexity`) the text was 605 characters with md5
  `0ebf110838ac6928df37c170e8ad8d2f`, matching the fingerprint taken before the migration
  exactly, so the restored row is the original and not a re-encryption.

```
$ psql "$DATABASE_URL_SYNC" -c "select key, user_id, md5(value::text), length(value::text), updated_at from settings;"
   key    | user_id |               md5                | length |          updated_at
----------+---------+----------------------------------+--------+-------------------------------
 api_keys |         | 0ebf110838ac6928df37c170e8ad8d2f |    605 | 2026-08-23 16:08:07.661389+00
```

No key material was written to the repo, to this file or to any log: the reconstruction
ran in a temporary script, the row went back through a generated SQL file, and both were
deleted. The `pageinspect` extension installed to inspect the heap was dropped again.

The underlying hazard, that these suites borrow a live credentials row from the dev
database and can lose it if their restore throws, is now in `todo.md` tagged
`[confirmed]`. It is a test-harness redesign, not part of this item.
