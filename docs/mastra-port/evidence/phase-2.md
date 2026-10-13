# Phase 2 evidence

Moved out of `LEDGER.md` on 2026-08-23 to cut the context
re-read every iteration. Verbatim, nothing edited.


## 2.1


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

## 2.2


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

## 2.3


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

## 2.4


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

## 2.5


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
