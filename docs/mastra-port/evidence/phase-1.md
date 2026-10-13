# Phase 1 evidence

Moved out of `LEDGER.md` on 2026-08-23 to cut the context
re-read every iteration. Verbatim, nothing edited.


## 1.1


  Drizzle was used as recommended. Installed into `web/`:

  ```
  $ cd web && pnpm add drizzle-orm && pnpm add -D drizzle-kit
  dependencies:
  + drizzle-orm 0.45.2
  devDependencies:
  + drizzle-kit 0.31.10
  ```

  The dev database from item 0.3 was restarted and confirmed at Alembic head:

  ```
  $ POSTGRES_HOST_PORT=5435 docker compose up -d db redis
  $ PGPASSWORD=pipeline psql -h localhost -p 5435 -U pipeline -d content_pipeline -At \
      -c "select version_num from alembic_version;"
  011

  $ PGPASSWORD=pipeline psql -h localhost -p 5435 -U pipeline -d content_pipeline -c '\dt'
   Schema |       Name       | Type  |  Owner
  --------+------------------+-------+----------
   public | alembic_version  | table | pipeline
   public | internal_links   | table | pipeline
   public | posts            | table | pipeline
   public | settings         | table | pipeline
   public | website_profiles | table | pipeline
  (5 rows)
  ```

  The schema was not written by hand. `drizzle-kit pull` introspected the live database, and
  its output was adopted as `web/src/db/schema.ts` with JSONB element types (`$type<>()`),
  doc comments, and `mode: "date"` timestamps added:

  ```
  $ pnpm exec drizzle-kit pull --config=/tmp/drizzle.pull.config.ts
  [✓] 5  tables fetched
  [✓] 90 columns fetched
  [✓] 0  enums fetched
  [✓] 3  indexes fetched
  [✓] 3  foreign keys fetched
  [✓] 0  policies fetched
  [✓] 0  check constraints fetched
  [✓] 0  views fetched
  ```

  **Fidelity proof.** DDL was generated from `web/src/db/schema.ts` and compared, statement
  for statement, against the DDL `drizzle-kit pull` produced from the live database. After
  stripping the introspection comment wrapper and normalising statement order, the two are
  identical:

  ```
  $ pnpm exec drizzle-kit generate --config=/tmp/drizzle.gen.config.ts
  posts 44 columns 0 indexes 1 fks
  settings 4 columns 1 indexes 0 fks
  website_profiles 32 columns 1 indexes 0 fks
  [✓] Your SQL migration file ➜ /tmp/drizzle-gen/0000_overconfident_pestilence.sql

  $ norm() { grep -v -e '^--> statement-breakpoint' -e '^-- Current sql file' \
      -e '^-- If you want to run' -e '^/\*$' -e '^\*/$' "$1" | sed '/^$/d' | sort; }
  $ diff <(norm /tmp/drizzle-pull/0000_*.sql) <(norm /tmp/drizzle-gen/0000_*.sql)
  $ echo "normalized diff exit=$?"
  normalized diff exit=0
  ```

  No migration was created against the real database and no second database exists.
  `web/drizzle.config.ts` deliberately has no migrate workflow: `out: "./drizzle"` is only a
  scratch target for drift detection, and the config comment states that `src/db/schema.ts`
  mirrors the Alembic-owned schema rather than generating it.

  All the columns the item calls out are present in `web/src/db/schema.ts`:
  `posts.stageLogs`, `posts.executionLogs`, `posts.stageStatus`, `posts.stageSettings`,
  `posts.imageManifest`, the five `wp*` post columns plus the eight profile-side WordPress
  columns, the Next.js publishing fields (`posts.nextjsPublishStatus`,
  `posts.nextjsPublishedAt`, `websiteProfiles.nextjsWebhookUrl`,
  `websiteProfiles.nextjsWebhookSecret`, `websiteProfiles.nextjsFrontmatterMap`), and the
  `user_id` column on both `settings` and `website_profiles`.

  Findings recorded while introspecting:

  1. **`posts` has no `user_id` column.** Multi-tenancy from Alembic 010 lands on
     `settings.user_id` and `website_profiles.user_id` only; posts are scoped transitively
     through `profile_id`. Phase 5's per-handler tenancy scoping must join through
     `website_profiles`, not filter `posts.user_id`.
  2. **`settings`' primary key is `key` alone**, with `user_id` only indexed. Per-user
     settings rows therefore collide on key today. Phase 6 (per-stage model settings,
     "persist per user") runs into this and cannot be solved by a schema change, since the
     port forbids one. Logged in `todo.md`.
  3. **`website_profiles.user_id` is nullable in the database** (`is_nullable = YES`), which
     contradicts iteration 1's reading that Alembic 010 made it NOT NULL. The pytest
     `NotNullViolationError` cluster therefore comes from the SQLAlchemy model, not the
     database constraint.
  4. **The SQLAlchemy model and the migrations disagree on two defaults.**
     `api/src/models/post.py` declares `output_format` server default `"markdown"` and
     `stage_settings` defaulting to all six stages at `"auto"`; the database Alembic actually
     produced has `'both'` and a five-stage `"review"` map. The TS schema follows the
     database, which is the stated ground truth. Logged in `todo.md`.
  5. **`nextjs_frontmatter_map` is `json`, not `jsonb`**, unlike every other JSON column.
     Preserved as `json()` in the TS schema.
  6. **`posts` has a hole at `ordinal_position` 30**, the `thread_id` column dropped by
     Alembic 005. Nothing to port; noted so a future column count of 44 (not 45) is not read
     as a missing column.

  Timestamps use `mode: "date"` rather than `drizzle-kit pull`'s default `mode: "string"`.
  `mode: "string"` returns Postgres' native `2026-08-21 12:00:00+00` form, which is not the
  ISO-8601 shape FastAPI emits today and would silently change every API response; `Date`
  objects serialise to ISO-8601 via `JSON.stringify`. Phase 5 must still confirm the exact
  string each handler emits against `web/src/lib/api.ts`.

  Gates after the change, all at the item 0.2 baseline:

  ```
  $ cd web && pnpm exec tsc --noEmit ; echo "tsc exit=$?"
  tsc exit=0

  $ pnpm lint ; echo "lint exit=$?"
  lint exit=0

  $ pnpm test ; echo "test exit=$?"
   Test Files  2 failed | 14 passed (16)
        Tests  9 failed | 191 passed (200)
  test exit=1

  $ pnpm build ; echo "build exit=$?"
  build exit=0
  ```

  No Python file was touched, so the backend gates are unchanged from item 0.4.

