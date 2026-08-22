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
- [ ] 0.3 Stand up a reachable dev database for this repo (resolve the host-port 5433
  collision) and record the working local invocation, so later phases can run the Python
  pipeline and, later, the TypeScript data layer against a real database.
- [ ] 0.4 Capture golden fixtures: run the existing Python pipeline end to end on at least 2
  representative posts with different `article_type` and `output_format`. For each stage
  save the fully rendered prompt, the provider request parameters, and the raw output to
  `docs/mastra-port/golden/<post-slug>/<stage>.json`. Redact API keys. Exit: >= 12 fixture
  files committed.

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
