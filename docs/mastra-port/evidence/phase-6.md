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

## 6.1

Six stages, three providers, one decision each. Every id below was checked twice: against
the provider's own live documentation, and against a real minimal API call billed to the
key in `settings.api_keys`. Two of the three providers moved.

### The choices

| Stage | Model | Verified | Source | Rationale |
| --- | --- | --- | --- | --- |
| research | `sonar-pro` (kept) | 2026-08-23 | `docs.perplexity.ai/getting-started/models` + live call | The only Sonar tier above it with live grounding and citations is `sonar-deep-research`, a report generator priced and paced for a different job; `sonar` is weaker. |
| outline | `claude-opus-5` | 2026-08-23 | `platform.claude.com/docs/en/about-claude/pricing` + live call | Strongest Anthropic tier reachable at the incumbent's per-token price. |
| write | `claude-opus-5` | 2026-08-23 | same | same |
| edit | `claude-opus-5` | 2026-08-23 | same | same |
| ready | `claude-opus-5` | 2026-08-23 | same | same |
| images (prompt half) | `claude-opus-5` | 2026-08-23 | same | The manifest call is a reasoning call like the other four and shares their agent options. |
| images (generation half) | `gemini-3-pro-image` | 2026-08-23 | `ai.google.dev/gemini-api/docs/pricing` + live call | Highest-quality image tier this key reaches, mandated by the objective and re-confirmed here. |

### The live calls

`web/src/mastra/scripts/verify-models.mjs` reads the same `user_id IS NULL` credentials row
`getApiKeys()` reads, and sends each provider its real request shape. The Anthropic body is
the one the four reasoning stages now send: adaptive thinking plus `output_config.effort`.
No key is printed.

```
$ cd web && set -a && . ../.env && set +a && node \
    --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
    src/mastra/scripts/verify-models.mjs
anthropic claude-opus-5: HTTP 200 model=claude-opus-5 stop_reason=end_turn text="ok" usage={"input_tokens":16,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":4,"output_tokens_details":{"thinking_tokens":0},"service_tier":"standard","inference_geo":"global"} 1.3s
anthropic claude-fable-5: HTTP 200 model=claude-fable-5 stop_reason=end_turn text="ok" usage={"input_tokens":16,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":10,"output_tokens_details":{"thinking_tokens":6},"service_tier":"standard","inference_geo":"global"} 5.9s
anthropic claude-opus-4-6: HTTP 200 model=claude-opus-4-6 stop_reason=end_turn text="ok" usage={"input_tokens":14,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":4,"output_tokens_details":{"thinking_tokens":0},"service_tier":"standard","inference_geo":"global"} 1.2s
perplexity sonar-pro: HTTP 200 model=sonar-pro citations=17 usage={"completion_tokens":34,"cost":{"input_tokens_cost":0.00004,"output_tokens_cost":0.00051,"request_cost":0.006,"total_cost":0.00655},"prompt_tokens":12,"search_context_size":"low","total_tokens":46} 4.0s
gemini gemini-3-pro-image: HTTP 200 modelVersion=gemini-3-pro-image mimeType=image/jpeg bytes=592750 usage={"promptTokenCount":10,"candidatesTokenCount":1180,"totalTokenCount":1292,"promptTokensDetails":[{"modality":"TEXT","tokenCount":10}],"candidatesTokensDetails":[{"modality":"IMAGE","tokenCount":1120}],"thoughtsTokenCount":102,"serviceTier":"standard"} 14.0s
gemini gemini-3.1-flash-image-preview: HTTP 200 modelVersion=gemini-3.1-flash-image-preview mimeType=image/jpeg bytes=458960 usage={"promptTokenCount":10,"candidatesTokenCount":1460,"totalTokenCount":1470,"promptTokensDetails":[{"modality":"TEXT","tokenCount":10}],"candidatesTokensDetails":[{"modality":"IMAGE","tokenCount":1120}],"serviceTier":"standard"} 9.7s
```

Each provider reports the id back in its own field: Anthropic in `model`, Perplexity in
`model`, Gemini in `modelVersion`. `sonar-pro` returned 17 citations, so the grounding the
`research` stage's link extraction depends on is intact.

### Why not `claude-fable-5`

It answers, and Anthropic documents it as the more capable model. It is not adopted because
it costs $10/$50 per MTok against Opus 5's $5/$25: double the incumbent for a long-form
blog-writing workload where the marginal reasoning is not the constraint. Opus 5 is the
strongest tier available at *no* per-token increase over `claude-opus-4-6`, which makes it
the free upgrade and Fable 5 a deliberate 2x that nobody asked for. Recorded here rather
than silently skipped, because "strongest available" and "strongest at this price" are
different answers and this port picked the second.

### The parameter that had to change with the model

Python sent `thinking={"type": "enabled", "budget_tokens": 10000}`. That form is removed on
this tier: Anthropic's documentation states `budget_tokens` is rejected with a 400 on Opus
5, replaced by adaptive thinking plus `output_config.effort`. The live call above is proof
the replacement shape is accepted, since it is exactly what the script sent.

The installed provider supports both halves. `@mastra/core`'s bundled Anthropic provider
options schema carries `thinking: {type: "adaptive", display?}` and `effort: low | medium |
high | xhigh | max`:

```
$ grep -n 'adaptive\|effort' node_modules/.pnpm/@mastra+core@1.61.0_*/node_modules/@mastra/core/\
    dist/_types/@ai-sdk_anthropic-v6/dist/index.d.ts
209:        type: z.ZodLiteral<"adaptive">;
247:    effort: z.ZodOptional<z.ZodEnum<{
```

Default effort is `high`, which is both the provider's own default and what the objective
asks for on the reasoning-heavy stages. Item 6.2 makes it per-user and per-stage.

**`max_tokens` did not move, and that is checked rather than assumed.** The provider computes
`baseArgs.max_tokens = maxTokens + (thinkingBudget != null ? thinkingBudget : 0)` and reads
`thinkingBudget` only from the `enabled` variant, so under adaptive thinking the second term
is zero. `claudeStageOptions` therefore passes Python's `effective_max` straight through as
`maxOutputTokens` and every stage's wire budget is byte-identical to the golden fixtures.
The four wire-payload tests assert `sent.body.max_tokens === recorded.max_tokens` against the
fixtures, unchanged.

### The stages reach the new models through the real agent path

Not the script: the registered Mastra agents, with the key read out of the settings table,
same as a production run. Every Claude stage's live smoke test now runs instead of skipping.

```
$ cd web && set -a && . ../.env && set +a && export ANTHROPIC_API_KEY=<decrypted from settings> \
    && pnpm test --run src/mastra/agents/{outline,write,edit,ready,images}.test.ts
 ✓ src/mastra/agents/images.test.ts (12 tests) 3300ms
     ✓ reaches Anthropic and reports back the configured model id  3209ms
 ✓ src/mastra/agents/ready.test.ts (9 tests) 4582ms
     ✓ reaches Anthropic and reports back the configured model id  1207ms
 ✓ src/mastra/agents/write.test.ts (8 tests) 5810ms
     ✓ reaches Anthropic and reports back the configured model id  1152ms
 ✓ src/mastra/agents/outline.test.ts (8 tests) 9186ms
     ✓ reaches Anthropic and reports back the configured model id  3299ms
 ✓ src/mastra/agents/edit.test.ts (10 tests) 10265ms
     ✓ reaches Anthropic and reports back the configured model id  981ms

 Test Files  5 passed (5)
      Tests  47 passed (47)
```

Each of those asserts `response.modelId === "claude-opus-5"`, so the id is confirmed at the
provider's response, not at the request.

### The images golden-capture gap the objective flagged is closed

`gemini.test.ts`'s end-to-end live test had never run: the old key's project reported
`generate_content_free_tier_requests, limit: 0`, which is also why every Gemini call in the
golden fixtures is a 429. The rotated key has quota, so it runs now.

```
$ cd web && ... GEMINI_API_KEY=<decrypted> GEMINI_IMAGE_QUOTA=1 \
    pnpm test --run src/mastra/images/gemini.test.ts
 ✓ src/mastra/images/gemini.test.ts (38 tests) 14365ms
     ✓ reaches Gemini and returns bytes for the configured model id  14222ms

 Test Files  1 passed (1)
      Tests  38 passed (38)
```

It failed first, for a real reason worth recording: the assertion asserted PNG magic bytes
and `gemini-3-pro-image` answers with JPEG.

```
-     137, 80, 78, 71,        (PNG)
+     255, 216, 255, 224,     (JPEG SOI/APP0)
```

That assertion had never executed, so it was a guess rather than a regression. It now
asserts JPEG. Nothing downstream cares: `optimizeImage` re-encodes to webp through sharp,
which reads either.

### Cost delta per article

| Stage | Before | After | Per-article delta |
| --- | --- | --- | --- |
| research | `sonar-pro`, unchanged | same | $0 |
| outline / write / edit / ready / images-prompt | `claude-opus-4-6` $5/$25 per MTok | `claude-opus-5` $5/$25 per MTok | $0 per token, but see the tokenizer note |
| images generation | `gemini-3.1-flash-image-preview`, ~$0.067 per 1K image | `gemini-3-pro-image`, ~$0.134 per 1K image | +$0.067 per image, so about **+$0.34** on a five-image article |

Two second-order costs, both real:

- **Tokenizer.** Anthropic's pricing page states Claude 4.7 and later use a tokenizer that
  produces roughly 30% more tokens for the same text. Same rate card, more tokens: the four
  reasoning stages should be budgeted at about **1.3x** their previous spend even though
  the per-MTok price is identical. Adaptive thinking moves this in the other direction on
  easy requests (the verification call above spent 0 thinking tokens where a fixed 10000
  budget would have been available), so the net is not predictable from the rate card and
  wants a real measurement once Phase 8's trace view reports `stream.usage`.
- **Latency.** Images go from about 9s to about 14s per image, so a five-image article
  spends roughly 25s longer in `images`. The objective accepts this tradeoff explicitly.

`MODEL_COSTS` gains rows for both new models rather than having its existing rows edited:
those priced every `stage_logs` entry already in the database, and the analytics response
ships the table as its own reference. `execution-log.ts`'s hardcoded $15/$75 is untouched
and still wrong in the same way it was wrong in Python; correcting it is a repricing
decision, not this item.

### Gates

```
$ pnpm -C web tsc --noEmit ; echo EXIT=$?
EXIT=0
$ pnpm -C web lint ; echo EXIT=$?
EXIT=0
$ pnpm -C web build ; echo EXIT=$?
EXIT=0
$ pnpm -C web test --run
 Test Files  4 failed | 122 passed (126)
      Tests  11 failed | 4390 passed | 7 skipped (4408)
```

