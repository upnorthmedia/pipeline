# Mastra port ledger

One item per iteration. Check an item only when the exact command and its real
output are pasted beneath it. Never paraphrase output.

Phase order is fixed. `api/` is deleted only in Phase 7.

---

## Phase 0: Baseline and ledger

- [x] 0.1 Create this ledger with every Phase 1-9 item as an unchecked checkbox, and record the
  Phase 0 baselines (`pytest`, `ruff check`, `ruff format --check`, `pnpm test`, `pnpm lint`,
  `pnpm tsc --noEmit`, `pnpm build`) with real pasted output.

  Raw logs committed under `docs/mastra-port/baseline/`.

  **Environment note.** `pnpm -C web <cmd>` as written in the objective does not work with
  pnpm 10.26.2 in this repo (`web/` carries its own `pnpm-workspace.yaml`, so it is a
  workspace root, not a member of a root workspace):

  ```
  $ pnpm -C web tsc --noEmit
  undefined
   ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "web" not found
  exit=254
  ```

  The working equivalents, used for every gate below and for the rest of this port, are
  `cd web && pnpm exec tsc --noEmit`, `cd web && pnpm lint|test|build`.

  **Environment note 2.** Host port 5433 is occupied by an unrelated project's Postgres
  container (`ship-restrict-shopify-db-1`), so the repo's own `db` service could not be
  started and `tests/conftest.py`'s hardcoded
  `postgresql+asyncpg://pipeline:pipeline@localhost:5433/content_pipeline_test` was
  unreachable on the host:

  ```
  $ PGPASSWORD=pipeline psql -h localhost -p 5433 -U pipeline -l
  psql: error: connection to server at "localhost" (::1), port 5433 failed: FATAL:  password authentication failed for user "pipeline"
  ```

  The pytest baseline was therefore taken inside a container that shares the network
  namespace of a throwaway `postgres:17-alpine` listening on 5433 (`PGPORT=5433`), so
  `localhost:5433` inside the test container resolves to the right database. No other
  project's container was touched, and the throwaway container was removed afterwards.
  Reproduce with:

  ```sh
  docker run -d --name jena-baseline-pg -e POSTGRES_USER=pipeline -e POSTGRES_PASSWORD=pipeline \
    -e POSTGRES_DB=content_pipeline -e PGPORT=5433 postgres:17-alpine
  docker exec jena-baseline-pg psql -U pipeline -p 5433 -d postgres -c "CREATE DATABASE content_pipeline_test"
  cd api && docker run --rm --network container:jena-baseline-pg -v "$PWD:/app" -w /app \
    -e UV_PROJECT_ENVIRONMENT=/tmp/venv --entrypoint sh ghcr.io/astral-sh/uv:python3.12-bookworm \
    -c "uv sync --extra dev -q && uv run pytest -q"
  docker rm -f jena-baseline-pg
  ```

  ### Baseline: `cd web && pnpm exec tsc --noEmit` -> **exit 1** (pre-existing failure)

  ```
  src/lib/auth.ts(5,22): error TS7016: Could not find a declaration file for module 'pg'. '.../node_modules/.pnpm/pg@8.20.0/node_modules/pg/esm/index.mjs' implicitly has an 'any' type.
    Try `npm i --save-dev @types/pg` if it exists or add a new declaration (.d.ts) file containing `declare module 'pg';`
  exit=1
  ```

  ### Baseline: `cd web && pnpm lint` -> **exit 0**

  ```
  > content-pipeline-dashboard@0.1.0 lint /Users/cody/.../web
  > eslint

  exit=0
  ```

  ### Baseline: `cd web && pnpm test` -> **exit 1**, 9 failed / 191 passed (200), 2 failed files / 14 passed (16)

  ```
   Test Files  2 failed | 14 passed (16)
        Tests  9 failed | 191 passed (200)
  exit=1
  ```

  The 9 failing tests, which are the never-exceed baseline for the rest of this port:

  ```
   FAIL  src/app/posts/PostDetail.test.tsx > PostDetailPage > renders stage tabs
   FAIL  src/app/posts/PostDetail.test.tsx > PostDetailPage > shows Run Next and Run All buttons when not running or complete
   FAIL  src/app/posts/PostDetail.test.tsx > PostDetailPage > renders stage logs when present
   FAIL  src/components/__tests__/image-preview.test.tsx > ImagePreview > renders image cards from manifest
   FAIL  src/components/__tests__/image-preview.test.tsx > ImagePreview > displays alt text
   FAIL  src/components/__tests__/image-preview.test.tsx > ImagePreview > displays placement info
   FAIL  src/components/__tests__/image-preview.test.tsx > ImagePreview > displays prompt text
   FAIL  src/components/__tests__/image-preview.test.tsx > ImagePreview > displays style metadata
   FAIL  src/components/__tests__/image-preview.test.tsx > ImagePreview > displays image with filename
  ```

  Correction to the objective's premise: it states 6 known pre-existing failures in
  `image-preview.test.tsx`. There are 6 there **plus 3 in `PostDetail.test.tsx`**, for a
  baseline of **9**. Treat 9 as the ceiling.

  ### Baseline: `cd web && pnpm build` -> **exit 1** (same missing `@types/pg`)

  ```
  ▲ Next.js 16.1.6 (Turbopack)

  ⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.
    Creating an optimized production build ...
  ✓ Compiled successfully in 3.0s
    Running TypeScript ...
  Failed to compile.

  ./src/lib/auth.ts:5:22
  Type error: Could not find a declaration file for module 'pg'.
  Next.js build worker exited with code: 1 and signal: null
   ELIFECYCLE  Command failed with exit code 1.
  exit=1
  ```

  ### Baseline: `cd api && uv run ruff check .` -> **exit 1**, 32 errors

  ```
  Found 32 errors.
  [*] 17 fixable with the `--fix` option (1 hidden fix can be enabled with the `--unsafe-fixes` option).
  exit=1
  ```

  ### Baseline: `cd api && uv run ruff format --check .` -> **exit 1**, 9 files

  ```
  Would reformat: src/api/posts.py
  Would reformat: src/pipeline/stages/images.py
  Would reformat: src/services/llm.py
  Would reformat: src/services/nextjs_publish.py
  Would reformat: src/worker.py
  Would reformat: tests/phase3/test_strip_leading_h1.py
  Would reformat: tests/phase6/test_ready_node.py
  Would reformat: tests/phase_nextjs/test_models.py
  Would reformat: tests/phase_nextjs/test_worker_trigger.py
  9 files would be reformatted, 117 files already formatted
  exit=1
  ```

  ### Baseline: `cd api && pytest` -> **exit 1**, 125 failed / 235 passed / 25 errors

  ```
  125 failed, 235 passed, 25 errors in 11.12s
  exit=1
  ```

  Correction to the objective's premise: it describes "~280 pytest tests" as the working
  backend baseline. The suite does not pass. The dominant cause is Alembic 010's
  multi-tenancy `user_id` column, which the fixtures never set:

  ```
  sqlalchemy.exc.IntegrityError: (sqlalchemy.dialects.postgresql.asyncpg.IntegrityError) <class 'asyncpg.exceptions.NotNullViolationError'>: null value in column "user_id" of relation "website_profiles" violates not-null constraint
  ```

  with a second cluster of `assert 401 == 201` from handlers that now require an
  authenticated user. Full failure list: `docs/mastra-port/baseline/pytest-summary.txt`.
  **Consequence for this port:** "both stacks stay green until Phase 7" cannot mean
  "pytest exits 0". It means the pass count never drops below 235 and the failure count
  never rises above 125/25.

  **Environment note 3.** `docs/` was entirely gitignored, so the ledger could not be
  committed. `.gitignore` now reads `docs/*` plus `!docs/mastra-port/`, which un-ignores this
  directory only. `CLAUDE.md` is also gitignored; item 7.4 asks for it to be updated, so decide
  there whether to un-ignore it too or record the change elsewhere.

