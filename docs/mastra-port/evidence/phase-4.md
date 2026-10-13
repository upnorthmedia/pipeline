# Phase 4 evidence

Moved out of `LEDGER.md` on 2026-08-23 to cut the context
re-read every iteration. Verbatim, nothing edited.


## 4.1


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

## 4.2a


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

## 4.2b


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

## 4.3


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

## 4.4a


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

## 4.4b


  `web/src/mastra/workflows/web-restart.test.ts` (8 tests) plus
  `web/src/mastra/workflows/web-service.fixture.mjs`, the `web` side as a real separate
  process. The fixture loads the built bundle's Mastra instance (the same
  `src/mastra/index.ts` the worker runs) and does the only three things `web` does with
  Mastra: `createRun()`, `startAsync()` and `getWorkflowRunById()`. It never calls
  `startWorkers()`. It has to be a process rather than a helper inside the test, because the
  item is about the starter dying and a function call cannot die.

  **Three claims, one run each, none of them billing a provider:**

  | Claim | Construction | Terminal state |
  |---|---|---|
  | A run outlives the process that started it | `web` A starts the run with no worker alive anywhere, exits 0, and only then is the worker spawned | `success`, six steps |
  | A parked run survives a `web` restart | post gated at `outline` (`research` already complete), so the worker suspends it at the gate; `web` B then starts and reads it | `suspended`, unchanged |
  | A hard-killed `web`'s run still completes | `web` B starts a run, is SIGKILLed with no chance to shut down | `success`, six steps |

  Ordering for the first claim is guaranteed by construction, not by a sleep: with no consumer
  in existence nothing can execute, so `web` A's observed exit provably precedes any step. The
  assertion is `webAExitedAt < workerSpawnedAt` plus untouched rows three seconds later.

  Provider spend is zero because the two `success` posts have every stage `complete` in
  `stage_status` (all six steps run and return `skipped: true`) and the gated post stops at the
  review gate before any agent call.

  ```
  $ cd web && pnpm exec vitest run src/mastra/workflows/web-restart.test.ts --reporter=verbose
   ✓ ... > builds the deployable worker bundle from the shared Mastra entry point 1ms
   ✓ ... > starts the runs from a web process that then exits, before anything executes 0ms
   ✓ ... > runs the pipeline to completion in the worker although its starter is gone 1ms
   ✓ ... > parks the gated run in flight, written by the worker 0ms
   ✓ ... > lets a restarted web read the in-flight run exactly where the worker left it 0ms
   ✓ ... > completes a run whose web process was killed without a shutdown 0ms
   ✓ ... > leaves the parked run untouched across the restart 0ms
   ✓ ... > never restarts the worker and reports nothing on its stderr 0ms
   Test Files  1 passed (1)
        Tests  8 passed (8)
  ```

  **Recorded decisions.**

  1. The bundle is built to `.mastra/worker-restart`, not `.mastra/worker`. Vitest runs files in
     parallel, so this suite and `worker-process.test.ts` would otherwise `rm -rf` and rebuild
     the same directory concurrently. `mastra worker build -o <dir>` writes only inside `<dir>`
     (`.mastra/.build`, `.mastra/bundler-config.mjs` and `.mastra/output` were untouched by a
     build verified by mtime), so two output directories are enough isolation.
  2. Redis database 10, for the same reason database 9 belongs to `worker-process.test.ts`: the
     bundle uses the production pubsub config, so `keyPrefix` is not reachable from it and the
     only isolation available is the database number.
  3. The fixture finds the Mastra instance in the bundle by shape
     (`typeof value === "object" && typeof value.getWorkflow === "function"`), because rollup
     minifies the export to `m`. `Mastra` the class is also exported but is a function, and
     carries `getWorkflow` on its prototype, so it is not matched.
  4. "The restart did not disturb the parked run" is asserted on `updated_at` as well as on the
     columns: an equal timestamp says no write happened at all, where equal columns alone would
     also be satisfied by an idempotent rewrite.

  **Negative controls.** Each mutation applied to a green tree, run, then reverted:

  | # | Mutation | Result |
  |---|---|---|
  | 1 | Spawn the worker before `web` A instead of after its exit | FAIL, `starts the runs from a web process that then exits`: `expected 1787384429277 to be less than 1787384428157` |
  | 2 | Worker reads Redis database 11 while `web` publishes to 10 | FAIL, `run 3005d501… never matched: last status running` |
  | 3 | Fixture's `read` loop iterates `[]`, so the restarted `web` reads nothing | FAIL, `lets a restarted web read the in-flight run…`: `expected undefined to be 'suspended'` |
  | 4 | SIGTERM instead of SIGKILL for `web` B | FAIL, `expected { code: null, signal: 'SIGTERM' } to deeply equal { code: null, signal: 'SIGKILL' }` |
  | 5 | `update posts set current_stage = 'research'` on the parked post during the restart | FAIL, `leaves the parked run untouched across the restart`: `expected 'research' to be 'outline'` |
  | 6 | Kill and respawn the worker between the two phases | FAIL, `never restarts the worker…`: `expected 64431 to be 64426` |
  | 7 | Gated post seeded with `outline: auto` instead of `review` | FAIL, `run e5136c76… never matched: last status failed` (the run reached the agent and died on the absent key) |

  Control 6 is the one that changed the test: the first version of it passed, because the
  assertion read `worker.stdout()` off the rebound variable and the fresh process had printed
  `Workers started` exactly once. Recording the pid at the first spawn and asserting identity
  at the end is what made the claim real.

  A first attempt at control 2 also passed vacuously: `deployEnv()` is shared by the `web`
  fixture and the worker, so overriding `REDIS_URL` inside it moved both processes to the same
  wrong database. The control only bites when the override is applied to the worker's spawn.

  **Frontend gates:**

  ```
  $ cd web && pnpm exec tsc --noEmit
  (no output, exit 0)
  $ cd web && pnpm exec eslint
  (no output, exit 0)
  $ cd web && pnpm test
   Test Files  2 failed | 51 passed (53)
        Tests  9 failed | 797 passed | 8 skipped (814)
  $ cd web && pnpm build
  ✓ Compiled successfully in 3.1s
  ```

  The 9 failures are the recorded baseline: 6 in `image-preview.test.tsx` and 3 in
  `PostDetail.test.tsx`. 789 passing became 797, the 8 tests added here.

  Backend gates, unchanged at the Phase 0 baseline (no Python touched):

  ```
  $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test NO_COLOR=1 uv run pytest -q
  125 failed, 236 passed, 25 errors in 15.08s
  $ cd api && uv run ruff check .
  Found 32 errors.
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 126 files already formatted
  ```

## 4.5


  Split, because the gate is two questions with very different costs. The engine question
  ("does an in-flight step survive its worker dying?") is a property of the evented engine and
  the Redis Streams transport, is free to answer, and decides the branch. The pipeline question
  ("does a run killed mid-`write` resume from `outline`?") bills Anthropic twice for `write`
  and takes minutes, so it is a scripted procedure rather than a suite member. 4.5a answers the
  first and 4.5b applies it to the real bundle.

  **Both passed. The port's workflow runner is Mastra's built-in evented engine over
  `RedisStreamsPubSub`, with Postgres storage.** No worker startup sweep (4.5b finding 2 shows
  storage carries no record of an interrupted step, so a sweep could not have found one),
  no `@mastra/inngest`, no second queue. Evidence under 4.5a and 4.5b.

  **Amended by 4.7a.** The runner decision stands, but the recovery latency recorded here and
  under 4.5a (70-98s, being `reclaimIdleMs` 60s plus up to one 30s `reclaimIntervalMs` tick) was
  measured at the transport's defaults. 4.7a found that the same 60s window re-executes any
  *live* step that runs longer than a minute, which is every stage in this pipeline, and raised
  `reclaimIdleMs` to 15 minutes. Crash recovery therefore now takes up to ~15 minutes rather
  than ~90 seconds. The guarantee is unchanged; the number is not.