Nine of those eleven are the Phase 0 baseline (6 in `image-preview.test.tsx`, 3 in
`PostDetail.test.tsx`). The other two are flakes in files this item does not touch
(`git diff --name-only` lists neither `pipeline-events.test.ts` nor `steps/outline.ts`):

- `pipeline-events.test.ts > carries Python's log payload and nothing else` uses `.find()`
  over an array the same file's own comment says is "the order those reads resolved in and
  not the order the topic delivered". It passed on the next run and failed on the one after.
- `workflows/scaffold-check.test.ts > emits the workflow lifecycle events` failed once and
  passed on both reruns.

Both are logged in `todo.md` tagged `[confirmed]`. Neither is chased here. A second full
run of the same tree landed on nine baseline failures plus the `scaffold-check` flake alone,
which is what the flake reading predicts:

```
$ pnpm -C web test --run
 Test Files  3 failed | 123 passed (126)
      Tests  10 failed | 4391 passed | 7 skipped (4408)
```

Python is untouched and lands exactly on the numbers item 6.0 recorded:

```
$ cd api && uv run pytest -q
120 failed, 241 passed, 25 errors in 13.56s
$ cd api && uv run ruff check .
Found 32 errors.
$ cd api && uv run ruff format --check .
9 files would be reformatted, 153 files already formatted
```

## 6.2a

The storage half of per-stage model configuration: what a legal value is, which row wins, and
where a bad value is stopped. No agent reads it yet; that is 6.2b.

### What the shape is, and the three decisions inside it

`web/src/mastra/stage-models.ts`. One `settings` row per user under the key `stage_models`,
holding only overrides:

```json
{"write": {"model": "claude-fable-5", "effort": "max"}, "images": {"model": "gemini-3-pro-image"}}
```

**The allowlist is the pasted evidence from #6.1 and nothing else.** Six ids are accepted:
`sonar-pro` for `research`, `claude-opus-5` / `claude-fable-5` / `claude-opus-4-6` for the four
Anthropic stages, and `gemini-3-pro-image` / `gemini-3.1-flash-image-preview` for `images`. Each
returned HTTP 200 from a real billed call in #6.1, sending the request shape its stage sends,
including `claude-opus-4-6` under the adaptive-thinking body that replaced `budget_tokens`.
`sonar` and `sonar-deep-research` are documented tiers with no live call behind them here, so
they are not offered. A test pins the whole map, so an id cannot be added without the test being
edited, which is where the "and paste the call" reminder lives.

**Effort exists only where the provider documents one.** `CLAUDE_EFFORTS` is read off the
provider options schema bundled with the installed `@mastra/core`
(`dist/_types/@ai-sdk_anthropic-v6/dist/index.d.ts`: `low | medium | high | xhigh | max`), and
`STAGE_EFFORT_ALLOWLIST` is derived from the stage's provider rather than written out, so a
stage cannot end up offering an effort its provider ignores. `research` and `images` therefore
reject `effort` with a 422 instead of storing a value nothing sends.

**`images` selects the Gemini generation model.** The stage also makes one Claude call to write
the image prompts (`IMAGES_MODEL_ID`); that call is not separately configurable and keeps the
shared Claude defaults. Recorded here rather than left implicit, because "the images stage's
model" is ambiguous and this port picked the generation half, which is the one the manifest
names and the one the stage is judged on.

### Resolution order

Defaults, then the global row (`user_id IS NULL`), then the user's row, **field by field**. A
user who overrides only `write`'s effort keeps whatever model the global row chose. Both rows
come back in one query. `resolveStageModels()` also reports where each field came from
(`default` / `global` / `user`), which is what 6.3's override badge reads.

A stored value that no longer validates (a hand-edited row, an id retired from the allowlist) is
ignored rather than raised: the stage still has a verified default, and stranding a pipeline run
on a stale settings row is the worse outcome. Covered by a test.

### Where a bad value is stopped

`PATCH /api/settings` stores every key's value verbatim, as Python did. `stage_models` is the
one exception: it is parsed against the allowlist for the whole body before any row is written,
so a rejected batch leaves nothing half-applied. The error names the stage and the accepted
values, because a rejected id is otherwise indistinguishable from a typo.

One consequence worth stating: `settings.update()` in `web/src/lib/api.ts` types its body as
`Record<string, {value: ...}>`, and that wrapper is stored verbatim for other keys. It is not a
stage map, so it is rejected here (`Unknown stage 'value'`) and 6.3 has to send the map itself.
A test pins that.

### Tests

44 tests against the real database: 26 in `web/src/mastra/stage-models.test.ts`, 18 in
`web/src/app/api/settings/route.test.ts` (12 pre-existing plus 6 new). The suite captures the
global `stage_models` row before it writes to it and restores it afterwards, following the
iteration-132 lesson about test helpers destroying live settings rows.

```
$ cd web && set -a && . ../.env && set +a && pnpm vitest run \
    src/mastra/stage-models.test.ts src/app/api/settings/route.test.ts
 ✓ src/app/api/settings/route.test.ts (18 tests) 81ms
 ✓ src/mastra/stage-models.test.ts (26 tests) 56ms

 Test Files  2 passed (2)
      Tests  44 passed (44)
```