- [x] 0.2 Fix the pre-existing `tsc`/`build` break by adding `@types/pg` to `web/`, so the
  Phase 0 gate baseline for `tsc --noEmit` and `build` is exit 0. Confirm `pnpm test`
  failure count is still 9.

  `@types/pg@8.23.1` added to `web/` devDependencies. The `pnpm-lock.yaml` diff adds exactly
  one resolution (verified: `git diff web/pnpm-lock.yaml | grep -cE '^-.*resolution:'` -> `0`,
  and a single added `resolution:` line, the `@types/pg` integrity hash). Everything else in
  that diff is peer-dependency hash re-keying, because `drizzle-orm`/`better-auth` peer sets
  now include `@types/pg`. No package version changed. `api/` was not touched, so the Python
  gates are unaffected and were not re-run.

  ### Reproduction of the break, before the fix

  ```
  $ cd web && pnpm exec tsc --noEmit
  src/lib/auth.ts(5,22): error TS7016: Could not find a declaration file for module 'pg'. '.../web/node_modules/.pnpm/pg@8.20.0/node_modules/pg/esm/index.mjs' implicitly has an 'any' type.
    Try `npm i --save-dev @types/pg` if it exists or add a new declaration (.d.ts) file containing `declare module 'pg';`
  exit=2
  ```

  ### `cd web && pnpm add -D @types/pg` -> **exit 0**

  ```
  devDependencies:
  + @types/pg 8.23.1

  Done in 2.2s using pnpm v10.26.2
  exit=0
  ```

  ### Gate: `cd web && pnpm exec tsc --noEmit` -> **exit 0** (was exit 1/2)

  ```
  $ pnpm exec tsc --noEmit; echo "exit=$?"
  exit=0
  ```

  ### Gate: `cd web && pnpm lint` -> **exit 0** (unchanged)

  ```
  > content-pipeline-dashboard@0.1.0 lint /Users/cody/.../web
  > eslint

  exit=0
  ```

  ### Gate: `cd web && pnpm test` -> **exit 1**, still exactly 9 failed / 191 passed (200)

  ```
  ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 9 ⎯⎯⎯⎯⎯⎯⎯
   Test Files  2 failed | 14 passed (16)
        Tests  9 failed | 191 passed (200)
  exit=1
  ```

  Identical to the 0.1 baseline: the ceiling of 9 pre-existing failures holds, no new failures.

  ### Gate: `cd web && pnpm build` -> **exit 0** (was exit 1)

  ```
  > content-pipeline-dashboard@0.1.0 build /Users/cody/.../web
  > next build

   ▲ Next.js 16.1.6 (Turbopack)

   ⚠ The "middleware" file convention is deprecated. Please use "proxy" instead. Learn more: https://nextjs.org/docs/messages/middleware-to-proxy
     Creating an optimized production build ...
   ✓ Compiled successfully in 2.9s
     Running TypeScript ...
   ✓ Generating static pages using 15 workers (25/25) in 295.5ms
     Finalizing page optimization ...

  Route (app)
  ┌ ○ /
  ├ ○ /_not-found
  ├ ƒ /api/auth/[...all]
  ├ ○ /apple-icon.png
  ├ ● /auth/[path]
  ├ ○ /icon0.svg
  ├ ○ /icon1.png
  ├ ○ /manifest.json
  ├ ○ /monitor
  ├ ƒ /posts/[id]
  ├ ○ /posts/batch
  ├ ○ /posts/new
  ├ ○ /profiles
  ├ ƒ /profiles/[id]
  └ ○ /settings
  exit=0
  ```

  **Revised gate baseline from here on.** `tsc --noEmit` and `build` must exit 0 for the rest
  of the port; the "pre-existing failure" allowance recorded in 0.1 for those two gates no
  longer applies. `pnpm test` remains at most 9 failures, `pnpm lint` exit 0. The deprecation
  warning about the `middleware` file convention is pre-existing and unrelated to this port;
  it is the only warning `build` emits.