## 4.5a


  **Outcome: the built-in evented engine on Redis Streams passes.** No startup sweep, no
  `@mastra/inngest`. The mechanism, read out of the installed packages and then proven:

  - `OrchestrationWorker` subscribes to the `workflows` topic with the fixed consumer group
    `mastra-orchestration` (`@mastra/core/dist/worker-BeL6789j.js:113,150`), so a restarted
    worker joins the group the dead one belonged to and inherits its pending entries.
  - `WorkflowEventProcessor.handle` awaits `processWorkflowStepRun`
    (`workflow-event-processor-Dp87-e6z.js:4390`) and the transport acks only on `{ok: true}`
    (`worker-BeL6789j.js:175`), so a `workflow.step.run` message stays in the group's
    pending-entries list for the whole of the step body. A `SIGKILL` therefore leaves it
    pending rather than losing it.
  - `RedisStreamsPubSub` runs `XAUTOCLAIM` on a timer for grouped subscriptions
    (`@mastra/redis-streams/dist/index.js:197-224`), defaulting to `reclaimIdleMs` 60000 and
    `reclaimIntervalMs` 30000. That is what hands the dead consumer's message to a live
    sibling, and it is why recovery is not instant.

  **Measured recovery latency: 60-90s** with those defaults (the suite asserts the observed
  value falls in 55-120s, so a change to either default fails the test rather than silently
  moving the number in this ledger). Nothing in this port shortens it; a worker that dies mid
  stage leaves that stage parked for about a minute.

  **Finding that rules out the ledger's first fallback.** The run snapshot carries no record of
  a step until the step finishes: at the moment of the kill, `steps` held `probe-first`
  (success) and had no `probe-slow` key at all. A worker startup sweep over storage therefore
  could not have identified the interrupted step, only that the run was still `running`.
  Recovery here is the Redis pending-entries list, not the snapshot, which is worth knowing
  before Phase 7 decides what the worker does on boot.

  The probe is `web/src/mastra/workflows/crash-probe.fixture.mjs`: a two-step workflow
  (`probe-first`, then `probe-slow` which records, sleeps 15s, records) on its own Mastra
  instance, isolated to Redis database 11. It touches no provider, no post row and no media
  directory, so it costs nothing and can stay in the suite. Run directly it is a worker
  process (`mastra.startWorkers()`); imported it is the `web` side. Both go through the same
  factory, so the graph the test publishes is the graph the worker executes. Steps record to an
  append-only JSONL file rather than to a table, because the record of "this body executed in
  this process" has to survive a `SIGKILL` outside any transaction or buffer the engine owns.

  ```
  $ cd web && NO_COLOR=1 pnpm exec vitest run --reporter=verbose src/mastra/workflows/crash-probe.test.ts
   RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web

   ✓ src/mastra/workflows/crash-probe.test.ts > a step whose worker is killed mid-execution > was genuinely in flight when the worker died 2ms
   ✓ src/mastra/workflows/crash-probe.test.ts > a step whose worker is killed mid-execution > has persisted the completed step and no trace of the running one 1ms
   ✓ src/mastra/workflows/crash-probe.test.ts > a step whose worker is killed mid-execution > is redelivered to the restarted worker and the run reaches success 1ms
   ✓ src/mastra/workflows/crash-probe.test.ts > a step whose worker is killed mid-execution > runs the interrupted step body exactly once to completion 0ms
   ✓ src/mastra/workflows/crash-probe.test.ts > a step whose worker is killed mid-execution > does not re-execute the step that had already completed 0ms
   ✓ src/mastra/workflows/crash-probe.test.ts > a step whose worker is killed mid-execution > does not rewrite the completed step's persisted result 0ms
   ✓ src/mastra/workflows/crash-probe.test.ts > a step whose worker is killed mid-execution > feeds the completed step's output into the resumed step 0ms
   ✓ src/mastra/workflows/crash-probe.test.ts > a step whose worker is killed mid-execution > recovers on the XAUTOCLAIM timer rather than immediately 0ms

   Test Files  1 passed (1)
        Tests  8 passed (8)
     Start at  03:28:56
     Duration  77.88s (transform 29ms, setup 129ms, import 416ms, tests 77.26s, environment 0ms)
  ```

  The same sequence run by hand first, which is where the numbers above come from. Worker A
  (pid 71087) executed `probe-first` and started `probe-slow` at 08:00:19.567Z and was killed
  at 08:00:20.3Z; worker B (pid 71163) was spawned at 08:00:30Z and the step was redelivered to
  it at 08:01:30.985Z, 70s after the kill:

  ```
  {"step":"probe-first","phase":"done","label":"crash","pid":71087,"at":"2026-08-22T08:00:19.562Z"}
  {"step":"probe-slow","phase":"start","label":"crash","pid":71087,"at":"2026-08-22T08:00:19.567Z"}
  {"step":"probe-slow","phase":"start","label":"crash","pid":71163,"at":"2026-08-22T08:01:30.985Z"}
  {"step":"probe-slow","phase":"done","label":"crash","pid":71163,"at":"2026-08-22T08:01:55.974Z"}
  settled after 86s: {"status":"success","steps":{"probe-slow":"success","probe-first":"success"}}
  ```

  Negative controls, each applied to a green suite and reverted from a copy taken before the
  mutation (the files are untracked, so `git checkout` cannot revert them):

  | # | Mutation | Expected | Observed |
  | - | -------- | -------- | -------- |
  | 1 | worker B spawned against Redis database 12 instead of 11 | no recovery | `Error: timed out waiting for the run to settle under worker B`, 8 skipped |
  | 2 | worker A not killed (`workerA.kill("SIGKILL")` removed) | redelivery claims fail | 3 failed, 5 passed: redelivered/exactly-once/latency |
  | 3 | `reclaimIntervalMs: 0` on the probe pubsub (XAUTOCLAIM loop off) | no recovery | `Error: timed out waiting for the run to settle under worker B`, 8 skipped |
  | 4 | `probe-first` writes its record twice | exactly-once claim fails | 1 failed, 7 passed: "does not re-execute the step that had already completed" |

  Controls 1 and 3 together say the recovery is the XAUTOCLAIM loop over a shared consumer
  group and nothing else. Control 2 says the redelivery assertions are not satisfied by a run
  that simply finished normally. Control 4 says the exactly-once assertions count real records.

  Gates. `pnpm test`'s failure count in this worktree is unstable run to run because of the
  pre-existing `settings.api_keys` race between the agent suites (logged in `todo.md`
  2026-08-21). Measured across three runs with this suite removed: 9, 10, 11 failures. Across
  five runs with it: 12, 10, 10, 11, 9. The 9 is the recorded baseline (6 `image-preview` +
  3 `PostDetail`); 805 passing is 797 plus this item's 8 tests. `scaffold-check.test.ts`'s
  stream-event race showed up in 3 of the 5 runs with this suite and 0 of the 3 without; it
  shares no Redis database, topic or row with the probe, so the link is scheduling pressure
  rather than state, and it is logged in `todo.md` rather than chased here.

  ```
  $ cd web && NO_COLOR=1 pnpm exec tsc --noEmit
  (no output)
  $ cd web && NO_COLOR=1 pnpm lint
  > content-pipeline-dashboard@0.1.0 lint
  > eslint
  (no output, exit 0)
  $ cd web && NO_COLOR=1 pnpm test
   Test Files  3 failed | 51 passed (54)
        Tests  10 failed | 804 passed | 8 skipped (822)
  ... and, on the fifth run, the clean baseline:
   Test Files  2 failed | 52 passed (54)
        Tests  9 failed | 805 passed | 8 skipped (822)
  $ cd web && NO_COLOR=1 pnpm build
  ✓ Compiled successfully in 3.3s
  ```

  Backend gates, unchanged at the Phase 0 baseline (no Python touched):

  ```
  $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test NO_COLOR=1 uv run pytest -q
  125 failed, 236 passed, 25 errors in 15.18s
  $ cd api && uv run ruff check .
  Found 32 errors.
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 126 files already formatted
  ```