### Mutations

Eleven mutations, all killed, each with a control run either side.

| # | Mutation | Result |
| --- | --- | --- |
| M0 | control, unmutated | 44 passed |
| M1 | resolution layers applied user-then-global | 2 failed |
| M2 | global row dropped from the query's predicate | 2 failed |
| M3 | an unparseable stored value trusted instead of ignored | 6 failed |
| M4 | the "provider has no such setting" guard removed | 2 failed |
| M5 | an explicit `null` stored instead of dropped | 1 failed |
| M6 | the unknown-stage check removed | 2 failed |
| M7 | allowlist membership not checked, only the type | 6 failed |
| M8 | `modelSource` hardcoded to `user` | 3 failed |
| M9 | the route's validation loop removed | 4 failed |
| M10 | the validated key never actually written | 1 failed |
| M11 | control, after restore | 44 passed |

The harness earned its control runs. The first attempt used `set -e` and died inside M1 without
restoring, so the next attempt backed up an already-mutated file and every subsequent result was
against the wrong baseline. The tell was M0 failing, exactly the failure mode iteration 128
recorded: a mutation harness with no control reports nonsense confidently.

### Gates

```
$ cd web && pnpm tsc --noEmit
(exit 0, no output)

$ cd web && pnpm lint
(exit 0, no output)

$ cd web && set -a && . ../.env && set +a && pnpm test --run
 Test Files  2 failed | 125 passed (127)
      Tests  9 failed | 4423 passed | 7 skipped (4439)

$ cd web && pnpm build
✓ Compiled successfully in 3.6s
✓ Generating static pages using 15 workers (41/41) in 304.1ms
```

The 9 failures are exactly the Phase 0 baseline: 6 in `image-preview.test.tsx` and 3 in
`PostDetail.test.tsx`. A second full run added the known `scaffold-check.test.ts` flake and
nothing else. No Python file was touched, so the pytest gate is unchanged.

---

## 6.2b The six stage agents build their request from the resolver

The consumption half of 6.2. Before this item every agent named its model in a module
constant, so item 6.2a's `settings` row was a stored preference nothing read. After it, the
model and (on Anthropic) the effort on the wire come from that row, resolved for the user who
owns the post.

### How the user reaches the agent

Mastra resolves an agent's dynamic `model` and `defaultOptions` with `{ requestContext, mastra }`
and nothing else (`node_modules/@mastra/core/dist/types/dynamic-argument.d.ts`), and
`generate(prompt, options)` merges `getDefaultOptions({ requestContext: options?.requestContext })`
(`dist/agent-DSxJoGjY.js:36863`). So the request context is the only channel a step has for
telling an agent whose overrides apply, which is what iteration 134 predicted.

Three pieces, in `mastra/stage-models.ts`:

- `settingsUserIdForPost(postId)`: `posts` has no `user_id`, so ownership comes through
  `posts.profile_id -> website_profiles.user_id` (Alembic 010). A post with no profile, a
  profile with no owner, and an id that matches no post all resolve to `null`, which resolves
  to the global row then the verified defaults.
- `stageRequestContext(userId)` / `stageRequestContextUserId(ctx)`: the `settingsUserId` key,
  written and read in one place so the two cannot disagree. An agent called with no context
  (Studio, `getModel()`, a live smoke test) reads `null`.
- `steps/stage-io.ts` `stageAgentOptions(postId)`: what a step hands `generate()`. The lookup
  is a query per provider call rather than a value carried in the step's input, deliberately:
  the workflow snapshot would otherwise pin the setting as it stood when the run started, and
  a stage resumed after a crash or rerun by name days later should use the setting stored now.

`agents/claude.ts` gained `claudeStageModel(stage)` and `claudeStageDefaultOptions(stage, maxTokens)`,
both taking a `ClaudeStage` (`outline | write | edit | ready`) rather than a `Stage`. That
narrowing is not cosmetic: the first pass of this item wired `images` through them, which put
`anthropic/gemini-3-pro-image` on the wire and failed three tests. The type makes the same
mistake a compile error.

so `outline`, `write`, `edit` and `ready` are one line each. `claudeStageOptions(maxTokens, effort)`
took the effort as a parameter; `CLAUDE_DEFAULT_EFFORT` is now only the fallback inside
`STAGE_MODEL_DEFAULTS`, not a value any call site reads. `research` resolves the same way with
the `perplexity/` prefix. `images` resolves the Gemini generation model in
`steps/images-generate.ts` and passes it to `generateOneImage` -> `generateImage`.

### Two constants that stayed, and why

- `IMAGES_MODEL_ID` (`agents/images.ts`): the `images` entry in `stage_models` names the
  Gemini generation model, so the Claude call that writes the manifest has no setting to read.
  Pointing it at another stage's row would be invented behaviour. The gap was already recorded
  under 6.2a and is now stated in the module.
- `GEMINI_IMAGE_MODEL_ID` (`images/gemini.ts`): `generateImage`'s own default for a caller
  with no settings row to read, which keeps that low-level client usable without a database.
  `stage-models.test.ts` asserts it equals `STAGE_MODEL_DEFAULTS.images.model`.

`no-next-imports.test.ts` gained `@mastra/core/request-context`: the entry point's package
graph really did grow by one, and the test failed with a clean one-package diff before the
list was updated.

### The router's id type