- [x] 0.3 Stand up a reachable dev database for this repo (resolve the host-port 5433
  collision) and record the working local invocation, so later phases can run the Python
  pipeline and, later, the TypeScript data layer against a real database.

  **Fix.** The host port is now a variable instead of a literal, so a collision is resolved
  by editing `.env` rather than by container gymnastics. Three changes:
  - `docker-compose.yml`: `"${POSTGRES_HOST_PORT:-5433}:5432"` and
    `"${REDIS_HOST_PORT:-6379}:6379"`. Defaults are the previous literals, so an environment
    with free ports behaves exactly as before.
  - `api/tests/conftest.py`: `TEST_DATABASE_URL` now reads the env var of the same name and
    falls back to the previous hardcoded `localhost:5433` URL.
  - `.env.example` documents `POSTGRES_HOST_PORT`, `REDIS_HOST_PORT`, and `TEST_DATABASE_URL`;
    `README.md` Quick Start explains the override.

  `api/alembic.ini` needed no change: `api/alembic/env.py` already prefers `DATABASE_URL_SYNC`
  over the ini value.

  **Working local invocation** (this machine: 5432 taken by `cairo-pooler`, 5433 by
  `ship-restrict-shopify-db-1`, 5434 by `petago-test-db`; 5435 and 6379 free). Local `.env`
  (gitignored) sets `POSTGRES_HOST_PORT=5435` and the matching URLs.

  ```
  $ docker compose up -d db redis
   Container objective-port-jena-46c1e6-1-db-1 Started
   Container objective-port-jena-46c1e6-1-redis-1 Started

  $ docker compose ps --format '{{.Service}}\t{{.State}}\t{{.Ports}}'
  db	running	0.0.0.0:5435->5432/tcp, [::]:5435->5432/tcp
  redis	running	0.0.0.0:6379->6379/tcp, [::]:6379->6379/tcp

  $ PGPASSWORD=pipeline psql -h localhost -p 5435 -U pipeline -d content_pipeline -c "select version();"
   PostgreSQL 17.8 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit
  (1 row)
  exit=0
  ```

  **Schema applied to the dev database** (this is the database Phase 1 introspects):

  ```
  $ cd api && DATABASE_URL_SYNC="postgresql://pipeline:pipeline@localhost:5435/content_pipeline" .venv/bin/alembic upgrade head
  INFO  [alembic.runtime.migration] Running upgrade  -> 001, initial schema
  ... (002 through 010 elided, all applied)
  INFO  [alembic.runtime.migration] Running upgrade 010 -> 011, Add Next.js publishing fields to profiles and posts.

  $ DATABASE_URL_SYNC="postgresql://pipeline:pipeline@localhost:5435/content_pipeline" .venv/bin/alembic current
  011 (head)
  exit=0

  $ PGPASSWORD=pipeline psql -h localhost -p 5435 -U pipeline -d content_pipeline -c "\dt"
   public | alembic_version  | table | pipeline
   public | internal_links   | table | pipeline
   public | posts            | table | pipeline
   public | settings         | table | pipeline
   public | website_profiles | table | pipeline
  (5 rows)

  $ PGPASSWORD=pipeline psql -h localhost -p 5435 -U pipeline -d postgres -c "CREATE DATABASE content_pipeline_test"
  CREATE DATABASE
  exit=0
  ```

  **Environment note 4.** The objective says "API keys live in the `api_settings` DB table".
  There is no `api_settings` table. Alembic 001-011 produce five tables and the settings table
  is named `settings`. Phase 1 and Phase 6 must target `settings`, not `api_settings`.
  (`auth_users` and friends are BetterAuth-managed and excluded from Alembic autogenerate;
  they are absent here because BetterAuth has not run against this fresh volume yet.)

  **pytest now runs from the host, no container required, and matches the 0.1 baseline
  exactly:**

  ```
  $ cd api && TEST_DATABASE_URL="postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test" .venv/bin/pytest -q
  125 failed, 235 passed, 25 errors in 14.26s
  exit=1
  ```

  Identical to the 0.1 baseline (125 failed / 235 passed / 25 errors), so the conftest change
  is behavior-preserving. The containerized `--network container:` procedure recorded under
  0.1 is superseded and should not be used again.

  **`ruff` unchanged by the conftest edit:**

  ```
  $ cd api && .venv/bin/ruff check .
  Found 32 errors.
  exit=1

  $ cd api && .venv/bin/ruff format --check .
  9 files would be reformatted, 117 files already formatted
  exit=1
  ```

  Both match the 0.1 baseline counts.

  **State left behind for later iterations.** The containers are stopped at the end of the
  iteration but the named volumes (`objective-port-jena-46c1e6-1_pgdata`,
  `..._redisdata`) persist, so `docker compose up -d db redis` from the repo root restores the
  migrated `content_pipeline` and empty `content_pipeline_test` databases immediately. The
  local `.env` holding `POSTGRES_HOST_PORT=5435` is gitignored and stays in the worktree.
