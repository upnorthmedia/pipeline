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