## 1.2


  The check lives in `web/src/db/schema-parity.ts` (pure comparison helpers) and
  `web/src/db/schema-parity.test.ts` (vitest, real database). It describes both sides in
  the same shape and diffs them in both directions:

  - Alembic side: read from the live `content_pipeline` catalog via `pg_attribute` /
    `format_type`, so the type spelling is Postgres' own, not `information_schema`'s
    split `data_type` + `character_maximum_length`.
  - TypeScript side: every `pgTable` exported from `schema.ts`, read with
    `getTableConfig` and `column.getSQLType()`.
  - Compared per column: type, `NOT NULL`, and whether a default exists.
  - `isAlembicOwned()` excludes the `public` tables Alembic does not own, so the "vice
    versa" direction still reports genuinely unexpected tables: `auth_*` and
    `subscription` (BetterAuth and its Stripe plugin, `web/src/lib/auth.ts`) and
    `mastra_*` (the Phase 2 Postgres storage adapter).
  - A separate assertion pins `alembic_version` to `011`, so the comparison can never
    silently run against a database behind head.

  ```
  $ docker compose up -d db redis
  $ cd web && NO_COLOR=1 pnpm exec vitest run src/db/schema-parity.test.ts ; echo "exit=$?"

   RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web

   ✓ src/db/schema-parity.test.ts (9 tests) 21ms

   Test Files  1 passed (1)
        Tests  9 passed (9)
     Start at  20:24:57
     Duration  406ms (transform 32ms, setup 126ms, import 182ms, tests 21ms, environment 0ms)
  exit=0
  ```

  **Negative control.** A green parity check proves nothing unless it can go red, so the
  live-database test was re-run with one invented column added to `posts` in `schema.ts`
  (`invented: text("invented_column")`) and reverted immediately afterwards:

  ```
  $ pnpm exec vitest run src/db/schema-parity.test.ts   # with the invented column present
   FAIL  src/db/schema-parity.test.ts > schema.ts against the live Alembic database > describes every Alembic table and column, and no others
  AssertionError: expected [ Array(1) ] to deeply equal []
  +   "posts.invented_column: in schema.ts, missing from database",
        Tests  1 failed | 8 passed (9)

  $ git diff --stat web/src/db/schema.ts   # after reverting
  (no output: schema.ts unchanged)
  ```

  The five non-database tests in the file cover the other diff directions with synthetic
  input (column missing from `schema.ts`, column missing from the database, a table
  missing from each side, and type / nullability / default drift), so each branch of
  `diffSchemas` is exercised rather than only the happy path.

  `web/vitest.config.ts` now loads the repo-root `.env` into `test.env`, because vitest
  runs from `web/` and the only copy of `DATABASE_URL_SYNC` lives at the repo root. This
  makes `docker compose up -d db redis` a prerequisite for `pnpm test`; the objective
  already requires database tests to hit a real database, and every later phase needs it.

  Gates after the change (frontend only; no Python file was touched, so the item 0.4
  backend gates are unchanged):

  ```
  $ cd web && pnpm exec tsc --noEmit ; echo "tsc exit=$?"
  tsc exit=0

  $ pnpm lint ; echo "lint exit=$?"
  lint exit=0

  $ pnpm test ; echo "test exit=$?"
   Test Files  2 failed | 15 passed (17)
        Tests  9 failed | 200 passed (209)
  test exit=1

  $ pnpm build ; echo "build exit=$?"
  build exit=0
  ```

  Pass count rises 191 -> 200 with the pre-existing failure count held at exactly 9
  (`image-preview.test.tsx` and `PostDetail.test.tsx`), so the item 0.1 baseline holds.
  `pnpm build` prints two pre-existing BetterAuth warnings (base URL undeterminable,
  default secret) from `src/lib/auth.ts`; they are not new here, since the only files this
  item added live under `src/db/` and nothing in the app imports them.