- [ ] 0.4 Capture golden fixtures: run the existing Python pipeline end to end on at least 2
  representative posts with different `article_type` and `output_format`. For each stage
  save the fully rendered prompt, the provider request parameters, and the raw output to
  `docs/mastra-port/golden/<post-slug>/<stage>.json`. Redact API keys. Exit: >= 12 fixture
  files committed.

  **Split.** 0.4 needs a capture harness, then two live provider runs that cost real money
  and take real time, so it is split into 0.4a (harness, no provider spend), 0.4b (live run
  for post 1) and 0.4c (live run for post 2). 0.4 is checked only when 0.4a-0.4c are all
  checked and >= 12 fixture files are committed.

- [x] 0.4a Build the golden-fixture capture harness (`api/scripts/capture_golden.py`) and
  verify it end to end with `--dry-run`, which stubs only the network call and leaves prompt
  assembly, the client wrappers, retries, manifest parsing and image optimisation intact.

  **Design decision: capture at the provider SDK boundary, not at `build_stage_prompt()`.**
  Two stages mutate the prompt after `build_stage_prompt()` returns, so its return value is
  not what the provider receives:

  - `edit_node` appends an analytics section (`src/pipeline/stages/edit.py:39-42`).
  - `research_node` wraps the prompt in `_reinforced_prompt()` on retry attempts 2 and 3
    (`src/pipeline/stages/research.py:80-84`).

  The recorders therefore wrap `httpx.AsyncClient.post` (filtered to `api.perplexity.ai`),
  `anthropic.resources.messages.AsyncMessages.create`, and
  `google.genai.models.Models.generate_content`, so the fixture holds the exact outbound
  payload. Verified patch points against the installed SDKs:

  ```
  $ cd api && uv run python -c "
  import anthropic
  from anthropic.resources.messages import AsyncMessages
  from google.genai.models import Models
  import google.genai as g
  print('anthropic', anthropic.__version__); print(AsyncMessages.create)
  print('genai', g.__version__); print(Models.generate_content)"
  anthropic 0.84.0
  <function AsyncMessages.create at 0x10c19e840>
  genai 1.65.0
  <function Models.generate_content at 0x10d16a7a0>
  ```

  ### Dry run -> **exit 0**, 12 fixture files

  ```
  $ cd api && uv run python scripts/capture_golden.py --dry-run --out /tmp/golden-dryrun
  [how-to-choose-a-crm-for-a-small-team] research: running
  [how-to-choose-a-crm-for-a-small-team] research: wrote /private/tmp/golden-dryrun/how-to-choose-a-crm-for-a-small-team/research.json (17968 bytes)
  [how-to-choose-a-crm-for-a-small-team] outline: running
  [how-to-choose-a-crm-for-a-small-team] outline: wrote /private/tmp/golden-dryrun/how-to-choose-a-crm-for-a-small-team/outline.json (20655 bytes)
  [how-to-choose-a-crm-for-a-small-team] write: running
  [how-to-choose-a-crm-for-a-small-team] write: wrote /private/tmp/golden-dryrun/how-to-choose-a-crm-for-a-small-team/write.json (20358 bytes)
  [how-to-choose-a-crm-for-a-small-team] edit: running
  [how-to-choose-a-crm-for-a-small-team] edit: wrote /private/tmp/golden-dryrun/how-to-choose-a-crm-for-a-small-team/edit.json (43202 bytes)
  [how-to-choose-a-crm-for-a-small-team] images: running
  [how-to-choose-a-crm-for-a-small-team] images: wrote /private/tmp/golden-dryrun/how-to-choose-a-crm-for-a-small-team/images.json (38186 bytes)
  [how-to-choose-a-crm-for-a-small-team] ready: running
  [how-to-choose-a-crm-for-a-small-team] ready: wrote /private/tmp/golden-dryrun/how-to-choose-a-crm-for-a-small-team/ready.json (19186 bytes)
  [best-time-tracking-tools-for-agencies] research: running
  [best-time-tracking-tools-for-agencies] research: wrote /private/tmp/golden-dryrun/best-time-tracking-tools-for-agencies/research.json (16834 bytes)
  [best-time-tracking-tools-for-agencies] outline: running
  [best-time-tracking-tools-for-agencies] outline: wrote /private/tmp/golden-dryrun/best-time-tracking-tools-for-agencies/outline.json (19520 bytes)
  [best-time-tracking-tools-for-agencies] write: running
  [best-time-tracking-tools-for-agencies] write: wrote /private/tmp/golden-dryrun/best-time-tracking-tools-for-agencies/write.json (19223 bytes)
  [best-time-tracking-tools-for-agencies] edit: running
  [best-time-tracking-tools-for-agencies] edit: wrote /private/tmp/golden-dryrun/best-time-tracking-tools-for-agencies/edit.json (41081 bytes)
  [best-time-tracking-tools-for-agencies] images: running
  [best-time-tracking-tools-for-agencies] images: wrote /private/tmp/golden-dryrun/best-time-tracking-tools-for-agencies/images.json (37054 bytes)
  [best-time-tracking-tools-for-agencies] ready: running
  [best-time-tracking-tools-for-agencies] ready: wrote /private/tmp/golden-dryrun/best-time-tracking-tools-for-agencies/ready.json (18260 bytes)

  Wrote 12 fixture file(s) under /private/tmp/golden-dryrun
  exit=0
  ```

  Fixture shape actually produced (inspected, not asserted from memory):

  ```
  $ cd api && uv run python - <<'EOF'
  import json, pathlib
  for f in ["research", "outline", "edit", "images"]:
      d = json.loads(pathlib.Path(f"/tmp/golden-dryrun/how-to-choose-a-crm-for-a-small-team/{f}.json").read_text())
      print("=====", f, "| keys:", list(d))
      print(" calls:", [(c["provider"], sorted(k for k in c["request"] if k != "messages")) for c in d["provider_calls"]])
      print(" rendered_prompt[0] len:", len(d["rendered_prompts"][0] or ""))
      print(" state_input.api_keys:", d["state_input"].get("api_keys"))
      print(" stage_output keys:", list(d["stage_output"]))
  EOF
  ===== research | keys: ['schema_version', 'generated_by', 'mode', 'captured_at', 'post_slug', 'stage', 'post_spec', 'state_input', 'rendered_prompts', 'provider_calls', 'stage_output']
   calls: [('perplexity', ['model', 'url'])]
   rendered_prompt[0] len: 6111
   state_input.api_keys: [REDACTED]
   stage_output keys: ['research', 'current_stage', 'stage_status', '_stage_meta']
  ===== outline
   calls: [('anthropic', ['max_tokens', 'model', 'system', 'thinking'])]
   rendered_prompt[0] len: 7348
  ===== edit
   calls: [('anthropic', ['max_tokens', 'model', 'system', 'thinking'])]
   rendered_prompt[0] len: 17709
  ===== images
   calls: [('anthropic', [...]), ('gemini', ['config', 'contents', 'model']), ('gemini', ['config', 'contents', 'model'])]
   stage_output keys: ['image_manifest', 'current_stage', 'stage_status', '_stage_meta', '_stage_meta_gemini']

  ```

  Trimmed for readability: the identical `keys:` line printed for all four stages is shown
  once. The two lines below came from a second inspection of the same fixtures, reading
  `provider_calls[0]["request"]` of `images.json` and `rendered_prompts[0]` of `edit.json`:

  ```
  anthropic thinking: {'type': 'enabled', 'budget_tokens': 10000} max_tokens: 11024 model: claude-opus-4-6
  edit prompt mentions Analytics: True
  ```

  ### Gates the harness could break

  ```
  $ cd api && uv run ruff check .
  Found 32 errors.
  exit=1
  ```

  ```
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 118 files already formatted
  exit=1
  ```

  Both hold the 0.1 baseline exactly (32 ruff errors, 9 unformatted files; the "already
  formatted" count rises 117 -> 118 because `scripts/capture_golden.py` is the new file).
  `pytest` is unaffected: the script is a standalone entry point, lives outside
  `testpaths = ["tests"]`, and nothing under `src/` or `tests/` imports it
  (`grep -rn capture_golden src tests` returns nothing).

  ### Facts discovered that Phase 3 parity tests must account for

  1. `_build_config_context()` injects `- **TODAY_DATE**: <today>` into every stage prompt
     (`src/pipeline/helpers.py:203`). Prompt equality across Python and TypeScript can only
     hold with the date pinned or normalised.
  2. `ClaudeClient.chat()` computes `effective_max = max(max_tokens, thinking_budget + 1024)`
     and always sends `thinking={"type": "enabled", "budget_tokens": 10000}`. The images
     stage asks for `max_tokens=8000` and therefore actually sends **11024**. Port the
     resolved value, not the call-site value.
  3. The images stage rewrites the featured image filename to
     `featured-<MMDDYY>-<2 random digits>.webp` and forces `image_size="2K"` (and `16:9`
     unless the manifest set `aspect_ratio`). The filename is nondeterministic, so the
     manifest parity assertion must exclude it.
  4. `ready_node` is missing from `src/pipeline/stages/__init__.py`'s imports and `__all__`
     even though the other five nodes are exported. `src/worker.py` sidesteps this by
     importing every node from its module. All six stages exist; only the package re-export
     is incomplete.

  ### Posts chosen

  Two specs are pinned in the script, both using values verified against
  `web/src/app/posts/new/page.tsx:37-49`:

  | slug | article_type | output_format | internal links |
  | --- | --- | --- | --- |
  | `how-to-choose-a-crm-for-a-small-team` | `how-to` | `markdown` | 3 (exercises the edit-stage links block) |
  | `best-time-tracking-tools-for-agencies` | `listicle` | `nextjs` | 0 |

  State is built by passing a transient (never-flushed) `Post` ORM instance through the real
  `state_from_post()`, so no rows are written and no `user_id` / BetterAuth fixture is
  needed. `settings.media_dir` is redirected under the output directory, so a capture run
  never dirties the repo's `media/`.

- [x] 0.4b Live capture for `how-to-choose-a-crm-for-a-small-team` (all six stages) with real
  provider keys. Commit `docs/mastra-port/golden/how-to-choose-a-crm-for-a-small-team/*.json`
  and the generated images. Record the run's token usage and cost in this ledger.

  Keys sourced from the main checkout's gitignored `.env` (this worktree has none):

  ```sh
  cd api && set -a && . /Users/cody/Documents/code/jena-ai/.env && set +a \
    && uv run python scripts/capture_golden.py --out ../docs/mastra-port/golden \
       --post how-to-choose-a-crm-for-a-small-team
  ```

  ```
  [how-to-choose-a-crm-for-a-small-team] research: running
  [how-to-choose-a-crm-for-a-small-team] research: wrote .../research.json (68563 bytes)
  [how-to-choose-a-crm-for-a-small-team] outline: running
  [how-to-choose-a-crm-for-a-small-team] outline: wrote .../outline.json (115274 bytes)
  [how-to-choose-a-crm-for-a-small-team] write: running
  [how-to-choose-a-crm-for-a-small-team] write: wrote .../write.json (114402 bytes)
  [how-to-choose-a-crm-for-a-small-team] edit: running
  Dead link (404): https://example.com/blog/sales-pipeline-basics
  Dead link (404): https://example.com/pricing
  Dead link (404): https://example.com/blog/crm-data-hygiene
  [how-to-choose-a-crm-for-a-small-team] edit: wrote .../edit.json (161899 bytes)
  [how-to-choose-a-crm-for-a-small-team] images: running
  [how-to-choose-a-crm-for-a-small-team] images: wrote .../images.json (185217 bytes)
  [how-to-choose-a-crm-for-a-small-team] ready: running
  [how-to-choose-a-crm-for-a-small-team] ready: wrote .../ready.json (155739 bytes)

  Wrote 6 fixture file(s) under .../docs/mastra-port/golden
  ```

  ### Recorded usage (from each fixture's `stage_output._stage_meta`)

  ```
  stage       bytes calls  err model                                       in     out    sec
  research    68563     1    0 sonar-pro                                 1510    4635   37.0
  outline    115274     1    0 claude-opus-4-6                           7092    4214  103.6
  write      114402     1    0 claude-opus-4-6                           5542    3423   90.1
  edit       161899     1    0 claude-opus-4-6                           8457    5953  135.7
  images     185217     6    5 claude-opus-4-6                           6994    3037   68.3
  ready      155739     1    0 claude-opus-4-6                           5222    2967   83.6
  TOTAL tokens_in 34817 tokens_out 24229
  ```

  Cost for this article at verified list prices:

  | provider | model | $/Mtok in | $/Mtok out | tokens in | tokens out | cost |
  | --- | --- | --- | --- | --- | --- | --- |
  | Perplexity | `sonar-pro` | 3 | 15 | 1510 | 4635 | $0.074 |
  | Anthropic | `claude-opus-4-6` | 5 | 25 | 33307 | 19594 | $0.656 |
  | | | | | | **total** | **$0.73** |

  Price sources, both checked 2026-08-21: Perplexity from
  https://docs.perplexity.ai/getting-started/pricing (`sonar-pro` `"input": 3`,
  `"output": 15`, "$ per 1,000,000 tokens"); Anthropic from the bundled `claude-api`
  skill's model table (`claude-opus-4-6`, $5.00 in / $25.00 out per 1M, table cached
  2026-06-24). Excluded from the total: Perplexity's separate per-request search fee, and
  all image generation, because no images were produced (see below). **~$0.73 per article**
  is the Phase 5 cost baseline any model upgrade is measured against.

  ### Blocker recorded honestly: no images were generated

  All five Gemini calls returned HTTP 429 on this API key. The key has **zero** free-tier
  image quota, so this is a provider account limit and not a code fault:

  ```
  Failed to generate image 0: 429 RESOURCE_EXHAUSTED. {'error': {'code': 429, 'message':
  'You exceeded your current quota, please check your plan and billing details. ...
  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests,
    limit: 0, model: gemini-3.1-flash-image ...
  ```

  Consequences and what was captured instead:

  - `images.json` holds the full Claude manifest (5 image specs with prompts, placements,
    alt text, aspect ratios and sizes) and all **5 Gemini request payloads** with their
    exact `model` / `contents` / `config` parameters plus the 429 error, so the Phase 3.5
    prompt-parity gate has its oracle. Only the returned image bytes are missing.
  - `image_manifest` records `total_generated: 0, total_failed: 5` and the stage still
    reports `images: complete`, which is itself the Python behaviour the port must match.
  - No `.webp` files exist to commit. Phase 5's images model verification (section 5 of the
    objective) must first resolve billing on the Gemini key.

  ### Defect found and fixed while capturing: `_parse_manifest` could not read a real response

  The first live run returned `{"images": [], "style_brief": {}, "error": "Failed to parse
  manifest"}`. Claude wraps the manifest in a ```json fence **and appends commentary after
  the closing fence** ("You can review and edit the prompts before generation ... Proceed?").
  The old parser stripped every line starting with a fence and then `json.loads`d the whole
  remainder including the prose, so it failed every time. This is a production bug, not a
  harness bug: the images stage would fail this way on any run where Claude adds a closing
  remark. Regression test written first and confirmed failing for the right reason:

  ```
  $ cd api && uv run pytest tests/phase3/test_images_stage.py -q -k trailing_prose
  E         Left contains 1 more item:
  E         {'error': 'Failed to parse manifest'}
  FAILED tests/phase3/test_images_stage.py::TestParseManifest::test_strips_code_fences_with_trailing_prose
  1 failed, 10 deselected in 0.07s
  ```

  After the fix (`_FENCED_BLOCK` regex takes the first fenced block, with an
  outermost-`{`..`}` fallback):

  ```
  $ cd api && uv run pytest tests/phase3/test_images_stage.py -q
  ...........                                                              [100%]
  11 passed in 0.14s
  ```

  ### Harness changes needed for live mode (both verified by `--dry-run` before spending)

  1. **Blob elision.** Gemini responses embed the generated image as base64, and
     `_serialize` reaches it through pydantic `model_dump_json`, so a successful images
     fixture would have been tens of megabytes. `_elide_blobs` now replaces any
     `data`/`inline_data`/`b64_json`/`image_bytes` string over 1 KiB, and any string over
     200 000 chars, with `{"__elided_blob__": true, "length": n, "sha256": ...}`. Rendered
     prompts are untouched.
  2. **Failed calls are recorded.** The wrappers previously let a provider exception
     propagate before `rec.record`, which is why the first post-fix run captured zero Gemini
     calls despite issuing five. `Recorder.record_error` now stores the request payload and
     the exception, then re-raises. This is what makes the 429 run useful rather than empty.

  ### Gates after the change

  ```
  $ cd api && uv run ruff check .
  Found 32 errors.
  exit=1
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 118 files already formatted
  exit=1
  $ docker compose up -d db redis
  $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test uv run pytest -q
  125 failed, 236 passed, 25 errors in 15.87s
  exit=1
  ```

  Both ruff gates match the 0.1 baseline exactly. pytest is 125 failed / 25 errors as at
  baseline with **236 passed, one more than the 235 baseline**: the new regression test.

  ### Secret check on the committed fixtures

  ```
  $ for k in "$PERPLEXITY_API_KEY" "$ANTHROPIC_API_KEY" "$GEMINI_API_KEY" \
             "$WP_ENCRYPTION_KEY" "$BETTER_AUTH_SECRET"; do
      grep -rlF "$k" docs/mastra-port/golden/; done | wc -l
  0
  $ grep -rlE "sk-ant-|pplx-|AIzaSy" docs/mastra-port/golden/ | wc -l
  0
  ```
- [ ] 0.4c Live capture for `best-time-tracking-tools-for-agencies` (all six stages). Commit
  its fixtures, then check 0.4.

## Phase 1: TypeScript data layer

- [ ] 1.1 Introspect the live database and define the full schema in TypeScript (Drizzle
  recommended; justify any other choice here). Must cover every table and column produced by
  Alembic 001-011, including `posts.stage_logs`, `execution_logs`, `stage_status`,
  `stage_settings`, `image_manifest` (JSONB), the WordPress fields, the Next.js publishing
  fields, and the `user_id` multi-tenancy column. Do not create a second database or a
  migration that recreates tables.
- [ ] 1.2 Write a schema-parity check that fails if any table or column known to Alembic is
  missing from the TS schema, or vice versa.
- [ ] 1.3 Port `api/src/services/crypto.py` to TypeScript and prove with a test that a value
  encrypted by the Python implementation decrypts correctly in TypeScript.
- [ ] 1.4 A TS script reads and writes a Post round-trip against the real dev database.

## Phase 2: Mastra scaffold

- [ ] 2.1 Install Mastra, the Postgres storage adapter, and `@mastra/redis-streams` in `web/`.
  Record installed versions and any API discrepancies against the objective's description.
- [ ] 2.2 Configure `web/src/mastra/index.ts`: Postgres storage against the existing
  `content_pipeline` database, `RedisStreamsPubSub` against the existing Redis, and a logger.
  Keep it importable without `next/*`.
- [ ] 2.3 Define one trivial two-step workflow. Test executes it, asserts
  `stream.status === 'success'`, asserts the emitted event types, and asserts the run row is
  present in Postgres storage.
- [ ] 2.4 A second process subscribed to the Redis Streams topic receives the same events.
- [ ] 2.5 Mastra Studio connects to the dev server and lists the trivial workflow. Paste the
  command and a committed screenshot path.

## Phase 3: Port the six stages (one per iteration)

Each: Mastra agent + step, Zod `inputSchema`/`outputSchema` (no `z.any()`, no untyped
passthrough), prompt assembled from `rules/blog-<stage>.md` plus post/profile fields matching
the Python assembly, output written to the same Post column via `STAGE_CONTENT_MAP`
immediately on completion. Parity test asserts the rendered prompt matches the
Python-rendered prompt (whitespace normalized only) and the output validates against
`outputSchema`.

- [ ] 3.1 `research`
- [ ] 3.2 `outline`
- [ ] 3.3 `write`
- [ ] 3.4 `edit`
- [ ] 3.5 `images` (identical `image_manifest` JSONB shape; `.foreach()` for per-image generation)
- [ ] 3.6 `ready`

## Phase 4: Workflow assembly, gates, durable execution

- [ ] 4.1 Compose the six steps into one workflow with `.then()` / `.commit()`, registered on
  the Mastra instance.
- [ ] 4.2 Support running a single stage in isolation and running all remaining stages from the
  current one, matching `_run_pipeline()`'s `stages` and `check_gates` behavior.
- [ ] 4.3 Review gates via `suspend()` / `resume()` with typed `suspendSchema` / `resumeSchema`.
  Suspend/resume test passes.
- [ ] 4.4 Execution moves to the `worker` process: `web` starts a run and returns immediately,
  the worker consumes the event off Redis Streams and executes the steps. Prove restarting
  `web` does not disturb an in-flight pipeline.
- [ ] 4.5 **Durability gate.** Kill the worker mid-`write`, restart it, and have the run resume
  from the last completed stage without re-running completed stages or duplicating writes.
  Record the outcome and the chosen workflow runner here. On failure: first add a worker
  startup sweep that resumes interrupted runs from storage; only if that still fails, adopt
  `@mastra/inngest` and record which guarantee failed. Never `@mastra/temporal`, never a
  second job queue.
- [ ] 4.6 Concurrency: two pipelines at once must not interleave writes to the same Post row or
  exhaust connections. Test passes.
- [ ] 4.7 Full workflow runs end to end against the real database.

## Phase 5: Route handlers (one router per iteration)

Contract is `web/src/lib/api.ts`; request/response shapes stay identical, or `api.ts` and every
caller change in the same iteration. Every handler scopes by the authenticated user
(Alembic 010 `user_id`). Per router, port its pytest coverage to vitest; do not delete a pytest
file until the TypeScript equivalent passes. Exit per router: TS tests pass and the dashboard
pages that use it work with the Python API stopped.

- [ ] 5.1 `settings`
- [ ] 5.2 `profiles`
- [ ] 5.3 `posts`
- [ ] 5.4 `queue`
- [ ] 5.5 `events` (SSE keeps `web/src/hooks/use-sse.ts`'s existing message shape; sourced from
  the Redis Streams pub/sub topic, not an in-process stream; uses Mastra resumable-stream
  replay; test disconnects and reconnects mid-run and asserts no gap in the event sequence)
- [ ] 5.6 `rules`
- [ ] 5.7 `links`
- [ ] 5.8 `analytics`
- [ ] 5.9 `wordpress`
- [ ] 5.10 `nextjs` (HMAC signing from `hmac_signing.py` and the webhook contract with
  `packages/create-mdx-blog` preserved exactly)

`auth` is out of scope; BetterAuth already owns it.

## Phase 6: Runtime model configuration

- [ ] 6.1 Verify the model ID for each of the six stages against live provider documentation and
  a real minimal API call. Record per stage: chosen ID, verification date, source, one-sentence
  rationale, and the pasted live response's reported model field. Keep the incumbent and say why
  if nothing better can be verified. Note any per-article cost delta.
- [ ] 6.2 Extend the `api_settings`-backed settings pattern so each stage has a configurable
  model and, where supported, a reasoning/effort setting, persisted per user, validated on write
  against the allowlist from 6.1, falling back to the verified hardcoded defaults when unset.
- [ ] 6.3 Settings UI: table of six stages with model and effort selectors, current effective
  value plus default-or-override indicator, save and revert-to-default per stage, real provider
  errors surfaced rather than silent fallback.
- [ ] 6.4 Test asserts that changing a stage's model in the UI changes the model in the outbound
  provider request payload.

## Phase 7: Cutover

- [ ] 7.1 Delete `api/`. Remove the Python `api` and `worker` services from
  `docker-compose.yml` and `docker-compose.prod.yml` and replace them with the TypeScript
  `worker` service. Keep `db` and `redis`.
- [ ] 7.2 Railway deployment configuration for `web` and `worker` from this repo, with start
  commands, shared Postgres and Redis references, and documented per-service environment
  variables. Both import the same `web/src/mastra/index.ts`.
- [ ] 7.3 Document the Mastra Studio workflow: running it locally alongside `next dev` against
  the same Postgres, `server.studioBase` if a custom mount path is used, and an explicit
  statement that Studio is never publicly exposed (auth or private network only).
- [ ] 7.4 Update `CLAUDE.md`, `README.md`, and `.env` documentation to the new architecture,
  commands, and env vars. Every command listed must be one actually run successfully.
- [ ] 7.5 Move `rules/` handling and any remaining assets that lived under `api/`.
- [ ] 7.6 `docker-compose up` brings up a working stack and a post goes from creation to `ready`
  with images through the UI, executing in the worker service.
- [ ] 7.7 `grep -rn "alembic\|arq\|fastapi\|uvicorn"` returns nothing outside
  `docs/mastra-port/` and git history. Paste the empty result.

## Phase 8: UI/UX (one screen per iteration)

Keep the existing shadcn/Tailwind v4 foundation. Verification is committed before/after
screenshots via `npx -y chrome-devtools-axi` into
`docs/mastra-port/ui/<iteration>-<screen>-{before,after}.png`, plus a clean
`chrome-devtools-axi console`. Stop the bridge at the end of every iteration.

- [ ] 8.1 Run trace view on `posts/[id]`: live per-step status, elapsed time, token counts and
  estimated cost from Mastra stream events and `stream.usage`; retries, suspensions and failures
  shown with their error text.
- [ ] 8.2 `/` (dashboard home): loading, empty, error, success states.
- [ ] 8.3 `/posts/[id]`: four states, plus visual hierarchy and spacing pass.
- [ ] 8.4 posts list: four states, plus visual hierarchy and spacing pass.
- [ ] 8.5 `/posts/new` and `/posts/batch`: four states.
- [ ] 8.6 `/profiles` and `/profiles/[id]`: four states.
- [ ] 8.7 `/settings`: four states, plus visual hierarchy and spacing pass.
- [ ] 8.8 `/monitor`: four states.
- [ ] 8.9 Keyboard and a11y pass across the touched screens: focus-visible on all interactive
  elements, labelled form controls, no keyboard traps, dialogs return focus on close.
- [ ] 8.10 Dark mode correct on every screen touched in Phase 8.

## Phase 9: Final verification

- [ ] 9.1 Full green run of every gate command, pasted.
- [ ] 9.2 This ledger fully checked with evidence under every item.
- [ ] 9.3 `docs/mastra-port/SUMMARY.md`: what changed, the new architecture, the model choices
  and why, what is not covered by tests, every known limitation, and which workflow runner was
  chosen and why.