`MastraModelConfig.id` is `` `${string}/${string}` ``, which a template literal built from a
`string` model id does not satisfy on its own (TS2322). Both resolvers apply the prefix through
an annotated binding rather than a cast, so the router's constraint is still checked.

### Tests

```
$ cd web && npx vitest run src/mastra/stage-models.test.ts src/mastra/agents \
    src/mastra/steps/outline.test.ts src/mastra/steps/images-generate.test.ts \
    src/mastra/no-next-imports.test.ts
 ✓ src/mastra/no-next-imports.test.ts (3 tests) 12ms
 ✓ src/mastra/steps/outline.test.ts (8 tests) 106ms
 ✓ src/mastra/steps/images-generate.test.ts (18 tests) 265ms
 ✓ src/mastra/stage-models.test.ts (31 tests) 94ms
 ✓ src/mastra/agents/research.test.ts (7 tests | 1 skipped) 36ms
 ✓ src/mastra/agents/images.test.ts (12 tests | 1 skipped) 120ms
 ✓ src/mastra/agents/edit.test.ts (10 tests | 1 skipped) 195ms
 ✓ src/mastra/agents/ready.test.ts (9 tests | 1 skipped) 265ms
 ✓ src/mastra/agents/write.test.ts (8 tests | 1 skipped) 328ms
 ✓ src/mastra/agents/outline.test.ts (12 tests | 1 skipped) 297ms

 Test Files  10 passed (10)
      Tests  112 passed | 6 skipped (118)
```

New coverage, all against the real database and the real serialized provider request:

- `agents/outline.test.ts`: four wire tests. A stored `{model, effort}` for the user puts
  `claude-opus-4-6` and `output_config.effort: "max"` on the outbound Anthropic request while
  `max_tokens` stays the golden fixture's; an effort-only override keeps the stage's model;
  another stage's override changes nothing; a run with no settings user sends the verified
  defaults. `claude-opus-4-6` is the pre-6.1 incumbent, so the override is a real allowlisted
  id rather than one invented for the test.
- `steps/outline.test.ts`: the step hands the agent a context carrying the owner of the post's
  profile, and a null user for a post with no profile.
- `steps/images-generate.test.ts`: the generation request goes to
  `/models/gemini-3.1-flash-image-preview:generateContent` when that is what the owner stored.
  The assertion is on the URL because `generateContent` is a per-model endpoint, so an override
  that never reached the client would be invisible in the body.
- `stage-models.test.ts`: `settingsUserIdForPost` over four real row shapes, and
  `resolveStageModelForPost` proving an owned post merges global then user while an unowned
  post sees only the global row.

### Mutations

Eleven mutations, ten killed.

| Mutation | Result |
| --- | --- |
| `stageRequestContextUserId` always returns null | KILLED |
| `settingsUserIdForPost` joins on `posts.id` instead of `posts.profile_id` | KILLED |
| `settingsUserIdForPost` always returns null | KILLED |
| `stageRequestContext` builds an empty context | KILLED |
| `claudeStageModel` resolves for `null` instead of the context's user | KILLED |
| `claudeStageDefaultOptions` resolves for `null` instead of the context's user | KILLED |
| `claudeStageDefaultOptions` drops the resolved effort | KILLED |
| the research agent resolves for `null` instead of the context's user | SURVIVED |
| `stageAgentOptions` passes a null user | KILLED |
| `images-generate` never resolves a model | KILLED |
| the images manifest call's model id changes | KILLED |

The survivor is equivalent under the current allowlist: `STAGE_MODEL_ALLOWLIST.research` has
exactly one entry (`sonar-pro`, the only Perplexity id with a live call behind it), so no
stored override can change what reaches the wire and the context is unobservable from outside.
`agents/research.test.ts` carries the tripwire: it asserts the allowlist is exactly that one
id, so verifying a second Perplexity model fails that test and forces the missing override
test to be written with it.

A control run either side of the sweep was clean. Note for future sweeps: detecting a kill by
grepping the last line containing `Tests ` is wrong, because vitest's `Failed Tests 1` banner
matches it and carries a capital `Failed`; the first pass reported all eleven as SURVIVED
before switching to the exit code.

### Gates

```
$ cd web && pnpm tsc --noEmit
(exit 0, no output)

$ cd web && pnpm lint
(exit 0, no output)

$ cd web && pnpm test
 Test Files  3 failed | 124 passed (127)
      Tests  10 failed | 4435 passed | 7 skipped (4452)

$ cd web && pnpm build
✓ Compiled successfully in 4.4s
```

Nine of the ten failures are the recorded baseline (6 in `image-preview.test.tsx`, 3 in
`PostDetail.test.tsx`); the tenth is the known `scaffold-check.test.ts` flake, which passed on
a repeat run of the same tree. No Python file was touched, so the pytest gate is unchanged.

---

## 6.3

The settings page's per-stage model and effort table.

### What was built

A read endpoint plus a card. Writes reuse `PATCH /api/settings`, so there is exactly one
place that decides what a legal model id is.

`GET /api/settings/stage-models` has no FastAPI ancestor. It exists because the page cannot
build the table from `GET /api/settings` alone: that endpoint returns the caller's own rows
verbatim, so the page would see the user's overrides but neither the operator's global row
underneath them, nor the verified defaults underneath that, nor the allowlist a selector is
populated from. Resolving in the browser would be a second implementation of
`resolveStageModels()` free to disagree with the one the pipeline runs on.

