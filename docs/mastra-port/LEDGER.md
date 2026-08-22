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
- [x] 0.4 Capture golden fixtures: run the existing Python pipeline end to end on at least 2
  representative posts with different `article_type` and `output_format`. For each stage
  save the fully rendered prompt, the provider request parameters, and the raw output to
  `docs/mastra-port/golden/<post-slug>/<stage>.json`. Redact API keys. Exit: >= 12 fixture
  files committed.

  **Split.** 0.4 needs a capture harness, then two live provider runs that cost real money
  and take real time, so it is split into 0.4a (harness, no provider spend), 0.4b (live run
  for post 1) and 0.4c (live run for post 2). 0.4 is checked only when 0.4a-0.4c are all
  checked and >= 12 fixture files are committed.

  **Done.** 0.4a, 0.4b and 0.4c are all checked and 12 fixture files are committed, two
  posts x six stages, with different `article_type` / `output_format`
  (`how-to`/`markdown` and `listicle`/`nextjs`):

  ```sh
  $ ls -l docs/mastra-port/golden/*/*.json | awk '{print $5, $9}'
  183447 docs/mastra-port/golden/best-time-tracking-tools-for-agencies/edit.json
  219810 docs/mastra-port/golden/best-time-tracking-tools-for-agencies/images.json
  121857 docs/mastra-port/golden/best-time-tracking-tools-for-agencies/outline.json
  186373 docs/mastra-port/golden/best-time-tracking-tools-for-agencies/ready.json
  71788 docs/mastra-port/golden/best-time-tracking-tools-for-agencies/research.json
  123643 docs/mastra-port/golden/best-time-tracking-tools-for-agencies/write.json
  161899 docs/mastra-port/golden/how-to-choose-a-crm-for-a-small-team/edit.json
  185217 docs/mastra-port/golden/how-to-choose-a-crm-for-a-small-team/images.json
  115274 docs/mastra-port/golden/how-to-choose-a-crm-for-a-small-team/outline.json
  155739 docs/mastra-port/golden/how-to-choose-a-crm-for-a-small-team/ready.json
  68563 docs/mastra-port/golden/how-to-choose-a-crm-for-a-small-team/research.json
  114402 docs/mastra-port/golden/how-to-choose-a-crm-for-a-small-team/write.json
  $ ls docs/mastra-port/golden/*/*.json | wc -l
  12
  ```

  **Known gap in the oracle.** Not one image was generated across either post: the Gemini
  key returns 429 `limit: 0` for `gemini-3.1-flash-image` on every request. Both `images`
  fixtures therefore record a real, fully parsed `image_manifest` with 6 prompts,
  `total_generated: 0` and `total_failed: 6`, plus the real outbound Gemini request
  parameters and the 429 responses. That is enough to build the Phase 3 prompt-parity and
  manifest-shape tests against, but there is no golden image binary and no successful Gemini
  response body to compare against. Unblocking it needs Google billing, not code. See
  `todo.md`.

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
- [x] 0.4c Live capture for `best-time-tracking-tools-for-agencies` (all six stages). Commit
  its fixtures, then check 0.4.

  Done via 0.4c-i (resumable harness plus the live `research.json`) and 0.4c-ii (the
  remaining five stages). All six fixtures for this post are committed; evidence under those
  two sub-items.

  **Split.** A full six-stage live capture is a ~10 minute uninterrupted run and two
  attempts have now been cut off partway, discarding provider spend on the stages that had
  already succeeded, because the harness always restarted from `research`. 0.4c is split
  into 0.4c-i (make the harness resumable, no provider spend beyond what is already on
  disk) and 0.4c-ii (capture the remaining stages). 0.4c is checked when both are done.

- [x] 0.4c-i Make `capture_golden.py` resumable so an interrupted capture can be finished
  without re-paying for completed stages, and commit the one stage fixture already captured
  live for this post (`research.json`, 71788 bytes, `sonar-pro`, 1475 in / 5489 out,
  37.5s).

  `--resume` reuses any stage fixture already on disk, replaying its saved `stage_output`
  into the running state (including `_stage_meta`, which the live path also leaves in
  state) instead of re-issuing the provider call.

  Verified against the real `research.json` with the network stubbed, so the skip path is
  exercised on a genuine live fixture without spending:

  ```sh
  mkdir -p /tmp/golden-resume/best-time-tracking-tools-for-agencies
  cp docs/mastra-port/golden/best-time-tracking-tools-for-agencies/research.json \
     /tmp/golden-resume/best-time-tracking-tools-for-agencies/
  cd api && uv run python scripts/capture_golden.py --dry-run --resume \
     --out /tmp/golden-resume --post best-time-tracking-tools-for-agencies
  ```

  ```
  [best-time-tracking-tools-for-agencies] research: skipped, reusing /private/tmp/golden-resume/best-time-tracking-tools-for-agencies/research.json
  [best-time-tracking-tools-for-agencies] outline: wrote .../outline.json (86648 bytes)
  [best-time-tracking-tools-for-agencies] write: wrote .../write.json (41600 bytes)
  [best-time-tracking-tools-for-agencies] edit: wrote .../edit.json (63458 bytes)
  [best-time-tracking-tools-for-agencies] images: wrote .../images.json (59428 bytes)
  [best-time-tracking-tools-for-agencies] ready: wrote .../ready.json (40634 bytes)
  Wrote 5 fixture file(s) under /private/tmp/golden-resume
  ```

  The replayed state is byte-identical to what an uninterrupted run would have fed the next
  stage, and the research document really does reach the outline prompt:

  ```
  research chars in resumed outline state_input: 22005
  matches live research output exactly: True
  _stage_meta carried: {'stage': 'research', 'model': 'sonar-pro', 'tokens_in': 1475, 'tokens_out': 5489, 'duration_s': 37.51096874999348}
  research text present in outline prompt: True
  ```

  Gates after the change, both identical to the 0.1 baseline (the touched file itself is
  already correctly formatted):

  ```
  $ cd api && uv run ruff check .
  Found 32 errors.
  exit=1
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 118 files already formatted
  exit=1
  $ cd api && uv run ruff format --check scripts/capture_golden.py
  1 file already formatted
  exit=0
  ```

  Not run this iteration: `pytest`. The change is confined to `api/scripts/`, which no test
  imports (`grep -rn "capture_golden" api/tests/` is empty), and the last recorded pytest
  result stands at 125 failed / 236 passed / 25 errors.

- [x] 0.4c-ii Capture the remaining five stages (`outline`, `write`, `edit`, `images`,
  `ready`) for `best-time-tracking-tools-for-agencies` with real keys, using `--resume`.
  Record usage and cost, commit the fixtures, then check 0.4c and 0.4.

  ```sh
  cd api && set -a && . /Users/cody/Documents/code/jena-ai/.env && set +a \
    && uv run python scripts/capture_golden.py --out ../docs/mastra-port/golden \
       --post best-time-tracking-tools-for-agencies --resume
  ```

  Real output (Gemini 429 bodies elided to one line each; the full text is identical to the
  quota block already recorded under 0.4b):

  ```
  [best-time-tracking-tools-for-agencies] research: skipped, reusing .../golden/best-time-tracking-tools-for-agencies/research.json
  [best-time-tracking-tools-for-agencies] outline: running
  [best-time-tracking-tools-for-agencies] outline: wrote .../outline.json (121857 bytes)
  [best-time-tracking-tools-for-agencies] write: running
  [best-time-tracking-tools-for-agencies] write: wrote .../write.json (123643 bytes)
  [best-time-tracking-tools-for-agencies] edit: running
  [best-time-tracking-tools-for-agencies] edit: wrote .../edit.json (183447 bytes)
  [best-time-tracking-tools-for-agencies] images: running
  Failed to generate image 2: 429 RESOURCE_EXHAUSTED. ... limit: 0, model: gemini-3.1-flash-image ...
  Failed to generate image 1: 429 RESOURCE_EXHAUSTED. ... limit: 0, model: gemini-3.1-flash-image ...
  Failed to generate image 0: 429 RESOURCE_EXHAUSTED. ... limit: 0, model: gemini-3.1-flash-image ...
  Failed to generate image 4: 429 RESOURCE_EXHAUSTED. ... limit: 0, model: gemini-3.1-flash-image ...
  Failed to generate image 3: 429 RESOURCE_EXHAUSTED. ... limit: 0, model: gemini-3.1-flash-image ...
  Failed to generate image 5: 429 RESOURCE_EXHAUSTED. ... limit: 0, model: gemini-3.1-flash-image ...
  [best-time-tracking-tools-for-agencies] images: wrote .../images.json (219810 bytes)
  [best-time-tracking-tools-for-agencies] ready: running
  [best-time-tracking-tools-for-agencies] ready: wrote .../ready.json (186373 bytes)

  Wrote 5 fixture file(s) under .../docs/mastra-port/golden
  exit=0
  ```

  `research` was reused from disk, so the resume path cost nothing for it and the five
  remaining stages ran live exactly once. Usage, read from each fixture's
  `stage_output._stage_meta`:

  | stage | model | tokens in | tokens out | duration s | provider calls |
  |---|---|---:|---:|---:|---:|
  | research | `sonar-pro` | 1475 | 5489 | 37.5 | 1 |
  | outline | `claude-opus-4-6` | 7892 | 4201 | 95.7 | 1 |
  | write | `claude-opus-4-6` | 5429 | 4085 | 102.9 | 1 |
  | edit | `claude-opus-4-6` | 8952 | 7002 | 161.8 | 1 |
  | images | `claude-opus-4-6` | 8027 | 4077 | 91.9 | 7 |
  | ready | `claude-opus-4-6` | 6295 | 3725 | 104.4 | 1 |
  | **total** | | **38070** | **28579** | **594.2** | |

  The `images` row counts only the Claude manifest call; its other 6 provider calls are the
  Gemini image attempts, all of which failed with 429 and consumed no tokens.

  Cost for this article: Perplexity reports it directly in the response body
  (`usage.cost.total_cost` = **$0.09276**, which includes the $6/1000 request fee on top of
  $3/$15 per Mtok). Anthropic at the $5.00/$25.00 per Mtok list price already verified under
  0.4b: 36595 in / 23090 out = **$0.7602**. Article total **$0.8530** with zero images
  generated. Post 1 was $0.73, so the two live articles bracket roughly $0.73-$0.85 in text
  generation, and the images stage's true cost is still unmeasured.

  Verified after the run:

  ```sh
  $ ls docs/mastra-port/golden/*/*.json | wc -l
  12
  $ python3 -c "import json;d=json.load(open('docs/mastra-port/golden/best-time-tracking-tools-for-agencies/images.json'));m=d['stage_output']['image_manifest'];print(len(m['images']),m['total_generated'],m['total_failed'])"
  6 0 6
  $ python3 -c "import json;d=json.load(open('docs/mastra-port/golden/best-time-tracking-tools-for-agencies/images.json'));print(json.dumps(d['stage_output']['stage_status']))"
  {"research": "complete", "outline": "complete", "write": "complete", "edit": "complete", "images": "complete"}
  $ grep -rlE "sk-ant-|pplx-|AIzaSy" docs/mastra-port/golden/ | wc -l
  0
  ```

  The live API key values from `.env` were also grepped for literally across the new fixture
  directory and matched 0 files each for `PERPLEXITY_API_KEY`, `ANTHROPIC_API_KEY` and
  `GEMINI_API_KEY`; the fixtures carry 6 `REDACTED` markers in their place.

  The 0.4b manifest-parsing fix held on fresh live output: `_parse_manifest` produced a
  complete 6-image manifest with `style_brief`, so the images stage reached
  `stage_status.images = complete` rather than failing empty.

  No source files changed this iteration (only fixtures and this ledger), so no code gate
  was re-run; the standing results are pytest 125 failed / 236 passed / 25 errors, `ruff
  check` and `ruff format --check` clean, and the frontend gates at the 0.2 baseline.

## Phase 1: TypeScript data layer

- [x] 1.1 Introspect the live database and define the full schema in TypeScript (Drizzle
  recommended; justify any other choice here). Must cover every table and column produced by
  Alembic 001-011, including `posts.stage_logs`, `execution_logs`, `stage_status`,
  `stage_settings`, `image_manifest` (JSONB), the WordPress fields, the Next.js publishing
  fields, and the `user_id` multi-tenancy column. Do not create a second database or a
  migration that recreates tables.

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
- [x] 1.2 Write a schema-parity check that fails if any table or column known to Alembic is
  missing from the TS schema, or vice versa.

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
- [x] 1.3 Port `api/src/services/crypto.py` to TypeScript and prove with a test that a value
  encrypted by the Python implementation decrypts correctly in TypeScript.

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
- [x] 1.4 A TS script reads and writes a Post round-trip against the real dev database.

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

## Phase 2: Mastra scaffold

- [x] 2.1 Install Mastra, the Postgres storage adapter, and `@mastra/redis-streams` in `web/`.
  Record installed versions and any API discrepancies against the objective's description.

  **Installed (exact-pinned, no caret, so the port cannot silently drift mid-phase):**

  ```
  $ cd web && pnpm add @mastra/core@1.61.0 @mastra/pg@1.21.1 \
      @mastra/redis-streams@0.4.0 @mastra/loggers@1.2.0 zod
  Packages: +101 -12
  dependencies:
  + @mastra/core 1.61.0
  + @mastra/loggers 1.2.0
  + @mastra/pg 1.21.1
  + @mastra/redis-streams 0.4.0
  + zod 4.4.3
  Done in 3.2s using pnpm v10.26.2

  $ cd web && pnpm add -D mastra@1.26.0
   WARN  Issues with peer dependencies found
  .
  └─┬ mastra 1.26.0
    └─┬ @mastra/deployer 1.61.0
      └─┬ @hono/node-ws 1.3.1
        └── ✕ unmet peer @hono/node-server@^1.19.11: found 1.19.9
  devDependencies:
  + mastra 1.26.0
  Done in 3.8s using pnpm v10.26.2
  ```

  Resolved versions read back out of `node_modules`:

  ```
  $ cd web && node -e "for (const p of ['@mastra/core','@mastra/pg','@mastra/redis-streams','@mastra/loggers','mastra','zod','pg']) console.log(p, require('./node_modules/'+p+'/package.json').version)"
  @mastra/core 1.61.0
  @mastra/pg 1.21.1
  @mastra/redis-streams 0.4.0
  @mastra/loggers 1.2.0
  mastra 1.26.0
  zod 4.4.3
  pg 8.20.0

  $ cd web && pnpm exec mastra --version
  1.26.0
  ```

  `zod` was not previously a direct dependency of `web/`; `@mastra/core` declares it as a peer
  (`^3.25.0 || ^4.0.0`), so it is now direct at 4.4.3. Three zod copies coexist in the store
  (`zod@3.25.76`, `zod@4.3.6`, `zod@4.4.3`) because other packages pin their own; only 4.4.3 is
  hoisted to `web/node_modules/zod`, which is what step schemas will compile against.
  `@mastra/loggers` was added beyond the three named in this item because the Mastra instance in
  2.2 requires a logger and `PinoLogger` lives there.

  **Runtime symbol check** (imports actually resolve, not just typings). Scratch file run from
  inside `web/` and deleted afterwards:

  ```
  $ cd web && node ./mastra-smoke.scratch.mjs
  ok      @mastra/core -> Mastra (function)
  ok      @mastra/core/workflows -> createWorkflow (function)
  ok      @mastra/core/workflows -> createStep (function)
  ok      @mastra/core/workflows -> createWorkflowStateReader (function)
  ok      @mastra/pg -> PostgresStore (function)
  ok      @mastra/redis-streams -> RedisStreamsPubSub (function)
  ok      @mastra/loggers -> PinoLogger (function)
  exit=0
  ```

  **API surface confirmed against the installed `.d.ts` files** (every symbol the objective's
  section 2 names exists):

  - `createWorkflow` / `createStep` / `createWorkflowStateReader`, all re-exported from
    `@mastra/core/workflows` (`dist/workflows/create.d.ts:24`, `dist/workflows/workflow.d.ts:62`,
    `dist/workflows/state-reader.d.ts:32`).
  - Workflow control flow: `.then()` (`workflow.d.ts:214`), `.parallel()` (`:320`),
    `.branch()` (`:325`), `.foreach()` (`:337`), `.commit()` (`:348`),
    `.getWorkflowRunById()` (`:424`). `.dowhile()` / `.dountil()` also exist (`:331`, `:334`).
  - `run.resume({ step, resumeData })` (`workflow.d.ts:669`) matches the documented shape;
    `step` accepts a `Step`, an array of steps, a string id, or an array of string ids.
  - `run.stream()` returns `WorkflowRunOutput` (`dist/stream/RunOutput.d.ts:7`) with
    `get status(): WorkflowRunStatus`, `get result(): Promise<TResult>` and
    `get usage(): Promise<LanguageModelV2Usage>`.
  - `stream.usage` resolves to exactly the shape the objective states:
    `inputTokens`, `outputTokens`, `totalTokens` (each `number | undefined`) plus optional
    `reasoningTokens` and `cachedInputTokens`
    (`dist/_types/@internal_ai-sdk-v5/dist/index.d.ts:4390-4408`). Phase 8's cost view can be
    driven from it directly.
  - Stream event type literals are exactly `workflow-start`, `workflow-step-start`,
    `workflow-step-output`, `workflow-step-result`, `workflow-finish`
    (`dist/stream/types.d.ts:933,958,994,1012,938`).
  - `new Mastra({ ... })` accepts `agents`, `workflows`, `storage`, `logger` and `pubsub`
    (`dist/mastra/index.d.ts:84,106,91,102,213`). `storage` is typed `MastraCompositeStore` and
    `PostgresStore extends MastraCompositeStore`
    (`@mastra/pg/dist/storage/index.d.ts:67`), so the Postgres adapter drops straight in.
  - `RedisStreamsPubSub` is a class in `@mastra/redis-streams`
    (`dist/index.d.ts:73`), `extends PubSub implements LeaseProvider`, matching the `pubsub`
    slot on the Mastra config.

  **Discrepancies against the objective's description, to carry into 2.2-2.4 and Phase 8:**

  1. `run.stream()`'s return value is async-iterable, but `[Symbol.asyncIterator]()` on it is
     marked `@deprecated` in favour of `stream.fullStream`
     (`dist/stream/RunOutput.d.ts:63-77`). `cancel()`, `getReader()`, `tee()`, `pipeTo()` and
     `pipeThrough()` on the object itself are deprecated the same way. Consume `fullStream`, not
     the object, or every Phase 8 stream reader ships a deprecation.
  2. `stream.status` is a **synchronous getter**, not a promise. Item 2.3's
     `stream.status === 'success'` assertion is only meaningful after the stream has been drained
     or `await stream.result` has settled; asserting it immediately after calling `stream()` would
     read the in-flight status.
  3. The engine entry point for cross-process execution is `createEventedWorkflow`
     (`dist/workflows/create.d.ts:31`), a sibling of `createWorkflow` the objective does not
     mention, and there is a separate `@mastra/core/workflows/evented` export path. Phase 4's
     "worker consumes the event off Redis Streams" almost certainly runs through this rather than
     through plain `createWorkflow`; 2.3 should build the trivial workflow with the plain
     constructor and 4.4 should re-check which constructor the evented path requires.
  4. Runs are created with `workflow.createRun()` (`workflow.d.ts:359`), not `createRunAsync()`.
  5. `@mastra/pg` exports storage under a single root entry (`"exports": { ".", "./package.json" }`).
     There is no `@mastra/pg/storage` subpath; import `PostgresStore` from `@mastra/pg`.
  6. The `mastra` CLI's own dependency tree has an unmet peer
     (`@hono/node-ws@1.3.1` wants `@hono/node-server@^1.19.11`, tree has `1.19.9`). It is internal
     to `@mastra/deployer` and `pnpm exec mastra --version` works, but if `mastra dev` fails to
     boot its server in 2.5, this is the first thing to check.
  7. `@mastra/core`, `@mastra/pg`, `@mastra/redis-streams` and `@mastra/loggers` all declare
     `engines.node >= 22.13.0`. This machine runs v24.12.0, and the Railway services in 7.2 must
     pin a Node major at or above 22.13.

  **Gates after install** (all four unchanged against the established baseline; run with
  `docker compose up -d db redis` first, since `pnpm test` needs the live database):

  ```
  $ cd web && pnpm exec tsc --noEmit
  tsc exit=0

  $ cd web && pnpm lint
  > content-pipeline-dashboard@0.1.0 lint
  > eslint
  lint exit=0

  $ cd web && NO_COLOR=1 pnpm test
   Test Files  2 failed | 17 passed (19)
        Tests  9 failed | 221 passed (230)
     Duration  5.70s
  test exit=1

  $ cd web && pnpm build
  ✓ Compiled successfully in 3.2s
  ✓ Generating static pages using 15 workers (25/25) in 327.9ms
  build exit=0
  ```

  The 9 failures are the established pre-existing baseline (6 in `image-preview.test.tsx` plus
  3 others recorded in 0.1); pass count held at 221, so the install added no failure. No `api/`
  file was touched, so the pytest and ruff baselines are unchanged by construction.
- [x] 2.2 Configure `web/src/mastra/index.ts`: Postgres storage against the existing
  `content_pipeline` database, `RedisStreamsPubSub` against the existing Redis, and a logger.
  Keep it importable without `next/*`.

  **What was built**

  - `web/src/mastra/index.ts` exports `logger` (`PinoLogger`), `storage` (`PostgresStore`),
    `pubsub` (`RedisStreamsPubSub`) and `mastra` (`new Mastra({ storage, pubsub, logger })`).
    `workflows` and `agents` are registered empty; 2.3 adds the trivial workflow and Phase 3
    registers the six stages.
  - `storage` is constructed with `{ id: 'content-pipeline', pool: getPool() }`, reusing the one
    `pg.Pool` from `web/src/db/index.ts` rather than opening a second one. Rationale: one
    connection budget per process instead of two (Phase 4.6 has to reason about exactly this),
    and `PostgresStore.close()` explicitly does not close a pool it did not create
    (`@mastra/pg/dist/storage/index.d.ts:89-93`), so `closeDb()` stays the single teardown.
  - `pubsub` is constructed with `{ url: process.env.REDIS_URL }`. No `keyPrefix` /
    `maxStreamLength` / reclaim overrides: the defaults are what the package ships and nothing in
    this item justifies deviating from them.
  - `redisUrl()` throws a named error when `REDIS_URL` is unset rather than silently falling back,
    matching how `web/src/db/index.ts` treats `DATABASE_URL_SYNC`.

  **Storage adapter points at the existing database, verified through an independent connection**

  ```
  $ docker compose exec -T db psql -U pipeline -d content_pipeline \
      -c "select count(*) as mastra_tables from information_schema.tables where table_schema='public' and table_name like 'mastra_%'" \
      -c "select table_name from information_schema.tables where table_schema='public' and table_name not like 'mastra_%' order by 1"
   mastra_tables
  ---------------
              43
  (1 row)

      table_name
  ------------------
   alembic_version
   internal_links
   posts
   settings
   website_profiles
  (5 rows)
  ```

  The Mastra tables and the Alembic tables are in the same database and the same schema, which is
  the "one datastore, one consistent backup" requirement from the objective's section 2.

  **Tests** (`web/src/mastra/index.test.ts`, node environment, real Postgres + real Redis;
  `web/src/mastra/no-next-imports.test.ts`, source-graph scan):

  ```
  $ cd web && NO_COLOR=1 pnpm exec vitest run src/mastra
   RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web

   ✓ src/mastra/no-next-imports.test.ts (3 tests) 5ms
   ✓ src/mastra/index.test.ts (5 tests) 542ms
       ✓ delivers a published event to a subscriber over the real Redis  503ms

   Test Files  2 passed (2)
        Tests  8 passed (8)
     Duration  1.37s
  ```

  The five live tests assert, in order: the instance carries a `PostgresStore`, a
  `RedisStreamsPubSub` and the configured `PinoLogger`; `storage.pool` is the same object
  `getPool()` returns; the store's tables and `posts` are in the same database
  (`current_database() = 'content_pipeline'`, `mastra_workflow_snapshot` present); a workflow
  snapshot persists and loads back through `storage.getStore('workflows')`; and an event published
  through `mastra.pubsub` is delivered to a subscriber over the real Redis.

  **Negative controls** (each applied, run, then reverted):

  A. `pubsub` removed from the `Mastra` config. Mastra falls back to `EventEmitterPubSub` and both
  the wiring assertion and the Redis round-trip go red, so neither test would pass on an
  in-process bus:

  ```
   FAIL  src/mastra/index.test.ts > mastra instance > is a Mastra instance carrying the configured storage, pubsub and logger
  AssertionError: expected bound EventEmitterPubSub{ …(10) } to be an instance of RedisStreamsPubSub

   FAIL  src/mastra/index.test.ts > redis streams pubsub > delivers a published event to a subscriber over the real Redis
  Error: no event delivered within 10s

   Test Files  1 failed (1)
        Tests  2 failed | 3 passed (5)
  ```

  B. `storage` removed from the `Mastra` config. Mastra substitutes its own default store, so the
  test fails rather than passing on the fallback:

  ```
   FAIL  src/mastra/index.test.ts > mastra instance > is a Mastra instance carrying the configured storage, pubsub and logger
  AssertionError: expected <Anonymous Class>{ …(12) } to be an instance of PostgresStore

   Test Files  1 failed (1)
        Tests  1 failed | 4 skipped (5)
  ```

  C. `import { headers } from "next/headers"` added to `web/src/mastra/index.ts`:

  ```
   FAIL  src/mastra/no-next-imports.test.ts (2 failed | 1 passed)
      "@mastra/redis-streams",
      "drizzle-orm/node-postgres",
      "drizzle-orm/pg-core",
  +   "next/headers",
      "pg",
  ```

  D. `import "next/headers"` added to `web/src/db/index.ts` instead, to prove the scan is
  transitive and not just reading the entry file:

  ```
   FAIL  src/mastra/no-next-imports.test.ts > mastra entry point > reaches no next/* module through its first-party imports
   ❯ src/mastra/no-next-imports.test.ts:63:21
       expect(nextish).toEqual([])

   Test Files  1 failed (1)
        Tests  1 failed | 2 skipped (3)
  ```

  **Further API discrepancies found while wiring this up** (numbering continues from 2.1):

  8. None of `mastra.getStorage()`, `mastra.pubsub` or `mastra.getLogger()` returns the object
     passed to the constructor. Storage is wrapped in an init-ensuring `Proxy`
     (`augmentWithInit`, `dist/agent-DSxJoGjY.js:16912`) that awaits `init()` before every method
     call, pubsub in a publish-rewriting `Proxy` (`dist/mastra-Bn5mWcPE.js:552`), and the logger in
     a `DualLogger` exposing the original as `.baseLogger`
     (`dist/logger/index.js:72-86`). Identity assertions (`toBe`) fail; assert `instanceof`, or
     `.pool` / `.baseLogger`. Because storage self-initialises, the explicit `storage.init()` in
     the test's `beforeAll` is belt-and-braces rather than required.
  9. **Relevant to 4.4.** The `mastra.pubsub` proxy rewrites `publish` for the internal
     `workflows` and `workflows-finish` topics: when the run belongs to a workflow registered on
     *this* instance, it publishes with `{ localOnly: true }`
     (`dist/mastra-Bn5mWcPE.js:556-578`), which keeps the event off Redis entirely. Any run-local
     topic (`isRunLocalTopic`) is treated the same way. So registering the workflow on the `web`
     service's Mastra instance and starting a run there may execute it in-process rather than
     handing it to the `worker`. 4.4 must check this branch before concluding that Redis Streams
     is carrying the work.
  10. `PostgresStore.init()` creates **43** `mastra_*` tables covering every Mastra domain
     (knowledge, datasets, experiments, scorers, skills, MCP, channels, ...), not just workflow
     state. They land in `public` alongside the five Alembic tables. `PostgresStoreConfig` accepts
     a `schemaName` if they ever need namespacing, but `schema-parity.ts` already excludes the
     `mastra_` prefix, so the default is kept and the parity check still passes.
  11. `RedisStreamsPubSubConfig.logger` is typed `{ debug?: (...args: unknown[]) => void; warn?: ... }`,
     which `MastraLogger`'s narrower `(message: string, args?: Record<string, any>)` signature is
     not assignable to. Passing the `PinoLogger` straight through is a `tsc` error (TS2322); the
     entry point adapts it with a small sink instead of widening.
  12. Redis Streams subscriptions are pull-based consumer groups, so a `publish` issued before the
     subscriber's first `XREADGROUP` is never delivered to it. The round-trip test waits 500ms
     after `subscribe()` before publishing. Phase 4 and Phase 5's SSE work must not assume
     subscribe/publish ordering is safe without that handshake.

  **Gates** (`docker compose up -d db redis` first; `pnpm test` now needs Redis as well as
  Postgres, because `src/mastra/index.test.ts` exercises the real bus):

  ```
  $ cd web && pnpm exec tsc --noEmit
  tsc exit=0

  $ cd web && pnpm lint
  > content-pipeline-dashboard@0.1.0 lint
  > eslint
  lint exit=0

  $ cd web && NO_COLOR=1 pnpm test
   Test Files  2 failed | 19 passed (21)
        Tests  9 failed | 229 passed (238)
     Duration  5.73s

  $ cd web && pnpm build
  build exit=0
  ```

  Failures held at the established baseline of 9 (6 in `image-preview.test.tsx` plus the 3 others
  recorded in 0.1); passes went 221 -> 229, which is exactly the 8 new tests. No `api/` file was
  touched, so the pytest and ruff baselines are unchanged by construction.