## 4.5b


  **Outcome: passed on the built-in evented engine over Redis Streams. That is the port's
  workflow runner.** No worker startup sweep, no `@mastra/inngest`, no second queue.

  The procedure is `web/src/mastra/scripts/durability-gate.mjs`, run once, exit 0, 10/10
  checks. It builds the real deployable bundle from scratch (`mastra worker build -o
  .mastra/worker-durability`), starts the run from a separate `web` process
  (`web-service.fixture.mjs`, which never calls `startWorkers()`), and spawns the bundle's own
  `index.mjs` as worker A and later worker B. Isolated to Redis database 12, because 9, 10 and
  11 belong to the three worker suites and all four share the `workflows` topic name.

  Three things about how it is built, because each one is what makes a claim checkable:

  - **The run parks itself.** The seeded post sets `research`/`outline`/`write` to `"auto"` and
    `edit`/`images`/`ready` to `"review"`, so the moment `write` commits its column the run
    suspends at the `edit` gate. That is ordinary production behaviour for a gated post and a
    real terminal state, and it stops the procedure spending on image generation to prove
    something about `write`.
  - **"Not rewritten" is counted, not inferred.** For the duration of the run the script
    installs an `AFTER INSERT OR UPDATE` trigger on `posts`, scoped to the one seeded row,
    logging every write of the three content columns with its md5 into a temporary
    `durability_gate_writes` table. Trigger, function and table are dropped in `finally`. This
    is measurement scaffolding on a dev row, not a schema change to the port.
  - **The providers' keys never touch the repo.** They are read from the environment,
    encrypted under the same throwaway Fernet key `write.test.ts` uses via the app's own
    `encryptWithKey`, written to the `settings` row the agents read, and the previous row is
    restored in `finally` (verified afterwards: the restored ciphertext does not decrypt under
    the throwaway key).

  ```
  $ cd web && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON src/mastra/scripts/durability-gate.mjs
  [2026-08-22T13:17:02.142Z] building the worker bundle from scratch
  [2026-08-22T13:17:15.381Z] seeding the post
  [2026-08-22T13:17:15.387Z] installing the write audit trigger
  [2026-08-22T13:17:15.403Z] writing the provider keys into the settings row
  [2026-08-22T13:17:16.406Z] starting the run from a separate `web` process
  [2026-08-22T13:17:16.683Z] run de13b1f1-9cac-4196-bed6-337b615599b6 published, no worker alive yet
  [2026-08-22T13:17:16.683Z] worker A spawned (pid 85187)
  [2026-08-22T13:17:16.683Z] waiting for `outline` to commit
  [2026-08-22T13:18:34.769Z] outline committed after 78.086s
  [2026-08-22T13:18:34.769Z] holding 30s so the kill lands inside the write agent call
  [2026-08-22T13:19:04.772Z] worker A SIGKILLed mid-`write`
  [2026-08-22T13:19:04.808Z] worker B spawned (pid 85885)
  [2026-08-22T13:19:04.809Z] waiting for `write` to commit on worker B
  [2026-08-22T13:20:42.919Z] waiting for the run to settle
  [2026-08-22T13:20:42.932Z] PASS  research-step-record-unchanged: persisted step record for `research` is byte-identical across the crash
  [2026-08-22T13:20:42.932Z] PASS  outline-step-record-unchanged: persisted step record for `outline` is byte-identical across the crash
  [2026-08-22T13:20:42.932Z] PASS  killed-mid-write: at the kill: research 6179 chars, outline 12035 chars, draft null
  [2026-08-22T13:20:42.932Z] PASS  write-completed-after-restart: draft_content is 13001 chars after the restart
  [2026-08-22T13:20:42.932Z] PASS  research-not-rewritten: research_content md5 unchanged across the crash and only 1 distinct value in 4 logged writes (0 rewrites)
  [2026-08-22T13:20:42.932Z] PASS  outline-not-rewritten: outline_content md5 unchanged across the crash and only 1 distinct value in 4 logged writes (0 rewrites)
  [2026-08-22T13:20:42.932Z] PASS  draft-written-once: draft_content has 1 distinct value in the write log (0 rewrites)
  [2026-08-22T13:20:42.932Z] PASS  resumed-through-reclaim: write committed 98.1s after the kill, which is past the 60s XAUTOCLAIM idle threshold: the message was pending under worker A, so worker A had genuinely started the step
  [2026-08-22T13:20:42.932Z] PASS  parked-at-edit-gate: run status suspended, suspendedPaths {"edit":[3]}, stage_status.edit review
  [2026-08-22T13:20:42.932Z] PASS  worker-b-is-a-different-process: worker A pid 85187, worker B pid 85885
  [2026-08-22T13:20:42.943Z] 10/10 checks passed
  $ echo $?
  0
  ```

  The audit table, which is the whole "no duplicated writes" claim in four rows. Every content
  column is written exactly once, and nothing that existed before the kill (13:19:04.772Z) is
  touched after it:

  ```
  {"at": "13:17:25.810Z", "research": "6179 1b197cba", "outline": null,            "draft": null,             "stageStatus": {"research": "complete"}}
  {"at": "13:18:33.982Z", "research": "6179 1b197cba", "outline": "12035 0840c369", "draft": null,             "stageStatus": {"outline": "complete", "research": "complete"}}
  {"at": "13:20:42.291Z", "research": "6179 1b197cba", "outline": "12035 0840c369", "draft": "13001 f058f23b", "stageStatus": {"write": "complete", "outline": "complete", "research": "complete"}}
  {"at": "13:20:42.299Z", "research": "6179 1b197cba", "outline": "12035 0840c369", "draft": "13001 f058f23b", "stageStatus": {"edit": "review", "write": "complete", "outline": "complete", "research": "complete"}}
  ```

  Run state either side of the kill, from `workflow.getWorkflowRunById()`:

  ```
  at the kill:    status "running",   steps ["outline","research"],                stage_status {"outline":"complete","research":"complete"}
  after restart:  status "suspended", steps ["edit","write","outline","research"], stage_status {"edit":"review","write":"complete","outline":"complete","research":"complete"}
                  suspendedPaths {"edit":[3]}, current_stage "edit"
  ```

  Timings and spend. `outline` committed 78.1s into the run; the kill landed 30s after that;
  worker B was up 36ms later; `write` committed 98.1s after the kill and the run settled 11ms
  after that. Providers reported: `research` `sonar-pro` 142 in / 1313 out, `outline`
  `claude-opus-4-6` 1636 in / 2982 out, `write` `claude-opus-4-6` 3148 in / 3162 out (the
  second, successful attempt; the first attempt's tokens died with worker A and are not
  reported anywhere, which is itself worth knowing for Phase 8's cost display).

  Three findings worth carrying forward:

  1. **The 98.1s is the evidence, not an inconvenience.** Worker B was alive 36ms after the
     kill, so had the `workflow.step.run` message for `write` still been unread in the stream
     it would have been consumed immediately. It was not: it sat in worker A's pending-entries
     list until `XAUTOCLAIM` reclaimed it. That both proves worker A had genuinely entered the
     step body and confirms 4.5a's measured 60-90s reclaim window on the real pipeline. A
     stage whose worker dies is parked for about a minute and a half before anything happens.
  2. **The run snapshot has no record of the interrupted step.** At the kill, `steps` held
     `research` and `outline` and no key at all for `write`, exactly as 4.5a found on the
     probe. Nothing in storage identifies an interrupted step, so the ledger's stated fallback
     (a worker startup sweep over storage) could not have been implemented even if it had been
     needed.
  3. **Recovery re-runs the whole step, so the provider is billed twice for `write`.** That is
     the memoization boundary: completed steps are never re-executed, interrupted ones restart
     from the top. At current volumes that is the right trade, but it is the cost model Phase 8
     has to display honestly.

  Negative controls. The system-level controls for this property were run in 4.5a on the
  provider-free probe against the same engine, transport and consumer group: worker B on the
  wrong Redis database (no recovery), `reclaimIntervalMs: 0` (no recovery), no kill at all
  (redelivery claims fail), and a step body that records twice (exactly-once claim fails).
  Re-running them here would re-bill `research` and `outline` to re-learn a property already
  proven for free, so they were not repeated, and that is a deliberate choice rather than a
  gap in the evidence. What is specific to this item is the audit instrument, so that is what
  was controlled here: the `count(distinct md5) = 1` rule was replayed over the recorded log,
  over a log in which `research_content` is rewritten once, and over an empty log standing for
  a trigger that never fired.

  ```
  $ psql "$DATABASE_URL" -c "<the three scenarios over the recorded md5s>"
                 scenario               | distinct_values | check_passes
  --------------------------------------+-----------------+--------------
   real log (trigger fired, no rewrite) |               1 | t
   research rewritten once by a re-run  |               2 | f
   audit trigger never fired            |               0 | f
  ```

  The third row is the one that matters: a dead instrument fails the check rather than
  silently satisfying it, so a green result cannot be produced by a trigger that was not
  recording.

  Frontend gates:

  ```
  $ cd web && pnpm tsc --noEmit
  (no output, exit 0)
  $ cd web && pnpm lint
  (no output, exit 0)
  $ cd web && NO_COLOR=1 pnpm test
   Test Files  2 failed | 52 passed (54)
        Tests  9 failed | 805 passed | 8 skipped (822)
     Duration  79.67s
  $ cd web && NO_COLOR=1 pnpm build
  ✓ Compiled successfully in 3.2s
  (exit 0)
  ```

  The 9 failures are the recorded baseline for this worktree (6 `image-preview` +
  3 `PostDetail`), unchanged: this item adds a script, not a test.

  Backend gates, unchanged at the Phase 0 baseline (no Python touched):

  ```
  $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test NO_COLOR=1 uv run pytest -q
  125 failed, 236 passed, 25 errors in 15.23s
  $ cd api && uv run ruff check .
  Found 32 errors.
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 126 files already formatted
  ```

## 4.6


  **The defect this found.** Every stage committed its column with
  `saveStageOutput(postId, stage, content, {...state.stageStatus, stage: "complete"})`: the
  fourth argument was the whole `stage_status` map, read from the row when the step started.
  That is a read-modify-write over a column two runs share. Two runs on one post that both read
  the row before either finishes each hold a pre-image of the map, so whichever writes second
  erases the other's entry. `stage_status` is what the dashboard reads to decide what has run,
  so a lost entry reports a finished stage as never run and a subsequent full pipeline re-bills
  it. Python had the same shape (`save_stage_output` in `api/src/pipeline/helpers.py:268`), so
  this is a defect carried over by a faithful port rather than one introduced by it.

  **Failing first**, before any fix, with the test's forced overlap in place:

  ```
  $ cd web && NO_COLOR=1 npx vitest run src/mastra/workflows/concurrency.test.ts
   FAIL  src/mastra/workflows/concurrency.test.ts > two runs writing the same post row at once >
     keeps both stages in stage_status rather than losing the earlier write
  AssertionError: expected { outline: 'complete' } to deeply equal { research: 'complete', ...(1) }

  - Expected
  + Received

    {
      "outline": "complete",
  -   "research": "complete",
    }

   Test Files  1 failed (1)
        Tests  2 failed | 8 passed (10)
  ```

  (The second failure in that run was a fault in the test itself, not in the code: `ready` is the
  one stage whose prompt is not built by `buildStagePrompt`, so it renders the slug rather than
  the topic and never saw the per-post marker. The marker now rides in both columns.)

  **The fix.** `mergeStageStatus()` in `web/src/mastra/post-state.ts` does the merge in SQL,
  inside the same single `UPDATE` that writes the content column, where Postgres' row lock
  serializes it:

  ```
  coalesce(posts.stage_status, '{}'::jsonb) || $patch::jsonb
  ```

  `saveStageOutput`'s fourth argument is now a patch (`{research: "complete"}`) rather than a
  whole map, and `markStageForReview` takes no map at all. Every call site already computed a
  pure merge (`{...state.stageStatus, [stage]: X}`), so single-run behaviour is unchanged. Two
  reads that existed only to build the map are gone: `reviewGate` lost its `stageStatus`
  parameter, and `images-assemble` lost a whole `loadPipelineState` call.

  **Passing**, ten tests over six real evented runs against live Postgres and Redis:

  ```
  $ cd web && NO_COLOR=1 npx vitest run src/mastra/workflows/concurrency.test.ts

   RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web

   ✓ src/mastra/workflows/concurrency.test.ts (10 tests) 3484ms

   Test Files  1 passed (1)
        Tests  10 passed (10)
     Duration  4.45s
  ```

  **What the test actually runs.** Two groups, all six agents stubbed and nothing else; the
  database, Redis and the evented engine are real.

  1. *Same row.* One post, two concurrent named-stage runs (`["research"]` and `["outline"]`).
     Both stubbed agents wait on a two-party barrier that sits downstream of
     `loadPipelineState` and upstream of `saveStageOutput` in both steps, so by construction
     both runs have read the row before either writes it. Asserts both runs succeed, that
     `stage_status` ends with both entries, that both content columns are committed, and that
     `current_stage` holds one of the two stages.
  2. *Different rows, and the pool.* Four full six-stage pipelines at once on four posts, each
     carrying a distinct marker in its topic and slug that every stubbed agent echoes. Asserts
     all four succeed, that every post's six stages are complete, and that no row holds another
     post's marker in any of its five prose columns. While they run the shared `pg` pool is
     sampled every 20ms.

  **`current_stage` is deliberately not serialized.** Both runs set it to their own stage and
  the later write wins. There is no ordering to prefer between two runs a user started at the
  same time, so the guarantee asserted is that it holds one of the two stages, not a
  particular one. Same for the content columns: each stage owns a different column, so a single
  `UPDATE` per stage means there is nothing to interleave.

  **Connections.** The pool is shared with Mastra's `PostgresStore`, so the engine's own storage
  traffic competes with the stage steps for the same ten connections. Measured peak across the
  four concurrent pipelines, from a temporary log removed before commit:

  ```
  POOLPEAK {"max":10,"total":4,"waiting":0,"borrowed":4}
  ```

  Four of ten connections opened, none ever queued. The settled pool is then asserted to hold no
  borrowed client, which is the leak that actually exhausts a pool over a long-lived worker's
  life.

  **Negative controls.** Every one was applied to a clean tree and reverted from a `/tmp` copy.

  | # | Mutation | Expected | Observed |
  | --- | --- | --- | --- |
  | 1 | `mergeStageStatus` replaced by a plain assignment of the patch | same-row test fails | `Tests 2 failed \| 8 passed`; `expected { outline: 'complete' } to deeply equal { research: 'complete', ...(1) }`, and group two's status map collapsed to `{ ready: 'complete' }` because the call sites now send patches |
  | 2 | Control 1 plus `research`/`outline` call sites reverted to spreading the whole map (the true pre-fix state), and the barrier disarmed | same-row test **passes**, proving the barrier is load-bearing | `✓ keeps both stages in stage_status...`; without the forced overlap the two runs did not race and the defect was invisible |
  | 3 | `write` commits to a hardcoded post id instead of its own | cross-post test fails | `Tests 2 failed \| 8 passed`; `× never writes one post's output into another post's row` |
  | 4 | A client borrowed from the pool and never released | leak test fails | `Tests 1 failed \| 9 passed`; `× returns every borrowed connection once the runs settle` |
  | 5 | The pool sampler replaced by a no-op | pool-bound test fails rather than passing vacuously | `Tests 1 failed \| 9 passed`; `× never opened more connections than the pool allows` |

  Control 2 is the one worth reading twice: it shows the pre-fix code passes this test when the
  overlap is left to the scheduler. A concurrency test without a forced rendezvous would have
  been green on broken code.

  The `coalesce` in the merge is load-bearing rather than defensive; the column is nullable and
  `||` propagates null, which would blank the map instead of seeding it:

  ```
  $ docker compose exec -T db psql -U pipeline -d content_pipeline -c "select (null::jsonb || '{\"research\":\"complete\"}'::jsonb) is null as without_coalesce_is_null, coalesce(null::jsonb,'{}'::jsonb) || '{\"research\":\"complete\"}'::jsonb as with_coalesce;"
   without_coalesce_is_null |      with_coalesce
  --------------------------+--------------------------
   t                        | {"research": "complete"}
  (1 row)
  ```

  Frontend gates:

  ```
  $ cd web && NO_COLOR=1 npx tsc --noEmit
  (no output)
  exit 0

  $ cd web && NO_COLOR=1 npx eslint
  (no output)
  lint exit: 0

  $ cd web && NO_COLOR=1 npx vitest run
   Test Files  2 failed | 53 passed (55)
        Tests  9 failed | 815 passed | 8 skipped (832)
  ```

  Nine failures, the recorded baseline for this worktree: 6 in `image-preview.test.tsx` and 3 in
  `PostDetail.test.tsx`. An earlier run of the same suite reported 10, the extra one being
  `scaffold-check.test.ts`'s stream-event race already logged in `todo.md`; it does not reproduce
  on a second run.

  ```
  $ cd web && NO_COLOR=1 npx next build
   ✓ Compiled successfully
  build exit: 0
  ```

  Backend gates, unchanged at the Phase 0 baseline (no Python touched):

  ```
  $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test NO_COLOR=1 uv run pytest -q
  125 failed, 236 passed, 25 errors in 15.45s
  $ cd api && uv run ruff check .
  Found 32 errors.
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 126 files already formatted
  ```

## 4.7


  Split. The first attempt at the run itself (the procedure is
  `web/src/mastra/scripts/full-pipeline.mjs`, committed under 4.7a) found three defects: one
  that kills the `edit` stage on a deployed worker, one that silently strips every stage's rule
  file from its prompt, and one that has been double-billing every stage of every run since
  Phase 2. Fixing them is not one iteration's work and each needs its own evidence, so:

  - 4.7a the duplicate-execution defect the run exposed, and its fix
  - 4.7b the full-pipeline completion hook (`current_stage = "complete"`, `completed_at`),
    which `_post_completion_hook` in `api/src/worker.py:429` runs at the end of a full run and
    the port never had
  - 4.7c the green end-to-end run with pasted evidence, itself split once run:
    - 4.7c-i the run, and every property of it that does not depend on a billed Gemini key
    - 4.7c-ii the image-generation half, which no key in this environment can execute

  The two deployability defects (`RULES_DIR` and `TEXTSTAT_DATA_DIR` on the worker bundle) are
  configuration rather than code, are recorded under 4.7a and in `todo.md`, and belong to items
  7.1 and 7.2 where the compose and Railway service definitions are written.

## 4.7a


  **How it was found.** `web/src/mastra/scripts/full-pipeline.mjs` runs the real thing: it
  builds the deployable worker bundle from scratch, starts a run from a separate `web` process
  that then exits, spawns the worker, and installs an `AFTER INSERT OR UPDATE` trigger on the
  seeded post row that records the md5 of all six content columns on every write. The second
  attempt ended `success` with all six stages `complete`, and the write log said this:

  ```
  $ cd web && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
      src/mastra/scripts/full-pipeline.mjs
  [2026-08-22T13:52:38.505Z] stage_status.research = complete at 63.1s
  [2026-08-22T13:53:44.598Z] stage_status.outline = complete at 129.2s
  [2026-08-22T13:54:23.652Z] stage_status.write = complete at 168.2s
  [2026-08-22T13:55:38.756Z] stage_status.edit = complete at 243.4s
  [2026-08-22T13:56:35.845Z] stage_status.images = complete at 300.4s
  [2026-08-22T13:57:35.966Z] stage_status.ready = complete at 360.6s
  [2026-08-22T13:57:35.969Z] run settled as success after 360.6s
  ...
  FAIL  each-column-written-once: distinct values over 13 logged writes:
        research_content=2 outline_content=2 draft_content=1 final_md_content=4
        image_manifest=3 ready_content=1
  FAIL  no-stage-billed-nothing: research.skipped=false outline.skipped=false write.skipped=true
        edit.skipped=false images.skipped=true ready.skipped=false
  ```

  Read the durations against the write counts and the rule is exact: `research` took 63s and was
  written twice, `outline` 66s and twice, `edit` 75s and four times, `images` 57s and three
  times, `write` 39s and once. Anything over 60 seconds ran more than once. The worker's own log
  agrees, with `edit`'s post-stage warning appearing four times from one process:

  ```
  $ grep -c "SEO checks still failing after edit" web/.mastra/full-pipeline/worker.log
  4
  ```

  The `skipped=true` entries are the same defect seen from the other end: a duplicate that
  starts after the original has committed takes the skip branch, so `write` and `images` report
  as skipped on a run that plainly executed them.

  **Mechanism**, read out of the installed package rather than inferred. `RedisStreamsPubSub`
  starts a reclaim loop per grouped subscription (`#startReclaimLoop`,
  `node_modules/@mastra/redis-streams/dist/index.js:202-225`) which every `reclaimIntervalMs`
  runs `XAUTOCLAIM <stream> <group> <consumer> <reclaimIdleMs> 0-0` and delivers whatever it
  claims. `XAUTOCLAIM` selects purely on idle time; it cannot tell a consumer that died from one
  that is still working. `WorkflowEventProcessor.handle` awaits the step body before the
  transport acks (4.5a), so a `workflow.step.run` message is pending for the whole step. The
  package's own type documentation says the quiet part out loud:

  ```
  $ sed -n '47,53p' node_modules/@mastra/redis-streams/dist/index.d.ts
      /**
       * Minimum idle time (in ms) before a pending message is eligible for
       * reclaim. Should be much larger than typical in-flight processing time to
       * avoid double-delivery. Defaults to 60_000 ms.
       */
      reclaimIdleMs?: number;
  ```

  The instance was left at that default in Phase 2, and every stage in this pipeline is an LLM
  call of 40 to 120 seconds. This is the same loop that recovers a crashed worker's step
  (4.5a), so it cannot be disabled: the window has to be wider than a step.

  **The fix.** `RECLAIM_IDLE_MS = 15 * 60_000` in `web/src/mastra/index.ts`, passed to the
  pubsub. 15 minutes is well past the slowest stage measured (`edit` 75s, `images` 57s over four
  generations) with room for a slow provider. The cost is recovery latency: a genuinely dead
  worker's in-flight step now waits up to 15 minutes for reclaim instead of the 70-98s recorded
  under 4.5. Duplicate billing on every stage of every run is the worse of the two, and a step
  that does outlive the window is re-delivered rather than lost, with the duplicate taking the
  skip branch if the original has committed. Item 4.5 is annotated with the new number.

  **Regression test**, provider-free and in the suite. `reclaim-duplication.test.ts` builds the
  same one-step probe workflow twice, once with a window under the step duration and once over,
  and asserts the app's own instance is wired wider than the slowest stage:

  ```
  $ cd web && NO_COLOR=1 npx vitest run src/mastra/workflows/reclaim-duplication.test.ts

   RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web

   ✓ src/mastra/workflows/reclaim-duplication.test.ts (5 tests) 23236ms

   Test Files  1 passed (1)
        Tests  5 passed (5)
     Duration  24.22s
  ```

  **Order, stated honestly.** The failing-first artifact is the end-to-end run above, not a unit
  test: the defect was found by the write audit, and the fix and the regression test were
  written after it. Tests 1-3 in the file parameterise their own window, so they do not depend
  on the app's configuration; tests 4 and 5 do, and the control below restores the pre-fix state
  and shows test 5 failing.

  **Negative controls.**

  | Control | Expectation | Result |
  | --- | --- | --- |
  | `reclaimIntervalMs: 0` on the short-window probe (reclaim loop off, everything else equal) | duplication tests fail | `2 failed \| 2 passed (4)`, exactly the two duplication tests, `expected 1 to be greater than 1` |
  | Delete `reclaimIdleMs: RECLAIM_IDLE_MS` from `index.ts` (constant kept, wiring removed) | the wiring test fails | `1 failed \| 4 skipped (5)` |
  | The two windows against the same 6s step (2s vs 60s) | duplication in one, not the other | 2s: more than one execution, second starting inside the first; 60s: exactly one |

  **The two deployability defects the same run found**, both logged in `todo.md` for items 7.1
  and 7.2. The worker bundle runs with cwd set to its own output directory, and both asset paths
  are resolved from `process.cwd()`:

  - `RULES_DIR`: `rulesDir()` falls back to `<cwd>/../rules`, which under the bundle is
    `web/.mastra/rules`. `loadRules` returns `""` for a missing file rather than throwing, so
    every stage would silently run with its rule file stripped from the prompt. Item 4.5b's
    durability-gate run was executed this way.
  - `TEXTSTAT_DATA_DIR`: `textstatDataDir()` falls back to `<cwd>/src/mastra/textstat/data`.
    This one is fatal, and it killed the first attempt at the run after `research`, `outline`
    and `write` had already been billed:

    ```
    $ grep -i error web/.mastra/full-pipeline/worker.log
    Error executing step edit: Error: ENOENT: no such file or directory, open
    '.../web/.mastra/worker-e2e/src/mastra/textstat/data/cmudict-syllables.txt.gz'
    ```

  `mastra worker build` has no asset-copy option (`BundlerConfig` is `externals`, `sourcemap`,
  `minify`, `transpilePackages`, `dynamicPackages`), so the data files cannot ride inside the
  bundle and the environment variables are the only lever. `docker-compose.yml` already sets
  `RULES_DIR: /app/rules` for the Python worker; the TypeScript `worker` service needs
  `RULES_DIR`, `TEXTSTAT_DATA_DIR` and `MEDIA_DIR`.

  **Two findings carried to 4.7b and 4.7c.**

  1. `current_stage` ended the successful run as `ready`, not `complete`. Python's full-pipeline
     branch calls `_post_completion_hook` (`api/src/worker.py:429`), which sets
     `current_stage = "complete"` and `completed_at` and queues any configured publish. The port
     has `markCompleteIfAllStagesComplete`, but only the single-stage rerun path calls it. That
     is item 4.7b.
  2. All four Gemini generations returned `429 RESOURCE_EXHAUSTED ... limit: 0, model:
     gemini-3.1-flash-image`, so the stage stored a manifest with `total_generated: 0` and
     `total_failed: 4` and the run continued. This is the environment, not the port: the Python
     golden capture hit the same wall on the same key
     (`docs/mastra-port/golden/how-to-choose-a-crm-for-a-small-team/images.json` records
     `total_generated 0, total_failed 5`). 4.7c cannot assert on generated image files with this
     key, and the honest exit is manifest shape plus per-entry provider errors matching Python's.

  **Gates.**

  ```
  $ cd web && npx tsc --noEmit
  (exit 0, no output)
  $ cd web && npx eslint
  (exit 0, no output)
  $ cd web && NO_COLOR=1 npx vitest run
   Test Files  2 failed | 54 passed (56)
        Tests  9 failed | 820 passed | 8 skipped (837)
  ```

  The 9 are the recorded baseline: 6 in `image-preview.test.tsx` and 3 in `PostDetail.test.tsx`.
  An earlier run of the same suite showed 11, the extra two being the `settings.api_keys` race
  in `agents/outline.test.ts` and the `scaffold-check` stream race, both already in `todo.md`.

  ```
  $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test NO_COLOR=1 uv run pytest -q
  125 failed, 236 passed, 25 errors in 15.23s
  $ cd api && uv run ruff check .
  Found 32 errors.
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 126 files already formatted
  ```

  Unchanged from the baseline recorded under 4.5b and 4.6; nothing in this item touches `api/`.

## 4.7b


  **What was missing.** Nothing sat at the end of the chain at all. A full run left
  `current_stage` reading whichever stage happened to run last (`"ready"`, or `"pending"` when
  every stage was already complete and all six steps skipped) and `completed_at` null for good.
  Those two columns are the pair the dashboard and the posts list read to tell a finished post
  from one still moving, so every post the port ever ran came out reading unfinished.

  **The port.** A seventh step, `pipeline-complete`, on the tail of the workflow:

  ```
  research -> outline -> write -> edit -> images -> ready -> pipeline-complete
  ```

  A step rather than a callback, because the structural rule of this port is that everything a
  run does is a Mastra primitive: as a step it appears in Studio, in `run.stream()`'s events and
  on the finished run's `steps` map. It passes `ready`'s stage meta straight through, so the
  workflow's declared `outputSchema` is unchanged.

  Three decisions worth recording:

  1. **Gated on the selection, not on `stage_status`.** Python's `if is_full_pipeline:` block is
     the only caller of `_post_completion_hook`, so a run that names its stages must not stamp
     `completed_at`; `markRerunComplete` (item 4.2b) already settles `current_stage` for that
     path. Restamping here would move the finish time of a post that finished days ago every
     time one stage is rerun from the dashboard.
  2. **Unconditional once the chain reaches it.** Unlike `markCompleteIfAllStagesComplete`, the
     hook does not re-read `stage_status`. A stage can finish without succeeding: `images`
     writes `images: failed` and returns rather than raising (`api/src/pipeline/stages/images.py`
     returns at line 99), and Python's run carries on to `ready` and reaches the hook anyway.
     Checking the map would leave such a run reading unfinished forever, which is not what the
     dashboard showed before the port.
  3. **A suspended run never reaches it**, because it is the last step. That is asserted rather
     than assumed.

  **Failing first.** The three assertions the hook exists to satisfy, before it was written:

  ```
  $ cd web && NO_COLOR=1 npx vitest run src/mastra/workflows/pipeline-completion.test.ts
   FAIL  ... > a full run that finishes > promotes current_stage to complete
  AssertionError: expected 'edit' to be 'complete' // Object.is equality
   FAIL  ... > a full run that finishes > stamps completed_at
  AssertionError: expected null to be an instance of Date
   FAIL  ... > a full run with every stage already complete > stamps both columns even though no stage ran
  AssertionError: expected 'pending' to be 'complete' // Object.is equality
   Test Files  1 failed (1)
        Tests  3 failed | 8 passed (11)
  ```

  The other eight passed unchanged, which is the point of the negative controls: the named-stage
  run and the gated run must behave the same before and after.

  **After.** Four real evented runs against live Postgres and Redis, every provider boundary
  stubbed and nothing else:

  ```
  $ cd web && NO_COLOR=1 npx vitest run src/mastra/workflows/pipeline-completion.test.ts
   ✓ src/mastra/workflows/pipeline-completion.test.ts (11 tests) 5542ms
   Test Files  1 passed (1)
        Tests  11 passed (11)
  ```

  | Run | `stages` | Seeded `stage_status` | `current_stage` after | `completed_at` after |
  | --- | --- | --- | --- | --- |
  | full, one stage left | absent | all but `edit` | `complete` | set |
  | named-stage rerun | `["edit"]` | all but `edit` | `complete` (item 4.2b) | **null** |
  | full, nothing to do | absent | all six | `complete` | set |
  | full, gated on `edit` | absent | all but `edit` | `edit` (suspended) | **null** |

  **Three existing tests changed, because the behaviour they pinned is what this item changes.**
  Each now asserts the new contract and says why in a comment:

  - `workflows/pipeline.test.ts`: a full run's `current_stage` is `"complete"`, not `"ready"`,
    and `completed_at` is set.
  - `workflows/worker-process.test.ts`: the all-complete post the worker skips still gets both
    columns stamped; the assertion that no content column moved is kept and strengthened.
  - `workflows/rerun-completion.test.ts`: its full-run case asserted "does not promote", with a
    comment saying the hook was not ported yet. It now asserts that the promotion came from the
    hook rather than from the rerun check, using `completed_at` (which only the hook writes) to
    tell the two apart.

  **A test-infrastructure defect found and fixed on the way.** The new file was first written
  with post ids `...04c1/04c2/04c3`, which are exactly `review-gates.test.ts`'s ids. Vitest runs
  files in parallel, so the two files deleted and re-inserted the same three rows underneath each
  other. Symptoms were nonsense: this file's runs came back `"suspended"` for posts with no gate
  configured, a post seeded all-complete came out at `current_stage = "outline"`, and one run hit
  `duplicate key value violates unique constraint "posts_pkey"` on an insert two lines after the
  matching delete. Moving to `...061a`-`061d` fixed it, and the file now carries a comment saying
  ids have to be unique across the suite rather than within a file. Worth knowing for Phase 5,
  which will add many more database-backed test files.

  **Gates.** Two consecutive full-suite runs, both exactly at the recorded baseline:

  ```
  $ cd web && npx tsc --noEmit
  (exit 0, no output)
  $ cd web && npx eslint
  (exit 0, no output)
  $ cd web && NO_COLOR=1 npx vitest run
   Test Files  2 failed | 55 passed (57)
        Tests  9 failed | 831 passed | 8 skipped (848)
  $ cd web && NO_COLOR=1 npx vitest run
   Test Files  2 failed | 55 passed (57)
        Tests  9 failed | 831 passed | 8 skipped (848)
  $ cd web && NO_COLOR=1 npx next build
  (exit 0)
  ```

  The 9 are the recorded baseline: 6 in `image-preview.test.tsx` and 3 in `PostDetail.test.tsx`.
  848 total is 837 plus the 11 new tests.

  ```
  $ cd api && TEST_DATABASE_URL=postgresql+asyncpg://pipeline:pipeline@localhost:5435/content_pipeline_test NO_COLOR=1 uv run pytest -q
  125 failed, 236 passed, 25 errors in 15.46s
  $ cd api && uv run ruff check .
  Found 32 errors.
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 126 files already formatted
  ```

  Unchanged from the baseline recorded under 4.5b, 4.6 and 4.7a; nothing in this item touches
  `api/`.

## 4.7c


  Split after running it. The run reached `success` and ten of the script's fourteen checks
  passed; the four that failed are all the same fact, that this environment's Gemini key is
  provisioned at `limit: 0` for every image-capable model, so no image can be generated here by
  any stack. That is a credential fact, not a port defect, and it cannot be fixed by rerunning.
  Separating it keeps the run's real result checkable and states the remaining gap precisely:

  - 4.7c-i the run itself, and every property that does not depend on a billed Gemini key
  - 4.7c-ii the image-generation half of the `images` stage and its effect on `ready`

## 4.7c-i


  ```
  $ cd web && set -a && . ../.env \
      && eval "$(grep -E '^(ANTHROPIC|PERPLEXITY|GEMINI)_API_KEY=' <main-checkout>/.env)" \
      && set +a \
      && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
           src/mastra/scripts/full-pipeline.mjs
  [2026-08-22T14:47:55.302Z] building the worker bundle from scratch
  [2026-08-22T14:48:08.648Z] installing the write audit trigger
  [2026-08-22T14:48:08.657Z] writing the provider keys into the settings row
  [2026-08-22T14:48:09.731Z] starting the run from a separate `web` process that then exits
  [2026-08-22T14:48:10.025Z] run 49c34483-4671-4002-9809-af702f4ae700 published, no worker alive yet
  [2026-08-22T14:48:15.029Z] worker spawned (pid 44767)
  [2026-08-22T14:48:33.077Z] stage_status.research = complete at 18.0s
  [2026-08-22T14:49:30.153Z] stage_status.outline = complete at 75.1s
  [2026-08-22T14:50:15.215Z] stage_status.write = complete at 120.2s
  [2026-08-22T14:51:30.317Z] stage_status.edit = complete at 195.3s
  [2026-08-22T14:52:21.403Z] stage_status.images = complete at 246.4s
  [2026-08-22T14:53:12.516Z] stage_status.ready = complete at 297.5s
  [2026-08-22T14:53:12.520Z] run settled as success after 297.5s
  [2026-08-22T14:53:12.522Z] PASS  nothing-ran-before-the-worker: 5s after the run was published and before any worker existed, stage_status was {} and every content column was empty
  [2026-08-22T14:53:12.523Z] PASS  run-succeeded: run 49c34483-4671-4002-9809-af702f4ae700 settled as success after 297.5s
  [2026-08-22T14:53:12.523Z] PASS  six-steps-succeeded: research=success outline=success write=success edit=success images=success ready=success
  [2026-08-22T14:53:12.523Z] PASS  six-stages-complete: stage_status {"edit":"complete","ready":"complete","write":"complete","images":"complete","outline":"complete","research":"complete"}
  [2026-08-22T14:53:12.523Z] PASS  post-promoted-to-complete: current_stage is complete
  [2026-08-22T14:53:12.523Z] PASS  six-columns-written: research_content=10259 outline_content=8219 draft_content=7368 final_md_content=8406 image_manifest=15429 ready_content=5534
  [2026-08-22T14:53:12.523Z] PASS  each-column-written-once: distinct values over 7 logged writes: research_content=1 outline_content=1 draft_content=1 final_md_content=1 image_manifest=1 ready_content=1
  [2026-08-22T14:53:12.523Z] PASS  no-stage-billed-nothing: research.skipped=false outline.skipped=false write.skipped=false edit.skipped=false images.skipped=false ready.skipped=false
  [2026-08-22T14:53:12.523Z] PASS  manifest-shape: image_manifest keys ["model","images","version","post_slug","style_brief","total_failed","fallback_model","generated_date","total_generated"]
  [2026-08-22T14:53:12.523Z] FAIL  images-generated: 0 of 4 manifest entries generated, total_generated=0 total_failed=4
  [2026-08-22T14:53:12.523Z] FAIL  image-files-on-disk: 
  [2026-08-22T14:53:12.523Z] FAIL  featured-image-present: entry ids ["featured","content-1","content-2","content-3"]
  [2026-08-22T14:53:12.523Z] FAIL  ready-content-embeds-the-images: 0 of 0 generated image urls appear in ready_content (5534 chars)
  [2026-08-22T14:53:12.523Z] PASS  worker-stayed-up: worker pid 44767 exitCode null, stderr 0 chars
  [2026-08-22T14:53:12.533Z] 10/14 checks passed
  EXIT=1
  ```

  The script exits 1 because four checks failed. That is the honest exit code and it is left
  alone: the script is not edited to pass, and 4.7c-ii is not closed by weakening it.

  **Per stage, from `.mastra/full-pipeline/report.json`.** `model` is what the step reported it
  actually sent, so this is also the first end-to-end confirmation that every stage reaches the
  provider it is supposed to.

  | stage | step | stage_status | model | tokens in | tokens out | duration | column chars | writes |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | research | success | complete | `sonar-pro` | 1397 | 2245 | 17.3s | 10259 | 1 |
  | outline | success | complete | `claude-opus-4-6` | 4351 | 2286 | 56.7s | 8219 | 1 |
  | write | success | complete | `claude-opus-4-6` | 3825 | 1913 | 43.7s | 7368 | 1 |
  | edit | success | complete | `claude-opus-4-6` | 6637 | 3662 | 75.0s | 8406 | 1 |
  | images | success | complete | `claude-opus-4-6` | 5541 | 2496 | 51.9s | 15429 | 1 |
  | ready | success | complete | `claude-opus-4-6` | 3891 | 1935 | 50.8s | 5534 | 1 |

  Whole run 297.5s, 25,642 input and 14,537 output tokens across six provider calls. The
  Gemini sub-usage the `images` step reports is `{tokensIn: 0, tokensOut: 0}`, which is correct:
  the four requests were rejected before any token was counted.

  **What the write audit proves.** Seven rows were logged by the `AFTER INSERT OR UPDATE`
  trigger scoped to the seeded row: the seeding INSERT plus exactly six UPDATEs, one per stage.
  `each-column-written-once` counts *distinct non-empty md5 values per column over that history*,
  not the final value, so a stage that ran twice and produced identical output would still count
  2 if it wrote twice, and a column overwritten with different content would count 2. Every
  column counts 1. Six stages, six writes, seven rows, no gap and no surplus.

  This is also the first run in which the fix from 4.7a is load-bearing rather than incidental:
  `write` took 120.2s and `edit` 195.3s, both far past the 60s default `reclaimIdleMs` that
  4.7a raised to 15 minutes. Under the old window both stages would have been redelivered to
  the live worker and executed a second time. The write audit says they were not.

  **What ran before the worker existed.** Five seconds after the `web` process published the
  run and exited, and before any worker process had been spawned, the row read
  `current_stage = pending`, `stage_status = {}` and all six content columns `NULL`. The `web`
  service therefore did not execute anything; the worker did. Restarting `web` cannot disturb a
  run because `web` is not where runs execute.

  **The completion hook from 4.7b, on a real run.** `current_stage` is `complete`. That column
  is only written by `pipelineCompleteStep`, and only on a run that did not name its stages, so
  its value here is the seventh step firing at the end of a genuine full pipeline rather than
  the single-stage rerun check.

  **`ready` did what `rules/blog-ready.md` asks.** `readyHasPublishingNotes` is `false`, so the
  publishing notes were dropped. This is reported rather than checked, for the reason recorded
  in the script: an assertion over generated prose is a coin flip.

  **Cleanup verified, not assumed.** The script's `finally` block ran:

  ```
  $ git status --porcelain
  $ psql ... -tAc "select count(*) from information_schema.tables where table_name='full_pipeline_writes'"
  0
  $ psql ... -tAc "select key, jsonb_object_keys(value) from settings where key='api_keys'"
  api_keys|anthropic
  ```

  Clean working tree, audit table and function and trigger dropped, and the `settings` row
  restored to the single-key row that was there before (the `sk-ant-` placeholder recorded under
  4.5b, not a real credential). No key was printed and none was written anywhere but that row.

  **Gates.** This item changes only the ledger, but the run rewrote and restored a shared
  `settings` row and seeded a `posts` row, so every gate was rerun rather than assumed.

  ```
  $ cd web && pnpm exec tsc --noEmit
  (exit 0, no output)
  $ cd web && pnpm lint
  (exit 0, no output)
  $ cd web && pnpm test
  Test Files  2 failed | 55 passed (57)
       Tests  9 failed | 831 passed | 8 skipped (848)
  $ cd web && pnpm build
  ✓ Compiled successfully in 3.3s
  (exit 0)
  ```

  The 9 failures are the Phase 0 baseline exactly, and in the same two files: 6 in
  `src/components/__tests__/image-preview.test.tsx` and 3 in `src/app/posts/PostDetail.test.tsx`.
  No new file joined them.

  ```
  $ cd api && set -a && . ../.env && set +a && uv run pytest -q
  125 failed, 236 passed, 25 errors in 15.23s
  $ cd api && uv run ruff check .
  Found 32 errors.
  $ cd api && uv run ruff format --check .
  9 files would be reformatted, 126 files already formatted
  ```

  Failures and errors are at the baseline (125 / 25) with one extra pass (236 against the
  recorded 235), so nothing regressed. Two notes worth carrying:

  1. `pytest` must be run with `.env` sourced. Without `TEST_DATABASE_URL`, `conftest.py` falls
     back to the hardcoded `localhost:5433`, which on this machine is an unrelated project's
     container, and the suite reports `4 failed, 205 passed, 177 errors`. That number is a
     mis-run, not a regression, and it is easy to mistake for one.
  2. The run left five `media/test-123/*.webp` files in the working tree. That is the already
     logged `todo.md` defect about `pytest` writing real images into the repo, not something
     this item introduced; they were deleted before committing.

## 4.7c-ii


  ```
  $ psql ... -tAc "select image_manifest->'images'->0->>'error' from posts where id='...04f7'"
  429 RESOURCE_EXHAUSTED. {"error":{"code":429,"message":"You exceeded your current quota,
  please check your plan and billing details. ...
  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests,
    limit: 0, model: gemini-3.1-flash-image
  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count,
    limit: 0, model: gemini-3.1-flash-image
  ","status":"RESOURCE_EXHAUSTED", ... "quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier" ...}
  ```

  **`limit: 0` is a billing tier, not a rate limit.** Waiting does not clear it. Probed live
  immediately after the run, every image-capable model on this key returns the same 429:

  ```
  $ for m in gemini-3.1-flash-image-preview gemini-3.1-flash-image \
             gemini-3.1-flash-lite-image gemini-2.5-flash-image \
             gemini-3-pro-image gemini-3-pro-image-preview; do
      curl -s -w $'\n%{http_code}' -X POST \
        "https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent" \
        -H "x-goog-api-key: ${GEMINI_API_KEY}" -H "Content-Type: application/json" \
        -d '{"contents":[{"parts":[{"text":"A single small blue square on white."}]}]}'
    done
  gemini-3.1-flash-image-preview     429  RESOURCE_EXHAUSTED | * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-flash-image
  gemini-3.1-flash-image             429  RESOURCE_EXHAUSTED | * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-flash-image
  gemini-3.1-flash-lite-image        429  RESOURCE_EXHAUSTED | * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-flash-lite-image
  gemini-2.5-flash-image             429  RESOURCE_EXHAUSTED | * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-2.5-flash-preview-image
  gemini-3-pro-image                 429  RESOURCE_EXHAUSTED | * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3-pro-image
  gemini-3-pro-image-preview         429  RESOURCE_EXHAUSTED | * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3-pro-image
  ```

  Six for six, including `gemini-3.1-flash-image-preview`, which is the id
  `GEMINI_IMAGE_MODEL_ID` in `web/src/mastra/images/gemini.ts` actually sends. Note that the
  quota is reported against the resolved id rather than the requested one
  (`-preview` resolves to `gemini-3.1-flash-image`), which is itself useful: it confirms the
  alias resolves server side rather than 404ing.

  The model list itself came from the live `GET /v1beta/models` on this key, so these are the
  ids the key can see, not ids from memory. A 429 `RESOURCE_EXHAUSTED` is an *authenticated*
  rejection, checked against the negative control rather than assumed:

  ```
  $ curl -s -X POST ".../gemini-3.1-flash-image-preview:generateContent" \
      -H "x-goog-api-key: not-a-real-key" ...
  HTTP 400
  400 INVALID_ARGUMENT | API key not valid. Please pass a valid API key.
  ```

  So a bad credential fails differently from this, and the credential and the model id both
  resolve; only the quota is zero. The Python golden capture hit the identical wall on the same
  day, so neither stack can generate an image here.

  **What the run did prove about `images`.** The stage reproduced Python's documented failure
  handling exactly rather than crashing the run: the manifest was still assembled and stored
  (15,429 chars, `manifest-shape` passed), each of the four entries carries `generated: false`
  and its own `error` string, `total_generated` is 0 and `total_failed` is 4, `stage_status.images`
  is `complete`, and the pipeline continued into `ready` and finished `success`.

  **What is left to prove, and how.** The generation path itself: that a Gemini success response
  becomes an optimised file on disk whose byte count matches the manifest entry, and that
  `ready` embeds those urls. The objective permits recorded/replayed provider calls as long as a
  live smoke test per provider exists and is run, and the live smoke test for Gemini is the 429
  above. So 4.7c-ii is closed by driving the real `imagesGenerateStep` and the real optimiser
  against a recorded Gemini success response and asserting the on-disk bytes and the `ready`
  embedding, not by rerunning `full-pipeline.mjs`. If a billed key ever becomes available, the
  script is already written and needs no change.

  Until then this is a real gap and belongs in `SUMMARY.md` (item 9.2), and it also bounds item
  7.6, whose exit criterion is a post reaching `ready` *with images* through the UI.

  **The success path, proven the way the item said it would be.**
  `web/src/mastra/steps/images-generate.test.ts` drives the production `imagesGenerateStep`
  against a recorded Gemini 200 and follows the bytes all the way to the `ready` prompt.
  Everything downstream of the socket is production code and real: the real `gemini.ts` parsing
  the recorded envelope, the real sharp optimizer, real files on a real disk, the production
  `imagesAssembleStep` writing the real `image_manifest` column of a real Postgres row, and the
  production `buildReadyPrompt` reading it back out of that row.

  ```
  $ cd web && pnpm exec vitest run src/mastra/steps/images-generate.test.ts --reporter=verbose
   RUN  v4.0.18 .../web

   ✓ imagesGenerateStep against a recorded Gemini success > sends the entry's aspect ratio and size to the incumbent model with the resolved key 1ms
   ✓ imagesGenerateStep against a recorded Gemini success > writes the content image at the content width, and its manifest entry names it 1ms
   ✓ imagesGenerateStep against a recorded Gemini success > writes the featured image at the featured width under a rewritten filename 1ms
   ✓ imagesGenerateStep against a recorded Gemini success > bills each generated image with the counts the response reported 0ms
   ✓ imagesGenerateStep against a recorded Gemini success > records an entry with no prompt as failed without calling or billing the provider 0ms
   ✓ the generated images reach the stored manifest and the ready prompt > stores every entry with the totals the fan-out produced 0ms
   ✓ the generated images reach the stored manifest and the ready prompt > claims a byte count for each generated entry that matches the file on disk 0ms
   ✓ the generated images reach the stored manifest and the ready prompt > embeds the generated urls in the ready prompt and drops the failed entry 0ms

   Test Files  1 passed (1)
        Tests  8 passed (8)
  ```

  **Where the recorded response comes from.** The 200 envelope is the `usage-reported` case of
  `images/data/gemini-parity.json`, captured under item 3.5d from the real Python
  `GeminiClient` with `httpx` intercepted, and it is used verbatim. Only the base64 payload is
  swapped, because the recorded one is a 1x1 pixel and the point here is to watch the optimizer
  resize; the substitute is `wide_png_base64` from `images/data/image-generation-parity.json`,
  the 2400x1600 PNG the item 3.5e exporter fed the real Python stage. Nothing in either corpus
  was authored for this test.

  **What the eight tests establish.** The request: one POST per prompted entry to
  `.../models/gemini-3.1-flash-image-preview:generateContent`, carrying the entry's own prompt,
  `responseModalities: ["IMAGE"]`, and the entry's `aspect_ratio` / `image_size` untouched
  (`4:3` / `1K` for the content entry, `16:9` / `2K` for the featured one, because `placement`
  is an object and so the featured overrides never fire: the 3.5e divergence, still holding).
  The `x-goog-api-key` header carries the value the step resolved through `requireApiKey`.

  The disk: the content image lands at `1200x800` and the featured one at `1920x1280`, both
  `webp`, both truncated heights, from one 2400x1600 source. Their sizes are 28,384 and 108,032
  bytes respectively, and the assertion is not against those constants but against the file:
  `spec.size_bytes` is compared to `stat()` on the written path, so a manifest that claims a
  byte count the file does not have fails. The content entry keeps its declared filename with
  the extension rewritten (`how-a-crm-pipeline-works.png` becomes
  `/media/<post>/how-a-crm-pipeline-works.webp`); the featured entry's `hero.png` is discarded
  for `featured-<MMDDYY>-<NN>.webp`.

  The manifest and `ready`: the three entries fold to `total_generated: 2`, `total_failed: 1` on
  the real row, every generated entry's stored `size_bytes` still matches its file, and the
  prompt `buildReadyPrompt` renders from that row contains both `/media/...` urls under
  `## Image Manifest (generated images only)` while the promptless entry's id and its
  `no prompt` error are absent.

  **Negative control**, so this is not eight assertions passing on nothing. Swapping the stub's
  reply for a 429 with the recorded `RESOURCE_EXHAUSTED` body, which is what this environment's
  key actually returns, fails five of the eight:

  ```
  $ # fetch stub temporarily returns 429 RESOURCE_EXHAUSTED instead of the recorded 200
  $ cd web && pnpm exec vitest run src/mastra/steps/images-generate.test.ts
  AssertionError: expected false to be true            (content generated)
  AssertionError: expected false to be true            (featured generated)
  AssertionError: expected null to deeply equal { tokensIn: 37, tokensOut: 1290, ... }
  AssertionError: expected +0 to be 2                  (total_generated)
  AssertionError: expected '# Blog Ready Stage ...' to contain 'undefined'   (no url to embed)

   Test Files  1 failed (1)
        Tests  5 failed | 3 passed (8)
  ```

  The three that still pass are the request-shape test, the promptless-entry test and the
  byte-count test (which has no generated entry left to check), which is the correct split: they
  do not depend on the provider succeeding.

  **The one stub, and why.** `requireApiKey` is stubbed to a literal. The `api_keys` settings
  row is a process-global singleton with no user scoping, and `api-keys.test.ts` already claims
  it exclusively (it saves the row, overwrites it, and restores it in `afterAll`). Seeding it
  from a second file that vitest may schedule on a parallel worker would make both files flaky.
  The lookup itself is proven against the real row and the real Fernet ciphertext under item
  3.1b, and asserting the stub's value on the outbound header proves the step reads the
  credential from that function rather than from anywhere else.

  **What is still not proven, and cannot be here.** That Gemini's own bytes are a usable image.
  Every assertion above is downstream of the base64 payload, so a live key would additionally
  prove that the model honours `aspectRatio`, `imageSize` and the style, brand-colour and
  exclusion constraints in `rules/blog-images.md`. That evaluation needs a billed key and stays
  on the gap list for `SUMMARY.md` (item 9.3) and as the bound on item 7.6.

  Gates, unchanged against the baseline recorded under 4.7c-i:

  ```
  $ cd web && pnpm exec tsc --noEmit
  (exit 0, no output)
  $ cd web && pnpm lint
  (exit 0, no output)
  $ cd web && pnpm test
  Test Files  2 failed | 56 passed (58)
       Tests  9 failed | 839 passed | 8 skipped (856)
  $ cd web && pnpm build
  ✓ Compiled successfully in 3.4s
  (exit 0)
  ```

  The 9 failures are the Phase 0 baseline exactly, in the same two files (6 in
  `image-preview.test.tsx`, 3 in `PostDetail.test.tsx`). The totals moved by exactly this
  item's 8 new tests in 1 new file. `api/` is untouched, so its gates are unchanged from 4.7c-i.