## 1.3


  `web/src/lib/crypto.ts` implements the Fernet spec directly on `node:crypto`
  (AES-128-CBC + HMAC-SHA256, key split 16/16), matching what
  `cryptography.fernet.Fernet` produces on the Python side. Same public surface:
  `encrypt()` / `decrypt()` read `WP_ENCRYPTION_KEY`, which is the env var behind
  `settings.wp_encryption_key`.

  The interop oracle is `web/src/lib/__fixtures__/python-fernet.json`: six tokens
  generated by `cryptography` 46.0.5, committed so the proof does not depend on Python
  being installed at test time. The key in that fixture is a throwaway generated only for
  this test and is not used by any environment.

  Fixture generation command:

  ```
  api/.venv/bin/python - <<'PY'
  ... Fernet.generate_key() + f.encrypt(pt) for six plaintexts ...
  PY
  wrote 6 cases
  ```

  Test run:

  ```
  $ cd web && NO_COLOR=1 pnpm exec vitest run src/lib/crypto.test.ts

   RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web

   ✓ src/lib/crypto.test.ts (16 tests) 3ms

   Test Files  1 passed (1)
        Tests  16 passed (16)
     Start at  20:28:05
     Duration  450ms (transform 27ms, setup 126ms, import 13ms, tests 3ms, environment 232ms)
  ```

  The six `decrypts a Python token: <case>` tests are the item's required proof; they cover
  an ASCII password, a symbol-heavy webhook secret, a multibyte-unicode value, the empty
  string, a block-aligned 16-byte value, and a 500-byte value.

  **Bug the byte-for-byte test caught.** The first implementation encoded tokens with Node's
  `'base64url'`, which strips `=` padding. That decrypted fine in TypeScript but Python's
  `Fernet.decrypt` uses `base64.urlsafe_b64decode`, which rejects unpadded input, so every
  TS-written secret would have been undecryptable by the still-running Python stack during
  the Phase 5 transition. Confirmed on the real token:

  ```
  $ api/.venv/bin/python -c "... Fernet(KEY).decrypt(token.rstrip('=')) ..."
  UNPADDED REJECTED: InvalidToken
  ```

  Failing assertion before the fix (expected padded, received unpadded):

  ```
   FAIL  src/lib/crypto.test.ts > encryptWithKey > reproduces a Python token byte for byte given that token timestamp and IV
  AssertionError: expected 'gAAAAABqiPr4w5ewgsX9V3VwZ0w-FN7OsR6iR…' to be 'gAAAAABqiPr4w5ewgsX9V3VwZ0w-FN7OsR6iR…' // Object.is equality
   Test Files  1 failed (1)
        Tests  1 failed | 15 passed (16)
  ```

  After padding the encoder, that test pins the whole token framing: given the timestamp and
  IV read back out of a Python token, `encryptWithKey` reproduces that token exactly.

  **Reverse direction** (TypeScript writes, Python reads), not expressible in vitest so run
  as a scripted check:

  ```
  $ node --experimental-strip-types -e "import('./src/lib/crypto.ts').then(m => console.log(m.encryptWithKey('ts-produced-value-é日', KEY)))"
  TS token: gAAAAABqiPsr5ZvQcxyCmJPsfSmcyiBgqoVQtc_WBG3lrb3l-YIVttsScnPktPQoulAsmr3ZcuAsTdUdhCL0VrVTITIiFkyENRR6uSwI1G92lTybdH7200s=

  $ api/.venv/bin/python -c "from cryptography.fernet import Fernet; print('Python decrypted:', Fernet(KEY).decrypt(TOKEN).decode())"
  Python decrypted: ts-produced-value-é日
  ```

  Frontend gates:

  ```
  $ cd web && pnpm exec tsc --noEmit ; echo EXIT=$?
  tsc EXIT=0

  $ cd web && pnpm lint ; echo EXIT=$?
  lint EXIT=0

  $ cd web && NO_COLOR=1 pnpm test ; echo EXIT=$?
  test EXIT=1
   Test Files  2 failed | 16 passed (18)
        Tests  9 failed | 216 passed (225)

  $ cd web && pnpm build ; echo EXIT=$?
  build EXIT=0
  ```

  Pass count rises 200 -> 216 with the pre-existing failure count held at exactly 9, so the
  item 0.1 baseline holds. No `api/` source file was touched, so the pytest and ruff
  baselines are unchanged by construction.