- [x] 2.3 Define one trivial two-step workflow. Test executes it, asserts
  `stream.status === 'success'`, asserts the emitted event types, and asserts the run row is
  present in Postgres storage.

  `web/src/mastra/workflows/scaffold-check.ts` defines `scaffold-check`: two `createStep`s
  (`scaffold-first`, `scaffold-second`) chained with `.then()` and terminated with `.commit()`,
  both carrying Zod input/output schemas. The second step reads the first's output and appends
  to `seenBy`, so chaining is observable rather than assumed. It is registered on the Mastra
  instance as `workflows: { scaffoldCheck: scaffoldCheckWorkflow }` and stays registered after
  Phase 3: it is the only regression test for storage, streaming, Redis transport and Studio
  discovery that costs no provider call.

  `web/src/mastra/workflows/scaffold-check.test.ts` runs it once in `beforeAll` against the
  real Postgres and Redis and asserts across five tests.

  ```
  $ cd web && NO_COLOR=1 pnpm exec vitest run src/mastra/workflows/scaffold-check.test.ts

   RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web

   ✓ src/mastra/workflows/scaffold-check.test.ts (5 tests) 42ms

   Test Files  1 passed (1)
        Tests  5 passed (5)
     Start at  20:53:25
     Duration  671ms (transform 41ms, setup 88ms, import 471ms, tests 42ms, environment 0ms)
  ```

  What each assertion covers:

  1. registration: `mastra.getWorkflow('scaffoldCheck')` is the same object, `listWorkflows()`
     lists the key, and the workflow id is `scaffold-check`.
  2. `stream.status === 'success'` after the stream is drained, plus `result.status` and the
     final output `{ message, seenBy: ['scaffold-first', 'scaffold-second'] }`.
  3. event types: first event `workflow-start`, last `workflow-finish` with
     `payload.workflowStatus === 'success'`, and exactly two `workflow-step-start` /
     `workflow-step-result` pairs in step order with `status: 'success'`.
  4. persistence: an independent `pg.Pool` selects `mastra_workflow_snapshot` by `run_id` and
     finds one row with `workflow_name = 'scaffold-check'`, `snapshot->>'status' = 'success'`
     and both step ids in `snapshot.context`.
  5. `workflow.getWorkflowRunById(runId)` returns the same run with status `success`.

  The run rows are really in the Alembic-owned database:

  ```
  $ docker compose exec -T db psql -U pipeline -d content_pipeline -c \
      "select workflow_name, run_id, snapshot->>'status' as status \
       from mastra_workflow_snapshot order by \"createdAt\" desc limit 3;"
   workflow_name  |                run_id                | status
  ----------------+--------------------------------------+---------
   scaffold-check | 60a72f96-886b-4f74-87bb-cb410d446eec | success
   scaffold-check | 04a05648-d4f7-4c5d-a6fc-c715ffb26149 | success
   scaffold-check | a2371e42-3c6e-4570-8011-71224d216804 | success
  (3 rows)
  ```

  **Negative control 1, chaining and event payloads.** `scaffold-second` changed to return
  `seenBy: [...inputData.seenBy]` (no append), which is a plausible-looking no-op:

  ```
   FAIL  scaffold-check workflow > runs both steps in order ...
   FAIL  scaffold-check workflow > emits the workflow lifecycle events ...
  AssertionError: expected { message: 'phase-2 scaffold', …(1) } to deeply equal { …(1) }
    {
      "message": "phase-2 scaffold",
      "seenBy": [
        "scaffold-first",
  -     "scaffold-second",
      ],
    }
   Test Files  1 failed (1)
        Tests  2 failed | 3 passed (5)
  ```

  Reverted; the file is back to the committed version.

  **Negative control 2, Postgres storage.** `storage` removed from the `new Mastra({...})`
  config, so Mastra substitutes its default store:

  ```
   FAIL  scaffold-check workflow > persists the run into the Postgres storage adapter
  AssertionError: expected [] to have a length of 1 but got +0
   Test Files  1 failed (1)
        Tests  1 failed | 4 passed (5)
  ```

  Reverted. Note which test did **not** fail: `getWorkflowRunById` still returned a successful
  run from the default in-memory store, so only the direct SQL probe distinguishes "persisted
  to Postgres" from "persisted somewhere". Later items that claim Postgres durability must
  probe SQL, not the workflow API.

  **Intentional test update.** `src/mastra/no-next-imports.test.ts` pins the exact external
  package list reachable from the entry point. Registering the workflow legitimately adds
  `@mastra/core/workflows` and `zod` to that list, so the expected array was extended by those
  two entries. The `next/*` and `server-only` assertion and its negative control are untouched.
  This is a behavior change to the entry point's import graph, not a test edited to pass.

  Frontend gates after the change:

  ```
  $ cd web && NO_COLOR=1 pnpm exec tsc --noEmit ; echo exit=$?
  exit=0

  $ cd web && NO_COLOR=1 pnpm lint ; echo exit=$?
  > content-pipeline-dashboard@0.1.0 lint
  > eslint
  exit=0

  $ cd web && NO_COLOR=1 pnpm test ; echo exit=$?
   Test Files  2 failed | 20 passed (22)
        Tests  9 failed | 234 passed (243)
  exit=1

  $ cd web && NO_COLOR=1 pnpm build ; echo exit=$?
  exit=0
  ```

  Failures held at the established baseline of 9; passes went 229 -> 234, exactly the 5 new
  tests. No `api/` file was touched, so the pytest and ruff baselines are unchanged by
  construction.
- [x] 2.4 A second process subscribed to the Redis Streams topic receives the same events.

  Files: `web/src/mastra/scripts/redis-event-observer.mjs` (the second process),
  `web/src/mastra/crossprocess-events.test.ts` (4 tests), plus the engine change described
  under "Amendment to 2.3" below.

  **The default workflow engine publishes nothing to Redis at all.** Item 2.3's workflow, built
  with `createWorkflow` from `@mastra/core/workflows`, executes entirely in the calling process.
  Measured directly: `redis-cli FLUSHALL`, run the scaffold workflow to completion, then

  ```
  $ docker compose exec -T redis redis-cli KEYS '*'
  (empty)
  ```

  exit=0, zero keys. There is no topic for a second process to subscribe to, so item 2.4 is not
  satisfiable on the default engine. The evented engine
  (`createWorkflow`/`createStep` from `@mastra/core/workflows/evented`) is what publishes
  workflow lifecycle events onto the pub/sub bus, which is the mechanism the objective's
  section 2 describes and the one Phase 4.4 needs. The scaffold workflow was moved onto it.

  **The second process.** `redis-event-observer.mjs` imports `@mastra/redis-streams` and
  nothing else from this repo: no Mastra instance, no database client, no workflow definition.
  It subscribes to the topics named on argv and writes one JSON line per received event to
  stdout. Nothing but the Redis connection string links it to the process running the workflow,
  so an event it prints provably crossed a process boundary. It subscribes without a `group`
  option, so each subscription gets its own fan-out consumer group and the observer cannot
  steal an event the orchestration worker needed.

  **Passing run** (after `docker compose up -d db redis` and `redis-cli FLUSHALL`):

  ```
  $ cd web && NO_COLOR=1 pnpm exec vitest run src/mastra/crossprocess-events.test.ts

   RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web

   ✓ src/mastra/crossprocess-events.test.ts (4 tests) 3269ms

   Test Files  1 passed (1)
        Tests  4 passed (4)
     Start at  21:04:19
     Duration  4.07s (transform 38ms, setup 125ms, import 596ms, tests 3.27s, environment 0ms)
  ```

  exit=0.

  What the four tests assert:
  1. the run still reached `success` locally and the observer wrote nothing to stderr, so
     observing did not disturb execution;
  2. the observer received this run's events on the `workflows` topic: `workflow.start` first,
     then exactly two `workflow.step.run` and two `workflow.step.end` (one pair per step), then
     `workflow.end`, every one carrying `workflowId: "scaffold-check"`;
  3. the terminal event arrives once on the separate `workflows-finish` topic, also as
     `workflow.end`;
  4. the per-run stream topic `workflow.events.v2.<runId>` delivers nothing to a third process,
     because `mastra.pubsub` tags it `localOnly`.

  **Redis state after that run**, confirming the events are really in Redis Streams rather than
  an in-process emitter:

  ```
  $ for k in $(docker compose exec -T redis redis-cli KEYS 'mastra:topic:*'); do \
      echo "$k  XLEN=$(docker compose exec -T redis redis-cli XLEN "$k")"; done
  mastra:topic:workflows  XLEN=6
  mastra:topic:workflow.events.v2.44ad5385-6e83-4e30-8119-3f0c3735e7e8  XLEN=0
  mastra:topic:workflows-finish  XLEN=1
  ```

  6 events on `workflows` (start + 2 step pairs + end), 1 on `workflows-finish`, and 0 on the
  run-local topic. The run-local key exists only because `subscribe()` creates the stream with
  `MKSTREAM`; no publish ever reached it.

  A representative entry read straight out of the stream with `XRANGE mastra:topic:workflows`:

  ```
  {"type":"workflow.start","runId":"<run-id>","data":{"workflowId":"evented-scratch",
   "runId":"<run-id>","prevResult":{"status":"success","output":{"message":"scratch"}},
   "requestContext":{},"initialState":{}},"id":"<event-id>",
   "createdAt":"2026-08-22T01:57:19.967Z","deliveryAttempt":1}
  ```

  **Negative control 1: the default engine.** Point `scaffold-check.ts` back at
  `@mastra/core/workflows` (one-word import change) and rerun:

  ```
   FAIL  src/mastra/crossprocess-events.test.ts [ src/mastra/crossprocess-events.test.ts ]
  Error: observer never reported a matching event within 30000ms
   ❯ Timeout._onTimeout src/mastra/crossprocess-events.test.ts:80:20

   Test Files  1 failed (1)
        Tests  4 skipped (4)
     Duration  31.44s
  ```

  The run itself still succeeds in-process; the observer simply never sees it. Reverted, and the
  import is back to `@mastra/core/workflows/evented` (verified by grep).

  **Negative control 2: wrong topic names.** Subscribe the observer to `workflows-typo` /
  `workflows-finish-typo` instead:

  ```
   FAIL  src/mastra/crossprocess-events.test.ts [ src/mastra/crossprocess-events.test.ts ]
  Error: observer never reported a matching event within 30000ms
   ❯ Timeout._onTimeout src/mastra/crossprocess-events.test.ts:80:20

   Test Files  1 failed (1)
        Tests  4 skipped (4)
     Duration  32.68s
  ```

  This rules out the observer reporting anything it did not read from the named Redis stream.
  Reverted.

  **Amendment to item 2.3.** `web/src/mastra/workflows/scaffold-check.ts` now builds its steps
  and workflow with `createStep`/`createWorkflow` from `@mastra/core/workflows/evented`, and
  `scaffold-check.test.ts` gained `await mastra.startWorkers()` in `beforeAll` and
  `await mastra.stopWorkers()` in `afterAll`. This is an intentional behaviour change, not a
  test edited to pass: the default engine cannot satisfy 2.4 and cannot support the `web` /
  `worker` split in 4.4, so the scaffold has to be built the way the real pipeline will be or it
  stops being a regression test for the infrastructure. Every assertion 2.3 recorded still holds
  unchanged (`workflow-start` first, `workflow-finish` last, the two `workflow-step-start` and
  two `workflow-step-result` payloads, the `mastra_workflow_snapshot` row, `getWorkflowRunById`);
  only the worker lifecycle calls were added:

  ```
  $ cd web && NO_COLOR=1 pnpm exec vitest run src/mastra

   ✓ src/mastra/no-next-imports.test.ts (3 tests) 6ms
   ✓ src/mastra/index.test.ts (5 tests) 545ms
   ✓ src/mastra/workflows/scaffold-check.test.ts (5 tests) 1198ms
   ✓ src/mastra/crossprocess-events.test.ts (4 tests) 3237ms

   Test Files  4 passed (4)
        Tests  17 passed (17)
     Duration  4.03s
  ```

  exit=0. `no-next-imports.test.ts`'s expected-package list was updated in the same way it will
  be once per Phase 3 stage: `@mastra/core/workflows` became `@mastra/core/workflows/evented`.
  The load-bearing `next/*` and `server-only` assertions are untouched.

  **API discrepancies found (continuing the numbering from item 2.2).**

  13. The objective's section 2 says workflow lifecycle events go onto a pub/sub bus that worker
      processes consume. That is true only of the **evented** engine. `createWorkflow` from
      `@mastra/core/workflows` publishes nothing to Redis, and every `run.stream()` event it
      emits is in-process. Phase 4.4 must be built on `@mastra/core/workflows/evented`.
  14. An evented workflow does not execute unless some process has called
      `mastra.startWorkers()`. Without it the run is published to `workflows` and nothing
      consumes it, so `run.stream()` never terminates: item 2.3's test hit its 60s hook timeout
      with all 5 tests skipped. This is precisely the `web` starts / `worker` executes division,
      and it means the `web` service must **not** call `startWorkers()` in Phase 4.
  15. `mastra.createRunAsync()` does not exist on the evented workflow object either
      (`TypeError: ...createRunAsync is not a function`); `createRun()` is the only constructor.
      This extends discrepancy 4 from item 2.1 to the evented engine.
  16. `createStep` and `createWorkflow` from `@mastra/core/workflows/evented` are different
      function objects from the ones exported by `@mastra/core/workflows` (both `===` checks are
      false), so the two engines cannot be mixed by importing steps from one and the workflow
      from the other. Also, `createEventedWorkflow` is **not** an actual runtime export of
      `@mastra/core` (`undefined` at run time) despite appearing in the typings, correcting
      discrepancy 3 from item 2.1: the working import path is `@mastra/core/workflows/evented`.
  17. The evented engine emits `workflow-start` and `workflow-finish` **twice** each on
      `run.stream().fullStream` (observed sequence: `workflow-start`, `workflow-start`,
      `workflow-step-start`, `workflow-step-result`, `workflow-step-start`,
      `workflow-step-result`, `workflow-finish`, `workflow-finish`) with a single Mastra
      instance and a single registered workflow. Phase 8's trace view must dedupe those two
      event types or it will render two runs.
  18. Iteration 14's reading of the `mastra.pubsub` `localOnly` guard was too broad. The guard on
      the `workflows` / `workflows-finish` topics fires only for workflows in the **internal**
      registry (`__registerInternalWorkflow`, used by background tasks and durable agents), not
      for workflows registered publicly on the instance, so a normally registered workflow's
      events do reach Redis. The unconditional local-only topic is the `workflow.events.v2.*`
      prefix (`RUN_LOCAL_TOPIC_PREFIXES` in `@mastra/core/dist/topics-BCcUoD5n.js:310`), which
      test 4 above pins.
  19. Consequence for Phase 5.5: because the per-run stream topic never leaves the executing
      process, the SSE route in the `web` service cannot read a worker-side run's chunks from
      `workflow.events.v2.<runId>`. It has to work from the `workflows` topic or from Mastra's
      own resumable-stream replay.

  **Frontend gates**, all four run from `web/` after the change:

  ```
  $ pnpm exec tsc --noEmit
  tsc exit=0

  $ pnpm lint
  lint exit=0

  $ NO_COLOR=1 pnpm test
   Test Files  2 failed | 21 passed (23)
        Tests  9 failed | 238 passed (247)
  test exit=1

  $ pnpm build
  build exit=0
  ```

  Failures held at the established baseline of 9 (`image-preview.test.tsx` and
  `PostDetail.test.tsx`); passes went 234 -> 238, exactly the 4 new tests. No `api/` file was
  touched, so the pytest and ruff baselines are unchanged by construction.
- [x] 2.5 Mastra Studio connects to the dev server and lists the trivial workflow. Paste the
  command and a committed screenshot path.

  **The command.** Run from `web/`, with the repo-root `.env` passed explicitly because the
  Mastra CLI does not read it on its own (negative control 1 below):

  ```
  $ cd web && pnpm exec mastra dev --env ../.env
  ◐ Preparing development environment...
  ✓ Initial bundle complete
  ◇ Starting Mastra dev server...

   mastra  1.26.0 ready in 1010 ms

  │ Studio: http://localhost:4111
  │ API:    http://localhost:4111/api

  ◯ watching for file changes...
  ```

  `docker compose up -d db redis` first; the entry point opens both connections at import time.

  **Studio lists the workflow and its steps.** Read back out of the server it serves:

  ```
  $ curl -s http://localhost:4111/api/workflows | node -e 'let s="";process.stdin.on("data",
      d=>s+=d).on("end",()=>{const w=JSON.parse(s);for(const[k,v]of Object.entries(w))
      console.log(k,"->",v.name,"| steps:",Object.keys(v.steps).join(", "))})'
  scaffoldCheck -> scaffold-check | steps: scaffold-first, scaffold-second
  ```

  **Committed screenshots** (captured with `npx -y chrome-devtools-axi`, per the objective's
  browser-tool constraint):

  - `docs/mastra-port/studio/2.5-studio-workflows-list.png`: `http://localhost:4111/workflows`,
    one row: `scaffold-check`, Number of steps `2`.
  - `docs/mastra-port/studio/2.5-studio-workflow-detail.png`:
    `http://localhost:4111/workflows/scaffoldCheck`, showing the rendered graph
    `Start → scaffold-first → scaffold-second → End`, the `2 steps` badge, the form generated
    from the workflow's Zod `inputSchema` (a required `Message` field), and 21 `success` runs
    under **Recent runs**.

  ```
  $ npx -y chrome-devtools-axi open http://localhost:4111/workflows
  $ npx -y chrome-devtools-axi screenshot <path> --full-page
  $ npx -y chrome-devtools-axi console
  console:
  ## Console messages
  <no console messages found>
  $ npx -y chrome-devtools-axi stop
  status: stopped
  ```

  No browser console messages of any kind, so no errors.

  **Studio is reading the shared Postgres, not a private store.** The two newest run IDs Studio
  rendered under Recent runs exist in `mastra_workflow_snapshot` in the `content_pipeline`
  database that also holds `posts`:

  ```
  $ psql "$DATABASE_URL_SYNC" -c "select workflow_name, run_id, snapshot->>'status' as status
      from mastra_workflow_snapshot where run_id in
      ('7e7b55d0-cbd7-4fc6-b2c8-eb4db46bfc2f','ecb3ff7a-d6ec-482d-80b0-5553ddaadbe9');"
   workflow_name  |                run_id                | status
  ----------------+--------------------------------------+---------
   scaffold-check | ecb3ff7a-d6ec-482d-80b0-5553ddaadbe9 | success
   scaffold-check | 7e7b55d0-cbd7-4fc6-b2c8-eb4db46bfc2f | success
  (2 rows)
  ```

  Those runs were produced by the item 2.3 and 2.4 test suites, in a different process, so
  Studio is observing state it did not create.

  **Negative control 1: the CLI does not find the env on its own.** Drop `--env ../.env` and
  clear the inherited variables, and the server dies loading the entry point instead of
  silently starting against a default store:

  ```
  $ env -u DATABASE_URL_SYNC -u DATABASE_URL -u REDIS_URL pnpm exec mastra dev
  ◇ Starting Mastra dev server...
  Error: DATABASE_URL_SYNC (or DATABASE_URL) must be set to reach the database
      at connectionString (.mastra/output/index.mjs:60:11)
      at getPool (.mastra/output/index.mjs:67:70)
  $ curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4111/api/workflows
  000
  ```

  This is what makes `--env ../.env` a required part of the documented command rather than a
  convenience, and it also proves Studio bundles *this* entry point: the thrown message is the
  one in `web/src/db/index.ts`.

  **Negative control 2: the listing reflects the registry.** Change `web/src/mastra/index.ts`
  to `workflows: {}`, restart, and Studio has nothing to list:

  ```
  $ pnpm exec mastra dev --env ../.env
   mastra  1.26.0 ready in 1005 ms
  $ curl -s http://localhost:4111/api/workflows
  {}
  ```

  Reverted (`workflows: { scaffoldCheck: scaffoldCheckWorkflow }`) and the listing returned, as
  the command output above shows.

  **Two repo changes this item forced**, both consequences of `mastra dev` writing a build
  directory at `web/.mastra/`:

  1. `web/.gitignore` gains `.mastra`. The directory is CLI build output (bundled server plus
     the whole Studio UI) and must not be committed.
  2. `web/eslint.config.mjs` gains `.mastra/**` to its `globalIgnores`. ESLint's flat config
     does not consult `.gitignore`, so with the directory present `pnpm lint` walked the
     bundled Studio assets and died:

     ```
     $ pnpm lint
     [BABEL] Note: The code generator has deoptimised the styling of
       web/.mastra/output/studio/assets/livekit-client.esm-CKIgC2IJ.js as it exceeds the max of 500KB.
     FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed -
       JavaScript heap out of memory
     ```

     This is a real gate break for anyone who runs Studio, not a cosmetic ignore: the lint gate
     fails on a clean checkout the moment `mastra dev` has been run once.

  **Frontend gates** after both changes:

  ```
  $ cd web && pnpm exec tsc --noEmit
  tsc exit=0

  $ pnpm lint
  lint exit=0

  $ NO_COLOR=1 pnpm test
   Test Files  2 failed | 21 passed (23)
        Tests  9 failed | 238 passed (247)
  test exit=1

  $ pnpm build
  build exit=0
  ```

  Failures held at the established baseline of 9 (`image-preview.test.tsx` and
  `PostDetail.test.tsx`) and passes held at 238; this item adds no tests, since its evidence is
  the running Studio and the committed screenshots. No `api/` file was touched, so the pytest
  and ruff baselines are unchanged by construction.

  **Phase 2 is complete**: 2.1 through 2.5 are all checked.

## Phase 3: Port the six stages (one per iteration)

Each: Mastra agent + step, Zod `inputSchema`/`outputSchema` (no `z.any()`, no untyped
passthrough), prompt assembled from `rules/blog-<stage>.md` plus post/profile fields matching
the Python assembly, output written to the same Post column via `STAGE_CONTENT_MAP`
immediately on completion. Parity test asserts the rendered prompt matches the
Python-rendered prompt (whitespace normalized only) and the output validates against
`outputSchema`.