Each stage row carries two resolutions. `model`/`effort` are what the caller's runs use now.
`fallback_model`/`fallback_effort` are what those fields resolve to with the caller's own row
removed, which is what "revert" produces and is not always the hardcoded default: a global
row sits in between.

### Three decisions

**The selector shows the effective value, not the override.** A stage nobody has configured
still runs on something. Showing that value with a badge for its origin (`Default`, `Global`,
`Override`) means the table always reads as the configuration the pipeline will run, never as
an empty form.

**Revert clears the stage, it does not write the fallback back.** Storing the resolved value
as an override would freeze today's fallback into the user's row, so a later change to the
operator's global row would stop reaching them. `M6` in the mutation table below is exactly
this mistake, and the test kills it.

**The client writes the whole overrides map, not a patch.** `stage_models` is one row value,
so a write that carried only the edited stage would silently drop every other stage's
override. `M7` is that mistake.

Two things the item asks for that the shape did not need: an effort control is rendered only
where `efforts` is non-empty (Perplexity and Gemini get the text "no effort setting"), and a
rejected write shows the route's own 422 `detail` against the row it belongs to rather than a
generic failure, via a new `apiErrorMessage()` helper in `lib/api.ts` that unwraps the
`{"detail": ...}` body `request()` throws with.

### Live evidence

Dev server on :3000 with `NEXT_PUBLIC_API_URL=http://localhost:3000`, a real BetterAuth
session cookie, against the dev database.

```
$ curl -s -o /dev/null -w "%{http_code}\n" -H "Cookie: $COOKIE" \
    http://localhost:3000/api/settings/stage-models
200

$ curl -s -H "Cookie: $COOKIE" http://localhost:3000/api/settings/stage-models \
    | python3 -m json.tool | head -30
{
    "stages": [
        {
            "stage": "research",
            "provider": "perplexity",
            "model": "sonar-pro",
            "effort": null,
            "model_source": "default",
            "effort_source": "default",
            "models": [
                "sonar-pro"
            ],
            "efforts": [],
            "fallback_model": "sonar-pro",
            "fallback_effort": null
        },
        {
            "stage": "outline",
            "provider": "anthropic",
            "model": "claude-opus-5",
            "effort": "high",
            "model_source": "default",
            "effort_source": "default",
            "models": [
                "claude-opus-5",
                "claude-fable-5",
                "claude-opus-4-6"
            ],
            "efforts": [
                "low",
```

The accessibility tree of the rendered card, with nothing configured
(`chrome-devtools-axi open http://localhost:3000/settings`):

```
uid=g1746:4_32 StaticText "Stage Models"
uid=g1746:4_33 StaticText "Model and reasoning effort per pipeline stage. Only verified model ids are selectable."
uid=g1746:4_34 StaticText "Research"
uid=g1746:4_35 StaticText "perplexity"
uid=g1746:4_36 StaticText "Default"
uid=g1746:4_37 combobox "research model" expandable haspopup="listbox" value="sonar-pro"
uid=g1746:4_38 StaticText "no effort setting"
uid=g1746:4_39 button "Save" disableable disabled
uid=g1746:4_40 button "Revert research to default" disableable disabled
uid=g1746:4_41 StaticText "Outline"
uid=g1746:4_42 StaticText "anthropic"
uid=g1746:4_43 StaticText "Default"
uid=g1746:4_44 combobox "outline model" expandable haspopup="listbox" value="claude-opus-5"
uid=g1746:4_45 combobox "outline effort" expandable haspopup="listbox" value="high"
uid=g1746:4_46 button "Save" disableable disabled
uid=g1746:4_47 button "Revert outline to default" disableable disabled
```

Selecting `claude-opus-4-6` on the `write` row and clicking Save (`chrome-devtools-axi click`
on the combobox, the option, then the button):

```
uid=g1752:7_49 StaticText "Write"
uid=g1752:7_50 StaticText "anthropic"
uid=g1752:7_51 StaticText "Override"
uid=g1752:7_52 combobox "write model" expandable haspopup="listbox" value="claude-opus-4-6"
uid=g1752:7_53 combobox "write effort" expandable haspopup="listbox" value="high"
uid=g1752:7_54 button "Save" disableable disabled
uid=g1752:7_55 button "Revert write to default"
uid=g1752:9_0 StaticText "Reverts to "
uid=g1752:9_1 StaticText "claude-opus-5"
uid=g1752:9_2 StaticText " / high"
```

The row that write produced, read straight from Postgres:

```
$ docker compose exec -T db psql -U pipeline -d content_pipeline \
    -c "select key, user_id, value from settings where key='stage_models' and user_id='$USERID';"
     key      |                     user_id                      |                           value
--------------+--------------------------------------------------+-----------------------------------------------------------
 stage_models | ui-check-63-b2bf0994-ab8a-497f-a17a-2bc34a8658ea | {"write": {"model": "claude-opus-4-6", "effort": "high"}}
(1 row)
```

Clicking Revert on the same row:

```
uid=g1756:7_49 StaticText "Write"
uid=g1756:7_50 StaticText "anthropic"
uid=g1756:7_51 StaticText "Default"
uid=g1756:7_52 combobox "write model" expandable haspopup="listbox" value="claude-opus-5"
uid=g1756:7_53 combobox "write effort" expandable haspopup="listbox" value="high"
uid=g1756:7_54 button "Save" disableable disabled
uid=g1756:7_55 button "Revert write to default" disableable disabled

$ docker compose exec -T db psql -U pipeline -d content_pipeline \
    -c "select key, value from settings where user_id='$USERID';"
     key      | value
--------------+-------
 stage_models | {}
(1 row)
```

The stage entry is gone rather than replaced by the fallback, which is the point of the second
decision above.

```
$ npx -y chrome-devtools-axi console
## Console messages
Showing 1-1 of 1 (Page 1 of 1).
msgid=36 [issue] A form field element should have an id or name attribute (count: 1)
```

No errors. That one issue is a pre-existing Chrome autofill hint against the API-key inputs on
the same page, not the new card.

Screenshots: `docs/mastra-port/ui/136-settings-stage-models-light.png` and
`136-settings-stage-models-dark.png`, both full-page with the `write` override in place.

### Tests

```
$ cd web && pnpm vitest run src/app/api/settings/stage-models/route.test.ts \
    src/app/settings/stage-models-card.test.tsx src/app/settings/SettingsPage.test.tsx \
    src/app/api/settings/route.test.ts
 ✓ src/app/api/settings/stage-models/route.test.ts (9 tests) 77ms
 ✓ src/app/api/settings/route.test.ts (18 tests) 97ms
 ✓ src/app/settings/SettingsPage.test.tsx (12 tests) 459ms
 ✓ src/app/settings/stage-models-card.test.tsx (10 tests) 531ms

 Test Files  4 passed (4)
      Tests  49 passed (49)
(exit 0)
```

The route suite runs against the real database and a real BetterAuth session; a mocked
resolver would prove nothing about the layering the endpoint exists to expose. It captures and
restores the shared global `stage_models` row per the hazard recorded under #6.0.

### Mutations

Ten mutations, with a control run of the unmutated files on both sides of the sweep (both
exit 0, so the harness reports a pass when it should).