## 1.4


  `web/src/db/index.ts` is the database client the rest of the port builds on: a lazily
  created `pg` Pool wrapped in drizzle, cached on `globalThis` so Next.js dev reloads do not
  leak pools, with no `next/*` import so the Phase 2 worker can import it. It normalises the
  `postgresql+asyncpg://` prefix the repo-root `.env` uses, which `pg` does not understand.

  `web/src/db/post-roundtrip.test.ts` is the round-trip: it inserts a profile and a post,
  reads them back through drizzle, checks the defaults the database applies, updates a stage
  content column plus `stage_status` and `image_manifest` (the Phase 3 persistence contract),
  re-reads through a second independent connection to prove the write committed, then deletes.

  ```
  $ cd web && NO_COLOR=1 pnpm vitest run src/db/post-roundtrip.test.ts

   RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web

   ✓ src/db/post-roundtrip.test.ts (5 tests) 45ms

   Test Files  1 passed (1)
        Tests  5 passed (5)
  ```

  **Negative control.** The test really reaches Postgres rather than drizzle's own type
  layer: renaming one column in `schema.ts` (`research_content` -> `research_contents`) turns
  all five tests red with a server-side error, and the rename was reverted afterwards
  (`git diff --stat src/db/schema.ts` is empty).

  ```
  $ sed -i '' 's|text("research_content")|text("research_contents")|' src/db/schema.ts
  $ NO_COLOR=1 pnpm vitest run src/db/post-roundtrip.test.ts
  ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯⎯⎯
  Error: Failed query: insert into "posts" (... "research_contents" ...)
  Caused by: error: column "research_contents" of relation "posts" does not exist
  Caused by: error: column "research_contents" does not exist
    hint: 'Perhaps you meant to reference the column "posts.research_content".'
  $ sed -i '' 's|text("research_contents")|text("research_content")|' src/db/schema.ts   # reverted
  ```

  **Cross-language proof (not committed, reproduced ad hoc).** The Python stack is still
  running, so the round-trip also has to hold across languages. TypeScript wrote a post with
  drizzle and SQLAlchemy read it back:

  ```
  TS inserted post: fe09fec1-50d5-4226-8cf8-3d6f3da40cdb ts-crosslang-post [ 'alpha', 'beta' ] 2026-08-22T01:32:40.206Z

  SQLAlchemy read: fe09fec1-50d5-4226-8cf8-3d6f3da40cdb ts-crosslang-post
    topic           : Written by TypeScript, read by SQLAlchemy
    related_keywords: ['alpha', 'beta'] list
    stage_status    : {'research': 'complete'} dict
    word_count      : 1234 int
    research_content: '## Research\n\nWritten from drizzle.'
    created_at      : 2026-08-22T01:32:40.206995+00:00 datetime
    current_stage   : pending
    stage_settings  : {'edit': 'review', 'write': 'review', 'images': 'review', 'outline': 'review', 'research': 'review'}
    execution_logs  : []
  ```

  And the reverse: SQLAlchemy wrote a post, drizzle read it back.

  ```
  SQLAlchemy inserted post: 22da4bf3-c3c2-4e1b-8fe3-fd514e854c32 py-crosslang-post

  drizzle read: 22da4bf3-c3c2-4e1b-8fe3-fd514e854c32 py-crosslang-post
    topic           : Written by SQLAlchemy, read by drizzle
    relatedKeywords : [ 'gamma', 'delta' ]
    imageManifest   : {"images":[{"filename":"hero.webp"}]}
    wordCount       : 4321 number
    createdAt       : 2026-08-22T01:33:01.977Z Date
    currentStage    : pending
    stageSettings   : {"edit":"auto","ready":"auto","write":"auto","images":"auto","outline":"auto","research":"auto"}
    outputFormat    : markdown
  ```

  Note the divergence in the last two lines, which confirms the defect logged in `todo.md`
  under 1.1 from the other direction: the row TypeScript inserted took the database defaults
  (`output_format` `both`, five-stage all-`review` `stage_settings`) while the row SQLAlchemy
  inserted took the model defaults (`markdown`, six-stage all-`auto`). The two stacks are
  writing different defaults for the same table today. This is pre-existing and out of scope
  for the port, which must not change schema shape; the TypeScript side deliberately matches
  the database, so a Phase 5 handler will produce `both`/`review` where FastAPI produced
  `markdown`/`auto` unless the handler sets them explicitly. Recorded so Phase 5 sets them.

  All four frontend gates after the change:

  ```
  $ cd web && pnpm tsc --noEmit ; echo EXIT=$?
  EXIT=0

  $ cd web && pnpm lint ; echo EXIT=$?
  EXIT=0

  $ cd web && NO_COLOR=1 pnpm test
   Test Files  2 failed | 17 passed (19)
        Tests  9 failed | 221 passed (230)

  $ cd web && pnpm build ; echo EXIT=$?
  EXIT=0
  ```

  Pass count rises 216 -> 221 with the pre-existing failure count held at exactly 9, so the
  item 0.1 baseline holds. No `api/` source file was touched, so the pytest and ruff
  baselines are unchanged by construction. Both cross-language rows and their profile were
  deleted afterwards (`select count(*) from posts` and `from website_profiles` both return 0).

  **Phase 1 exit reached:** the parity check passes (1.2), the crypto interop test passes
  (1.3), and TypeScript now reads and writes a Post against the real dev database (1.4).