- [x] 3.1a Shared prompt assembly (`load_rules` / `build_stage_prompt`), with a prompt-parity
  test against every golden fixture.

  Split out of 3.1 because it is not research-specific: all six stages render their prompt
  through the same two Python functions, so porting them once, proven against all 12 golden
  fixtures, is a self-contained unit and stops each of 3.1b through 3.6 re-deriving it.

  **What was ported.** `web/src/mastra/state.ts` carries the stage vocabulary from
  `api/src/pipeline/state.py` (`STAGES`, `STAGE_CONTENT_MAP`, `STAGE_PROVIDER_MAP`,
  `STAGE_RULES_MAP`, `STAGE_OUTPUT_KEY`, the status constants) plus `pipelineContextSchema`,
  the Zod schema for the prompt-visible subset of `PipelineState`. API keys, `stage_status`
  and run-control fields are deliberately absent from that schema: they never reach a prompt,
  so a step cannot leak a credential into a provider payload through it.
  `web/src/mastra/prompts.ts` ports `load_rules()` and `build_stage_prompt()` from
  `api/src/pipeline/helpers.py`, including `_build_config_context`, `_get_previous_output` and
  `_build_links_context`.

  **The prompt contract is not uniform across the six stages.** The parity run against the
  golden fixtures established, rather than assumed, which stages the shared assembly covers:

  | Stage | Prompt actually sent |
  | --- | --- |
  | `research`, `outline`, `write` | exactly `build_stage_prompt()` |
  | `images` | `build_stage_prompt()` as prompt 1 of N; prompts 2..N are per-image (item 3.5) |
  | `edit` | `build_stage_prompt()` + `"\n\n---\n\n"` + `_build_analytics_section()` (item 3.4) |
  | `ready` | not `build_stage_prompt()` at all: `_build_ready_prompt()` is a separate builder (item 3.6) |

  So the test asserts byte equality for the first four, an exact-prefix relationship for
  `edit`, and for `ready` it pins the fixture's distinguishing markers (`- **SLUG**:`, the
  fenced `## Image Manifest (generated images only)` block, no `- **BLOG_POST_TOPIC**:`) so
  item 3.6 cannot wire up the wrong builder unnoticed.

  **Verification.**

  ```
  $ cd web && NO_COLOR=1 pnpm exec vitest run src/mastra/prompts.test.ts

   RUN  v4.0.18 /Users/cody/.../objective-port-jena-46c1e6-1/web

   ✓ src/mastra/prompts.test.ts (21 tests) 20ms

   Test Files  1 passed (1)
        Tests  21 passed (21)
     Start at  21:20:40
     Duration  203ms (transform 31ms, setup 81ms, import 33ms, tests 20ms, environment 0ms)
  ```

  The 21 cover: 8 byte-exact fixture comparisons (4 stages x 2 posts), 2 `edit` prefix
  comparisons, 2 `ready` non-applicability pins, a check that the two captured posts really do
  differ in `article_type`/`output_format`, TODAY_DATE injection in both directions, rule-file
  loading for all six stages against the on-disk bytes, the `RULES_DIR` override plus
  missing-file behaviour, and four assembly edge cases.

  **Negative controls** (each applied, run, reverted):

  ```
  $ # 1. swap the NICHE and INTENT rows of CONFIG_FIELDS
   Test Files  1 failed (1)
        Tests  10 failed | 11 passed (21)

  $ # 2. drop the non-ASCII escaping from pythonJsonDumps
   FAIL  src/mastra/prompts.test.ts > buildStagePrompt edge cases >
         escapes non-ASCII in a serialized manifest the way json.dumps does
   Test Files  1 failed (1)
        Tests  1 failed | 20 passed (21)

  $ # 3. join sections with "\n\n" instead of "\n\n---\n\n"
   Test Files  1 failed (1)
        Tests  10 failed | 11 passed (21)

  $ # restored
   Test Files  1 passed (1)
        Tests  21 passed (21)
  ```

  Control 2 is the one the golden fixtures could not catch on their own, because neither
  captured manifest contains a non-ASCII character. Python's `json.dumps(..., indent=2)`
  defaults to `ensure_ascii=True` and `JSON.stringify` does not, so the two stacks would have
  diverged on exactly the manifests carrying typographic punctuation. Confirmed against the
  real Python:

  ```
  $ python3 -c 'import json
  print(json.dumps({"alt": "café — 90% sure ☕"}, indent=2))'
  {
    "alt": "caf\u00e9 \u2014 90% sure \u2615"
  }
  ```

  which is the exact string the TypeScript assertion expects.

  **Frontend gates:**

  ```
  $ cd web && pnpm exec tsc --noEmit
  tsc exit=0

  $ pnpm lint
  lint exit=0

  $ NO_COLOR=1 pnpm test
   Test Files  2 failed | 22 passed (24)
        Tests  9 failed | 259 passed (268)
  test exit=1

  $ pnpm build
  build exit=0
  ```

  Failures held at the established baseline of 9 (`image-preview.test.tsx` and
  `PostDetail.test.tsx`); passes moved 238 -> 259, which is the 21 new tests. No `api/` file
  was touched (`git status --porcelain` listed only the three new `web/src/mastra/` files), so
  the pytest and ruff baselines are unchanged by construction.

