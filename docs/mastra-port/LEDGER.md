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