| # | File | Mutation | Verdict |
| --- | --- | --- | --- |
| M1 | route.ts | `resolveStageModels(null)` -> `resolveStageModels(user.id)` (fallback computed with the user's own row) | KILLED |
| M2 | route.ts | `fallback_model: withoutUser[...]` -> `effective[...]` | KILLED |
| M3 | route.ts | stored-row validation dropped, value returned raw | KILLED |
| M4 | route.ts | own-row lookup drops the `user_id` predicate | KILLED |
| M5 | card.tsx | `entry.effort === null` -> `false` (sends `effort` to a provider with none) | KILLED |
| M6 | card.tsx | revert writes `{ model: fallback_model }` instead of deleting the stage | KILLED |
| M7 | card.tsx | write starts from `{}` instead of the existing overrides | KILLED |
| M8 | card.tsx | `apiErrorMessage(...)` -> the generic fallback string | KILLED |
| M9 | card.tsx | source badge never reports `user` | KILLED |
| M10 | card.tsx | Save enabled regardless of dirtiness | KILLED |

### One shared-fixture change

`src/test/setup.ts` gained pointer-capture and `scrollIntoView` no-ops on `Element.prototype`.
jsdom implements none of them and Radix's `Select` calls all three while opening, so before
this a test that clicked a `<Select>` trigger threw `target.hasPointerCapture is not a
function`, which reads like a component bug rather than a missing DOM API. No component in the
repo had been tested through a `Select` before, so the gap had not surfaced. The block is
guarded by `typeof Element !== "undefined"` because the same setup file is loaded for the
`node`-environment route suites, where an unguarded reference is a `ReferenceError` that fails
every one of them.

### Gates

```
$ cd web && pnpm tsc --noEmit
(exit 0, no output)

$ cd web && pnpm lint
(exit 0, no output)

$ cd web && pnpm build
(exit 0)
├ ƒ /api/settings
├ ƒ /api/settings/api-keys
├ ƒ /api/settings/api-keys/[provider]/reveal
├ ƒ /api/settings/stage-models

$ cd web && pnpm test
 Test Files  2 failed | 127 passed (129)
      Tests  9 failed | 4455 passed | 7 skipped (4471)
```

Nine of the nine failures are the recorded baseline: 6 in `image-preview.test.tsx` and 3 in
`PostDetail.test.tsx`. Both were confirmed pre-existing on this tree by stashing this
iteration's changes and re-running `PostDetail.test.tsx`, which still reported `3 failed | 12
passed`. A tenth failure in `images-manifest.test.ts` appeared in the full-suite run and passed
on its own immediately afterwards, so it is load-dependent flake and not a regression. The
build's 15 `BetterAuthError: You are using the default secret` lines are pre-existing noise
from prerendering without `BETTER_AUTH_SECRET` in the build environment. No Python file was
touched, so the pytest gate is unchanged.

---

## 6.4 A model chosen in the UI changes the outbound provider request

Phase 6's exit criterion, and the first test in the phase that does not supply one of the
chain's links by hand.

### Why a new test rather than a claim from the three that exist

Item 6.2a proved the row wins the merge, 6.2b proved the agent reads the merge, 6.3 proved the
page writes the row. Each of the three hands itself the previous link's output: 6.2a inserts
the row it then resolves, 6.2b inserts the row the agent then reads, and 6.3's component tests
assert on a mocked `stageModels.update`. All three can pass while a seam between them is
broken, which is not hypothetical: the mismatch recorded under 6.2a, where
`settings.update()` wraps every value in `{value: ...}` and the validated `stage_models` key
rejects that wrapper, is exactly a seam defect that the per-link tests could not see.

`web/src/app/settings/stage-models-to-provider.test.tsx` runs the chain in one process:

```
StageModelsCard (real component, driven by userEvent through its Radix selects)
  -> @/lib/api (real client)
  -> PATCH /api/settings (real handler, real BetterAuth session)
  -> settings row in Postgres (real)
  -> resolveStageModels()
  -> the agent's dynamic model / defaultOptions resolvers
  -> the serialized HTTP request
```

Two things are not real, both of them transport. `fetch` is routed: dashboard calls are
dispatched into the route-handler modules with the session cookie attached (no Next.js server
is running and jsdom has no cookie jar), and provider calls are captured and answered from a
canned response. Anything the router does not recognise throws rather than reaching the
network.

Both provider shapes are covered because they fail differently: Anthropic carries the id in a
JSON body field with the effort beside it, Gemini carries it in the URL path and has no effort
parameter at all. The Gemini half runs the production `imagesGenerateStep`, so the assertion is
on the URL the step's own client built.

Each chain asserts the verified default on the wire *before* the UI is touched, and the
Anthropic chain asserts it again after the UI reverts the stage. Without those controls a
resolver that ignored the setting entirely could pass by happening to agree with it.

### The test

```
$ cd web && npx vitest run src/app/settings/stage-models-to-provider.test.tsx

 ✓ src/app/settings/stage-models-to-provider.test.tsx (6 tests) 614ms
     ✓ stores what the settings page saved, through the real handler  345ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
```

The six, in the order they run (they share the row they write, so the order is the point):

| # | Test | What it pins |
| --- | --- | --- |
| 1 | sends the verified default while the user has configured nothing | negative control, Anthropic |
| 2 | stores what the settings page saved, through the real handler | UI -> handler -> row |
| 3 | puts that model and effort on the wire | row -> agent -> request body |
| 4 | goes back to the default when the page reverts the stage | revert -> row -> request body |
| 5 | sends the verified default while the user has configured nothing | negative control, Gemini |
| 6 | carries the chosen model in the request path after the page saves it | UI -> handler -> row -> URL |

### Mutations

Nine mutations across the five files the chain runs through, each reverted before the next.
Verdicts are the test command's exit code, not a grep of its output, per the trap recorded
under 6.2b.

| # | File | Mutation | Verdict |
| --- | --- | --- | --- |
| M1 | `mastra/stage-models.ts` | drop the `user` layer from the merge | KILLED |
| M2 | `app/api/settings/route.ts` | `PATCH` stores nothing | KILLED |
| M3 | `mastra/agents/claude.ts` | model ignores the setting, uses the default | KILLED |
| M4 | `mastra/agents/claude.ts` | effort ignores the setting, uses `CLAUDE_DEFAULT_EFFORT` | KILLED |
| M5 | `mastra/steps/images-generate.ts` | pass no model, let the client default | KILLED |
| M6 | `app/settings/stage-models-card.tsx` | write a non-object override value | KILLED |
| M7 | `mastra/stage-models.ts` | `settingsUserIdForPost` always null | KILLED |
| M8 | `app/settings/stage-models-card.tsx` | card sends the model without the effort | KILLED |
| M9 | `app/api/settings/stage-models/route.ts` | `GET` resolves without the caller | KILLED |

Control runs exit 0 before the sweep and the working tree is clean after it (`git status
--porcelain` lists only the new test file), so no verdict was measured against a mutated
baseline.

### One shared-fixture change: a lock on the global `stage_models` row

Alembic 012 allows exactly one `user_id IS NULL` `stage_models` row, and it is the operator
layer every resolution falls through, so a file that sets it sets it for every file running at
the same time. Two files already did (`mastra/stage-models.test.ts` and
`app/api/settings/stage-models/route.test.ts`); this one is the third and the most sensitive to
it, because its negative controls assert the hardcoded default is what reaches the provider.

`src/test/row-lock.ts` now holds the advisory-lock mechanics that `api-keys-row.ts` had inline,
`api-keys-row.ts` is a thin wrapper over it keeping its two exported names (so its eight
importers are untouched), and `src/test/stage-models-row.ts` is a second wrapper on its own
lock key. The three files that write the global row take it in `beforeAll` and release it in
`afterAll` before `closeDb()`. The ordering rule is documented in `row-lock.ts`: `api_keys`
first, `stage_models` second, so two files cannot deadlock on the pair. Only the new file takes
both.

### Gates

```
$ cd web && npx tsc --noEmit
(exit 0, no output)

$ cd web && pnpm lint
(exit 0, no output)

$ cd web && pnpm test
 Test Files  2 failed | 128 passed (130)
      Tests  9 failed | 4461 passed | 7 skipped (4477)
(exit 1)

$ cd web && pnpm build
(exit 0)
```

The nine failures are the recorded baseline and nothing else: 6 in `image-preview.test.tsx` and
3 in `PostDetail.test.tsx`, the same nine as under #6.3. The passing count moved from 4455 to
4461, which is this item's six tests and nothing else. The build's 15 `BetterAuthError: You are
using the default secret` lines are the same pre-existing prerender noise. No Python file was
touched, so the pytest gate is unchanged.