- [x] 3.1b `research` **agent**: the provider-facing half of the stage (model id, system
  message, credential resolution), registered on the Mastra instance.

  Split from the original 3.1b, which bundled the agent, the step, the meta-response
  retry loop, the persistence contract and the parity test into one item. The agent half
  carries the port's biggest unknown for Phase 3 (can Mastra's model router reach
  Perplexity at all, and where does the API key come from) and is verifiable on its own
  with a live call, so it is its own iteration. The step half is 3.1c.

  **What was built**

  - `web/src/mastra/api-keys.ts`: `getApiKeys()` / `requireApiKey()`, ported from
    `get_api_keys()` in `api/src/services/api_keys.py`. Reads the encrypted `api_keys`
    row out of the `settings` table and decrypts it with `web/src/lib/crypto.ts` (item
    1.3). Same `PROVIDERS` tuple and same "missing provider maps to empty string"
    behaviour as Python.
  - `web/src/mastra/agents/research.ts`: the `research` Mastra `Agent`.
    `RESEARCH_SYSTEM_MESSAGE` is byte-identical to the `system=` string
    `research_node` sends; `RESEARCH_MODEL_ID` is `perplexity/sonar-pro`.
  - `web/src/mastra/index.ts`: `agents: { research: researchAgent }`.

  **Credential path decision.** The key is resolved inside the agent's dynamic `model`
  resolver, from the database, per call. It is deliberately *not* passed through the
  workflow input or `RequestContext`: the evented engine serialises run input into Redis
  Streams payloads and into the `mastra_workflow_snapshot` rows in Postgres, so a key
  routed that way would be persisted in the run history of every pipeline that ever ran.
  Resolving per call also means rotating the key on the settings page takes effect
  without restarting the worker, and it works identically in `web` and `worker` because
  both reach the same database. The cost is one indexed single-row read per provider
  call.

  **Model choice.** `sonar-pro` is carried over unchanged from
  `PerplexityClient.chat()`'s default. Per section 5, keeping a working incumbent is a
  success; choosing a stronger research model with its live verification and cost
  delta is ledger item 6.1, and changing it here would be an unverified choice. The
  live response below confirms the incumbent id resolves through Mastra's router.

  **Mastra's provider registry reaches Perplexity with no extra dependency.**
  `node_modules/@mastra/core/dist/provider-registry.json` carries a `perplexity`
  provider (`apiKeyEnvVar: PERPLEXITY_API_KEY`, models `sonar`, `sonar-deep-research`,
  `sonar-pro`, `sonar-reasoning-pro`, `npm: @ai-sdk/perplexity`), and the router
  resolves `{ id: "perplexity/sonar-pro", apiKey }` (an `OpenAICompatibleConfig`, see
  `@mastra/core/dist/llm/model/shared.types.d.ts:24-35`) without `@ai-sdk/perplexity`
  being installed. No new dependency was added for this item.

  **Evidence**

  ```
  $ cd web && NO_COLOR=1 pnpm exec vitest run src/mastra/api-keys.test.ts
   Test Files  1 passed (1)
        Tests  6 passed (6)
  exit=0

  $ cd web && PERPLEXITY_API_KEY=<redacted> NO_COLOR=1 pnpm exec vitest run \
      src/mastra/agents/research.test.ts
   ✓ src/mastra/agents/research.test.ts (6 tests) 834ms
       ✓ reaches Perplexity and reports back the configured model id  810ms
   Test Files  1 passed (1)
        Tests  6 passed (6)
  exit=0
  ```

  The live smoke test writes the real key into the `settings` table encrypted with a
  throwaway Fernet key, runs one minimal generate, asserts the provider's own reported
  model id, and removes the row again, so it exercises the whole production path
  (encrypted row -> `crypto.ts` -> model router -> Perplexity) instead of a stub. It is
  `describe.skipIf(!process.env.PERPLEXITY_API_KEY)` so the default `pnpm test` needs no
  credentials; in the unkeyed run it reports as 1 skipped. The dev database is left with
  zero `settings` rows afterwards:

  ```
  $ PGPASSWORD=<redacted> psql -h localhost -p 5435 -U pipeline -d content_pipeline \
      -c "select count(*) from settings;"
   count
  -------
       0
  (1 row)
  ```

  **Live provider response (redacted).** Captured from a scratch call before the agent
  was written, confirming both the resolved model id and that the router carries
  Perplexity's citations and cost metadata through:

  ```
  MODELID: {"modelId":"sonar-pro","id":"24482d0f-621f-42cb-83d6-ed0c69ac6df8"}
  SOURCES: [{"type":"source","payload":{"sourceType":"url",
             "url":"https://www.reddit.com/r/CRM/comments/1f0yp7n/..."}}, ...]
  PROVIDERMETA: {"perplexity":{"images":null,
    "usage":{"citationTokens":null,"numSearchQueries":null},
    "cost":{"inputTokensCost":0.00007,"outputTokensCost":0.00042,
            "requestCost":0.006,"totalCost":0.00649}}}
  USAGE: {"inputTokens":15,"outputTokens":1,"totalTokens":16,"reasoningTokens":0, ...
          "raw":{"raw":{"cost":{"request_cost":0.006,"total_cost":0.00606}}}}
  ```

  Two notes this hands forward. `result.sources` exposes Perplexity's citation URLs as
  structured `source` parts, which is a better input for the `link_validator` TS port
  (item 5.7) than re-parsing them out of the markdown. And `result.usage.raw.raw.cost`
  carries the provider's own per-request cost in dollars, so Phase 8's cost column does
  not have to maintain a price table for Perplexity.

  **Negative controls** (each applied, run, reverted)

  1. Changed `RESEARCH_SYSTEM_MESSAGE`'s opening clause to "You are a helpful
     assistant.": `× sends the system message the Python stage sent, per the golden
     fixtures`, `AssertionError: expected 'You are an expert SEO content researc...' to
     be 'You are a helpful assistant. Respond ...'`. Proves the system message is
     checked against the golden fixtures, not against a copy of itself.
  2. Changed `RESEARCH_MODEL_ID` to `perplexity/sonar`: three tests red, including the
     live one with `AssertionError: expected 'sonar' to be 'sonar-pro'` reported by
     Perplexity itself. Proves the live assertion reads the provider's response rather
     than echoing the configured constant.
  3. Made `getApiKeys()` return the stored value without calling `decrypt()`: 4 of 6
     api-key tests red, including `expected 'gAAAAABqiQn5BeTxPn8UOkO4LVYYgH9X-KDUD...'
     to be 'pplx-only'`. Proves the reader decrypts real Fernet ciphertext out of the
     real table.

  **Intentional test update.** `no-next-imports.test.ts`'s expected package list gained
  `@mastra/core/agent`, `drizzle-orm` and `node:crypto`, which the registered agent
  legitimately pulls into the entry point's import graph, and the test name changed from
  "the packages the scaffold needs" to "the packages the registered primitives need".
  The load-bearing assertion in that file (no `next/*` or `server-only` anywhere in the
  graph) is untouched and still passes.

  **Gates**

  ```
  $ cd web && pnpm exec tsc --noEmit
  tsc exit=0

  $ cd web && pnpm lint
  lint exit=0

  $ cd web && NO_COLOR=1 pnpm test
   Test Files  2 failed | 24 passed (26)
        Tests  9 failed | 270 passed | 1 skipped (280)
  test exit=1

  $ cd web && pnpm build
  build exit=0
  ```

  Failures held at the established baseline of 9 (`image-preview.test.tsx` and
  `PostDetail.test.tsx`); passes moved 259 -> 270, which is the 11 new non-skipped
  tests. No `api/` file was touched, so the pytest and ruff baselines are unchanged by
  construction.

- [x] 3.1c-i Shared posts-table bridge: `stateFromPost()` (ported from
  `state_from_post()` in `api/src/pipeline/state.py`) and `saveStageOutput()` (ported
  from `save_stage_output()` in `api/src/pipeline/helpers.py`), which all six steps
  read and write through.

  **Split rationale.** 3.1c bundled four separable things: the posts-table bridge, the
  meta-response retry loop, the `createStep` wiring and the parity test. The bridge is
  shared by all six stages rather than specific to `research`, and it is the piece the
  crash-resume gate (item 4.5) actually depends on, so it is worth proving on its own
  against the real database before any stage is built on it. Item 3.1c-ii is the
  `research` step itself.

  **What was built.** `web/src/mastra/post-state.ts`:
  - `pipelineStateSchema` / `PipelineState`: `pipelineContextSchema` extended with the
    identity and run-control fields (`postId`, `slug`, `profileId`, `imageStyle`,
    `imageBrandColors`, `imageExclude`, `finalHtml`, `currentStage`, `stageSettings`,
    `stageStatus`). `api_keys` stays out, unlike Python's `PipelineState`, so a
    credential cannot ride into a provider payload inside the prompt-input object.
  - `stateFromPost(post, internalLinks)`: column-for-column port, including Python's
    falsy coalescing (`or`, not `??`, so `word_count` 0 becomes 2000) and the three
    defaults `2000` / `"Conversational and friendly"` / `"markdown"` plus the
    all-six-stages-`auto` `stage_settings` fallback.
  - `saveStageOutput(postId, stage, content, stageStatus?)`: writes the stage's column,
    advances `current_stage`, and replaces `stage_status` only when the caller supplies
    one. The drizzle property for each stage's column is resolved at import time from
    `getTableColumns(posts)` by the database column name in `STAGE_CONTENT_MAP`, so the
    two maps cannot drift into writing the wrong column.

  **Two behaviours found in the Python original that a naive port would have lost.**
  1. `save_stage_output()` runs through SQLAlchemy's Core `update()`, so
     `TimestampMixin.updated_at`'s `onupdate` fired on every stage write. Postgres has
     no trigger doing this, so the TypeScript version stamps `updatedAt` explicitly.
     Negative control 3 below is the proof that the database does not do it for us.
  2. `stage_settings` differs by writer, as recorded under item 1.4: the fixtures'
     all-`auto` six-stage value came from the SQLAlchemy model default, which happens to
     equal `stateFromPost`'s NULL fallback, while a drizzle insert would get the
     database's five-stage all-`review` default. The parity test inserts NULL so the
     fallback branch is the one under test.

  **Parity oracle.** The golden fixtures' `state_input` block is a verbatim dump of the
  state the Python pipeline ran on. The test inserts a row built from `post_spec` into
  the real Alembic-owned dev database, reads it back through drizzle, and asserts
  `stateFromPost(row, links)` deep-equals `state_input` with keys camelized and
  `api_keys` dropped. Keys are camelized generically rather than by a listed mapping, so
  a field the port forgot to map surfaces as a missing key instead of being silently
  excluded from the comparison.

  ```
  $ cd web && NO_COLOR=1 pnpm exec vitest run src/mastra/post-state.test.ts
   RUN  v4.0.18 /Users/cody/.../web

   ✓ src/mastra/post-state.test.ts (6 tests) 35ms

   Test Files  1 passed (1)
        Tests  6 passed (6)
  ```

  **Negative controls** (each reverted immediately):
  1. `wordCount: post.wordCount || DEFAULT_WORD_COUNT` -> `?? `: `× coalesces a zero
     word count to Python's 2000, not to zero`, `AssertionError: expected +0 to be 2000`.
     Proves the test pins Python's falsy coalescing rather than any coalescing.
  2. Deleted the `articleType` mapping: both fixture parity tests red with
     `- "articleType": "how-to",` and `- "articleType": "listicle",` in the diff. Proves
     the generic camelization really does catch an unmapped field.
  3. Deleted the explicit `updatedAt: new Date()`: `AssertionError: expected
     1787366289626 to be greater than 1787366289626`. The two timestamps being identical
     is the evidence that Postgres does not stamp `updated_at` on its own, so the
     explicit stamp is load bearing and not decoration.
  4. Renamed `STAGE_CONTENT_MAP.research` to `reserch_content`: import-time
     `Error: posts has no column 'reserch_content' for stage 'research'`, `Tests no
     tests`. Proves the column resolver fails loudly instead of writing nowhere.

  **Gates**

  ```
  $ cd web && pnpm exec tsc --noEmit
  tsc exit=0

  $ cd web && pnpm lint
  lint exit=0

  $ cd web && NO_COLOR=1 pnpm test
   Test Files  2 failed | 25 passed (27)
        Tests  9 failed | 276 passed | 1 skipped (286)

  $ cd web && pnpm build
  build exit=0
  ```

  Failures held at the established baseline of 9 (`image-preview.test.tsx` and
  `PostDetail.test.tsx`); passes moved 270 -> 276, which is the 6 new tests. `lint`
  reports zero problems. No `api/` file was touched, so the pytest and ruff baselines
  are unchanged by construction.

- [x] 3.1c-ii `research` **step**: `createStep` with Zod input/output schemas, prompt
  assembled by `buildStagePrompt` (item 3.1a), the agent from item 3.1b, the
  meta-response retry loop from `research_node` (`_REFUSAL_PATTERNS`,
  `_EXPECTED_SECTIONS`, `MAX_RESEARCH_ATTEMPTS`, `_reinforced_prompt`), output persisted
  to `research_content` through `saveStageOutput` (item 3.1c-i), and the parity test
  against the golden fixtures.

  **What was built**

  - `web/src/mastra/steps/stage-io.ts`: the input/output contract every stage step
    shares. Input is `{ postId }` only. A step reads its inputs from the columns
    previous steps committed rather than from the workflow snapshot, which is what
    makes a resume cheap and correct; the snapshot never carries article-sized
    strings. Output is Python's `_stage_meta` (`stage`, `model`, `tokens_in`,
    `tokens_out`, `duration_s`) plus `postId`, so the next step in the chain gets a
    valid input with no mapping step between them.
  - `web/src/mastra/steps/research.ts`: `researchStep` via `createStep` from
    `@mastra/core/workflows/evented` (the same engine the scaffold workflow uses, per
    item 2.4), plus the ported `isValidResearch`, `REFUSAL_PATTERNS`,
    `EXPECTED_SECTIONS`, `MAX_RESEARCH_ATTEMPTS` and `reinforcedPrompt`.
  - `web/src/mastra/post-state.ts` gains `loadInternalLinks` and `loadPipelineState`,
    the read path a step uses: post row plus the profile's crawled links, matching
    `_fetch_internal_links()` in `api/src/worker.py`. A missing post throws rather
    than yielding an empty state, so a bad id cannot bill a provider call for a
    prompt full of empty strings.

  Nothing was registered on the Mastra instance by this item: `createStep` products
  reach the instance through the workflow they are composed into, which is item 4.1.

  **Parity oracle.** The fixture's `post_spec` is inserted into the real
  Alembic-owned database, the step reads it back through drizzle, and the prompt it
  hands the agent is compared byte for byte against the fixture's
  `rendered_prompts[0]`. The provider call is replayed from the fixture's recorded
  response body rather than made live; the live Perplexity call is item 3.1b's smoke
  test, and re-billing a 6k-token research call on every `pnpm test` would prove
  nothing this replay does not. Both database round trips run for real.

  ```
  $ cd web && NO_COLOR=1 pnpm exec vitest run src/mastra/steps/research.test.ts
   RUN  v4.0.18 /Users/cody/.../web

   ✓ src/mastra/steps/research.test.ts (9 tests) 57ms

   Test Files  1 passed (1)
        Tests  9 passed (9)
  ```

  **Negative controls** (each reverted immediately):
  1. `loadRules("research")` -> `loadRules("outline")`: both prompt parity tests red
     with `- # Blog Research Agent` / `+ # Blog Outline Agent` in the diff. Proves the
     comparison is against the real rendered prompt, not a self-consistent rebuild.
  2. `tokensIn +=` -> `tokensIn =`: `AssertionError: expected 1510 to be 1610`. Proves
     the retry test pins Python's sum-across-attempts billing rather than last-call
     billing.
  3. Reworded the retry preamble (`your limitations` -> `your limits`): retry test red
     with the two `IMPORTANT: You must respond with ONLY...` strings differing. Worth
     recording that the first version of this assertion compared against
     `reinforcedPrompt()` itself and stayed green under this control, because both
     sides moved together; it now compares against a `PYTHON_RETRY_PREAMBLE` literal
     copied from `_reinforced_prompt`.
  4. Deleted the `break` out of the retry loop: four tests red, including
     `expected [ ...(3) ] to have a length of 1 but got 3`. Proves a valid first
     response really does stop the loop instead of being re-asked three times.

  **Gates**

  ```
  $ cd web && pnpm exec tsc --noEmit
  tsc exit=0

  $ cd web && pnpm lint
  lint exit=0

  $ cd web && NO_COLOR=1 pnpm test
   Test Files  2 failed | 26 passed (28)
        Tests  9 failed | 285 passed | 1 skipped (295)

  $ cd web && pnpm build
  build exit=0
  ```

  Failures held at the established baseline of 9, still the same two files
  (`image-preview.test.tsx` 6, `PostDetail.test.tsx` 3); passes moved 276 -> 285,
  which is the 9 new tests. No `api/` file was touched, so the pytest and ruff
  baselines are unchanged by construction.

  **Discrepancy noted.** `research_node` publishes four SSE progress lines through
  `publish_stage_log` (rules loaded, calling Perplexity, retry warnings, token
  count). The step logs the retry and degraded-research cases through
  `mastra.getLogger()` but publishes no SSE. The event bus that carries these to the
  dashboard is item 5.5, and Phase 8 reads step progress from Mastra's own stream
  events rather than from hand-published log lines, so wiring a second channel here
  would be building something Phase 8 replaces.
- [x] 3.2 `outline`

  Ported as an agent (`web/src/mastra/agents/outline.ts`, registered on the Mastra
  instance) plus a step (`web/src/mastra/steps/outline.ts`) reusing the item-3.1a
  prompt assembly and the item-3.1c-i posts-table bridge. Unlike `research` this
  stage has no validator and no retry loop, so the step is one provider call
  wrapped in the state contract.

  The shared Claude call settings live in `web/src/mastra/agents/claude.ts`, which
  the remaining three Anthropic stages (`write`, `edit`, `ready`) will reuse: they
  all go through the same `ClaudeClient.chat()` with nothing but `max_tokens` and
  the system message differing.

  ```
  $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/steps/outline.test.ts src/mastra/agents/outline.test.ts
   RUN  v4.0.18 /Users/cody/.../web

   OK src/mastra/steps/outline.test.ts (5 tests) 58ms
   OK src/mastra/agents/outline.test.ts (8 tests | 1 skipped) 74ms

   Test Files  2 passed (2)
        Tests  12 passed | 1 skipped (13)
     Duration  945ms
  ```

  The skipped test is the live Anthropic smoke test, gated on `ANTHROPIC_API_KEY`
  so the default `pnpm test` needs no credentials. Run with the real key:

  ```
  $ cd web && ANTHROPIC_API_KEY=<redacted> NO_COLOR=1 pnpm vitest run \
      src/mastra/agents/outline.test.ts -t "live smoke"
   OK src/mastra/agents/outline.test.ts (8 tests | 7 skipped) 2082ms
       OK reaches Anthropic and reports back the configured model id  2063ms

   Test Files  1 passed (1)
        Tests  1 passed | 7 skipped (8)
  ```

  That asserts `response.modelId === "claude-opus-4-6"`, so `anthropic/claude-opus-4-6`
  resolves through Mastra's model router against the live API. The model choice
  itself is still the incumbent; item 6.1 owns picking and justifying a better one.

  **Provider request parity, and the token-budget divergence it exposed.**
  `outline` is the first stage whose provider request carries more than a model and
  a system message. Python enables extended thinking
  (`thinking={"type": "enabled", "budget_tokens": 10000}`) and computes
  `max_tokens = max(8000, 10000 + 1024) = 11024`, treating `max_tokens` as the
  total budget the way Anthropic's API does. The AI SDK provider inside
  `@mastra/core` instead treats `maxOutputTokens` as the **text** budget and puts
  `max_tokens = maxOutputTokens + budget_tokens` on the wire
  (`node_modules/@mastra/core/dist/dist-BcUqNSEb.js`:
  `baseArgs.max_tokens = maxTokens + (thinkingBudget != null ? thinkingBudget : 0)`).
  Passing Python's 11024 straight through would have sent 21024. `claudeStageOptions`
  subtracts the thinking budget so both stacks send 11024.

  `agents/outline.test.ts` proves that on the real serialized request rather than on
  the agent's configuration: it swaps `globalThis.fetch`, runs `agent.generate()`,
  and compares the captured body against the request recorded in the golden fixture.

  Negative control, dropping the subtraction in `claudeStageOptions`:

  ```
  $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/agents/outline.test.ts
       x puts Python's model, max_tokens and thinking budget on the wire 60ms
    AssertionError: expected 21024 to be 11024 // Object.is equality
        Tests  1 failed | 6 passed | 1 skipped (8)
  ```

  Negative control, not seeding the chain input (`researchContent: null`) so the
  step renders without the research document the previous stage committed:

  ```
  $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/steps/outline.test.ts
       x sends the prompt the Python stage sent for how-to-choose-a-crm-for-a-small-team
       x sends the prompt the Python stage sent for best-time-tracking-tools-for-agencies
       x carries the research document the previous stage committed
       x commits the outline to its column and reports Python's stage meta
       OK fails loudly on a post that does not exist rather than billing a call
        Tests  4 failed | 1 passed (5)
  ```

  Frontend gates:

  ```
  $ cd web && pnpm tsc --noEmit
  tsc exit=0

  $ cd web && NO_COLOR=1 pnpm lint
  lint exit=0

  $ cd web && NO_COLOR=1 pnpm test
   Test Files  2 failed | 28 passed (30)
        Tests  9 failed | 297 passed | 2 skipped (308)

  $ cd web && pnpm build
  build exit=0
  ```

  Failures held at the established baseline of 9, still the same two files
  (`image-preview.test.tsx` 6, `PostDetail.test.tsx` 3); passes moved 285 -> 297,
  which is the 12 new tests, and skips moved 1 -> 2, which is the live smoke test.
  No `api/` file was touched, so the pytest and ruff baselines are unchanged by
  construction.

  **Discrepancies noted.**
  1. Python's Anthropic SDK sends `system` as a bare string; the AI SDK sends the
     same text as `[{"type": "text", "text": ...}]`. Anthropic accepts both, so the
     test compares the text and not the shape.
  2. A `url` override on the model config is **not** a way to capture an Anthropic
     request: it routes the agent through Mastra's OpenAI-compatible client, which
     POSTs to `/chat/completions` and passes `budgetTokens` through unconverted.
     Only `globalThis.fetch` capture exercises the native provider.
  3. `outline_node` publishes three SSE progress lines through `publish_stage_log`;
     the step publishes none, for the same reason recorded under item 3.1c-ii (the
     event bus is item 5.5 and Phase 8 reads progress from Mastra's stream events).
  4. The step test seeds no internal links. `buildStagePrompt` offers them to `edit`
     only, so they cannot affect this stage's prompt; `edit`'s parity test (item 3.4)
     is where the link inventory has to be seeded for real.
- [x] 3.3 `write`

  Ported as an agent (`web/src/mastra/agents/write.ts`, registered on the Mastra
  instance) plus a step (`web/src/mastra/steps/write.ts`). Structurally the same as
  `outline`: no validator, no retry loop, one Claude call wrapped in the state
  contract, reusing the item-3.1a prompt assembly, the item-3.1c-i posts-table
  bridge and the shared `agents/claude.ts` call settings. What differs is the chain
  input (`posts.outline_content` rather than `posts.research_content`), the token
  budget and the column the draft is committed to (`posts.draft_content`).

  ```
  $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/steps/write.test.ts src/mastra/agents/write.test.ts
   RUN  v4.0.18 /Users/cody/.../web

   OK src/mastra/steps/write.test.ts (6 tests) 69ms
   OK src/mastra/agents/write.test.ts (8 tests | 1 skipped) 73ms

   Test Files  2 passed (2)
        Tests  13 passed | 1 skipped (14)
     Duration  970ms
  ```

  The skipped test is the live Anthropic smoke test, gated on `ANTHROPIC_API_KEY`
  so the default `pnpm test` needs no credentials. Run with the real key:

  ```
  $ cd web && ANTHROPIC_API_KEY=<redacted> NO_COLOR=1 pnpm vitest run \
      src/mastra/agents/write.test.ts -t "live smoke"
   OK src/mastra/agents/write.test.ts (8 tests | 7 skipped) 1928ms
       OK reaches Anthropic and reports back the configured model id  1910ms

   Test Files  1 passed (1)
        Tests  1 passed | 7 skipped (8)
  ```

  That asserts `response.modelId === "claude-opus-4-6"`, so `anthropic/claude-opus-4-6`
  resolves through Mastra's model router against the live API. The model choice is
  still the incumbent; item 6.1 owns picking and justifying a better one.

  **The other branch of the token-budget divergence.** Item 3.2 recorded that
  Python's `effective_max = max(max_tokens, thinking_budget + 1024)` and the AI SDK's
  `max_tokens = maxOutputTokens + budget_tokens` only agree because
  `claudeStageOptions` subtracts the budget. `outline`'s 8000 exercises the clamped
  branch (raised to the 11024 floor); `write`'s 16000 is the first stage that clears
  the floor, so it exercises the pass-through branch and pins `max_tokens = 16000`
  on the wire against the golden fixture. Both branches are now covered.

  **The internal-link inventory is withheld from `write`, and that is now pinned.**
  The `how-to-choose-a-crm-for-a-small-team` fixture was captured with three internal
  links in `state["internal_links"]` and its recorded prompt has no link section,
  because `build_stage_prompt` offers links to `edit` only. So this step's test seeds
  a real `website_profiles` row and three real `internal_links` rows, attaches the
  post to that profile, and asserts the prompt still matches byte for byte and
  contains neither the heading nor any of the three URLs. The second fixture has no
  links and stays unattached, so the no-links path through `stateFromPost` is still
  covered.

  Negative control, seeding `outlineContent: null` so the step renders without the
  outline the previous stage committed:

  ```
  $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/steps/write.test.ts
       x sends the prompt the Python stage sent for how-to-choose-a-crm-for-a-small-team
       x sends the prompt the Python stage sent for best-time-tracking-tools-for-agencies
       x carries the outline the previous stage committed, not the research
       OK withholds the internal-link inventory even when the post has links
       x commits the draft to its column and reports Python's stage meta
       OK fails loudly on a post that does not exist rather than billing a call
        Tests  4 failed | 2 passed (6)
  ```

  Negative control, extending `buildStagePrompt`'s link condition from
  `stage === "edit"` to `stage === "edit" || stage === "write"`. Both the
  withholding test and the first fixture's byte-parity test go red, which also
  proves the seeded links really reach the prompt path rather than the assertion
  passing vacuously:

  ```
  $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/steps/write.test.ts
       x sends the prompt the Python stage sent for how-to-choose-a-crm-for-a-small-team
       OK sends the prompt the Python stage sent for best-time-tracking-tools-for-agencies
       OK carries the outline the previous stage committed, not the research
       x withholds the internal-link inventory even when the post has links
       OK commits the draft to its column and reports Python's stage meta
       OK fails loudly on a post that does not exist rather than billing a call
    AssertionError: expected '# Blog Writing Agent...' not to contain 'Available Internal Links'
        Tests  2 failed | 4 passed (6)
  ```

  Negative control, `WRITE_MAX_TOKENS` set to `outline`'s 8000 so the clamp applies:

  ```
  $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/agents/write.test.ts
       x puts Python's model, max_tokens and thinking budget on the wire 53ms
       x passes 16000 through untouched because it clears the thinking floor 0ms
    AssertionError: expected 11024 to be 16000 // Object.is equality
    AssertionError: expected 8000 to be 16000 // Object.is equality
        Tests  2 failed | 5 passed | 1 skipped (8)
  ```

  Frontend gates:

  ```
  $ cd web && pnpm tsc --noEmit
  tsc exit=0

  $ cd web && NO_COLOR=1 pnpm lint
  lint exit=0

  $ cd web && NO_COLOR=1 pnpm test
   Test Files  2 failed | 30 passed (32)
        Tests  9 failed | 310 passed | 3 skipped (322)

  $ cd web && pnpm build
  build exit=0
  ```

  Failures held at the established baseline of 9, still the same two files
  (`image-preview.test.tsx` 6, `PostDetail.test.tsx` 3); passes moved 297 -> 310,
  which is the 13 new tests, and skips moved 2 -> 3, which is the live smoke test.
  No `api/` file was touched, so the pytest and ruff baselines are unchanged by
  construction.

  **Discrepancies noted.**
  1. Python builds `write_node`'s `system=` by concatenating five adjacent string
     literals; `WRITE_SYSTEM_MESSAGE` reproduces the concatenation with the same
     splits, and both golden fixtures' recorded `system` are asserted equal to it.
  2. `write_node` publishes three SSE progress lines through `publish_stage_log`;
     the step publishes none, for the same reason recorded under item 3.1c-ii.
  3. The `system`-as-block-list and `url`-override discrepancies recorded under item
     3.2 apply unchanged here; they are properties of the shared Anthropic path, not
     of this stage.
- [x] 3.4 `edit`. Split, because `edit_node` is the only stage that computes prompt content
  from two services the port does not yet have: `compute_analytics` (which reaches into
  `textstat` for sentence counts and Flesch reading ease) and `validate_links`. Both feed
  numbers straight into the rendered prompt, so byte-exact prompt parity for this stage
  cannot be reached without porting them first.
  - [x] 3.4a `textstat` readability primitives (`count_words`, `count_sentences`,
    `count_syllables`, `words_per_sentence`, `syllables_per_word`, `flesch_reading_ease`)
    ported to TypeScript, including the `pyphen` hyphenator and the CMU pronouncing
    dictionary they read, with exhaustive parity against the installed Python
    implementation.

    **Why this is its own item**

    `compute_analytics` calls two textstat entry points, `sentence_count()` and
    `flesch_reading_ease()`, and prints both numbers into the edit prompt
    (`- **Flesch Reading Ease:** {analytics.flesch_reading_ease}`). Byte-exact
    prompt parity therefore needs textstat's arithmetic reproduced exactly, and
    that arithmetic bottoms out in two data sets: the CMU pronouncing dictionary
    (reached through `nltk`) and `pyphen`'s `hyph_en_US.dic` TeX patterns, which
    `count_syllables` falls back to for out-of-vocabulary words. The usual
    JavaScript syllable heuristics disagree with the CMU dictionary on ordinary
    words, and one syllable across a 2,000 word draft moves the Flesch score by
    enough to change the rendered digit, so an approximation is not usable here.

    **What was built**

    - `api/scripts/export_textstat_data.py`: freezes what Python reads into
      `web/src/mastra/textstat/data/`. It writes `cmudict-syllables.txt.gz`
      (`word -> syllables in the first pronunciation`, 123,455 entries, 388 KB
      gzipped), copies `hyph_en_US.dic` and its licence notice verbatim out of the
      installed `pyphen`, and writes `textstat-parity.json`, the oracle. The data
      files are frozen rather than pulled from npm because no JavaScript package
      guarantees the same revision of either data set, and because both vanish
      from this repo when `api/` is deleted in Phase 7.
    - `web/src/mastra/textstat/hyphenator.ts`: port of `pyphen`'s `HyphDict` and
      `Pyphen.positions`, at `left=2` / `right=2` (pyphen's constructor defaults,
      which it applies in preference to the `LEFTHYPHENMIN` / `RIGHTHYPHENMIN`
      directives inside the dictionary file). Only `positions()` is ported;
      `iterate`, `wrap` and `inserted` have no consumer in `count_syllables`.
    - `web/src/mastra/textstat/index.ts`: `pythonSplit`, `removePunctuation`,
      `listWords`, `countWords`, `countSentences`, `cmuSyllables`,
      `countSyllables`, `wordsPerSentence`, `syllablesPerWord`,
      `fleschReadingEase`.
    - `web/src/mastra/textstat/textstat.test.ts`: 52 parity tests.

    **How the parity is proved**

    The centrepiece is a SHA-256 over an exhaustive table rather than a sample:
    every CMU dictionary word with its syllable count and its `pyphen` hyphenation
    positions, `<word>\t<syllables>\t<comma-joined positions>` per line, sorted,
    joined by `\n`. Python writes the digest, TypeScript rebuilds the table from
    the two frozen files and compares. That proves the port over 123,455 real
    words from a 20 KB assertion. Recording positions rather than their count
    means a port that reaches the right count for the wrong reason still fails.

    On top of the digest: the 400 golden-fixture words that miss the CMU
    dictionary (the only words that reach the hyphenator in real content), a
    150-word readable sample so a digest mismatch is debuggable, and 41 whole-text
    expectations, 29 of which are the real research documents, outlines, drafts
    and final markdown captured in `docs/mastra-port/golden/`.

    ```
    $ cd web && pnpm vitest run src/mastra/textstat/textstat.test.ts
     RUN  v4.0.18 /Users/cody/.../objective-port-jena-46c1e6-1/web

     v src/mastra/textstat/textstat.test.ts (52 tests) 522ms

     Test Files  1 passed (1)
          Tests  52 passed (52)
       Start at  22:23:11
       Duration  909ms
    ```

    **Negative controls** (each applied, run, reverted)

    1. `LEFT_HYPHEN_MIN` 2 -> 1 in `hyphenator.ts`: `Tests  34 failed | 18 passed`.
       The digest, the sample, the out-of-vocabulary words and every text carrying
       an out-of-vocabulary word all go red.
    2. `PY_WHITESPACE` replaced by JavaScript's `\s`:
       `Tests  1 failed | 51 passed`, on the assertion that pins Python's
       whitespace set against JavaScript's.
    3. The Unicode word-boundary emulation in `SENTENCE` replaced by JavaScript's
       `\b`: `Tests  1 failed | 51 passed`, on
       `unicode-initial-single-letter-word`.
    4. `countSyllables` forced down the hyphenator path, ignoring the CMU
       dictionary: `Tests  30 failed | 21 passed`.

    Control 3 initially passed, which was informative: the golden fixtures and the
    first set of hand-written cases never place a non-ASCII letter where the two
    engines' `\b` disagree, so the emulation was untested. A case was added to the
    exporter (`"A" ist gut. Das war alles was wir sagen wollten.` with a leading
    single-letter umlaut word) where Python counts 2 sentences and JavaScript's
    `\b` counts 1, and the control then failed as it should.

    One control was applied and did **not** fail, and the code was corrected rather
    than the control discarded: dropping the trailing zero-length pair from
    `parsePattern` (Python's `re.findall` emits one at end of string) changes
    nothing, because that pair only ever appends a zero value and the caller chops
    trailing zeros. The pair is kept for readability against `re.findall`, and its
    comment now says it is not load-bearing instead of claiming it is.

    **Recorded discrepancies**

    1. Python's `\w` and Node's `\p{L}\p{N}_` come from different Unicode
       revisions: 4,382 code points (for example `U+1C89`, `U+A7CB`, the
       `U+105C0` block) are word characters to Node and not to Python 3.13.
       Measured by enumerating both classes over the full code point range. None is
       reachable from a blog draft.
    2. Python's `\s` (identical to `str.isspace()`, verified by enumerating both
       over the full range) covers `\x1c`-`\x1f` and `\x85`, which JavaScript's
       `\s` does not, and omits `U+FEFF`, which JavaScript's includes. Spelled out
       as `PY_WHITESPACE` rather than borrowed, and pinned by a test.
    3. `analytics.py` wraps these numbers in Python's `round()`, which is
       round-half-to-even and unlike JavaScript's `Math.round`. That belongs to
       item 3.4b, not here; this module returns the unrounded score, matching
       textstat, whose own rounding is off by default (`__round_points is None`).
    4. The data files are read with `readFileSync` relative to `process.cwd()`,
       the same assumption `rulesDir()` already makes. `next build`'s output file
       tracing does not follow that, so both need handling before the Phase 7
       Railway deploy. Logged in `todo.md` rather than solved here.

    **One defect fixed in passing**, because it made an honest gate reading
    impossible: `research`, `outline` and `write` step tests each seeded the
    golden fixtures' posts under the fixtures' own ids, so vitest running the three
    files in parallel raced on the `posts` primary key. It surfaced as
    `duplicate key value violates unique constraint "posts_pkey"` and
    `post ... not found`, 6 to 9 extra failures depending on scheduling, and it was
    present before this iteration's files existed (verified by moving
    `src/mastra/textstat/` aside and re-running: `Tests  16 failed | 303 passed`).
    Each file now namespaces its rows by rewriting the fixture id's second-to-last
    byte, which no rendered prompt reads.

    ```
    $ cd web && pnpm vitest run src/mastra/steps
     v src/mastra/steps/research.test.ts (9 tests) 63ms
     v src/mastra/steps/write.test.ts (6 tests) 79ms
     Test Files  3 passed (3)
          Tests  20 passed (20)
    ```

    **Gates**

    ```
    $ cd web && pnpm tsc --noEmit ; echo "tsc exit=$?"
    tsc exit=0

    $ cd web && pnpm lint ; echo "lint exit=$?"
    lint exit=0

    $ cd web && pnpm test
     Test Files  2 failed | 31 passed (33)
          Tests  9 failed | 362 passed | 3 skipped (374)

    $ cd web && pnpm build ; echo "build exit=$?"
    build exit=0

    $ cd api && uv run ruff check scripts/export_textstat_data.py ; echo "exit=$?"
    All checks passed!
    exit=0

    $ cd api && uv run ruff format --check scripts/export_textstat_data.py ; echo "exit=$?"
    1 file already formatted
    exit=0

    $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test uv run pytest -q
    125 failed, 236 passed, 25 errors in 14.92s
    ```

    `pnpm test` is 9 failed / 362 passed, which is the recorded failure baseline
    (6 in `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`) unchanged, with
    passes moving 310 -> 362: the 52 new tests. Run three times with identical
    results, where before the step-test fix the same command returned 15, 16 and 18
    failures on consecutive runs. `pytest` is at the Phase 0 baseline of
    125 failed / 235-236 passed / 25 errors; the repo-wide `ruff check .` and
    `ruff format --check .` baselines (41 errors, 10 files) are untouched, and the
    one file this iteration added to `api/` passes both.
  - [x] 3.4b `compute_analytics` (`api/src/services/analytics.py`): `_strip_markdown`,
    keyword density, the SEO checklist, and Python's rounding, with a parity test against
    the golden fixtures' draft content.

    **Why the fixtures are the primary oracle here**

    The captured edit prompts already contain the numbers Python produced, as
    literals: `- **Word Count:** 2128 (target: 1800)`,
    `- **Flesch Reading Ease:** 65.7 (target: 60-70; ...)`,
    `- **Avg Sentence Length:** 15.1 words (target: <20)` and one
    `- **<keyword>:** <density>% (target: 1-2%)` line per keyword, plus a
    `[PASS]` / `[FAIL]` line per boolean check. Nothing in this repo generated
    those digits for the benefit of the test, so the strongest assertion
    available is to recompute them in TypeScript and look them up in the
    captured prompt. That is `describe("golden fixture edit prompts")`, and it
    covers both fixtures.

    **What was built**

    - `web/src/mastra/analytics/index.ts`: `computeAnalytics`, `seoChecklist`,
      `stripMarkdown` and `urlNetloc`, a statement-for-statement port of
      `compute_analytics`, `_seo_checklist` and `_strip_markdown`. The SEO
      checklist keeps Python's insertion order and its mixed value type
      (booleans for the checks, integers for `internal_link_count` and
      `external_link_count`), because `edit_node` renders the dict in order and
      filters on `isinstance(passed, bool)`.
    - `web/src/mastra/analytics/python-round.ts`: `pythonRound`, Python's
      `round(float, ndigits)` in `BigInt` arithmetic over the double's exact
      binary value.
    - `api/scripts/export_analytics_parity.py`: writes
      `web/src/mastra/analytics/data/analytics-parity.json`, the second oracle,
      covering what the fixtures cannot reach.
    - `web/src/mastra/textstat/index.ts`: `pythonStrip` and `PY_WHITESPACE`
      exported so the analytics port spells Python's whitespace class the same
      way rather than re-deriving it; `pythonSplit` now calls `pythonStrip`.

    **Three Python primitives that do not survive a naive translation**

    1. `round()` is round-half-to-even over the double's *exact binary value*.
       JavaScript has no equivalent: `Math.round` breaks ties upward and
       `Number.prototype.toFixed` breaks them away from zero. This is reachable
       from real data, not just theory: `avg_sentence_length` is
       `word_count / sentence_count`, so a 405 word draft with 20 sentences is
       exactly `20.25`, and Python prints `20.2` where `toFixed(1)` prints
       `20.3`. A double is an exact tie at `n` decimals only when it is
       `odd / 2**k` with `k <= n + 1`, so `pythonRound` compares the true
       remainder in `BigInt` rather than re-parsing a decimal approximation.
       Verified against 52 exported `round()` results including every tie of
       that form at 1 and 2 decimals.
    2. `re.MULTILINE`'s `^` matches only after `\n`. JavaScript's `m` flag also
       matches after `\r`, `U+2028` and `U+2029`. Every multiline anchor in the
       port is written `(?:^|(?<=\n))` and the `m` flag is never used, so
       `Carriage return\r## not a heading in Python` stays body text in both
       stacks.
    3. Python's `.` excludes `\n` alone; JavaScript's excludes `\r`, `U+2028`
       and `U+2029` too. Written as `[^\n]`. This one is not observable through
       `compute_analytics`'s output (the H2 captures only feed substring tests
       and a count), and it is ported faithfully anyway.

    Also ported rather than approximated: `str.count` is non-overlapping, and
    `urlparse(url).netloc` is empty for a URL with no `//`, so a profile whose
    `website_url` is a bare `example.com` classifies every link as external.
    Both are pinned by tests, the second against 17 exported `urlparse` results.

    **Test run**

    ```
    $ cd web && pnpm vitest run src/mastra/analytics/analytics.test.ts
     RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web

     ✓ src/mastra/analytics/analytics.test.ts (46 tests) 48ms

     Test Files  1 passed (1)
          Tests  46 passed (46)
    ```

    46 tests: 4 on `pythonRound`, 1 comparing `urlNetloc` against all 17
    exported `urlparse` results, 17 comparing `computeAnalytics` against the
    exported `compute_analytics` results, 16 comparing `stripMarkdown` against
    the exported `_strip_markdown` output, 2 reading the analytics literals back
    out of the captured edit prompts, 5 pinning the Python primitives above, and
    1 asserting the oracle file is the one this test expects.

    **Oracle regeneration**

    ```
    $ cd api && uv run python scripts/export_analytics_parity.py
    wrote web/src/mastra/analytics/data/analytics-parity.json: 17 cases, 52 round cases, 17 netloc cases
    ```

    **Four negative controls, applied and reverted**

    ```
    == NC1: toFixed instead of round-half-even ==
          Tests  2 failed | 44 passed (46)
    == NC2: JavaScript m flag for the multiline anchors ==
          Tests  4 failed | 42 passed (46)
    == NC3: overlapping substring count ==
          Tests  1 failed | 45 passed (46)
    == NC4: permissive netloc (bare host treated as authority) ==
          Tests  3 failed | 43 passed (46)
    == reverted ==
          Tests  46 passed (46)
    ```

    NC1 is the honest one to read carefully: swapping `pythonRound` for
    `Number(value.toFixed(ndigits))` fails only the two dedicated tie tests and
    leaves all 17 fixture and golden cases green. The captured drafts never land
    on an exact tie, which is precisely why the 52 exported `round()` results
    exist rather than trusting the fixtures to cover it.

    **Gates**

    ```
    $ cd web && pnpm tsc --noEmit          # exit 0, no output
    $ cd web && pnpm lint                  # exit 0, no output
    $ cd web && pnpm test
     Test Files  2 failed | 32 passed (34)
          Tests  9 failed | 408 passed | 3 skipped (420)
    $ cd web && pnpm build
    ✓ Compiled successfully in 3.1s
    ```

    `pnpm test` is 9 failed, the recorded failure baseline (6 in
    `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`) unchanged, with passes
    moving 362 -> 408: the 46 new tests. The 3 skipped are the live-provider
    smoke tests, which need keys this worktree does not carry. `db` and `redis`
    must be up for an honest reading: with them down the same command reports
    15 failed files and 73 skipped tests, which is a missing datastore and not a
    regression.

    ```
    $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test uv run pytest -q
    125 failed, 236 passed, 25 errors in 15.08s
    $ cd api && uv run ruff check scripts/export_analytics_parity.py
    All checks passed!
    $ cd api && uv run ruff format --check scripts/export_analytics_parity.py
    1 file already formatted
    ```

    `pytest` is at the Phase 0 baseline. The repo-wide `ruff check .` and
    `ruff format --check .` baselines are untouched; the one file this iteration
    added to `api/` passes both.

    **Discrepancies recorded, not fixed**

    1. `edit_node` renders the floats with an f-string, so `str(float)` always
       carries a decimal point and a density of exactly zero prints `0.0%` where
       JavaScript's `String(0)` gives `0%`. The golden fixture
       `how-to-choose-a-crm-for-a-small-team` contains
       `- **crm comparison:** 0.0%`, so item 3.4e needs a production
       `str(float)` shim; this item's test carries a local one.
    2. Python's `str.lower()` and JavaScript's `toLowerCase()` are not the same
       function for every code point. Both fixtures' keywords and headings are
       ASCII, so nothing here discriminates between them. If a non-ASCII keyword
       ever appears, this is the first place to look.
    3. `tsconfig.json` targets ES2017, where BigInt *literals* (`0n`) are a type
       error even though `lib: esnext` provides the type. `pythonRound` names its
       constants through `BigInt(...)` rather than raising the app-wide target.
  - [x] 3.4c `validate_links` (`api/src/services/link_validator.py`).

    **Why this needed its own oracle shape**

    `link_validator` is the only service in the pipeline that reaches the
    network, so it cannot be pinned by a table of inputs and outputs the way
    `analytics-parity.json` pins `compute_analytics`. The oracle is therefore
    split in two, both halves written by one script:

    1. **Network cases.** Python stands up a local HTTP server whose routes
       return exactly the status codes the stripper cares about (404, 410 and
       451 strip; 200, 418 and 500 keep), plus a 301 to a 410, a 302 to a 200, a
       refused connection on a closed port, and a route that sleeps past
       `_REQUEST_TIMEOUT`. It runs the real `validate_links` against them and
       records the resulting content and `removed` list with the base URL
       templated back to `{BASE}`. The vitest file stands up the equivalent
       server in Node on its own port and runs the TypeScript port against it.
       Nothing is mocked on either side: both implementations open real sockets
       to a real server.
    2. **Extraction and strip cases.** `_MD_LINK_RE.findall` and the `re.sub`
       loop are pure, so they are exported as plain input/output tables. The
       eight golden cases carry a pointer into `docs/mastra-port/golden/`
       instead of a copy of the text, so the test reads the real captured stage
       content rather than a transcription made for its benefit.

    **What was built**

    - `web/src/mastra/links/index.ts`: `validateLinks`, plus `findMarkdownLinks`
      and `stripDeadLinks` exported because they are the pure half of the module
      and therefore the half a test can pin exactly. `CONCURRENCY_LIMIT` and
      `REQUEST_TIMEOUT_MS` mirror `_SEMAPHORE_LIMIT` and `_REQUEST_TIMEOUT`.
    - `api/scripts/export_link_validator_parity.py`: writes
      `web/src/mastra/links/data/link-validator-parity.json` (16 KB): 22 network
      cases, 22 extraction cases, 9 strip cases.
    - `web/src/mastra/links/links.test.ts`: 57 tests.

    **Four details that do not survive a naive translation**

    1. `re.escape` escapes a superset of what a JavaScript regex needs, but the
       two agree on every character that is actually special outside a character
       class, so `escapeRegExp` escapes the JavaScript set and the `u` flag is
       never used. Under `u`, `\&` is a SyntaxError rather than an identity
       escape, so escaping Python's full set would not even compile.
    2. `re.sub`'s replacement `\1` inserts the captured text verbatim.
       `String.prototype.replace` with `"$1"` also inserts it verbatim, but a
       `$&`, `$1`, `` $` `` or `$'` *inside the captured link text* is a
       replacement special only if the text is used as the replacement pattern.
       It is not, and a dedicated test pins that.
    3. `str.startswith(("http://", "https://"))` is case-sensitive, so a link
       written `HTTP://...` is never checked and never stripped. Pinned by the
       `uppercase-scheme` case.
    4. Python iterates `dead_urls`, a `set`, whose iteration order is
       hash-randomised per process. The substitutions are independent for every
       URL, so the order is unobservable for any content this pipeline produces;
       the port substitutes in first-appearance order so it is deterministic at
       all. The `removed` list's order is *not* arbitrary in Python (it comes
       from the `results` dict, which is insertion-ordered), and the port
       reproduces it, pinned by `two-dead-out-of-order` and `mixed`.

    **Recorded discrepancies**

    1. `httpx`'s `timeout=10` is a per-phase budget (connect, read, write, pool
       each get 10s); `AbortSignal.timeout(10_000)` is a deadline over the whole
       request. A server that dribbles a response for more than 10s total
       without ever stalling 10s in one phase is answered by Python and aborted
       here. Both branches keep the link unless the slow answer was a 404, so
       the divergence is in the conservative direction. Not reachable through
       the fixtures.
    2. `validate_links` calls `logger.warning(f"Dead link ({status}): {url}")`
       per dead URL. The port logs nothing: `edit_node` separately publishes a
       `Stripped N dead link(s): ...` SSE line from the returned `removed` list,
       and that line is item 3.4e's business, for the same reason recorded under
       item 3.1c-ii.
    3. `strip_dead_links_html` is deliberately not ported. It has no caller
       anywhere in the repo outside its own pytest:

       ```
       $ grep -rn "strip_dead_links_html" --include='*.py' --include='*.ts' --include='*.tsx' . | grep -v node_modules
       api/tests/phase9/test_link_validator.py:8:    strip_dead_links_html,
       api/tests/phase9/test_link_validator.py:138:def test_strip_dead_links_html():
       api/tests/phase9/test_link_validator.py:140:    result = strip_dead_links_html(html, {"https://dead.com"})
       api/tests/phase9/test_link_validator.py:147:    result = strip_dead_links_html(html, {"https://dead.com"})
       api/src/services/link_validator.py:110:def strip_dead_links_html(html: str, dead_urls: set[str]) -> str:
       ```

       The WordPress HTML path (`wp_html.py`) does not use it. Porting it would
       be speculative; if a caller appears before Phase 7 deletes `api/`, the
       Python source is the reference.

    **The concurrency probe, and why the first reading was wrong**

    `_SEMAPHORE_LIMIT` is pinned by a case with 12 links to a route that sleeps
    0.3s, with the server recording the highest number of simultaneous in-flight
    requests. The first Python run reported 6 for a limit of 5, from two
    separate measurement bugs rather than from `asyncio.Semaphore`:

    - counting a request as in flight across the response *write* leaves the
      handler thread counted after the client has already been answered and
      released its slot, so the next request overlaps it. Fixed by releasing the
      counter before responding.
    - the `/hang` route sleeps 12s but the client gives up at 10s, so its
      handler thread was still holding a slot open during the case that ran
      next. Fixed by not counting `/hang` at all.

    With both fixed the reading is exactly 5, twice in a row, and the Node
    server reproduces the same 5.

    **Test run**

    ```
    $ cd web && npx vitest run src/mastra/links/links.test.ts
     RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web

     ✓ src/mastra/links/links.test.ts (57 tests) 10954ms
         ✓ matches Python for timeout  10003ms
         ✓ matches Python for semaphore-probe  914ms

     Test Files  1 passed (1)
          Tests  57 passed (57)
       Start at  22:53:48
       Duration  11.18s (transform 27ms, setup 129ms, import 19ms, tests 10.95s, environment 0ms)
    ```

    The 10s case is the real `REQUEST_TIMEOUT_MS` elapsing against a route that
    never answers. It asserts both that the link survives and that the wait
    ended at the deadline rather than at the server's 12s sleep, so a port with
    no timeout at all fails it.

    **Negative controls, each applied then reverted**

    ```
    $ # DEAD_STATUSES gains 500
    FAIL  matches Python for kept-500
    $ # redirect: "manual" instead of "follow"
    FAIL  matches Python for redirect-to-dead
    $ # url.toLowerCase().startsWith(...) instead of url.startsWith(...)
    FAIL  matches Python for uppercase-scheme
    $ # escapeRegExp returns its argument unchanged
    FAIL  matches Python for regex-special-url
    FAIL  matches re.sub for regex-special
    $ # CONCURRENCY_LIMIT raised from 5 to 8
    FAIL  matches Python for semaphore-probe
    FAIL  admits exactly CONCURRENCY_LIMIT requests at a time
    $ # the AbortSignal.timeout line deleted
    FAIL  matches Python for timeout
    $ # the per-URL text list deduplicated through a Set
    FAIL  matches Python for duplicate-url-same-text
    $ # urls checked in .sort() order instead of first-appearance order
    FAIL  matches Python for mixed
    FAIL  matches Python for two-dead-out-of-order
    ```

    The Set control is the informative one: it *passed* against the original
    case list, because `duplicate-url` used two different link texts for the
    same URL and a Set therefore collapsed nothing. Two cases were added to the
    oracle to close that hole (`duplicate-url-same-text`, which repeats both the
    URL and the text, and `two-dead-out-of-order`, whose two dead URLs are in
    reverse alphabetical order), and the control fails against them.

    **Gates**

    ```
    $ cd web && npx tsc --noEmit
    tsc exit=0
    $ cd web && pnpm lint
    > content-pipeline-dashboard@0.1.0 lint
    > eslint
    (no output)
    $ cd web && pnpm test
     Test Files  2 failed | 33 passed (35)
          Tests  9 failed | 465 passed | 3 skipped (477)
    $ cd web && pnpm build
    (succeeded; route table printed)
    $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test .venv/bin/pytest -q
    125 failed, 236 passed, 25 errors in 15.15s
    $ cd api && .venv/bin/ruff check scripts/export_link_validator_parity.py
    All checks passed!
    $ cd api && .venv/bin/ruff format --check scripts/export_link_validator_parity.py
    1 file already formatted
    ```

    `pnpm test` is 9 failed, the recorded failure baseline (6 in
    `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`) unchanged, with passes
    moving 408 -> 465: the 57 new tests. `pytest` is at the Phase 0 baseline of
    125 failed / 236 passed / 25 errors. The repo-wide `ruff check .` baseline of
    32 errors is untouched; the one file this iteration added to `api/` passes
    both ruff gates.
  - [x] 3.4d `edit` **agent**: system message, model id, `max_tokens`, wire-payload parity
    against the golden fixtures' recorded Anthropic request.

    **What was built**

    - `web/src/mastra/agents/edit.ts`: `editAgent`, the provider-facing half of
      `edit_node`. `EDIT_SYSTEM_MESSAGE` reproduces Python's twelve adjacent
      string literals with the same splits, `EDIT_MAX_TOKENS` is Python's
      `max_tokens=16000`, `EDIT_MODEL_ID` is the incumbent
      `anthropic/claude-opus-4-6`, and the credential is resolved per call
      through `requireApiKey` so no key enters `RequestContext`, the Redis event
      payloads or the Postgres workflow snapshots. Extended thinking comes from
      the shared `claudeStageOptions`, as for `outline`, `write` and (later)
      `ready`.
    - `EDIT_FORMAT_INSTRUCTION` is spelled out as its own constant because
      `edit_node` is the only stage that names a `format_instruction`. In Python
      it is a local variable, which reads like a branch point; the comment above
      it records that it is not one (the stage always emits Markdown, with the
      WordPress HTML conversion deferred to publish time).
    - Registered on the Mastra instance as `agents.edit`.
    - `web/src/mastra/agents/edit.test.ts`: 10 tests, 9 of which run without
      credentials.

    **Divergences recorded, not fixed**

    1. The `system`-as-block-list divergence recorded under item 3.2 applies
       unchanged: Python sends `system` as a bare string, the AI SDK sends the
       same text as a one-element `[{type: "text", text}]` list. The test asserts
       the AI SDK shape against the fixture's string, so the text is pinned even
       though the envelope differs.
    2. `edit_node` publishes three `publish_stage_log` progress lines plus up to
       three warning lines; the agent publishes none, for the same reason
       recorded under item 3.1c-ii. The warnings themselves are the step's
       business, item 3.4e.
    3. `EDIT_SYSTEM_MESSAGE` contains two literal U+2014 em-dashes, because the
       Python string does and this port must not change the bytes the provider
       sees. This is the one place the repo's own no-em-dash writing rule is
       deliberately not applied; the file says so at the constant.

    **Evidence**

    ```
    $ docker compose up -d db redis
    $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/agents/edit.test.ts
     OK src/mastra/agents/edit.test.ts (10 tests | 1 skipped) 90ms

     Test Files  1 passed (1)
          Tests  9 passed | 1 skipped (10)
       Duration  925ms
    ```

    The skipped test is the live Anthropic smoke test, gated on
    `ANTHROPIC_API_KEY` so the default `pnpm test` needs no credentials. Run
    with the real key, which is what confirms `claude-opus-4-6` still resolves:

    ```
    $ cd web && ANTHROPIC_API_KEY=<redacted> NO_COLOR=1 pnpm vitest run \
        src/mastra/agents/edit.test.ts -t "live smoke"
     OK src/mastra/agents/edit.test.ts (10 tests | 9 skipped) 2074ms
         OK reaches Anthropic and reports back the configured model id  2056ms

     Test Files  1 passed (1)
          Tests  1 passed | 9 skipped (10)
       Duration  2.96s
    ```

    **Negative controls**, each applied to `agents/edit.ts` (or `index.ts`) and
    reverted; every one turned the suite red:

    | mutation | result |
    | --- | --- |
    | requirement 1's em-dash replaced with a hyphen | FAIL |
    | the `\n` after requirement 1 replaced with a space | FAIL |
    | `EDIT_FORMAT_INSTRUCTION` suffix replaced with `""` | FAIL |
    | `EDIT_MAX_TOKENS` 16000 -> 8000 | FAIL |
    | model id opus -> sonnet | FAIL |
    | trailing space dropped after `blog editor and SEO specialist.` | FAIL |
    | `edit: editAgent` removed from the Mastra instance | FAIL |

    **Gates**

    ```
    $ cd web && pnpm tsc --noEmit
    (exit 0, no output)
    $ cd web && pnpm lint
    (exit 0, no output)
    $ cd web && pnpm build
    (exit 0)
    $ cd web && NO_COLOR=1 pnpm test
     Test Files  2 failed | 34 passed (36)
          Tests  9 failed | 474 passed | 4 skipped (487)
    ```

    `pnpm test` is 9 failed, the recorded failure baseline (6 in
    `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`) unchanged, with passes
    moving 465 -> 474 (the 9 new credential-free tests) and skips 3 -> 4 (the
    new live smoke test).

    ```
    $ cd api && set -a && . ../.env && set +a && uv run pytest -q
    125 failed, 236 passed, 25 errors in 15.08s
    $ cd api && uv run ruff check .
    Found 32 errors.
    ```

    Both at the Phase 0 baseline; no file under `api/` was touched this
    iteration. Note for future iterations: `pytest` must be run with `.env`
    sourced. This worktree's Postgres is on `POSTGRES_HOST_PORT=5435`, while
    `api/tests/conftest.py` falls back to `localhost:5433` when
    `TEST_DATABASE_URL` is unset, which points at a different Postgres and turns
    the baseline into `4 failed, 205 passed, 177 errors` with
    `InvalidPasswordError` rather than a real regression.
  - [x] 3.4e `edit` **step**: `createStep`, the analytics section appended to the prompt,
    the post-edit validation warnings, persistence to `final_md`, and the prompt-parity
    test against both golden fixtures.

    **What was built**

    - `web/src/mastra/steps/edit.ts`: `editStep`, plus the two pure functions it
      is built from. `buildAnalyticsSection` is `_build_analytics_section` and
      `editOutputWarnings` is `_validate_edit_output`, the latter returning its
      warnings rather than publishing them so they are assertable without a
      logger spy. The step's own body is Python's ordering exactly: load state,
      render the rules prompt, append the analytics section behind
      `\n\n---\n\n`, call the agent, warn on the output, validate links, commit
      to `final_md`, return `_stage_meta`.
    - `web/src/mastra/analytics/python-float.ts`: `pythonFloat`, the production
      `str(float)` shim item 3.4b said this item would need. Three of
      `compute_analytics`'s numbers are interpolated into the prompt with an
      f-string, and Python's float repr always carries a decimal point where
      JavaScript's does not.
    - `web/src/mastra/steps/edit.test.ts`: 14 tests, all credential-free, all
      against the real Alembic-owned database.

    **Why this stage's prompt test proves more than the three before it**

    `research`, `outline` and `write` render prompts assembled entirely from
    columns and `rules/*.md`. Roughly a kilobyte of the `edit` prompt is
    *computed*: the analytics section is `compute_analytics` over the draft the
    `write` stage committed, so a byte-exact prompt match here is simultaneously
    an end-to-end check of the item 3.4a textstat port, the item 3.4b analytics
    port and Python's float formatting. Both fixtures are load-bearing and in
    different ways: `how-to-choose-a-crm-for-a-small-team` has three internal
    links (which `edit` alone is offered) and a keyword density of exactly zero,
    which is the `str(float)` case; `best-time-tracking-tools-for-agencies` has
    a Flesch score of 47.8, the only fixture that reaches the `SIMPLIFY` branch
    of the `ACTION REQUIRED` block.

    **Two Python primitives that do not survive a naive translation**

    1. `check.replace("_", " ")` replaces *every* underscore in Python and only
       the *first* in JavaScript, so `keyword_in_title` would render as
       `Keyword In_Title`. Written as `replaceAll`.
    2. `str.title()` is not `capitalize each word`: it uppercases the first
       cased character of each run of cased characters and lowercases the rest,
       which is what turns `keyword_in_first_100_words` into
       `Keyword In First 100 Words`. `pythonTitleAscii` spells that rule out; it
       is ASCII-only because every key `_seo_checklist` produces is ASCII
       snake_case, and the comment says so rather than implying full Unicode
       coverage.

    **Divergences recorded, not fixed**

    1. `edit_node` publishes its warnings (em-dashes, low Flesch, remaining SEO
       failures, stripped dead links) through `publish_stage_log(level=
       "warning")`. The step logs them through `mastra.getLogger()` and
       publishes no SSE, for the reason recorded under item 3.1c-ii: the event
       bus is item 5.5 and Phase 8 reads step progress from Mastra's own stream
       events.
    2. `pythonFloat` deliberately does not implement Python's exponent form.
       Python switches to scientific notation below `1e-4` and writes a
       two-digit exponent (`1e-05`) where JavaScript switches below `1e-7` and
       writes one (`1e-7`), but every value that reaches it has been through
       `pythonRound(x, 1)` or `pythonRound(x, 2)`, so the smallest non-zero
       magnitude reachable is `0.01`. Not guessed at rather than guessed at.
    3. `ACTION REQUIRED — Fix These Failures` carries a literal U+2014, as
       `EDIT_SYSTEM_MESSAGE` does, and for the same reason: it is the bytes the
       provider sees.

    **Evidence**

    ```
    $ docker compose up -d db redis
    $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/steps/edit.test.ts
     OK src/mastra/steps/edit.test.ts (14 tests) 226ms
       OK sends the prompt the Python stage sent for how-to-choose-a-crm-for-a-small-team 51ms
       OK sends the prompt the Python stage sent for best-time-tracking-tools-for-agencies 19ms
       OK offers the internal-link inventory that the earlier stages were denied 14ms
       OK renders a keyword density of exactly zero the way Python's str(float) does 6ms
       OK reaches the SIMPLIFY branch only on the fixture whose Flesch score is under 55 7ms
       OK appends nothing at all when the draft column is empty 14ms
       OK matches the section Python appended, character for character 12ms
       OK warns about em-dashes, readability and the SEO checks the edit left failing 16ms
       OK counts em-dashes in the output the way Python's str.count does 6ms
       OK strips a dead link over real sockets and keeps the live one 19ms
       OK commits the model's own output when link validation throws 14ms
       OK commits the final markdown to its column and reports Python's stage meta 13ms
       OK fails loudly on a post that does not exist rather than billing a call 8ms
       OK returns the empty string for a post with no draft 6ms

     Test Files  1 passed (1)
          Tests  14 passed (14)
    ```

    `validateLinks` reaches the public internet and both fixtures' outputs cite
    real domains, so the module is wrapped rather than replaced: the prompt tests
    hand it a pass-through, and one test clears the stub and drives the real
    implementation over real sockets against a local `node:http` server that
    answers `/gone` with a 404, asserting both that the dead link is stripped
    from the committed column and that the live one survives.

    **Negative controls**, each applied and reverted; every one turned the suite
    red:

    | mutation | result |
    | --- | --- |
    | `pythonFloat` drops the trailing `.0` | 1 failed / 13 passed |
    | `replaceAll("_", " ")` -> `replace("_", " ")` | 3 failed / 11 passed |
    | checklist labels not title-cased | 3 failed / 11 passed |
    | SIMPLIFY threshold 55 -> 45 | 2 failed / 12 passed |
    | analytics separator `\n\n---\n\n` -> `\n\n` | 3 failed / 11 passed |
    | ACTION REQUIRED lines reordered | 3 failed / 11 passed |
    | that heading's em-dash replaced with a hyphen | 3 failed / 11 passed |
    | link counts no longer filtered out of the checklist | 3 failed / 11 passed |
    | raw model output committed instead of the link-stripped content | 1 failed / 13 passed |
    | earlier stages' `stage_status` not merged in | 1 failed / 13 passed |
    | analytics computed over the outline instead of the draft | 3 failed / 11 passed |
    | word-count target hardcoded to 2000 | 3 failed / 11 passed |
    | `validateLinks` failure allowed to propagate | 1 failed / 13 passed |

    One further mutation, computing the analytics over `state.finalMd || draft`,
    stayed green and is recorded here rather than dropped: both fixtures were
    captured with `final_md` empty, so that expression is a no-op against them.
    It is a gap in the fixtures, not in the port.

    **Gates**

    ```
    $ cd web && pnpm tsc --noEmit
    tsc exit=0
    $ cd web && pnpm lint
    lint exit=0
    $ cd web && NO_COLOR=1 pnpm build
    build exit=0
    $ cd web && NO_COLOR=1 pnpm test
     Test Files  2 failed | 35 passed (37)
          Tests  9 failed | 488 passed | 4 skipped (501)
    ```

    `pnpm test` is 9 failed, the recorded failure baseline (6 in
    `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`) unchanged, with passes
    moving 474 -> 488, which is the 14 new tests. Skips stay at 4.

    ```
    $ cd api && set -a && . ../.env && set +a && uv run pytest -q
    125 failed, 236 passed, 25 errors in 15.16s
    $ cd api && uv run ruff check .
    Found 32 errors.
    ```

    Both at the Phase 0 baseline; no file under `api/` was touched this
    iteration.
- [x] 3.5 `images` (identical `image_manifest` JSONB shape; `.foreach()` for per-image
  generation). Split, because `images_node` is the only stage that talks to two providers
  in one step and writes files to disk: Claude produces a manifest, a JSON parser has to
  recover it from prose, a Node image library has to reproduce PIL's WebP output, and
  Gemini generates one image per manifest entry under a concurrency limit. Each of those
  is independently verifiable and none of them shares an oracle with the others.
  - [x] 3.5a `_parse_manifest` ported to TypeScript, with a parity corpus generated by
    calling Python's implementation directly.

    **Why this is its own item**

    `_parse_manifest` is the only thing between Claude's answer and the
    `image_manifest` JSONB column, and the stage branches on the `error` key it
    synthesises: a parse failure short-circuits the whole stage to
    `stage_status.images = "failed"` before Gemini is ever called. So the port has
    to agree with Python on the *unparseable* inputs as much as the parseable
    ones, and the disagreements are all in primitives the rest of item 3.5 does
    not touch. It also has an oracle available now (both golden fixtures carry a
    real Claude manifest response) that the Gemini half of the stage does not,
    since every recorded Gemini call in the fixtures is a 429.

    **What was built**

    - `api/scripts/export_manifest_parity.py`: calls
      `src.pipeline.stages.images._parse_manifest` over 37 inputs and writes
      `web/src/mastra/images/data/manifest-parity.json`. Two inputs are the raw
      Claude manifest text out of `docs/mastra-port/golden/*/images.json`; the
      other 35 are synthetic and each one names the branch or primitive it
      exercises in a `why` field.
    - `web/src/mastra/images/manifest.ts`: `parseManifest`, reusing the item-3.4a
      `pythonStrip` and `PY_WHITESPACE`.
    - `web/src/mastra/images/manifest.test.ts`: 43 tests.

    **The three primitives that do not survive a naive translation**

    | Python | Naive JavaScript | Why it matters |
    | --- | --- | --- |
    | `str.strip()` | `String.trim()` | Python's class omits `﻿` and includes `\x1c`-`\x1f` and `\x85`; JavaScript's does the reverse |
    | `\s` in the fenced-block pattern | `\s` | same class difference, inside the pattern that decides whether a fence matches at all |
    | `.` under `re.DOTALL` | `.` | JavaScript's `.` also excludes `\r`, `U+2028` and `U+2029`, so the fence body cannot span lines |

    The oracle stores Python's result as a JSON string rather than as a value, and
    the test compares after both sides have been through a JSON parse. That is
    deliberate: `json.dumps` writes Python's `1.0` float as `1.0` and its exact
    20-digit int in full, neither of which a JavaScript number holds, so comparing
    spellings would fail on cases where the values the port writes to
    `image_manifest` are identical.

    **One divergence recorded, not repaired**

    `json.loads` accepts the `NaN`, `Infinity` and `-Infinity` literals and
    `JSON.parse` rejects them, so `{"images": [], "score": NaN}` parses in Python
    (`{'images': [], 'score': nan}`) and falls back to the synthesised error
    manifest here. Reproducing it means hand-rolling a JSON parser for output no
    image model produces. The two inputs are exported under `divergences` rather
    than `cases` and the test asserts the fallback explicitly, so the difference
    is pinned rather than inherited silently.

    **A dead branch in the Python stage, found while pinning the manifest shape**

    `images_node` tests `image_spec.get("placement") == "featured"` before it
    tests `type`, and in both golden manifests `placement` is an object
    (`{"location": "featured_image", "after_section": null}`), never the string
    `"featured"`. That first comparison is therefore always false and the
    `image_size = "2K"` / `aspect_ratio = "16:9"` override behind it is
    unreachable. The featured image in the fixtures was sent at `2K`/`16:9`
    because the manifest itself asked for them, which the recorded Gemini request
    confirms. Item 3.5e still has to port the branch, but this corrects the note
    in the iteration-4 log that read the override as live behaviour.

    **Evidence**

    ```
    $ cd api && uv run python scripts/export_manifest_parity.py
    wrote web/src/mastra/images/data/manifest-parity.json: 37 cases, 2 divergences

    $ cd web && NO_COLOR=1 pnpm exec vitest run src/mastra/images/manifest.test.ts
     ✓ src/mastra/images/manifest.test.ts (43 tests)
     Test Files  1 passed (1)
          Tests  43 passed (43)
    ```

    **Negative controls.** Each mutation applied to `manifest.ts` alone, the whole
    file restored afterwards, and the final `diff` against the original empty.

    | Mutation | Result |
    | --- | --- |
    | `pythonStrip` -> `String.trim()` | 2 failed / 41 passed |
    | fence pattern's `PY_WHITESPACE` -> JavaScript `\s` | 1 failed / 42 passed |
    | `[\s\S]*?` -> `[^\n]*?` (DOTALL dropped) | 1 failed / 42 passed |
    | last fenced block taken instead of the first | 1 failed / 42 passed |
    | line filter tests the line without stripping it | 1 failed / 42 passed |
    | fallback object shared between calls instead of fresh | 3 failed / 40 passed |
    | outermost-brace fallback removed | 5 failed / 38 passed |
    | fenced-block branch removed | 3 failed / 40 passed |

    Two of those mutations passed against the first version of the corpus. Both
    gaps were real: no case had a fenced body spanning more than one line whose
    brace fallback gave a different answer, and no case had an indented fence
    marker carrying a brace. `pretty printed fenced json with braces in the
    trailing prose` and `indented closing fence followed by braces` were added to
    close them, and both mutations then failed. The two strip discriminators
    (`python-only whitespace around a json array`, `byte order mark before a json
    scalar`) were added for the same reason: every earlier whitespace case reached
    the same value down the brace-fallback path either way.

    **Gates**

    ```
    $ cd web && pnpm exec tsc --noEmit
    tsc exit=0
    $ cd web && NO_COLOR=1 pnpm lint
    lint exit=0
    $ cd web && NO_COLOR=1 pnpm build
    build exit=0
    ✓ Compiled successfully in 3.2s
    $ cd web && NO_COLOR=1 pnpm test
     Test Files  2 failed | 36 passed (38)
          Tests  9 failed | 531 passed | 4 skipped (544)
    ```

    `pnpm test` holds the recorded failure baseline of 9 (6 in
    `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`) with passes moving
    488 -> 531, which is the 43 new tests. Skips stay at 4.

    A first run of that gate reported 17 failed files / 11 failed / 97 skipped.
    That was `docker compose up -d db redis` not being up in this worktree, not a
    regression: every database-backed suite skips or errors on
    `ECONNREFUSED 127.0.0.1:5435`. The numbers above are from the re-run with the
    containers started.

    ```
    $ cd api && set -a && . ../.env && set +a && uv run pytest -q
    125 failed, 236 passed, 25 errors in 15.16s
    $ cd api && uv run ruff check .
    Found 32 errors.
    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 122 files already formatted
    ```

    All three at the Phase 0 baseline. `ruff format --check` counts one more
    formatted file than the last recorded run because
    `export_manifest_parity.py` is new and formatted; the would-reformat count is
    unchanged at 9. The pytest run wrote three `media/test-123/featured-*.webp`
    files (the defect already logged in `todo.md`); they were deleted before
    committing and `git status` is clean of them.
  - [x] 3.5b `optimize_image` ported to TypeScript: resize to `max_width` with Lanczos and
    encode WebP at quality 82, matching PIL's output closely enough that the manifest's
    recorded `size_bytes` and the stored file are usable. Needs a Node image library, which
    is a dependency decision, and needs a parity oracle built from real PNG input rather
    than from the golden fixtures, whose Gemini calls all 429'd.

    **The dependency decision: sharp**

    `sharp` 0.35.3 was added to `web/` as a runtime dependency. It is the only
    mature Node image library with a native WebP encoder, it ships prebuilt
    binaries for the platforms this app deploys to, and Next.js already treats it
    as a first-class optional dependency for its own image optimizer, so it is
    not a new class of dependency for this repo. The deciding fact came out of
    the installed package rather than the docs:

    ```
    $ cd web && node -e "console.log(require('sharp').versions.webp, require('sharp').versions.vips)"
    1.6.0 8.18.3
    $ cd api && uv run python -c "from PIL import features; print(features.version('webp'))"
    1.6.0
    ```

    sharp and Pillow drive the *same* libwebp 1.6.0. That turned out to matter
    more than expected (see the byte-identity finding below).

    Pure-JS alternatives (`jimp`, `@napi-rs/image`) were not evaluated further
    once byte-identity with Pillow's encoder was demonstrated with sharp; nothing
    else can match that without linking libwebp.

    **The oracle**

    `api/scripts/export_optimize_parity.py` builds 14 deterministic PNG inputs,
    runs Python's `optimize_image` over each, and commits both the input and
    Pillow's WebP output to
    `web/src/mastra/images/data/optimize-parity/`. The golden fixtures cannot
    serve here: every Gemini call recorded in them returned 429, so no real
    generated image was ever optimized, and there is no captured PNG anywhere in
    the repo to feed this function.

    ```
    $ cd api && uv run python scripts/export_optimize_parity.py
    smooth-2400x1350-w1200: RGB 2400x1350 (115011B png) -> 1200x675 (49386B webp)
    smooth-2400x1350-w1920: RGB 2400x1350 (115011B png) -> 1920x1080 (89594B webp)
    odd-1600x901-w1200: RGB 1600x901 (78939B png) -> 1200x675 (53246B webp)
    odd-1001x1000-w1000: RGB 1001x1000 (63543B png) -> 1000x999 (62002B webp)
    exact-1200x800-w1200: RGB 1200x800 (59806B png) -> 1200x800 (57820B webp)
    small-800x600-w1200: RGB 800x600 (40045B png) -> 800x600 (39616B webp)
    tiny-3x2-w1200: RGB 3x2 (85B png) -> 3x2 (76B webp)
    wide-3000x400-w1200: RGB 3000x400 (54829B png) -> 1200x160 (19802B webp)
    tall-1500x2400-w1200: RGB 1500x2400 (113777B png) -> 1200x1920 (95546B webp)
    detailed-1600x900-w1200: RGB 1600x900 (132493B png) -> 1200x675 (128306B webp)
    detailed-1200x675-w1200: RGB 1200x675 (99434B png) -> 1200x675 (142386B webp)
    alpha-1600x900-w1200: RGBA 1600x900 (151796B png) -> 1200x675 (136100B webp)
    grayscale-1600x900-w1200: L 1600x900 (115120B png) -> 1200x675 (89486B webp)
    palette-1600x900-w1200: P 1600x900 (81063B png) -> 1200x675 (136662B webp)

    14 cases -> web/src/mastra/images/data/optimize-parity
    ```

    Regeneration is byte-stable, which is what makes committing the outputs
    worth the 2.4 MB the directory costs:

    ```
    $ md5 -q web/src/mastra/images/data/optimize-parity/*.webp | md5   # before
    f0ddaff4a101962cdd93ade20bbace36
    $ cd api && uv run python scripts/export_optimize_parity.py && cd ..
    $ md5 -q web/src/mastra/images/data/optimize-parity/*.webp | md5   # after
    f0ddaff4a101962cdd93ade20bbace36
    ```

    The generated inputs are posterized to 3 bits per channel purely to keep that
    directory small: an un-posterized bicubic gradient costs about 1 MB per case
    as PNG and the corpus came out at 8.4 MB. Posterizing does not weaken the
    oracle, since banding adds edges for the resampler to disagree about rather
    than removing them.

    **What was built**

    - `web/src/mastra/images/optimize.ts`: `optimizeImage`, plus
      `OPTIMIZE_QUALITY`. The two Python decisions that are observable
      downstream are reproduced exactly: an image at or under `max_width` is
      never touched (and never upscaled), and the resized height is
      `Math.trunc(height * maxWidth / width)`.
    - `web/src/mastra/images/optimize.test.ts`: 51 tests.

    **The finding that changed the shape of the test: the encoder halves are equal**

    For all four cases where no resize happens, sharp's output is not merely
    close to Pillow's, it is **byte-identical**, at 57820, 39616, 76 and 142386
    bytes. Same libwebp, same quality 82, same method/effort 4, same alpha
    quality 100, and Pillow passes no ICC or EXIF through `save()` while sharp
    strips metadata by default. So the encoder is an equality, not an
    approximation, and only the resampler is approximate. The test asserts
    `Buffer.compare(...) === 0` for those four cases rather than a tolerance,
    which is a far sharper guard: negative control 3 (quality 82 -> 80) failed 8
    tests.

    **Three divergences found, all recorded rather than papered over**

    1. **Pillow ignores LANCZOS for palette images.** `Image.resize` contains
       `if self.mode in ("1", "P"): resample = Resampling.NEAREST`, so Python's
       palette output is nearest-neighbour while sharp's is lanczos3 (MAE 3.97,
       max channel difference 189). sharp produces the better image here. This
       is accepted, not reproduced, and the case carries its own tolerance and a
       comment naming the cause. It is close to unreachable in production
       anyway: Gemini returns RGB PNG.
    2. **Near-transparent pixels.** Pillow converts RGBA to the premultiplied
       RGBa mode before resizing, and libvips premultiplies too, so the
       algorithms agree, but unpremultiplying a pixel with alpha near zero
       amplifies any difference by up to 255x. Measured on the alpha case: MAE
       3.36 and max difference 255 over all pixels, but MAE 2.29 and max
       difference 63 once pixels below alpha 8 are excluded.
    3. **Everything else stays under MAE 1.6.** The remaining eight resized
       cases measured 0.61 to 1.56 MAE with a max channel difference of 43, so
       the default tolerance is pinned at MAE 1.7 / max 48.

    **Why lanczos3 rather than a kernel picked by name**

    Pillow's LANCZOS has no exact libvips equivalent, so the kernel was chosen by
    measuring all four sharp offers against Pillow's output. Summed over the ten
    resized cases: lanczos3 15.66, lanczos2 16.61, cubic 16.79, mitchell 18.66.
    lanczos2 actually beats lanczos3 on two individual smooth cases, so the test
    asserts the total rather than a per-case win, and it drives the shipped
    number through `optimizeImage` so switching the kernel fails the test instead
    of quietly costing image fidelity.

    **Verification**

    ```
    $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/images/optimize.test.ts
     ✓ src/mastra/images/optimize.test.ts (51 tests) 5987ms

     Test Files  1 passed (1)
          Tests  51 passed (51)
    ```

    **Negative controls** (each applied to `optimize.ts`, run, reverted)

    | mutation | result |
    | --- | --- |
    | `Math.trunc` -> `Math.round` on the scaled height | 3 failed / 48 passed |
    | quality 82 -> 80 | 8 failed / 43 passed |
    | kernel `lanczos3` -> `cubic` | 2 failed / 49 passed |
    | effort 4 -> 6 | 5 failed / 46 passed |
    | default `maxWidth` 1200 -> 1920 | 1 failed / 50 passed |
    | `fit: "fill"` -> `fit: "inside"` | 3 failed / 48 passed |

    One control stayed green and is recorded rather than dropped: changing
    `width > maxWidth` to `width >= maxWidth` kept all 51 tests passing. That is
    not a hole in the corpus, it is unobservable in both stacks, because a
    scale-1 resize is a no-op on both sides:

    ```
    sharp scale-1 resize is a no-op: true 57820 57820
    pillow scale-1 resize is a no-op: True 57820 57820
    ```

    The first control is only a control because the corpus was fixed for it. The
    case originally shipped as 1601x901, where `901 * 1200 / 1601` is 675.32 and
    `round` and `int` both give 675, so `Math.round` passed. It was regenerated
    at 1600x901, where the value is 675.75 and the two disagree.

    **Gates**

    ```
    $ cd web && pnpm tsc --noEmit
    tsc exit=0
    $ cd web && pnpm lint
    lint exit=0
    $ cd web && NO_COLOR=1 pnpm build
    build exit=0
    $ cd web && NO_COLOR=1 pnpm test
     Test Files  2 failed | 37 passed (39)
          Tests  9 failed | 582 passed | 4 skipped (595)
    ```

    `pnpm test` is 9 failed, the recorded failure baseline (6 in
    `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`) unchanged, with passes
    moving 531 -> 582, which is the 51 new tests. Skips stay at 4.

    Two earlier full-suite runs in this iteration reported 13 and 10 failures,
    the extras being `src/mastra/agents/{edit,research,write}.test.ts` wire-payload
    and credential-resolution tests. Each passes on its own and the third full run
    came back at the baseline, so they are flaky under parallel load rather than
    regressed. Logged in `todo.md` as `[investigate]`; not chased here.

    ```
    $ cd api && set -a && . ../.env && set +a && uv run pytest -q
    125 failed, 236 passed, 25 errors in 15.06s
    $ cd api && uv run ruff check .
    Found 32 errors.
    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 123 files already formatted
    ```

    All three at the Phase 0 baseline. `ruff format --check` counts one more
    formatted file than the last recorded run because
    `export_optimize_parity.py` is new and formatted; the would-reformat count is
    unchanged at 9.
  - [x] 3.5c `images` **agent**: the Claude half of the stage (model id, system message,
    `max_tokens`, the resolved `thinking` budget) with system-message and prompt parity
    against both golden fixtures and a live call confirming the model id resolves.

    **What was built**

    - `web/src/mastra/agents/images.ts`: `imagesAgent`, the provider half of step 1
      of `images_node`. `IMAGES_SYSTEM_MESSAGE` reproduces Python's four adjacent
      string literals, `IMAGES_MAX_TOKENS` is Python's 8000, the credential is
      resolved per call through `requireApiKey`, and extended thinking comes from
      the shared `claudeStageOptions`.
    - `imagesAgent` registered on the Mastra instance as `agents.images`.
    - `web/src/mastra/agents/images.test.ts`: 12 tests (11 credential-free).

    **Why this stage is not just another copy of `outline`**

    `images_node` is the only node that calls two providers, so the fixture's
    `provider_calls` list has an Anthropic entry followed by five or six Gemini
    entries. A test asserts that shape rather than assuming `provider_calls[0]`
    is the manifest call, because items 3.5d and 3.5e read the rest of the list.

    Its `max_tokens=8000` is below the extended-thinking floor, so 11024 is what
    reaches Anthropic. `outline` shares that branch, but the assertion here is
    pinned against `images.json`'s own recorded `max_tokens`, not against
    `OUTLINE_MAX_TOKENS`, so the two stages cannot drift into agreeing with each
    other while both disagreeing with Python.

    **Finding: the fenced-block branch of `parseManifest` has no fixture coverage**

    The system message ends `Output ONLY valid JSON, no code fences.` and both
    recorded answers obey it: each `text` block opens at `{`. Item 3.5a's
    fenced-block branch is therefore exercised only by that item's synthetic
    corpus, never by a real recorded response. A test asserts the fence-free
    property directly, so a future prompt change that makes Claude start fencing
    shows up as a failing test rather than as silently-live parsing code.

    Both recorded responses carry a `thinking` block ahead of the `text` block,
    so the test extracts the manifest text the way Python's `ClaudeClient.chat()`
    does (text blocks only) rather than reading `response.content` as a string.

    ### Item test

    ```
    $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/agents/images.test.ts
     OK src/mastra/agents/images.test.ts (12 tests | 1 skipped) 95ms

     Test Files  1 passed (1)
          Tests  11 passed | 1 skipped (12)
    ```

    ### Live Anthropic call confirming the model id resolves

    The key is read out of the developer `.env` and never written to the repo; the
    test encrypts it into the `settings` table with a throwaway Fernet key for the
    duration of the call and deletes the row afterwards.

    ```
    $ cd web && ANTHROPIC_API_KEY=<redacted> NO_COLOR=1 pnpm vitest run \
        src/mastra/agents/images.test.ts -t "live smoke"
     OK src/mastra/agents/images.test.ts (12 tests | 11 skipped) 2514ms
         OK reaches Anthropic and reports back the configured model id  2495ms

     Test Files  1 passed (1)
          Tests  1 passed | 11 skipped (12)
    ```

    The assertion inside it is `response.modelId === "claude-opus-4-6"`, which is
    the model id Anthropic reported back for the request, plus a non-empty text
    and a non-zero `usage.outputTokens`.

    ### Negative controls

    Each mutation was applied to `agents/images.ts` (or `index.ts` for control 7),
    the item test run, then the file restored from a copy taken before the first
    mutation. `images.ts` is new and untracked this iteration, so
    `git checkout` would not have restored it.

    | # | Mutation | Result |
    | --- | --- | --- |
    | 1 | `IMAGES_MAX_TOKENS` 8000 -> 16000 | 3 failed |
    | 2 | `IMAGES_MODEL_ID` -> `anthropic/claude-sonnet-4-5` | 4 failed |
    | 3 | Space dropped at the first literal boundary | 4 failed |
    | 4 | Fourth literal (`Output ONLY valid JSON...`) dropped | 5 failed |
    | 5 | `defaultOptions: claudeStageOptions(...)` removed | 2 failed |
    | 6 | `instructions` removed from the Agent | 3 failed |
    | 7 | `images: imagesAgent` removed from the Mastra instance | 1 failed |
    | 8 | Sentence join turned into a newline | 4 failed |

    ```
    $ # after reverting all eight
          Tests  11 passed | 1 skipped (12)
    ```

    ### Gates

    ```
    $ cd web && NO_COLOR=1 pnpm tsc --noEmit
    tsc exit=0
    $ cd web && NO_COLOR=1 pnpm lint
    lint exit=0
    $ cd web && NO_COLOR=1 pnpm test
     Test Files  2 failed | 38 passed (40)
          Tests  9 failed | 593 passed | 5 skipped (607)
    $ cd web && NO_COLOR=1 pnpm build
    (built; route table printed, exit 0)
    ```

    Failures hold at the Phase 0 baseline of 9 (6 `image-preview`, 3 `PostDetail`).
    Totals moved 595 -> 607, which is the 12 new tests, and skips moved 4 -> 5,
    which is the new live smoke test. The suite was run twice with identical
    counts, because iteration 30 recorded the three agent test files failing
    intermittently under a full run.

    ```
    $ cd api && set -a && . ../.env && set +a && NO_COLOR=1 uv run pytest -q
    125 failed, 236 passed, 25 errors in 15.19s
    $ cd api && uv run ruff check .
    Found 32 errors.
    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 123 files already formatted
    ```

    All three at the Phase 0 baseline. No file under `api/` was touched this
    iteration.
  - [x] 3.5d Gemini image-generation client ported: `generate_image` with `aspect_ratio`,
    `image_size` and `response_modalities`, plus the token accounting the stage sums into
    `_stage_meta_gemini`, and a live smoke test.

    **The oracle had to be built, because the fixtures have none**

    Every Gemini call in both golden fixtures is a 429, so they pin the prompt text
    and nothing else: not the request that carries it, not the shape of a successful
    answer, and not the token accounting. `api/scripts/export_gemini_parity.py`
    supplies all three by driving the real `GeminiClient` with
    `google.genai._api_client.SyncHttpxClient.request` replaced, so both the
    outbound request and the parsing of a canned answer come from the production
    Python path rather than from a reading of it. It writes
    `web/src/mastra/images/data/gemini-parity.json`: 5 `wire` cases (the exact
    request `google-genai` builds) and 14 `responses` cases (a canned status and
    body, with the resulting `ImageGenResponse` or the raised exception, plus the
    number of HTTP attempts Python actually made).

    **Three things the corpus settled that reading the Python did not**

    1. *The retry wrapper is inert for this client.* `_retry` wraps the call, but
       `_is_retryable` tests for `httpx.HTTPStatusError` and
       `anthropic.APIStatusError`, and `google.genai.errors.ClientError` inherits
       from neither (`ClientError -> APIError -> Exception`, checked against the
       installed 1.65.0). So a 429 fails on the first attempt and no `Retry-After`
       is ever read. The corpus records `attempts: 1` for both the 429 and the 500
       case, which matches the fixtures having exactly one recorded 429 per image.
       Only the 180s timeout and transport failures retry, and the port reproduces
       that split with `GeminiTransportError` as the single retryable class.
    2. *A part carrying `inline_data` with no bytes ends the search.* Python breaks
       on the first part whose `inline_data` is truthy and only then checks for
       `None`, so such a part fails the call with "No image returned in Gemini
       response" rather than deferring to a later image part. Corpus case
       `inline-data-without-bytes` confirms it against a body whose second part is
       a valid image.
    3. *Byte equality on the request body is unreachable.* `json.dumps` writes
       `", "` and `": "` as separators and escapes every non-ASCII character;
       `JSON.stringify` does neither. The corpus records both the parsed body and
       the raw string, and the test asserts
       `sent === JSON.stringify(JSON.parse(pythonRaw))`, which normalises exactly
       those two differences and nothing else, so key order and every value still
       have to match.

    **What was built**

    - `api/scripts/export_gemini_parity.py`, the corpus generator.
    - `web/src/mastra/images/gemini.ts`: `generateImage`, `GeminiApiError`,
      `GeminiTransportError` and the constants (`GEMINI_IMAGE_MODEL_ID`,
      `GEMINI_IMAGE_SIZE_TOKENS`, `GEMINI_TIMEOUT_MS`, `GEMINI_MAX_RETRIES`,
      `GEMINI_BASE_DELAY_MS`, `GEMINI_API_BASE`).
    - `web/src/mastra/images/gemini.test.ts`: 38 tests.

    **Why this posts to `generateContent` directly instead of adding `@google/genai`**

    The oracle is a recorded request. Matching a recorded request byte for byte is
    not a check the JS SDK can be made to perform on itself, and the surface in use
    is one POST with a five-field body, so a dependency whose own request shape
    would then need a second parity corpus buys nothing. The recorded URL, method,
    header names and body are asserted directly instead. No dependency was added.

    **Deliberate divergence**

    `GeminiApiError`'s message is `${code} ${status}. ${JSON.stringify(details)}`
    where Python's `APIError` uses `f'{code} {status}. {details}'` with `details`
    rendered by `repr(dict)`. That string reaches the `image_manifest` JSONB column
    through the stage's `str(e)` on a failed image, so the divergence is real but
    confined to failure text; reproducing Python's dict `repr` for arbitrary
    provider payloads would need a second float-and-string formatting port. The
    code and the `${code} ${status}. ` prefix are asserted to match.

    ### Corpus and tests

    ```
    $ cd api && uv run python scripts/export_gemini_parity.py
    wrote web/src/mastra/images/data/gemini-parity.json
      wire cases: 5
      response cases: 14

    $ cd web && NO_COLOR=1 pnpm vitest run src/mastra/images/gemini.test.ts
     OK src/mastra/images/gemini.test.ts (38 tests | 2 skipped) 16ms
     Test Files  1 passed (1)
          Tests  36 passed | 2 skipped (38)
    ```

    ### Negative controls, each applied and reverted

    Every mutation below was applied to `gemini.ts` alone, the file's suite run, and
    the file restored. The two marked `(*)` passed on the first attempt and
    the tests were tightened until they failed: both assertions were computing the
    expected value from the port's own exported constant, which made them
    self-referential. The retry tests now advance the fake clock by literal 999 /
    1 / 1999 / 1 ms and assert the attempt count at each step.

    ```
    NC1  drop `role: "user"` from the body                    5 failed | 31 passed
    NC2  unknown-size fallback 1100 -> 1200                   1 failed | 35 passed
    NC3  trust a reported candidatesTokenCount of 0           7 failed | 29 passed
    NC4  skip an inlineData part that carries no bytes        1 failed | 35 passed
    NC5  retry status errors as well as transport errors      9 failed | 27 passed
    NC6  GET instead of POST                                  5 failed | 31 passed
    NC7  credential in `authorization` not `x-goog-api-key`   5 failed | 31 passed
    NC8  swap the two generationConfig keys                   5 failed | 31 passed
    NC9  tokensIn read from candidatesTokenCount              2 failed | 34 passed
    NC10 v1beta -> v1 in the base URL                         6 failed | 30 passed
    NC11 MAX_RETRIES 3 -> 2                                (*) 2 failed | 34 passed
    NC12 drop the empty-parts guard                           2 failed | 34 passed
    NC13 backoff base 1s -> 5s                             (*) 3 failed | 33 passed
    NC14 linear backoff instead of exponential                1 failed | 35 passed
    ```

    ### Live API

    The key is read out of the developer `.env` and never written to the repo.

    ```
    $ cd web && GEMINI_API_KEY=<redacted> NO_COLOR=1 pnpm vitest run \
        src/mastra/images/gemini.test.ts -t "live smoke"
     OK src/mastra/images/gemini.test.ts (38 tests | 37 skipped) 151ms
     Test Files  1 passed (1)
          Tests  1 passed | 37 skipped (38)
    ```

    That test GETs `v1beta/models/gemini-3.1-flash-image-preview` and asserts the
    returned `name` and that `supportedGenerationMethods` contains
    `generateContent`. The live body, for the record:

    ```
    $ curl -s -H "x-goog-api-key: <redacted>" \
        https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview
    {
      "name": "models/gemini-3.1-flash-image-preview",
      "version": "3.0",
      "displayName": "Nano Banana 2",
      "description": "Gemini 3.1 Flash Image Preview.",
      "inputTokenLimit": 65536,
      "outputTokenLimit": 65536,
      "supportedGenerationMethods": ["generateContent", "countTokens", "batchGenerateContent"],
      "temperature": 1, "topP": 0.95, "topK": 64, "maxTemperature": 1, "thinking": true
    }
    HTTP 200
    ```

    **Gap: the end-to-end image call cannot run on this account.** The second live
    test does the real `generateImage` round trip and is gated on a second env var,
    `GEMINI_IMAGE_QUOTA`, because the developer key's project has no image quota at
    all. Run without that gate it fails, and this is the real failure, which is also
    why every Gemini call in the golden fixtures is a 429:

    ```
    $ cd web && GEMINI_API_KEY=<redacted> NO_COLOR=1 pnpm vitest run \
        src/mastra/images/gemini.test.ts -t "live smoke"
     FAIL  src/mastra/images/gemini.test.ts > live smoke > reaches Gemini and returns
           bytes for the configured model id
    GeminiApiError: 429 RESOURCE_EXHAUSTED. {"error":{"code":429,"message":"You exceeded
    your current quota ... * Quota exceeded for metric:
    generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0,
    model: gemini-3.1-flash-image ...","status":"RESOURCE_EXHAUSTED", ...}}
     Test Files  1 failed (1)
          Tests  1 failed | 36 skipped (37)
    ```

    `limit: 0` is a free-tier entitlement, not a rate limit that clears, so no wait
    or retry reaches a successful image on this key. What the 429 does establish is
    that the request is well formed enough to be routed and quota-checked against
    this exact model: an unknown model id returns 404 NOT_FOUND, not a quota
    violation naming `gemini-3.1-flash-image`. The bytes-out path is therefore
    covered by the corpus and by the `optimize.ts` parity work of item 3.5b, and is
    unproven against a live image only. Item 6.1 revisits the model choice and will
    need a billed project to close this.

    ### Gates

    ```
    $ cd web && NO_COLOR=1 pnpm tsc --noEmit
    tsc exit=0
    $ cd web && NO_COLOR=1 pnpm lint
    lint exit=0
    $ cd web && NO_COLOR=1 pnpm test
     Test Files  2 failed | 39 passed (41)
          Tests  9 failed | 629 passed | 7 skipped (645)
    $ cd web && NO_COLOR=1 pnpm build
    (built; route table printed, exit 0)
    ```

    Failures hold at the Phase 0 baseline of 9 (6 `image-preview`, 3 `PostDetail`).
    Totals moved 607 -> 645, which is the 38 new tests, and skips moved 5 -> 7,
    which is the two new live tests. The first full run of this iteration showed 10
    failures, adding `src/mastra/api-keys.test.ts`; that is the shared-`settings`-row
    flake already logged in `todo.md`, now seen to hit `api-keys.test.ts` as well as
    the three agent suites, and the note has been updated. The rerun above is clean
    at baseline.

    ```
    $ cd api && set -a && . ../.env && set +a && NO_COLOR=1 uv run pytest -q
    125 failed, 236 passed, 25 errors in 15.19s
    $ cd api && uv run ruff check .
    Found 32 errors.
    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 124 files already formatted
    ```

    All three at the Phase 0 baseline. `ruff format --check`'s "already formatted"
    count moved 123 -> 124, which is the new script; the reformat count is
    unchanged.
  - [x] 3.5e Per-image generation unit (`generateOneImage`) ported, against a parity
    corpus captured by driving the real `images_node` with both providers intercepted.

    **Why this splits off from the step**

    `_generate_one` is a closure inside `images_node`, and everything
    interesting about the `images` stage that is not the manifest, the WebP
    encoder or the Gemini wire format lives inside it: which aspect ratio and
    image size reach Gemini, which optimize width applies, what the written
    filename is, what URL is recorded, and which keys the returned image spec
    carries in the success and both failure shapes. Those are the fields that
    end up in the `image_manifest` JSONB column, so they need their own oracle
    and their own negative controls. The remaining half (prompt assembly, the
    `.foreach()` fan-out, the manifest-parse failure branch, `_stage_meta` /
    `_stage_meta_gemini` and `saveStageOutput`) is item 3.5f.

    **What was ported**

    `web/src/mastra/images/generate-one.ts` is `_generate_one`, the closure
    inside `images_node`: the aspect-ratio and image-size decision including the
    featured overrides, the 1920-vs-1200 optimize width, `Path(filename).stem`,
    the featured filename rewrite, the disk write and the
    `/media/<post_id>/<filename>` URL, plus the success and both failure shapes
    of the manifest entry. `ensureMediaDir` is the stage's one
    `media_dir.mkdir(parents=True, exist_ok=True)`.

    **The oracle**

    `api/scripts/export_image_generation_parity.py` runs the real Python stage
    with `ClaudeClient` and `GeminiClient` replaced, a frozen
    `datetime.now(UTC)` and a frozen `random.randint`, and a temporary media
    directory. Everything between the two providers ran for real over there, so
    `web/src/mastra/images/data/image-generation-parity.json` records what
    Python actually stored, wrote and billed: 16 manifest entries covering every
    branch, the 14 Gemini calls they produced with the exact arguments sent, the
    9 files that survived on disk with their dimensions and (where no resize
    happened) Pillow's sha256, the `_stage_meta_gemini` totals, and a 15-case
    direct oracle for `Path(...).stem`.

    Two inputs are used: a 64x48 PNG, narrow enough that `optimize_image` never
    resizes, so its WebP bytes are byte-identical across Pillow and sharp (item
    3.5b) and the committed sha256 is an equality rather than a tolerance; and a
    2400x1600 PNG, which is the only thing that can tell the 1920 branch from
    the 1200 one. The two resized files are compared on dimensions only, because
    Pillow's Lanczos convolution and libvips' reduce do not agree byte for byte.

    **What the corpus exposed**

    1. The featured aspect-ratio and image-size overrides key off
       `placement == "featured"`, a *string*, while `is_featured`, which picks
       the optimize width and the filename rewrite, also accepts
       `type == "featured"`. Both golden fixtures show Claude writing
       `placement` as an object (`{location, after_section}`), so on real
       manifests the overrides never fire and the width and filename rules
       always do. Three of the corpus cases exist only to cover the string form.
    2. The overrides rewrite the local variables, never the entry, so a stored
       manifest entry can read `image_size: "1K"` for a call made at `2K`, or
       carry no `aspect_ratio` at all for a call made at `16:9`. Logged in
       `todo.md`.
    3. A Gemini call that succeeded is billed even when `optimize_image` then
       rejects the bytes: Python accumulates `gemini_tokens_in/out` immediately
       after the call and the optimizer runs inside the same `try`. The port
       reports usage separately from success so the sum can be reproduced;
       reporting only successes would under-report spend.
    4. Every featured entry gets the same filename, so four featured entries in
       the corpus produced one file: the last write wins and all four entries
       record the same URL. Latent on real manifests (one featured image each),
       1-in-90 otherwise. Logged in `todo.md`.
    5. An empty `filename` writes the dotfile `.webp`. Logged in `todo.md`.
    6. `Path("..png").stem` is `"."` and `Path("...").stem` is `"..."`, because
       the rule is `0 < i < len(name) - 1` rather than "strip after the last
       dot", and `Path(".").name` is `""` while `Path("..").name` is `".."`.
       `pathStem` reimplements the rule rather than approximating it, which is
       also what flattens `sub/dir/nested.png` to `nested.webp` and keeps a
       manifest entry from writing outside the media directory.

    **Known divergence, recorded not fixed.** Python reads `aspect_ratio`,
    `image_size` and `filename` with `dict.get(key, default)`, which returns an
    explicit JSON `null` rather than the default. The port treats a non-string
    as absent. No rule asks the model for a null there and no fixture has one,
    so the `None` behaviour would have to be invented rather than observed.
    Logged in `todo.md` for a decision before Phase 7.

    ```
    $ cd api && uv run python scripts/export_image_generation_parity.py
    wrote web/src/mastra/images/data/image-generation-parity.json
      images: 16
      gemini calls: 14
      files written: 9
    ```

    ```
    $ pnpm -C web exec vitest run src/mastra/images/generate-one.test.ts
     ✓ src/mastra/images/generate-one.test.ts (30 tests) 2228ms

     Test Files  1 passed (1)
          Tests  30 passed (30)
       Duration  2.51s
    ```

    **Negative controls.** Eleven mutations applied to
    `generate-one.ts` one at a time and reverted; every one failed the suite,
    with the failure count in brackets:

    | mutation | failures |
    | --- | --- |
    | `DEFAULT_ASPECT_RATIO` `"4:3"` -> `"3:4"` | 1 |
    | featured override forces 16:9 unconditionally | 1 |
    | override keyed off `isFeatured` instead of the string `placement` | 1 |
    | optimize width always `CONTENT_MAX_WIDTH` | 1 |
    | `pathStem`'s `dot > 0` relaxed to `dot >= 0` | 1 |
    | `featuredFilename` renders `DDMMYY` instead of `MMDDYY` | 3 |
    | usage recorded only after the optimizer succeeds | 2 |
    | empty prompt string treated as usable | 5 |
    | default filename `image-<index>.png` -> `image.png` | 2 |
    | featured filename rewrite applied to every image | 3 |
    | (control) unmodified file | 0 |

    The fourth is the one that justified adding the 2400x1600 input: with only
    the 64x48 PNG it passed, because nothing was ever wide enough to resize.

    **Gates.**

    ```
    $ pnpm -C web tsc --noEmit
    (exit 0, no output)

    $ pnpm -C web lint
    (exit 0, no output)

    $ pnpm -C web test
     ❯ src/components/__tests__/image-preview.test.tsx (9 tests | 6 failed) 42ms
     ❯ src/app/posts/PostDetail.test.tsx (15 tests | 3 failed) 3475ms

     Test Files  2 failed | 40 passed (42)
          Tests  9 failed | 659 passed | 7 skipped (675)

    $ pnpm -C web build
    ✓ Compiled successfully
    ```

    9 failures is the standing baseline (6 `image-preview` from Phase 0 plus the
    3 `PostDetail` timeouts). Both were re-confirmed on a clean tree this
    iteration: with this iteration's work stashed,
    `vitest run src/app/posts/PostDetail.test.tsx` still reported
    `3 failed | 12 passed (15)`. Passing tests move 629 -> 659, which is the 30
    added here.

    ```
    $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test uv run pytest -q
    125 failed, 236 passed, 25 errors in 15.09s

    $ cd api && uv run ruff check .
    Found 32 errors.

    $ cd api && uv run ruff format --check .
    9 files would be reformatted, 125 files already formatted
    ```

    All three at the Phase 0 baseline; the `already formatted` count moves
    124 -> 125 for the new script. `TEST_DATABASE_URL` has to be passed
    explicitly because `api/tests/conftest.py` defaults to port 5433 while this
    worktree's compose project publishes postgres on 5435; without it every
    database test errors with `InvalidPasswordError` against whatever is
    listening on 5433.
  - [x] 3.5f `images` **step**: `createStep` with Zod schemas, `.foreach()` for per-image
    generation, the `image_manifest` JSONB shape preserved byte for byte, both `_stage_meta`
    and `_stage_meta_gemini` returned, and the persistence contract via `saveStageOutput`.
    Split, because `.foreach()` is a *workflow* operator, not something a step can call:
    it consumes the previous step's array output, so the stage has to become three steps
    inside one nested workflow rather than one step with a loop in it. The Claude half and
    the fan-out half have different oracles and different failure modes.
    - [x] 3.5f-i `images-manifest` **step**: the Claude call, prompt assembly from
      `rules/blog-images.md`, `parseManifest`, and the parse-failure branch.

      **Why `.foreach()` forces a three-step stage**

      `Workflow.foreach(step, opts)` is declared on `Workflow`, typed
      `TPrevIsArray extends true ? Step<...> : 'Previous step must return an array
      type'`, and takes `ForeachOptions { concurrency: number | ForeachConcurrencyResolver }`
      (`node_modules/@mastra/core/dist/workflows/workflow.d.ts:337`,
      `types.d.ts:591`). `EventedWorkflow extends Workflow`, so the evented engine
      this port runs on has it. There is no step-level equivalent, so honouring the
      objective's "use `.foreach()` rather than a hand-rolled loop" means the stage is

      ```
      createWorkflow({ id: "images" })
        .then(imagesManifestStep)   // this item
        .map(...)                   // manifest entries -> per-image jobs
        .foreach(generateImageStep, { concurrency: 3 })   // item 3.5f-ii
        .then(imagesAssembleStep)                          // item 3.5f-ii
        .commit()
      ```

      registered on the Mastra instance as a nested workflow. `.map()` is what lets
      the manifest step keep a rich object output while still handing `.foreach()` an
      array, and `getStepResult(step)` (`workflows/step.d.ts:34`) is what lets the
      assembling step read the manifest back.

      **What Python's single function guarantees that the split has to preserve**

      1. *One write per stage.* `api/src/worker.py:223` saves
         `STAGE_OUTPUT_KEY["images"]` exactly once, from whichever dict `images_node`
         returned, including on the parse-failure path. So this step commits nothing
         at all; the assembling step is the only writer. A test asserts the post row
         is byte-identical before and after.
      2. *One timer over the whole stage.* `StageTimer` wraps the manifest call and
         every image (`stages/images.py:48`), so `duration_s` cannot be measured
         here. The step returns `stageStartedAtMs` instead and 3.5f-ii subtracts it.
      3. *The parse failure is a branch, not an exception.* A manifest Claude wrote as
         prose is stored verbatim with `stage_status.images = "failed"` and no Gemini
         call is billed. Signalled with `parseFailed`, because throwing would lose the
         synthesised document Python stores.

      **Found while reading the Python, and reproduced**

      - `timer.duration` is `0` until `StageTimer.__exit__` runs
        (`api/src/pipeline/helpers.py:376-388`), and the parse-failure branch returns
        from *inside* the `with` block. So Python reports `duration_s: 0.0` for a
        failed manifest, not the elapsed time. 3.5f-ii has to reproduce that.
      - Python tests `manifest.get("error")` for *truthiness*, not for key presence,
        so a manifest in which the model itself wrote `"error": "I cannot ..."`
        short-circuits the stage exactly like a parse failure, while `"error": ""`
        does not. `pythonTruthy` is here because the two engines disagree on empty
        containers: `[]` and `{}` are falsy in Python and truthy in JavaScript, and
        this is the branch that decides whether Gemini is billed at all.
      - `response.content[:500]` slices by code point; `String.prototype.slice`
        slices by UTF-16 unit. `rawSnippet` uses `[...content]`, so 600 emoji give
        500 characters rather than 250.
      - `manifest.get("images", [])` returns the default only for an *absent* key, so
        the port tests `"images" in manifest` rather than using `??`. An explicit
        `null` raises out of `len(None)` in Python and out of the output schema here.

      **Recorded divergences**

      - A manifest that parses to an array or a scalar reaches `manifest.get("error")`
        in Python and raises `AttributeError`. `JSON.parse` admits both too, so this
        port throws a `TypeError` with its own message. Same outcome (the stage
        fails), different text.
      - A present but non-array `images` value fails the output schema here, where
        Python would `enumerate` whatever it is (a string yields its characters).
        Neither golden fixture has one and no rule in `rules/blog-images.md` asks for
        one, so the behaviour is not invented.
      - The parse-failure log is a `mastra.getLogger().warn` rather than
        `publish_stage_log(..., level="warning", data={error, raw_snippet})`. The
        event bus is item 5.5; the payload is carried on the log's metadata so the
        port to SSE is a change of sink, not of content.

      **The oracle**

      Prompt parity is byte equality against `rendered_prompts[0]` in both golden
      fixtures (the other five recorded prompts are Gemini's and belong to 3.5f-ii).
      The manifest entries have a second, independent oracle: Python stores
      `{**image_spec, generated, index, ...}` per entry, so stripping those
      bookkeeping keys off `stage_output.image_manifest.images` recovers the exact
      specs Python parsed, and the step's `images` output is compared against *that*
      rather than against a re-run of this port's own parser.

      ```
      $ NO_COLOR=1 pnpm -C web test --run src/mastra/steps/images-manifest.test.ts
       ✓ src/mastra/steps/images-manifest.test.ts (18 tests) 157ms

       Test Files  1 passed (1)
            Tests  18 passed (18)
         Duration  718ms
      ```

      **Negative controls.** Each mutation was applied to
      `web/src/mastra/steps/images-manifest.ts`, the suite re-run, and the file
      restored (`diff` against the pre-mutation copy confirms `restored identical`).

      | mutation | result |
      | --- | --- |
      | `pythonTruthy` uses JS truthiness for containers | Tests 1 failed \| 17 passed (18) |
      | `rawSnippet` slices UTF-16 units | Tests 1 failed \| 17 passed (18) |
      | `"images" in manifest` becomes `manifest.images ?? []` | Tests 1 failed \| 17 passed (18) |
      | parse failure still forwards the parsed images | Tests 1 failed \| 17 passed (18) |
      | non-mapping manifest is not rejected | Tests 1 failed \| 17 passed (18) |
      | rules file swapped to `blog-ready.md` | Tests 2 failed \| 16 passed (18) |
      | stage start not recorded (`stageStartedAtMs = 0`) | Tests 1 failed \| 17 passed (18) |
      | model reported as requested rather than as returned | Tests 1 failed \| 17 passed (18) |
      | parse-failure warning dropped | Tests 1 failed \| 17 passed (18) |
      | error truthiness replaced by key presence | Tests 1 failed \| 17 passed (18) |

      **Gates.**

      ```
      $ cd web && npx tsc --noEmit
      tsc exit=0
      $ NO_COLOR=1 pnpm -C web lint
      (no output, exit 0)
      $ NO_COLOR=1 pnpm -C web test --run
       Test Files  2 failed | 41 passed (43)
            Tests  9 failed | 677 passed | 7 skipped (693)
      $ NO_COLOR=1 pnpm -C web build
      exit 0
      ```

      Failures stay at the 9-test baseline (`image-preview.test.tsx` plus the shared
      `settings`-row flake logged in `todo.md`). Totals moved 675 -> 693, which is the
      18 new tests; skips unchanged at 7.

      ```
      $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test NO_COLOR=1 uv run pytest -q
      125 failed, 236 passed, 25 errors in 15.12s
      $ cd api && uv run ruff check .
      Found 32 errors.
      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 125 files already formatted
      ```

      All three at the Phase 0 baseline; no Python file was touched this iteration.
    - [x] 3.5f-ii `images` **workflow**: the `.map()` that turns manifest entries into
      per-image jobs, `.foreach(generateImageStep, { concurrency: 3 })` reproducing
      Python's `asyncio.Semaphore(3)`, the assembling step that folds the results back
      into the manifest (`total_generated` / `total_failed`, JSONB shape byte for byte),
      both `_stage_meta` (with `duration_s: 0` on the parse-failure branch) and
      `_stage_meta_gemini`, and the single `saveStageOutput` write.

      **What was built**

      - `web/src/mastra/steps/images-generate.ts`: `imagesGenerateStep`, the Mastra
        shell around item 3.5e's `generateOneImage`. It resolves the Gemini
        credential itself, per image, rather than taking it on the job, because a
        job is serialised into the workflow snapshot Postgres persists *and* into
        the Redis event that hands the step to the worker.
      - `web/src/mastra/steps/images-assemble.ts`: `imagesAssembleStep`, the stage's
        only writer, plus `foldManifest` as a separate pure function so the folded
        document's key order is assertable.
      - `web/src/mastra/workflows/images.ts`: `imagesWorkflow`, registered on the
        Mastra instance as `images`.
      - `web/src/mastra/images/generate-one.ts` gains `mediaRoot()`, the port of
        `settings.media_dir` with the same `MEDIA_DIR` override `rulesDir()` has.

      The committed graph is exactly the shape item 3.5f predicted, read back off
      `imagesWorkflow.serializedStepGraph`:

      ```
      [ { "type": "step",    "step": { "id": "images-manifest" } },
        { "type": "mapping", "id": "mapping_images_0" },
        { "type": "foreach", "step": { "step": { "id": "images-generate" } },
                             "opts": { "concurrency": 3 } },
        { "type": "step",    "step": { "id": "images-assemble" } } ]
      ```

      **The oracles**

      1. Both golden fixtures. Every recorded Gemini call was a 429, so
         `stage_output.image_manifest` is a whole failed stage and
         `_stage_meta_gemini` records one that billed nothing while still naming a
         model. Feeding the stored entries back through the fold reproduces the
         stored document, both totals, `stage_status` and both meta records.
      2. `images/data/image-generation-parity.json` (item 3.5e), where 12 of 16
         entries succeeded. Its `stage_meta_gemini` is `tokens_in: 225`,
         `tokens_out: 1395` over 14 calls, and re-deriving those sums from the
         exporter's own token schedule only works if the `BADBYTES` entry is
         billed: it is stored as failed and paid for all the same.
      3. A real run of the workflow through the evented engine against the live
         Postgres and Redis, with only the two provider calls stubbed. sharp
         encodes, the files land on disk, and the manifest is read back out of the
         `posts` row.

      **Recorded divergences**

      - Postgres `jsonb` sorts object keys by length and then bytes, so the key
        order Python's dict carried does not survive the write and cannot be
        asserted on the row. "JSONB shape byte for byte" therefore means the key
        and value set, not the order. The order is still what every in-process
        reader sees between the fold and the write, so it is pinned on
        `foldManifest`'s return value instead.
      - Python acquires the semaphore *inside* `_generate_one`, after the
        no-prompt check, so an entry with no prompt never takes a slot; here the
        whole step occupies one. Invisible in the stored manifest.
      - Python assigns `gemini_model` as each call returns, so on a mixed-model
        response the last *completed* call wins; this port takes the last call in
        manifest order. Both golden fixtures and the 3.5e corpus report one model
        for every call, so the two cannot disagree on any recorded data.
      - `.map()`'s parse-failure short-circuit is not redundant even though the
        manifest step already returns `images: []` on that branch: without it the
        stage would still check the Gemini key and create the media directory,
        which Python does not because it returns before both. The test asserts the
        directory's absence, which is the only observable difference.

      **Item tests.**

      ```
      $ NO_COLOR=1 npx vitest run src/mastra/steps/images-assemble.test.ts src/mastra/workflows/images.test.ts
       ✓ src/mastra/steps/images-assemble.test.ts (19 tests) 100ms
       ✓ src/mastra/workflows/images.test.ts (8 tests) 3402ms
           ✓ fans nothing out and bills nothing when the manifest never parses  1116ms

       Test Files  2 passed (2)
            Tests  27 passed (27)
         Duration  4.24s
      exit=0
      ```

      **Negative controls.** Each mutation was applied to the file named, both
      suites re-run, and the file restored from a pre-mutation copy (`diff`
      reports `restored identical` for all twelve).

      | mutation | result |
      | --- | --- |
      | `foldManifest` appends `images` after the totals | Tests 1 failed \| 26 passed (27) |
      | parse failure reports the measured duration | Tests 2 failed \| 25 passed (27) |
      | parse failure marks the stage complete | Tests 2 failed \| 25 passed (27) |
      | parse failure still reports a Gemini record | Tests 2 failed \| 25 passed (27) |
      | only generated entries are billed | Tests 1 failed \| 26 passed (27) |
      | Gemini model falls back to `""` not the requested id | Tests 2 failed \| 25 passed (27) |
      | duration measured in the assembling step, not from the stage start | Tests 5 failed \| 22 passed (27) |
      | `stage_status` not advanced on the success path | Tests 4 failed \| 23 passed (27) |
      | fan-out concurrency raised from 3 to 5 | Tests 1 failed \| 26 passed (27) |
      | jobs all carry `index: 0` | Tests 1 failed \| 26 passed (27) |
      | media directory never created | Tests 5 failed \| 22 passed (27) |
      | parse failure still runs the mapping body | Tests 1 failed \| 26 passed (27) |

      The last one passed at first: the manifest step already returns `images: []`
      on that branch, so mapping over nothing produced the same jobs. It only
      became a control once the test asserted that no media directory is created
      for the unparseable post.

      **`no-next-imports.test.ts`'s allowlist was updated, deliberately.**
      Registering `imagesWorkflow` makes the stage steps reachable from the entry
      point for the first time, so its transitive package set legitimately grows by
      `node:fs` (reading `rules/*.md`), `node:fs/promises` and `node:path` (writing
      images), `sharp` (encoding them) and `node:zlib` (the textstat dictionaries
      the `edit` analytics gunzip). The `next/*` assertion the file exists for is
      unchanged and still passes.

      **Gates.**

      ```
      $ cd web && npx tsc --noEmit
      tsc exit=0
      $ NO_COLOR=1 pnpm lint
      (no output, exit 0)
      $ NO_COLOR=1 pnpm test --run
       Test Files  2 failed | 43 passed (45)
            Tests  9 failed | 704 passed | 7 skipped (720)
      $ NO_COLOR=1 pnpm build
      build exit=0
      ```

      Failures are back to the 9-test baseline exactly (6 in
      `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`); the first full run of
      this iteration also hit the shared-`settings`-row flake in
      `write.test.ts` logged in `todo.md`, which the second run did not.
      Totals moved 693 -> 720, which is the 27 new tests; skips unchanged at 7.
      `next build` emits one BetterAuth base-URL warning; it was confirmed
      pre-existing by building `git show HEAD:web/src/mastra/index.ts` in place
      and seeing the same line, then restoring the file.

      ```
      $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test NO_COLOR=1 uv run pytest -q
      125 failed, 236 passed, 25 errors in 15.11s
      $ cd api && uv run ruff check .
      Found 32 errors.
      $ cd api && uv run ruff format --check .
      9 files would be reformatted, 125 files already formatted
      ```

      All three at the Phase 0 baseline; no Python file was touched this iteration.
- [x] 3.6 `ready`. The last stage, and the only one that does not go through
  `build_stage_prompt`: `ready_node` has a private `_build_ready_prompt` that
  replaces the thirteen-field configuration block and the `## Previous Stage
  Output` section with three lines of post configuration, the edited markdown,
  and the image manifest filtered down to the entries that actually generated.

  **Ported as:**
  - `web/src/mastra/agents/ready.ts`: `readyAgent`, registered on the Mastra
    instance under `ready`. `READY_SYSTEM_MESSAGE` (byte-identical to both
    fixtures), `READY_MAX_TOKENS = 16_000`, `READY_MODEL_ID =
    "anthropic/claude-opus-4-6"`, and the shared `claudeStageOptions` thinking
    configuration. The incumbent model is carried over unchanged; choosing a
    stronger one is item 6.1.
  - `web/src/mastra/steps/ready.ts`: `readyStep`, plus `buildReadyPrompt` and
    `generatedImages` exported as pure functions so the prompt half is
    assertable without a provider.
  - `web/src/mastra/prompts.ts`: `pythonJsonDumps` exported. It was written for
    `buildStagePrompt`'s previous-output section, but `ready` is the stage that
    actually serializes JSON and it does not use that path, so it needs the same
    `ensure_ascii` escaping around a *filtered* manifest.

  **The golden fixture is not the production oracle for this stage.** This is
  the finding of the iteration and it changed how the item was verified.
  `capture_golden.py` builds one in-memory `Post`, threads a single state dict
  from stage to stage (`state.update(saved)`), and never touches Postgres.
  `_run_pipeline` does the opposite: it reloads the post from the database
  before every stage (`api/src/worker.py:144`, "Load fresh post from DB each
  iteration"). The ready prompt embeds the image manifest as pretty-printed
  JSON, and `jsonb` does not store a document, it stores a normalised value:
  object keys come back sorted by length, then bytewise. So the prompt in
  `docs/mastra-port/golden/<slug>/ready.json` and the prompt the Python worker
  sends for the same post differ, in the order of the manifest's keys, for both
  fixtures.

  The port reads its state from the table (that is what makes a crash
  resumable), so its oracle has to be the production path.
  `api/scripts/export_ready_prompt_parity.py` produces it: for each fixture it
  writes `final_md_content` and `image_manifest` into the real `posts` table,
  reads the row back, builds the state the way the worker does, and renders the
  real `_build_ready_prompt` over it. No provider is called and no API key is
  read.

  ```
  $ cd api && DATABASE_URL=postgresql://pipeline:pipeline@localhost:5435/content_pipeline \
      uv run python scripts/export_ready_prompt_parity.py
  how-to-choose-a-crm-for-a-small-team: prompt 20429 chars, differs from fixture: True
  best-time-tracking-tools-for-agencies: prompt 24954 chars, differs from fixture: True
  wrote .../web/src/mastra/steps/data/ready-prompt-parity.json
  ```

  Both oracles are now gates, and a third test pins the relationship between
  them: the step's database-sourced prompt is byte-equal to Python's production
  prompt; `buildReadyPrompt` fed the fixture's in-memory manifest is byte-equal
  to the fixture's captured prompt; and the two differ *only* in the manifest's
  key order, with everything outside that section identical and the parsed
  documents deep-equal.

  **Three more divergences recorded, none of them invented behaviour:**
  1. Both captures ran against an account with zero image quota, so every
     manifest entry in both fixtures has `generated: false` and the
     generated-images filter's only observable effect there is an empty list.
     Item 3.5e's parity corpus came out of the real Python images stage and
     carries 12 generated and 4 failed entries, so it stands in as the filter's
     oracle.
  2. `if manifest:` is falsy for `{}` in Python and truthy in JavaScript, and
     `manifest.get("images", [])` distinguishes an absent key from an explicit
     `null`. Both are reproduced explicitly rather than with `??`.
  3. A manifest whose `images` is not a list, or whose entries are not mappings,
     raises out of `_build_ready_prompt` before any call is billed. The port
     throws rather than guessing, and both branches are asserted.

  **Tests** (31 credential-free, 1 live):

  ```
  $ cd web && NO_COLOR=1 npx vitest run \
      src/mastra/steps/ready.test.ts src/mastra/agents/ready.test.ts
   RUN  v4.0.18 .../web
   OK src/mastra/steps/ready.test.ts (23 tests) 145ms
   OK src/mastra/agents/ready.test.ts (9 tests | 1 skipped) 81ms

   Test Files  2 passed (2)
        Tests  31 passed | 1 skipped (32)
     Duration  1.01s
  ```

  The skipped test is the live Anthropic smoke test, gated on
  `ANTHROPIC_API_KEY` so the default `pnpm test` needs no credentials. Run with
  the real key, which is what confirms `claude-opus-4-6` still resolves for this
  stage:

  ```
  $ cd web && ANTHROPIC_API_KEY=<redacted> NO_COLOR=1 npx vitest run \
      src/mastra/agents/ready.test.ts -t "live smoke"
   OK src/mastra/agents/ready.test.ts (9 tests | 8 skipped) 2015ms
       OK reaches Anthropic and reports back the configured model id  1997ms

   Test Files  1 passed (1)
        Tests  1 passed | 8 skipped (9)
     Duration  3.06s
  ```

  **Negative controls**, each applied to `steps/ready.ts`, `agents/ready.ts` or
  `index.ts` and reverted; every one turned the suite red:

  | mutation | result |
  | --- | --- |
  | `OUTPUT_FORMAT` line hardcoded to `markdown` | 2 failed |
  | `{...manifest, images}` -> `{images, ...manifest}` (key moves) | 7 failed |
  | empty `final_md` section no longer suppressed | 1 failed |
  | `Object.keys(manifest).length > 0` -> `if (manifest)` (JS truthiness) | 1 failed |
  | `pythonTruthy(generated)` -> `generated === true` | 1 failed |
  | `"images" in manifest ? ... : []` -> `manifest.images ?? []` | 1 failed |
  | `pythonJsonDumps` -> `JSON.stringify(..., 2)` (no `ensure_ascii`) | 1 failed |
  | section separator `\n\n---\n\n` -> `\n\n***\n\n` | 13 failed |
  | `stage_status` replaced instead of merged | 1 failed |
  | reported model hardcoded instead of read off the response | 1 failed |
  | system message: `publishing notes` -> `publication notes` | 3 failed |
  | system message literals joined with a newline | 3 failed |
  | `READY_MAX_TOKENS` 16000 -> 8000 | 2 failed |
  | agent unregistered from the Mastra instance | 1 failed |
  | `saveStageOutput(postId, "ready", ...)` -> `"edit"` | 1 failed |

  The "reported model hardcoded" control only became a control once a test
  replayed a response carrying a server-side alias: both fixtures recorded the
  same id the agent asks for, so fixture equality alone cannot tell a
  passthrough from a constant.

  **Gates.**

  ```
  $ cd web && npx tsc --noEmit
  tsc exit=0
  $ NO_COLOR=1 pnpm lint
  (no output, exit 0)
  $ NO_COLOR=1 pnpm test --run
   Test Files  2 failed | 45 passed (47)
        Tests  9 failed | 735 passed | 8 skipped (752)
  $ NO_COLOR=1 pnpm build
  build exit=0
  ```

  Failures are the 9-test baseline exactly (6 in `image-preview.test.tsx`, 3 in
  `PostDetail.test.tsx`). Totals moved 720 -> 752, which is the 32 new tests;
  skips moved 7 -> 8, which is the new live smoke test. `next build` emits the
  same pre-existing BetterAuth base-URL warning recorded under item 3.5f-ii.

  ```
  $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test NO_COLOR=1 uv run pytest -q
  125 failed, 236 passed, 25 errors in 15.26s
  $ cd api && uv run ruff check .
  Found 32 errors.
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 126 files already formatted
  ```

  All three at the Phase 0 baseline. The only Python file added is the parity
  exporter, which is why `already formatted` moved 125 -> 126; the 9 files that
  would be reformatted and the 32 ruff errors are unchanged and all pre-existing.

  With this item all six stages are ported. Phase 4 composes them.

## Phase 4: Workflow assembly, gates, durable execution

- [x] 4.1 Compose the six steps into one workflow with `.then()` / `.commit()`, registered on
  the Mastra instance.

  `web/src/mastra/workflows/pipeline.ts` chains the six in Python's order and
  commits; `index.ts` registers it as `pipeline`. `images` goes in as a nested
  workflow rather than a step, because its fan-out is `.foreach()` and that is
  declared on `Workflow`, not on `Step` (item 3.5f-ii). Nesting typechecks and
  runs: `EventedWorkflow` extends `Workflow`, which `implements Step<...>`, and
  both `DefaultEngineType` and `EventedEngineType` are `{}` in
  `dist/workflows/types.d.ts` and `dist/workflows/evented/workflow.d.ts`, so the
  engine-type parameter on `.then()` is not a barrier. On the finished run the
  nested workflow appears in `result.steps` under its own id, `images`, exactly
  like a step.

  The chain carries only `{ postId }`. Each step re-reads the row the previous
  one committed, which the prompt assertions below prove, so nothing is handed
  forward in memory and a run resumed in another process rebuilds its inputs
  from committed rows.

  Left to their own items, not folded in here: skipping stages already marked
  complete and single-stage runs (4.2), review gates (4.3), and the per-stage
  `running` status, execution logs and SSE events the Python runner published
  around each call (Phase 5's `events` router owns their transport).

  `web/src/mastra/workflows/pipeline.test.ts` runs the whole thing on the
  evented engine against live Postgres and Redis. Only the six agent calls and
  the Gemini image call are stubbed, plus `validateLinks`, which would otherwise
  make live HTTP requests to whatever URLs a stubbed model invents. sharp
  encodes for real and the manifest is read back out of Postgres.

  ```
  $ cd web && pnpm vitest run src/mastra/workflows/pipeline.test.ts
   RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web

   ✓ src/mastra/workflows/pipeline.test.ts (9 tests) 2190ms

   Test Files  1 passed (1)
        Tests  9 passed (9)
     Start at  01:18:42
     Duration  2.91s (transform 108ms, setup 82ms, import 570ms, tests 2.19s, environment 0ms)
  ```

  Negative controls, one mutation of the chain at a time, restoring between each:

  | mutation of `pipeline.ts` | result |
  | --- | --- |
  | `outline` and `write` swapped | Tests 2 failed \| 7 passed (9) |
  | `.then(imagesWorkflow)` dropped | Tests 6 failed \| 3 passed (9) |
  | `.then(readyStep)` dropped | Tests 7 failed \| 2 passed (9) |
  | `.then(researchStep)` dropped | Tests 5 failed \| 4 passed (9) |
  | restored | Tests 9 passed (9) |

  Frontend gates:

  ```
  $ cd web && pnpm tsc --noEmit
  (no output, exit 0)
  $ cd web && pnpm lint
  (no output, exit 0)
  $ cd web && pnpm test
   Test Files  2 failed | 46 passed (48)
        Tests  9 failed | 744 passed | 8 skipped (761)
  $ cd web && pnpm build
  ✓ Compiled successfully in 3.1s
  ```

  Failures are the 9-test baseline exactly (6 in `image-preview.test.tsx`, 3 in
  `PostDetail.test.tsx`). Totals moved 752 -> 761, which is this file's 9 tests.
  The build emits no warnings on this run, including the BetterAuth base-URL one
  recorded earlier.

  Backend gates, unchanged at the Phase 0 baseline:

  ```
  $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test NO_COLOR=1 uv run pytest -q
  125 failed, 236 passed, 25 errors in 15.12s
  $ cd api && uv run ruff check .
  Found 32 errors.
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 126 files already formatted
  ```
- [x] 4.2a Stage selection: run only the named stages, and on a full run skip the stages
  `stage_status` already calls complete. (Split from 4.2 this iteration; 4.2b below is the
  rest of it.)

  `check_gates` in the item's original wording does not exist in the Python being ported.
  `_run_pipeline()` (`api/src/worker.py:94`) takes `ctx, post_id, redis, session_factory,
  job_try, stages=None` and nothing else; gate checking was removed with LangGraph in the
  reliability work, so 4.3 owns gates outright and this item is only about `stages`.

  The two rules Python spells out, both reproduced:

  - `stages=[x]` runs exactly `x` and deliberately does *not* consult `stage_status`, which
    is what makes the dashboard's per-stage rerun button work on a completed stage.
  - `stages=None` runs `STAGES` minus whatever `stage_status` already calls complete
    (`worker.py:151`, `if ss.get(stage) == "complete": continue`).

  The chain is fixed, so the decision moved into the steps: `stages` is declared on both
  `stageStepInputSchema` and `stageStepOutputSchema` and threaded through every step, and
  each step asks `shouldRunStage()` right after it loads its state. It is threaded through
  the data flow rather than carried in a runtime context so it lands in the persisted
  workflow snapshot, which is what a run resumed in another process reads. A skipped stage
  returns `skipped: true` with zeroed meta and touches no column, no provider and no
  credential. `images` decides one step earlier than the rest, in `images-manifest`, because
  the fan-out sits between that step and the one that writes.

  **Defect found and fixed while doing this: the second `images` run in a process failed.**
  `jsonValueSchema` was `z.lazy(() => z.union([..., z.array(jsonValueSchema), ...]))`. The
  first parse populates the lazy's `_cachedInner` and closes a reference cycle through the
  union's array member. Mastra's evented engine publishes a nested workflow's
  `parentWorkflow.stepGraph`, schemas included, onto the pub/sub topic as JSON, so from the
  second `images` start onward `JSON.stringify` threw `Converting circular structure to JSON`
  and the step failed terminally after three redeliveries. One run per process hid it;
  a worker serving a queue would have hit it on the second post. Probed directly:

  ```
  $ cd web && pnpm vitest run src/mastra/workflows/cycle-probe.test.ts   # scratch, not committed
  stdout | step graph serializability before and after the lazy schema is used
    before: 'ok',
    after: 'TypeError: Converting circular structure to JSON\n    --> sta'
  ```

  Fixed by moving the recursion out of the schema and into a predicate
  (`z.custom<JsonValue>(isJsonValue)`), which keeps the schema object a flat leaf while
  admitting and rejecting the same documents. `NaN` is still rejected as `z.number()`
  rejected it; `Infinity` is still admitted as `z.number()` admitted it, since tightening
  that is a separate decision.

  The stage-selection suite, two real runs against live Postgres and Redis on the evented
  engine with only the six agents and the Gemini call stubbed:

  ```
  $ cd web && pnpm vitest run src/mastra/workflows/stage-selection.test.ts
   ✓ src/mastra/workflows/stage-selection.test.ts (11 tests) 3330ms
   Test Files  1 passed (1)
        Tests  11 passed (11)
  ```

  And the schema regression tests added next to the manifest step:

  ```
  $ cd web && pnpm vitest run src/mastra/steps/images-manifest.test.ts
   ✓ src/mastra/steps/images-manifest.test.ts (21 tests)
   Test Files  1 passed (1)
        Tests  21 passed (21)
  ```

  Negative controls. Each mutation applied alone, suite rerun, then reverted:

  | Mutation | Result |
  | --- | --- |
  | `shouldRunStage` always returns true | Tests 8 failed \| 2 passed (10)* |
  | full-run branch ignores `stage_status` | Tests 3 failed \| 7 passed (10)* |
  | single-stage branch also consults `stage_status` | Tests 2 failed \| 8 passed (10)* |
  | `images-manifest` ignores the skip | Tests 5 failed \| 6 passed (11) |
  | `images-assemble` ignores the skip | Tests 2 failed \| 9 passed (11) |
  | `.foreach()` map ignores the skip | Tests 1 failed \| 10 passed (11) |
  | `jsonValueSchema` back to `z.lazy` | Tests 3 failed \| 7 passed (10)* and, in `images-manifest.test.ts`, Tests 2 failed \| 1 passed \| 18 skipped (21) |
  | restored | Tests 11 passed (11) |

  \* Run before the eleventh test (the Gemini-credential assertion) was added, hence 10.
  The `.foreach()` map mutation passed 10/10 at that point, which is what prompted the
  eleventh test: with `requireApiKey` stubbed and `images` empty the guard was unobservable,
  so the spy's call count now stands in for the credential a passed-through stage must not
  demand.

  Frontend gates:

  ```
  $ cd web && pnpm tsc --noEmit
  (no output, exit 0)
  $ cd web && pnpm lint
  (no output, exit 0)
  $ cd web && pnpm test
   Test Files  3 failed | 46 passed (49)
        Tests  11 failed | 756 passed | 8 skipped (775)
  ...rerun:
   Test Files  2 failed | 47 passed (49)
        Tests  9 failed | 757 passed | 8 skipped (775)
  $ cd web && pnpm build
  ✓ Compiled successfully in 3.2s
  ```

  Totals moved 761 -> 775, which is this iteration's 11 + 3 tests. The clean rerun is the
  9-test deterministic baseline exactly (6 in `image-preview.test.tsx`, 3 in
  `PostDetail.test.tsx`). The extra failures across runs were 1 in `agents/edit.test.ts` +
  1 in `agents/ready.test.ts` + 1 in `api-keys.test.ts`, then 1 in `agents/outline.test.ts`,
  then 0: the known intermittent shared-`settings.api_keys` contention already logged in
  `todo.md` as `[investigate]`, not new. The build's BetterAuth base-URL warning is the one
  recorded in Phase 0.

  Backend gates, unchanged at the Phase 0 baseline (no Python touched):

  ```
  $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test NO_COLOR=1 uv run pytest -q
  125 failed, 236 passed, 25 errors in 15.08s
  $ cd api && uv run ruff check .
  Found 32 errors.
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 126 files already formatted
  ```
- [x] 4.2b Single-stage rerun completion check: after a run with an explicit `stages`
  selection, if `stage_status` now calls every stage complete, set `current_stage` to
  `"complete"` (`api/src/worker.py:234`). Deliberately left out of 4.2a: the full-pipeline
  path reaches the same end state through `_post_completion_hook`, which also stamps
  `completed_at` and queues publishing, so the two want deciding together rather than
  bolting the single-stage half onto every step.

  `markCompleteIfAllStagesComplete()` (`web/src/mastra/post-state.ts`) re-reads
  `stage_status` from the row and promotes `current_stage` to `CURRENT_STAGE_COMPLETE`
  when every stage calls itself complete. `markRerunComplete()`
  (`web/src/mastra/steps/stage-io.ts`) is the rule around it: it returns without touching
  the row unless the run named its stages, which is Python's `if not is_full_pipeline`.
  All six stages call it immediately after committing their column, `images` from
  `images-assemble` because that is where its column is written.

  Three decisions worth recording:

  - The full-pipeline path deliberately still does **not** promote. Python's promotion for
    that path lives in `_post_completion_hook`, which also stamps `completed_at` and queues
    WordPress / Next.js publishing; promoting `current_stage` here alone would leave a post
    that reads finished with `completed_at` still null. The hook is its own future item.
  - `images-assemble`'s parse-failure branch does not call the check, where Python's loop
    would have. That branch has just written `stage_status.images = "failed"`, so the
    "every stage complete" question it would ask can never be true. A comment marks it.
  - `CURRENT_STAGE_COMPLETE` is a new constant in `state.ts` rather than a reuse of
    `STATUS_COMPLETE`. Same spelling, different column vocabulary: `current_stage`
    otherwise holds a stage name.

  Four real evented runs against live Postgres and Redis, one per branch of the rule, with
  only the six agents and the Gemini call stubbed:

  ```
  $ cd web && npx vitest run src/mastra/workflows/rerun-completion.test.ts
   ✓ src/mastra/workflows/rerun-completion.test.ts (10 tests) 5603ms
   Test Files  1 passed (1)
        Tests  10 passed (10)
  ```

  The promotion assertion was written first and failed for the right reason, alone:

  ```
   × promotes current_stage to complete rather than leaving it on the stage
  AssertionError: expected 'edit' to be 'complete' // Object.is equality
   Test Files  1 failed (1)
        Tests  1 failed | 6 passed (7)
  ```

  Negative controls, each applied to the implementation and reverted:

  | Mutation | Result |
  | --- | --- |
  | drop `if (!input.stages) return false` in `markRerunComplete` | Tests 1 failed \| 9 passed (10), the full run promotes |
  | `STAGES.every` -> `STAGES.some` in `markCompleteIfAllStagesComplete` | Tests 1 failed \| 9 passed (10), a post with `ready` outstanding promotes |
  | drop the call from `steps/edit.ts` | Tests 1 failed \| 9 passed (10) |
  | drop the call from `steps/images-assemble.ts` | Tests 1 failed \| 9 passed (10), the nested workflow's own path |
  | `CURRENT_STAGE_COMPLETE` -> `"finished"` | Tests 2 failed \| 8 passed (10) |

  Frontend gates:

  ```
  $ cd web && npx tsc --noEmit
  (no output, exit 0)
  $ cd web && pnpm lint
  (no output, exit 0)
  $ cd web && pnpm test
   Test Files  2 failed | 48 passed (50)
        Tests  9 failed | 768 passed | 8 skipped (785)
  $ cd web && pnpm build
  ✓ Compiled successfully in 3.3s
  ```

  The 9 failures are the recorded baseline: 6 in `image-preview.test.tsx` and 3 in
  `PostDetail.test.tsx`, the same set and count as item 4.2a's rerun, none of them in a
  file this item touched.

  Backend gates, unchanged at the Phase 0 baseline (no Python touched):

  ```
  $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test NO_COLOR=1 uv run pytest -q
  125 failed, 236 passed, 25 errors in 15.19s
  $ cd api && uv run ruff check .
  Found 32 errors.
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 126 files already formatted
  ```
- [x] 4.3 Review gates via `suspend()` / `resume()` with typed `suspendSchema` / `resumeSchema`.
  Suspend/resume test passes.

  **What was ported.** Gate checking left the Python worker with LangGraph, so the spec is the
  version that ran before that: `_run_pipeline()` read `post.stage_settings[stage]` before
  executing a stage, and for the modes `review` and `approve_only` wrote
  `stage_status[stage] = "review"`, set `current_stage` to that stage, committed, and returned.
  A single-stage rerun passed `check_gates=False` and never looked. The three rules that carries
  (the two pausing modes, the `.get(stage, "review")` fail-safe default, and no gates on a named
  selection) now live in `stageNeedsReview` / `gateModeFor` / `reviewGate` in
  `web/src/mastra/steps/stage-io.ts`, and all six steps call the gate in the same place: right
  after the skip check and before anything the stage spends.

  Python's `return` becomes `suspend()`, which is the difference worth having: the parked run
  keeps its place in the chain, so approving it continues into the remaining stages rather than
  needing a second run to work out where the first stopped.

  Schemas, both typed, no `z.any()`:

  ```
  suspendSchema: { stage: enum(STAGES), mode: enum("review" | "approve_only"), message: string }
  resumeSchema:  { approved: literal(true) }
  ```

  `approved` is a literal rather than a boolean because Python had no reject branch at all: its
  pause was a bare `return`. A reviewer who says no cancels the run (`EventedRun.cancel()`),
  which releases it instead of leaving a declined run parked forever, and the literal turns
  "resume without approving" into a schema error rather than a silent run.

  **Recorded divergences.**

  1. Python read the raw `stage_settings` column, this port reads it through `stateFromPost`,
     which substitutes all-auto when the column is NULL. The two therefore disagree on exactly
     one input: a NULL column pauses at `research` in Python and runs unattended here. Closing
     it would mean either a second read of the row per stage or breaking `stateFromPost`'s
     parity with Python's `state_from_post`, and the column is NULL only via raw SQL.
  2. A missing *key* is not that case and does match Python: `gateModeFor` falls back to
     `"review"`, so a partially populated settings map fails safe towards the human.
  3. Python also appended an execution log and published an SSE `stage_review` event when it
     paused. Neither helper is ported yet; the suspend is already on Mastra's own event stream
     (`step-suspended`), which is where item 5.5 sources the SSE feed, so the pause is visible
     there rather than through a second channel.

  **The database default is a live hazard, logged in `todo.md`.** The column default in the real
  database still reads
  `{"edit":"review","write":"review","images":"review","outline":"review","research":"review"}`,
  from before the gates were removed, and never mentioned `ready`:

  ```
  $ docker compose exec -T db psql -U pipeline -d content_pipeline -c "select column_default from information_schema.columns where table_name='posts' and column_name='stage_settings';"
                                                  column_default
  ---------------------------------------------------------------------------------------------------------------
   '{"edit": "review", "write": "review", "images": "review", "outline": "review", "research": "review"}'::jsonb
  (1 row)
  ```

  SQLAlchemy sent its own all-auto default on every insert, so no post created through FastAPI
  inherited it. A Drizzle insert that omits the column does, and with gates back such a post
  parks at `research` on its first run. That is why the four existing workflow suites now seed
  `stageSettings` explicitly: their rows were inheriting the column default, and the change to
  those files is the seed, not an assertion.

  **Failing first.** The test was written before the implementation and failed for the expected
  reason, nothing suspending:

  ```
  $ cd web && npx vitest run src/mastra/workflows/review-gates.test.ts
   FAIL  src/mastra/workflows/review-gates.test.ts [ src/mastra/workflows/review-gates.test.ts ]
  Error: This workflow run was not suspended
   ❯ EventedRun.resume node_modules/.pnpm/@mastra+core@1.61.0.../dist/agent-DSxJoGjY.js:8482:46
   ❯ src/mastra/workflows/review-gates.test.ts:207:14
   Test Files  1 failed (1)
        Tests  13 skipped (13)
  ```

  **Passing.** Three real evented runs against live Postgres and Redis, every provider boundary
  stubbed and nothing else: gated at the first stage, gated inside the nested `images` workflow
  behind the `.foreach()` fan-out, and a named selection that must not pause.

  ```
  $ cd web && npx vitest run src/mastra/workflows/review-gates.test.ts
   ✓ src/mastra/workflows/review-gates.test.ts (13 tests) 4786ms

   Test Files  1 passed (1)
        Tests  13 passed (13)
  ```

  **Two engine behaviours the test had to be built around**, both recorded in `todo.md` because
  Phase 5 has to live with them:

  - `EventedRun.resume()` resolves with a *stale* snapshot. It subscribes to the shared
    `workflows-finish` topic and the Redis stream still holds this run's earlier
    `workflow.suspend` event, so the promise resolves with that event the moment it subscribes
    while the resumed run carries on executing behind it. `resumeStream()`'s `.result` has the
    same problem and its `fullStream` replays the pre-suspend events. Only
    `workflow.getWorkflowRunById(runId)` reports the truth, and that is what the test polls.
  - The suspend event and the snapshot write race, so a resume issued immediately after `start()`
    returns can be told the run was never suspended. The test waits for the persisted status
    first.

  **Negative controls**, each applied to the implementation, run, and reverted:

  | Mutation | Result |
  | --- | --- |
  | `reviewGate` ignores `resumeData` | Suite failed in `beforeAll`: `Error: run a777211c-... never left the suspended state` |
  | `stageNeedsReview` drops `if (input.stages) return false` | Tests 2 failed \| 11 passed (13) |
  | `DEFAULT_GATE_MODE` is `"auto"` instead of `"review"` | Tests 1 failed \| 12 passed (13) |
  | `REVIEW_MODES` drops `"approve_only"` | Suite failed in `beforeAll`: `Error: This workflow run was not suspended` |
  | `reviewGate` does not call `markStageForReview` | Tests 2 failed \| 11 passed (13) |
  | `markStageForReview` writes `STATUS_PENDING` | Tests 2 failed \| 11 passed (13) |
  | the gate removed from `images-manifest` | Suite failed in `beforeAll`: `Error: This workflow run was not suspended` |

  Frontend gates:

  ```
  $ cd web && npx tsc --noEmit
  (no output, exit 0)
  $ cd web && pnpm lint
  (no output, exit 0)
  $ cd web && pnpm test
   Test Files  2 failed | 49 passed (51)
        Tests  9 failed | 781 passed | 8 skipped (798)
  $ cd web && pnpm build
  ✓ Compiled successfully in 3.1s
  ```

  The 9 failures are the recorded baseline: 6 in `image-preview.test.tsx` and 3 in
  `PostDetail.test.tsx`, the same set and count as item 4.2b's rerun. 768 passing became 781,
  the 13 tests added here.

  Backend gates, unchanged at the Phase 0 baseline (no Python touched):

  ```
  $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test NO_COLOR=1 uv run pytest -q
  125 failed, 236 passed, 25 errors in 15.08s
  $ cd api && uv run ruff check .
  Found 32 errors.
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 126 files already formatted
  ```
- [x] 4.4a The `worker` service: a second process, built from the same
  `src/mastra/index.ts`, consumes `workflow.start` off Redis Streams and executes the steps,
  while the process that started the run never executes anything.

  The worker under test is the real deployable artifact. `mastra worker build` bundles
  `src/mastra/index.ts` behind the CLI's generated entry (`await mastra.startWorkers()` plus a
  SIGINT/SIGTERM `stopWorkers()`), and `mastra worker start` boots it. Two `package.json`
  scripts name them:

  ```
  "worker:build": "mastra worker build -o .mastra/worker",
  "worker": "mastra worker start --dir .mastra/worker"
  ```

  `-o .mastra/worker` keeps the worker bundle out of `.mastra/output`, which `mastra dev`
  already owns for Studio (item 2.5); the CLI overwrites one with the other otherwise.

  **The build, from a clean `.mastra/worker`:**

  ```
  $ cd web && rm -rf .mastra/worker && pnpm run worker:build
  INFO (Mastra CLI): Bundling Mastra application
  INFO (Mastra CLI): Bundling Mastra done
  INFO (Mastra CLI): Installing dependencies
  INFO (Mastra CLI): Done installing dependencies
  INFO (Mastra CLI): Generating package-lock.json for deploy
  INFO (Mastra CLI): Worker build complete.
  INFO (Mastra CLI): Run with: mastra worker start [name] --dir .mastra/worker
  INFO (Mastra CLI):   or:     node /…/web/.mastra/worker/index.mjs
  ```

  **The start command:**

  ```
  $ cd web && env -u NODE_PATH timeout 15 pnpm exec mastra worker start --dir .mastra/worker --env ../.env
  [mastra] Workers started
  [mastra] Shutting down workers...
  [mastra] Shutting down workers...
  ```

  (The shutdown line appears twice because `timeout` signals the whole process group, so the
  CLI and the worker it spawned each handle their own SIGTERM. Not a defect; noted so the next
  reader does not chase it.)

  **Two repo changes the worker bundle forced**, neither of which `next build`, `vitest` or
  `mastra dev` had exposed:

  1. `@opentelemetry/api` added as a dependency. The first `mastra worker build` failed with
     `We couldn't load "@opentelemetry/api" from "@mastra/redis-streams"`. The deployer
     validates its output by importing each generated chunk, and that import is unresolvable
     here: no package in the tree declares `@opentelemetry/api`, and pnpm's strict layout puts
     nothing at `web/node_modules/@opentelemetry`. Installing it is the first remedy the error
     itself suggests and the one that leaves the import working at runtime; the alternative it
     offers (`bundler.externals`) would only move the failure from build time to boot time.
  2. `bundler: { externals: ["sharp"] }` on the Mastra instance. `sharp` is native: its
     JavaScript inlines into the bundle but the `.node` binary cannot, so the bundle threw
     `Could not load the "sharp" module using the darwin-arm64 runtime` on boot. As an external
     it stays out of the bundle and lands in the generated `package.json`, where the deploy
     target installs it for its own platform.

  **The test.** `web/src/mastra/workflows/worker-process.test.ts`, 8 tests, against live
  Postgres and Redis. It builds the bundle from scratch, starts two runs with no worker alive,
  waits five seconds, snapshots, then spawns the worker and watches both runs execute. Neither
  run bills a provider, so the bundle is the untouched production one with no stubbing seam:
  the first post has every stage `complete` in `stage_status` (an unnamed run executes all six
  steps and each returns `skipped: true`), the second has `research: "review"` (the run reaches
  the gate, writes its two columns and suspends). Between them, six steps run, a row is
  written by the worker, and both terminal states a worker can reach are covered.

  ```
  $ cd web && pnpm exec vitest run src/mastra/workflows/worker-process.test.ts
   ✓ src/mastra/workflows/worker-process.test.ts (8 tests) 19615ms

   Test Files  1 passed (1)
        Tests  8 passed (8)
     Duration  20.41s
  ```

  **Two isolation decisions the suite depends on**, both learned the hard way:

  - **Redis database 9.** The bundle uses the production pubsub config, so `keyPrefix` (the
    lever the other workflow suites pull) is not reachable from it. A shared `workflows` topic
    would let `crossprocess-events.test.ts`'s workers consume these runs, which would execute
    them in the wrong process and destroy the ordering the whole proof rests on. The URL's
    database index is the one isolation knob available without a test-only seam in production
    code. `clearTopic` runs before and after, so an interrupted earlier run cannot replay
    against the same seeded post ids.
  - **`NODE_PATH` is deleted from the worker's environment.** Vitest sets it to pnpm's flat
    virtual store, and inheriting it lets the bundle resolve any package installed anywhere in
    this repo. The suite passed with the `sharp` external removed until this was fixed, while
    the same bundle booted by hand crashed on `sharp` immediately. A deploy has no such path,
    so inheriting it turns a bundle that cannot boot on Railway into a green test.

  **Negative controls.** Each mutation applied to a green tree, run, then reverted:

  | # | Mutation | Result |
  |---|---|---|
  | 1 | Spawn the worker before the five-second snapshot instead of after | FAIL, `executes nothing while no worker is running`: `expected true to be false` |
  | 2 | Worker reads Redis database 8 while `web` publishes to 9 | FAIL, `run … never matched: last status running` after the 20s wait |
  | 3 | Remove `bundler: { externals: ["sharp"] }` | FAIL, run never executed: the worker crashed on boot with `Could not load the "sharp" module` |
  | 4 | `start()` instead of `startAsync()` | FAIL, `Hook timed out in 60000ms`: with no worker there is nothing to finish the run, which is exactly what `startAsync` exists to avoid |

  Control 3 is the one that matters most: it passed before `NODE_PATH` was stripped, which is
  how the leak was found.

  **Frontend gates:**

  ```
  $ cd web && pnpm exec tsc --noEmit
  (no output)
  $ cd web && pnpm exec eslint
  (no output)
  $ cd web && pnpm test
   Test Files  2 failed | 50 passed (52)
        Tests  9 failed | 789 passed | 8 skipped (806)
  $ cd web && pnpm build
  ✓ Compiled successfully in 3.2s
  ```

  The 9 failures are the recorded baseline: 6 in `image-preview.test.tsx` and 3 in
  `PostDetail.test.tsx`. 781 passing became 789, the 8 tests added here.

  Backend gates, unchanged at the Phase 0 baseline (no Python touched):

  ```
  $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test NO_COLOR=1 uv run pytest -q
  125 failed, 236 passed, 25 errors in 15.18s
  $ cd api && uv run ruff check .
  Found 32 errors.
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 126 files already formatted
  ```
- [ ] 4.4b Prove restarting `web` does not disturb an in-flight pipeline: a `web` process that
  starts a run and then dies must leave the worker executing it to completion. Split out of
  4.4 because 4.4a's harness (the real bundle, Redis database 9, the `NODE_PATH` strip) was a
  full iteration on its own; 4.4a proves `web` executes nothing, not that `web` can disappear.
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
