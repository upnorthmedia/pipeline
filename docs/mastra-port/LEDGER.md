# Mastra port ledger

Check an item only when the exact command and its real output exist as evidence.

**Evidence lives in `evidence/phase-<N>.md`, not here.** This file is re-read in full
every iteration, so inline output blocks tax every future iteration. Write output under a
`## <item-id>` heading in the phase evidence file and leave a one-line link here. On
2026-08-23 this file was 20,820 lines (1.1MB); 143 evidence blocks were moved out verbatim,
bringing it to about 1,100 lines. Do not undo that.

**Split depth is capped at two levels below a numbered phase item** (`5.3` -> `5.3c` ->
`5.3c-iii`, stop). Complete a second-level item in one iteration however long it takes, or
mark it `[blocked]` with a reason and move on. Small sibling leaves may be batched into one
iteration.

Phase order is fixed. `api/` is deleted only in Phase 7.

---

## Phase 0: Baseline and ledger

- [x] 0.1 Create this ledger with every Phase 1-9 item as an unchecked checkbox, and record the
  Phase 0 baselines (`pytest`, `ruff check`, `ruff format --check`, `pnpm test`, `pnpm lint`,
  `pnpm tsc --noEmit`, `pnpm build`) with real pasted output.

  Evidence: [`evidence/phase-0.md` #0.1](../mastra-port/evidence/phase-0.md)

- [x] 0.2 Fix the pre-existing `tsc`/`build` break by adding `@types/pg` to `web/`, so the
  Phase 0 gate baseline for `tsc --noEmit` and `build` is exit 0. Confirm `pnpm test`
  failure count is still 9.

  Evidence: [`evidence/phase-0.md` #0.2](../mastra-port/evidence/phase-0.md)

- [x] 0.3 Stand up a reachable dev database for this repo (resolve the host-port 5433
  collision) and record the working local invocation, so later phases can run the Python
  pipeline and, later, the TypeScript data layer against a real database.

  Evidence: [`evidence/phase-0.md` #0.3](../mastra-port/evidence/phase-0.md)

- [x] 0.4 Capture golden fixtures: run the existing Python pipeline end to end on at least 2
  representative posts with different `article_type` and `output_format`. For each stage
  save the fully rendered prompt, the provider request parameters, and the raw output to
  `docs/mastra-port/golden/<post-slug>/<stage>.json`. Redact API keys. Exit: >= 12 fixture
  files committed.

  Evidence: [`evidence/phase-0.md` #0.4](../mastra-port/evidence/phase-0.md)

- [x] 0.4a Build the golden-fixture capture harness (`api/scripts/capture_golden.py`) and
  verify it end to end with `--dry-run`, which stubs only the network call and leaves prompt
  assembly, the client wrappers, retries, manifest parsing and image optimisation intact.

  Evidence: [`evidence/phase-0.md` #0.4a](../mastra-port/evidence/phase-0.md)

- [x] 0.4b Live capture for `how-to-choose-a-crm-for-a-small-team` (all six stages) with real
  provider keys. Commit `docs/mastra-port/golden/how-to-choose-a-crm-for-a-small-team/*.json`
  and the generated images. Record the run's token usage and cost in this ledger.

  Evidence: [`evidence/phase-0.md` #0.4b](../mastra-port/evidence/phase-0.md)

- [x] 0.4c Live capture for `best-time-tracking-tools-for-agencies` (all six stages). Commit
  its fixtures, then check 0.4.

  Evidence: [`evidence/phase-0.md` #0.4c](../mastra-port/evidence/phase-0.md)

- [x] 0.4c-i Make `capture_golden.py` resumable so an interrupted capture can be finished
  without re-paying for completed stages, and commit the one stage fixture already captured
  live for this post (`research.json`, 71788 bytes, `sonar-pro`, 1475 in / 5489 out,
  37.5s).

  Evidence: [`evidence/phase-0.md` #0.4c-i](../mastra-port/evidence/phase-0.md)

- [x] 0.4c-ii Capture the remaining five stages (`outline`, `write`, `edit`, `images`,
  `ready`) for `best-time-tracking-tools-for-agencies` with real keys, using `--resume`.
  Record usage and cost, commit the fixtures, then check 0.4c and 0.4.

  Evidence: [`evidence/phase-0.md` #0.4c-ii](../mastra-port/evidence/phase-0.md)

## Phase 1: TypeScript data layer

- [x] 1.1 Introspect the live database and define the full schema in TypeScript (Drizzle
  recommended; justify any other choice here). Must cover every table and column produced by
  Alembic 001-011, including `posts.stage_logs`, `execution_logs`, `stage_status`,
  `stage_settings`, `image_manifest` (JSONB), the WordPress fields, the Next.js publishing
  fields, and the `user_id` multi-tenancy column. Do not create a second database or a
  migration that recreates tables.

  Evidence: [`evidence/phase-1.md` #1.1](../mastra-port/evidence/phase-1.md)

- [x] 1.2 Write a schema-parity check that fails if any table or column known to Alembic is
  missing from the TS schema, or vice versa.

  Evidence: [`evidence/phase-1.md` #1.2](../mastra-port/evidence/phase-1.md)

- [x] 1.3 Port `api/src/services/crypto.py` to TypeScript and prove with a test that a value
  encrypted by the Python implementation decrypts correctly in TypeScript.

  Evidence: [`evidence/phase-1.md` #1.3](../mastra-port/evidence/phase-1.md)

- [x] 1.4 A TS script reads and writes a Post round-trip against the real dev database.

  Evidence: [`evidence/phase-1.md` #1.4](../mastra-port/evidence/phase-1.md)

## Phase 2: Mastra scaffold

- [x] 2.1 Install Mastra, the Postgres storage adapter, and `@mastra/redis-streams` in `web/`.
  Record installed versions and any API discrepancies against the objective's description.

  Evidence: [`evidence/phase-2.md` #2.1](../mastra-port/evidence/phase-2.md)

- [x] 2.2 Configure `web/src/mastra/index.ts`: Postgres storage against the existing
  `content_pipeline` database, `RedisStreamsPubSub` against the existing Redis, and a logger.
  Keep it importable without `next/*`.

  Evidence: [`evidence/phase-2.md` #2.2](../mastra-port/evidence/phase-2.md)

- [x] 2.3 Define one trivial two-step workflow. Test executes it, asserts
  `stream.status === 'success'`, asserts the emitted event types, and asserts the run row is
  present in Postgres storage.

  Evidence: [`evidence/phase-2.md` #2.3](../mastra-port/evidence/phase-2.md)

- [x] 2.4 A second process subscribed to the Redis Streams topic receives the same events.

  Evidence: [`evidence/phase-2.md` #2.4](../mastra-port/evidence/phase-2.md)

- [x] 2.5 Mastra Studio connects to the dev server and lists the trivial workflow. Paste the
  command and a committed screenshot path.

  Evidence: [`evidence/phase-2.md` #2.5](../mastra-port/evidence/phase-2.md)

## Phase 3: Port the six stages (one per iteration)

Each: Mastra agent + step, Zod `inputSchema`/`outputSchema` (no `z.any()`, no untyped
passthrough), prompt assembled from `rules/blog-<stage>.md` plus post/profile fields matching
the Python assembly, output written to the same Post column via `STAGE_CONTENT_MAP`
immediately on completion. Parity test asserts the rendered prompt matches the
Python-rendered prompt (whitespace normalized only) and the output validates against
`outputSchema`.

- [x] 3.1a Shared prompt assembly (`load_rules` / `build_stage_prompt`), with a prompt-parity
  test against every golden fixture.

  Evidence: [`evidence/phase-3.md` #3.1a](../mastra-port/evidence/phase-3.md)

- [x] 3.1b `research` **agent**: the provider-facing half of the stage (model id, system
  message, credential resolution), registered on the Mastra instance.

  Evidence: [`evidence/phase-3.md` #3.1b](../mastra-port/evidence/phase-3.md)

- [x] 3.1c-i Shared posts-table bridge: `stateFromPost()` (ported from
  `state_from_post()` in `api/src/pipeline/state.py`) and `saveStageOutput()` (ported
  from `save_stage_output()` in `api/src/pipeline/helpers.py`), which all six steps
  read and write through.

  Evidence: [`evidence/phase-3.md` #3.1c-i](../mastra-port/evidence/phase-3.md)

- [x] 3.1c-ii `research` **step**: `createStep` with Zod input/output schemas, prompt
  assembled by `buildStagePrompt` (item 3.1a), the agent from item 3.1b, the
  meta-response retry loop from `research_node` (`_REFUSAL_PATTERNS`,
  `_EXPECTED_SECTIONS`, `MAX_RESEARCH_ATTEMPTS`, `_reinforced_prompt`), output persisted
  to `research_content` through `saveStageOutput` (item 3.1c-i), and the parity test
  against the golden fixtures.

  Evidence: [`evidence/phase-3.md` #3.1c-ii](../mastra-port/evidence/phase-3.md)

- [x] 3.2 `outline`

  Evidence: [`evidence/phase-3.md` #3.2](../mastra-port/evidence/phase-3.md)

- [x] 3.3 `write`

  Evidence: [`evidence/phase-3.md` #3.3](../mastra-port/evidence/phase-3.md)

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

    Evidence: [`evidence/phase-3.md` #3.4a](../mastra-port/evidence/phase-3.md)

  - [x] 3.4b `compute_analytics` (`api/src/services/analytics.py`): `_strip_markdown`,
    keyword density, the SEO checklist, and Python's rounding, with a parity test against
    the golden fixtures' draft content.

    Evidence: [`evidence/phase-3.md` #3.4b](../mastra-port/evidence/phase-3.md)

  - [x] 3.4c `validate_links` (`api/src/services/link_validator.py`).

    Evidence: [`evidence/phase-3.md` #3.4c](../mastra-port/evidence/phase-3.md)

  - [x] 3.4d `edit` **agent**: system message, model id, `max_tokens`, wire-payload parity
    against the golden fixtures' recorded Anthropic request.

    Evidence: [`evidence/phase-3.md` #3.4d](../mastra-port/evidence/phase-3.md)

  - [x] 3.4e `edit` **step**: `createStep`, the analytics section appended to the prompt,
    the post-edit validation warnings, persistence to `final_md`, and the prompt-parity
    test against both golden fixtures.

    Evidence: [`evidence/phase-3.md` #3.4e](../mastra-port/evidence/phase-3.md)

- [x] 3.5 `images` (identical `image_manifest` JSONB shape; `.foreach()` for per-image
  generation). Split, because `images_node` is the only stage that talks to two providers
  in one step and writes files to disk: Claude produces a manifest, a JSON parser has to
  recover it from prose, a Node image library has to reproduce PIL's WebP output, and
  Gemini generates one image per manifest entry under a concurrency limit. Each of those
  is independently verifiable and none of them shares an oracle with the others.
  - [x] 3.5a `_parse_manifest` ported to TypeScript, with a parity corpus generated by
    calling Python's implementation directly.

    Evidence: [`evidence/phase-3.md` #3.5a](../mastra-port/evidence/phase-3.md)

  - [x] 3.5b `optimize_image` ported to TypeScript: resize to `max_width` with Lanczos and
    encode WebP at quality 82, matching PIL's output closely enough that the manifest's
    recorded `size_bytes` and the stored file are usable. Needs a Node image library, which
    is a dependency decision, and needs a parity oracle built from real PNG input rather
    than from the golden fixtures, whose Gemini calls all 429'd.

    Evidence: [`evidence/phase-3.md` #3.5b](../mastra-port/evidence/phase-3.md)

  - [x] 3.5c `images` **agent**: the Claude half of the stage (model id, system message,
    `max_tokens`, the resolved `thinking` budget) with system-message and prompt parity
    against both golden fixtures and a live call confirming the model id resolves.

    Evidence: [`evidence/phase-3.md` #3.5c](../mastra-port/evidence/phase-3.md)

  - [x] 3.5d Gemini image-generation client ported: `generate_image` with `aspect_ratio`,
    `image_size` and `response_modalities`, plus the token accounting the stage sums into
    `_stage_meta_gemini`, and a live smoke test.

    Evidence: [`evidence/phase-3.md` #3.5d](../mastra-port/evidence/phase-3.md)

  - [x] 3.5e Per-image generation unit (`generateOneImage`) ported, against a parity
    corpus captured by driving the real `images_node` with both providers intercepted.

    Evidence: [`evidence/phase-3.md` #3.5e](../mastra-port/evidence/phase-3.md)

  - [x] 3.5f `images` **step**: `createStep` with Zod schemas, `.foreach()` for per-image
    generation, the `image_manifest` JSONB shape preserved byte for byte, both `_stage_meta`
    and `_stage_meta_gemini` returned, and the persistence contract via `saveStageOutput`.
    Split, because `.foreach()` is a *workflow* operator, not something a step can call:
    it consumes the previous step's array output, so the stage has to become three steps
    inside one nested workflow rather than one step with a loop in it. The Claude half and
    the fan-out half have different oracles and different failure modes.
    - [x] 3.5f-i `images-manifest` **step**: the Claude call, prompt assembly from
      `rules/blog-images.md`, `parseManifest`, and the parse-failure branch.

      Evidence: [`evidence/phase-3.md` #3.5f-i](../mastra-port/evidence/phase-3.md)

    - [x] 3.5f-ii `images` **workflow**: the `.map()` that turns manifest entries into
      per-image jobs, `.foreach(generateImageStep, { concurrency: 3 })` reproducing
      Python's `asyncio.Semaphore(3)`, the assembling step that folds the results back
      into the manifest (`total_generated` / `total_failed`, JSONB shape byte for byte),
      both `_stage_meta` (with `duration_s: 0` on the parse-failure branch) and
      `_stage_meta_gemini`, and the single `saveStageOutput` write.

      Evidence: [`evidence/phase-3.md` #3.5f-ii](../mastra-port/evidence/phase-3.md)

- [x] 3.6 `ready`. The last stage, and the only one that does not go through
  `build_stage_prompt`: `ready_node` has a private `_build_ready_prompt` that
  replaces the thirteen-field configuration block and the `## Previous Stage
  Output` section with three lines of post configuration, the edited markdown,
  and the image manifest filtered down to the entries that actually generated.

  Evidence: [`evidence/phase-3.md` #3.6](../mastra-port/evidence/phase-3.md)

## Phase 4: Workflow assembly, gates, durable execution

- [x] 4.1 Compose the six steps into one workflow with `.then()` / `.commit()`, registered on
  the Mastra instance.

  Evidence: [`evidence/phase-4.md` #4.1](../mastra-port/evidence/phase-4.md)

- [x] 4.2a Stage selection: run only the named stages, and on a full run skip the stages
  `stage_status` already calls complete. (Split from 4.2 this iteration; 4.2b below is the
  rest of it.)

  Evidence: [`evidence/phase-4.md` #4.2a](../mastra-port/evidence/phase-4.md)

- [x] 4.2b Single-stage rerun completion check: after a run with an explicit `stages`
  selection, if `stage_status` now calls every stage complete, set `current_stage` to
  `"complete"` (`api/src/worker.py:234`). Deliberately left out of 4.2a: the full-pipeline
  path reaches the same end state through `_post_completion_hook`, which also stamps
  `completed_at` and queues publishing, so the two want deciding together rather than
  bolting the single-stage half onto every step.

  Evidence: [`evidence/phase-4.md` #4.2b](../mastra-port/evidence/phase-4.md)

- [x] 4.3 Review gates via `suspend()` / `resume()` with typed `suspendSchema` / `resumeSchema`.
  Suspend/resume test passes.

  Evidence: [`evidence/phase-4.md` #4.3](../mastra-port/evidence/phase-4.md)

- [x] 4.4a The `worker` service: a second process, built from the same
  `src/mastra/index.ts`, consumes `workflow.start` off Redis Streams and executes the steps,
  while the process that started the run never executes anything.

  Evidence: [`evidence/phase-4.md` #4.4a](../mastra-port/evidence/phase-4.md)

- [x] 4.4b Prove restarting `web` does not disturb an in-flight pipeline: a `web` process that
  starts a run and then dies must leave the worker executing it to completion. Split out of
  4.4 because 4.4a's harness (the real bundle, Redis database 9, the `NODE_PATH` strip) was a
  full iteration on its own; 4.4a proves `web` executes nothing, not that `web` can disappear.

  Evidence: [`evidence/phase-4.md` #4.4b](../mastra-port/evidence/phase-4.md)

- [x] 4.5 **Durability gate.** Kill the worker mid-`write`, restart it, and have the run resume
  from the last completed stage without re-running completed stages or duplicating writes.
  Record the outcome and the chosen workflow runner here. On failure: first add a worker
  startup sweep that resumes interrupted runs from storage; only if that still fails, adopt
  `@mastra/inngest` and record which guarantee failed. Never `@mastra/temporal`, never a
  second job queue.

  Evidence: [`evidence/phase-4.md` #4.5](../mastra-port/evidence/phase-4.md)

- [x] 4.5a Engine guarantee: a step whose worker is `SIGKILL`ed mid-execution is redelivered to
  a restarted worker and completes, while the step that had already completed is neither
  re-executed nor rewritten. Provider-free, automated, stays in the suite.

  Evidence: [`evidence/phase-4.md` #4.5a](../mastra-port/evidence/phase-4.md)

- [x] 4.5b Pipeline gate: start a full run against the real worker bundle, kill the worker
  mid-`write`, restart it, and prove the run resumes without re-running `research` or `outline`
  and without duplicating their column writes. Bills Anthropic for two `write` calls, so it is
  a scripted procedure with pasted output rather than a suite member. Record the chosen
  workflow runner (expected: the built-in evented engine, per 4.5a).

  Evidence: [`evidence/phase-4.md` #4.5b](../mastra-port/evidence/phase-4.md)

- [x] 4.6 Concurrency: two pipelines at once must not interleave writes to the same Post row or
  exhaust connections. Test passes.

  Evidence: [`evidence/phase-4.md` #4.6](../mastra-port/evidence/phase-4.md)

- [x] 4.7 Full workflow runs end to end against the real database. Split; the evidence is
  under 4.7a, 4.7b and 4.7c below, all four of which are now checked.

  Evidence: [`evidence/phase-4.md` #4.7](../mastra-port/evidence/phase-4.md)

- [x] 4.7a **The reclaim window re-executes every stage.** A step that runs longer than
  `reclaimIdleMs` is delivered a second time to a *live* worker and executed again, concurrently
  with the first. No crash, no failure, one worker.

  Evidence: [`evidence/phase-4.md` #4.7a](../mastra-port/evidence/phase-4.md)

- [x] 4.7b Port the full-pipeline completion hook: a full run ends with
  `current_stage = "complete"` and `completed_at` set, matching `_post_completion_hook` in
  `api/src/worker.py:429`. The auto-publish half of that hook depends on the `wordpress` and
  `nextjs` routers and belongs to Phase 5.

  Evidence: [`evidence/phase-4.md` #4.7b](../mastra-port/evidence/phase-4.md)

- [x] 4.7c Full workflow runs end to end against the real database: green run of
  `web/src/mastra/scripts/full-pipeline.mjs` with its output pasted here. Image generation is
  bounded by the Gemini key's quota (see 4.7a finding 2).

  Evidence: [`evidence/phase-4.md` #4.7c](../mastra-port/evidence/phase-4.md)

- [x] 4.7c-i **The full workflow runs end to end against the real database.** A run started by a
  `web` process that then exits was executed by the deployable `worker` bundle through all six
  stages, against the real Postgres and the real Redis, with real Perplexity and Anthropic
  calls. Ten of fourteen checks passed; the four failures are 4.7c-ii and are quoted below in
  full rather than elided.

  Evidence: [`evidence/phase-4.md` #4.7c-i](../mastra-port/evidence/phase-4.md)

- [x] 4.7c-ii **Image generation, which this environment's Gemini key cannot execute.** All four
  manifest entries failed with the same live error, recorded per entry in `image_manifest` and
  quoted here from the database:

  Evidence: [`evidence/phase-4.md` #4.7c-ii](../mastra-port/evidence/phase-4.md)

## Phase 5: Route handlers (one router per iteration)

Contract is `web/src/lib/api.ts`; request/response shapes stay identical, or `api.ts` and every
caller change in the same iteration. Every handler scopes by the authenticated user
(Alembic 010 `user_id`). Per router, port its pytest coverage to vitest; do not delete a pytest
file until the TypeScript equivalent passes. Exit per router: TS tests pass and the dashboard
pages that use it work with the Python API stopped.

- [x] 5.1a `settings`: the shared route-handler authentication step plus
  `GET /api/settings` and `PATCH /api/settings`

  Evidence: [`evidence/phase-5.md` #5.1a](../mastra-port/evidence/phase-5.md)

- [x] 5.1b-i `settings`: the two read endpoints (`GET /api/settings/api-keys`,
  `GET /api/settings/api-keys/{provider}/reveal`) and the masking and reveal half
  of `api/src/services/api_keys.py` (`get_masked_keys`, `reveal_api_key`)

  Evidence: [`evidence/phase-5.md` #5.1b-i](../mastra-port/evidence/phase-5.md)

- [x] 5.1b-ii `settings`: `PUT /api/settings/api-keys`, the write half of
  `api/src/services/api_keys.py` (`save_api_keys`, `save_validation_results`) and
  the live per-provider validation in `api/src/services/api_key_validator.py`

  Evidence: [`evidence/phase-5.md` #5.1b-ii](../mastra-port/evidence/phase-5.md)

- [x] 5.2a `profiles`: the two read endpoints (`GET /api/profiles`,
  `GET /api/profiles/{profile_id}`)

  Evidence: [`evidence/phase-5.md` #5.2a](../mastra-port/evidence/phase-5.md)

- [x] 5.2b `profiles`: the three write endpoints (`POST /api/profiles`,
  `PATCH /api/profiles/{profile_id}`, `DELETE /api/profiles/{profile_id}`),
  including encrypting `wp_app_password` and `nextjs_webhook_secret` with the
  crypto port from item 1.3 and the `exclude_unset` semantics of `ProfileUpdate`

  Evidence: [`evidence/phase-5.md` #5.2b](../mastra-port/evidence/phase-5.md)

- [x] 5.2c-i `profiles`: port `api/src/services/sitemap.py` to TypeScript with a
  parity oracle over the real Python service

  Evidence: [`evidence/phase-5.md` #5.2c-i](../mastra-port/evidence/phase-5.md)

- [x] 5.2c-ii `profiles`: the `crawl_profile_sitemap` job itself, as a Mastra
  primitive registered on the instance and executed in the `worker` process off
  the Redis Streams bus, upserting `internal_links` by `(profile_id, url)` and
  moving `crawl_status` / `last_crawled_at`. Also decide the home of
  `check_recrawl_schedules`, the daily `cron(hour=0, minute=0)` job in
  `WorkerSettings` that enqueues the same job per `recrawl_interval`, so Phase 7
  does not drop it silently

  Evidence: [`evidence/phase-5.md` #5.2c-ii](../mastra-port/evidence/phase-5.md)

- [x] 5.2c-ii-1 `profiles`: `crawl_profile_sitemap` as a registered Mastra
  workflow, executed off the Redis Streams bus, upserting `internal_links` by
  `(profile_id, url)` and moving `crawl_status` / `last_crawled_at`.

  Evidence: [`evidence/phase-5.md` #5.2c-ii-1](../mastra-port/evidence/phase-5.md)

- [x] 5.2c-ii-2 `profiles`: the home of `check_recrawl_schedules`, the daily
  `cron(check_recrawl_schedules, hour=0, minute=0)` in `WorkerSettings` that
  starts a crawl per profile whose `recrawl_interval` (weekly / biweekly /
  monthly) is due. Mastra has a first-party home for it that was not obvious
  when 5.2c was split: `createWorkflow({ schedule: { cron } })` from
  `@mastra/core/workflows/scheduler/types.d.ts`, documented as "the scheduler
  will publish a `workflow.start` event on the cron schedule" and "only
  supported on the evented engine", which is the engine this port already runs
  on. Confirm the declared schedule actually fires against the installed
  version before relying on it, and decide between a `recrawl-check` workflow
  that starts one `sitemapCrawl` run per due profile and a schedule declared on
  `sitemapCrawl` itself

  Evidence: [`evidence/phase-5.md` #5.2c-ii-2](../mastra-port/evidence/phase-5.md)

- [x] 5.2c-iii `profiles`: `POST /api/profiles/{profile_id}/crawl`, plus the
  auto-enqueue on create that 5.2b's `POST` left out because the mechanism did
  not exist yet

  Evidence: [`evidence/phase-5.md` #5.2c-iii](../mastra-port/evidence/phase-5.md)

- [x] 5.3 `posts`. Closed by 5.3c-iii-b-2-e: all four sub-items are checked, and every
  one of the router's 17 endpoints is served from `web/src/app/api/posts/`.
  (split: this router is 665 lines over 17 endpoints, far more than one
  iteration. Split into 5.3a reads, 5.3b writes, 5.3c pipeline control, 5.3d exports,
  logs and analytics.)
  - [x] 5.3a `GET /api/posts` and `GET /api/posts/{post_id}`, plus the shared `PostRead`
    serializer.

    Evidence: [`evidence/phase-5.md` #5.3a](../mastra-port/evidence/phase-5.md)

  - [x] 5.3b Writes (split: five endpoints, two of which carry the whole
    `PostCreate` validation and prefill surface. Split into 5.3b-i create,
    5.3b-ii patch and delete, 5.3b-iii duplicate and batch.) Closed by
    5.3b-iii: all three sub-items are checked with their own evidence, and the
    five write endpoints `POST /api/posts`, `PATCH /{post_id}`,
    `DELETE /{post_id}`, `POST /{post_id}/duplicate` and `POST /batch` are all
    served from `web/src/app/api/posts/`.
    - [x] 5.3b-i `POST /api/posts`: `PostCreate` validation, the profile-driven
      prefill and the auto-enqueue that replaces
      `enqueue_job("run_pipeline_stage", post.id)`.

      Evidence: [`evidence/phase-5.md` #5.3b-i](../mastra-port/evidence/phase-5.md)

    - [x] 5.3b-ii `PATCH /{post_id}` and `DELETE /{post_id}`, including the media
      directory cleanup the delete performed.

      Evidence: [`evidence/phase-5.md` #5.3b-ii](../mastra-port/evidence/phase-5.md)

    - [x] 5.3b-iii `POST /{post_id}/duplicate` and `POST /batch`.

      Evidence: [`evidence/phase-5.md` #5.3b-iii](../mastra-port/evidence/phase-5.md)

  - [x] 5.3c Pipeline control. Closed by 5.3c-iii-b-2-e: all three sub-items are
    checked, and the six endpoints `/run`, `/run-all`, `/rerun`, `/restart`, `/pause`
    and `/publish` are all served from `web/src/app/api/posts/[id]/`.
    (split: six endpoints, three of which rewrite the whole
    stage map. Split into 5.3c-i `/run` and `/run-all`, 5.3c-ii `/rerun` and `/restart`,
    5.3c-iii `/pause` and `/publish`.)
    - [x] 5.3c-i `POST /{post_id}/run` and `POST /{post_id}/run-all`, started as Mastra
      runs rather than ARQ jobs.

      Evidence: [`evidence/phase-5.md` #5.3c-i](../mastra-port/evidence/phase-5.md)

    - [x] 5.3c-ii `POST /{post_id}/rerun` and `POST /{post_id}/restart`.

      Evidence: [`evidence/phase-5.md` #5.3c-ii](../mastra-port/evidence/phase-5.md)

    - [x] 5.3c-iii `POST /{post_id}/pause` and `POST /{post_id}/publish` (split: `/pause`
      writes one column, `/publish` enqueues two ARQ jobs whose Mastra equivalents do not
      exist yet. Split into 5.3c-iii-a pause, 5.3c-iii-b publish.)
      - [x] 5.3c-iii-a `POST /{post_id}/pause`.

        Evidence: [`evidence/phase-5.md` #5.3c-iii-a](../mastra-port/evidence/phase-5.md)

      - [x] 5.3c-iii-b `POST /{post_id}/publish`. Closed by 5.3c-iii-b-2-e: both
        publish paths are ported, registered as the `wordpressPublish` and
        `nextjsPublish` workflows, and both branches of the endpoint start them.

        Blocked on work Phase 5's later items own, and deliberately left for after them:
        `publish_post()` is a two-line status write around
        `enqueue_job("publish_to_wordpress" | "publish_to_nextjs", post_id)`, and neither
        ARQ job has a Mastra equivalent yet. `api/src/pipeline/publish.py`,
        `api/src/services/wordpress.py` (160 lines) and
        `api/src/services/nextjs_publish.py` (188 lines) are all still Python-only, which
        is the same gap `web/src/mastra/workflows/pipeline.ts` already records for the
        auto-publish half of its completion hook. Starting a run for a workflow that does
        not exist is not a port.

        When it is picked up it should be split again, one publish path per iteration:
        5.3c-iii-b-1 the WordPress workflow plus the `output_format == "wordpress"` branch,
        5.3c-iii-b-2 the Next.js workflow (HMAC signing preserved exactly) plus its branch
        and the trailing 400 for every other `output_format`. Item 5.9 and item 5.10 cover
        the two routers, not the publishing itself, so the workflows land here.

        5.3c-iii-b-1 is itself larger than one iteration: the WordPress publish path needs
        the write half of the REST client (three unported methods), the
        markdown-to-Gutenberg converter (`api/src/services/wp_html.py`, 127 lines), and
        then the Mastra workflow that assembles them. Split into:

        - [x] 5.3c-iii-b-1-a The write half of the WordPress REST client:
          `upload_media`, `create_post`, `update_post`.

          Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-a](../mastra-port/evidence/phase-5.md)

        - [x] 5.3c-iii-b-1-b `markdown_to_wp_html` (`api/src/services/wp_html.py`), the
          markdown-to-Gutenberg-block converter the publish hook runs the article
          through. Closed by -b-iii: all three layers are checked, so
          `web/src/mastra/wordpress/wp-html.ts` is a whole-function port of
          `markdown_to_wp_html`, tokenizer included, with 1124 replay and control tests
          across nine `wp-html*` test files, plus the 103 in `escape-url.test.ts` for
          `util.escape_url`. (Split: the file is a 127-line mistune 3 renderer, but the renderer
          is the easy half. Which lines become a heading and which a paragraph is
          decided by mistune's tokenizer, and that tokenizer is another 900 lines across
          `block_parser.py`, `list_parser.py` and `inline_parser.py`, none of which has a
          JavaScript equivalent that agrees with it. Pointing `marked` or
          `mdast-util-from-markdown` at the same input and hoping is not a port: it
          silently diverges exactly where the corpus is thin. Split by tokenizer layer,
          one oracle each: 5.3c-iii-b-1-b-i leaf blocks, -b-ii container blocks,
          -b-iii inline.)

          - [x] 5.3c-iii-b-1-b-i The frontmatter strip, the newline normalisation, the
            block scan loop and the leaf blocks: `blank_line`, `fenced_code`,
            `indent_code`, `atx_heading`, `setex_heading`, `thematic_break` and the
            paragraph fallback, plus the two inline break tokens a multi-line paragraph
            produces.

            Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-b-i](../mastra-port/evidence/phase-5.md)

          - [x] 5.3c-iii-b-1-b-ii The container blocks and the two remaining block
            rules. (Split: `block_quote` alone is `extract_block_quote`'s two scan
            strategies plus the child-state recursion, `list` is the whole 269-line
            `list_parser.py` with the tight/loose rule and the per-item break scanner,
            and `ref_link`/`raw_html` share nothing with either. One oracle each:
            -ii-1 block quotes, -ii-2 lists, -ii-3 reference links and raw HTML.)

            Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-b-ii](../mastra-port/evidence/phase-5.md)

            - [x] 5.3c-iii-b-1-b-ii-1 `block_quote`: `extract_block_quote`'s
              require-marker and lazy-continuation branches, the child `BlockState` and
              its nesting depth, `prepend_token`, and the `block_quote` renderer method.

              Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-b-ii-1](../mastra-port/evidence/phase-5.md)

            - [x] 5.3c-iii-b-1-b-ii-2 `list` (`list_parser.py`): the per-item break
              scanner, the continuation width, the tight/loose rule and the nesting
              depth, plus the `list`, `list_item` and `block_text` renderer methods. Its
              oracle must also carry the `list`-vs-`thematic_break` and
              `list`-vs-`setext` precedence cases.

              Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-b-ii-2](../mastra-port/evidence/phase-5.md)

            - [x] 5.3c-iii-b-1-b-ii-3 `ref_link` (with `parse_link_href`,
              `parse_link_title`, `unikey` and `escape_url`, and the `ref_links` env the
              inline layer reads) and `raw_html`/`block_html` (the seven CommonMark HTML
              block rules and the `BLOCK_TAGS`/`PRE_TAGS` tables), plus the `block_html`
              renderer method.

              Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-b-ii-3](../mastra-port/evidence/phase-5.md)

              - [x] 5.3c-iii-b-1-b-ii-3-a `raw_html`/`block_html`: the seven CommonMark
                HTML block rules, the `BLOCK_TAGS`/`PRE_TAGS` tables,
                `_parse_html_to_end`/`_parse_html_to_newline`, the `_OPEN_TAG_END` /
                `_CLOSE_TAG_END` bounded matches for rule 7, and the `block_html`
                renderer method.

                Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-b-ii-3-a](../mastra-port/evidence/phase-5.md)

              - [x] 5.3c-iii-b-1-b-ii-3-b `ref_link`, with `parse_link_href`,
                `parse_link_title`, `unikey`, `escape_url` (and the `unescape` /
                percent-encoding it needs) and the `ref_links` env.

                Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-b-ii-3-b](../mastra-port/evidence/phase-5.md)

                - [x] 5.3c-iii-b-1-b-ii-3-b-1 `escape_url`: `mistune.util.unescape`
                  (the CommonMark-flavoured `html.unescape` and the
                  `html.entities.html5` / `_invalid_charrefs` / `_invalid_codepoints`
                  tables it reaches into) and `urllib.parse.quote` with the safe set
                  `:/?#@!$&()*+,;=%`.

                  Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-b-ii-3-b-1](../mastra-port/evidence/phase-5.md)

                - [x] 5.3c-iii-b-1-b-ii-3-b-2 `parse_ref_link` itself, with
                  `parse_link_href`, `parse_link_title`, `unikey` and the `ref_links`
                  env the inline `link` rule reads.

                  Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-b-ii-3-b-2](../mastra-port/evidence/phase-5.md)

          - [x] 5.3c-iii-b-1-b-iii The inline rules: `escape`, `codespan`, `emphasis`,
            `strong`, `link`, `image`, `auto_link`, `auto_email` and `inline_html`, plus
            the `emphasis`, `strong`, `link`, `codespan` and `image` renderer methods.
            Closed by -iii-d: all four sub-items are checked with their own oracle and
            evidence, and every rule in `InlineParser.DEFAULT_RULES` plus the appended
            `softbreak` is ported.
            Note that `image` is an inline token that the Gutenberg renderer turns into a
            block comment, so an image inside a paragraph nests one. Its oracle must
            include the backtick-info-string fence case moved out of the -b-i corpus.

            Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-b-iii](../mastra-port/evidence/phase-5.md)

            - [x] 5.3c-iii-b-1-b-iii-a `escape` and `codespan`, the inline state, the
              inline scan loop and the `codespan` renderer method.

              Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-b-iii-a](../mastra-port/evidence/phase-5.md)

            - [x] 5.3c-iii-b-1-b-iii-b `auto_link`, `auto_email` and `inline_html`, plus
              the `link` renderer method and the `in_link` flag `inline_html` toggles.
              `_GutenbergRenderer` has no `inline_html` method, so the oracle pins the
              `AttributeError` rather than an HTML string.

              Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-b-iii-b](../mastra-port/evidence/phase-5.md)

            - [x] 5.3c-iii-b-1-b-iii-c `emphasis` and `strong`, their renderer methods
              and `precedence_scan`.

              Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-b-iii-c](../mastra-port/evidence/phase-5.md)

            - [x] 5.3c-iii-b-1-b-iii-d `link` and `image`, `parse_link_label`,
              `parse_link_text`, `parse_link`, the `in_link` / `in_image` guards, the
              `state.env['ref_links']` lookup, and the `link` and `image` renderer
              methods.

              Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-b-iii-d](../mastra-port/evidence/phase-5.md)

        - [x] 5.3c-iii-b-1-c The Mastra WordPress publish workflow
          (`api/src/pipeline/publish.py`): the media-directory sweep, the manifest-driven
          featured image and alt text, the local-to-remote URL rewrite, the create/update
          branch, the `wp_publish_status` transitions and the `publish_start` /
          `publish_complete` / `publish_error` events. Split into three: the two pure
          helpers decide the title and which upload becomes featured and are oracle-testable
          against the real Python with no network or filesystem at all, the sweep is a
          filesystem walk plus real HTTP uploads, and the workflow itself is database
          transitions and events. They share no machinery, and only the first can be pinned
          byte for byte against Python. Closed by 5.3c-iii-b-1-c-iii: all three
          sub-items are checked with their own evidence, and the whole hook is registered
          on the Mastra instance as the `wordpressPublish` workflow.
          - [x] 5.3c-iii-b-1-c-i `_extract_frontmatter` and the `manifest_by_file` /
            `featured_filename` index.

            Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-c-i](../mastra-port/evidence/phase-5.md)

          - [x] 5.3c-iii-b-1-c-ii The media-directory sweep. Split into three: the
            `mimetypes` filter is a pure function over a filename and is the only part of
            the sweep that can be pinned against Python with no filesystem and no network,
            the walk is a filesystem enumeration whose ordering rule is the thing worth
            testing, and the upload loop is HTTP plus the featured-media and URL-rewrite
            bookkeeping. Closed by 5.3c-iii-b-1-c-ii-3: all three sub-items are checked
            with their own evidence, and the whole sweep is reachable through
            `sweepMediaDirectory()` in `web/src/mastra/wordpress/media-upload.ts`.
            - [x] 5.3c-iii-b-1-c-ii-1 `mimetypes.guess_type`, the image filter.

              Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-c-ii-1](../mastra-port/evidence/phase-5.md)

            - [x] 5.3c-iii-b-1-c-ii-2 The sorted walk: `media_dir.is_dir()`, the
              `sorted(media_dir.iterdir())` ordering and the `is_file()` filter.
              Ported to `web/src/mastra/wordpress/media-walk.ts` as `listMediaFiles()`,
              with the two Python primitives the walk is built out of exported beside it:
              `decodeFsName()` (`os.fsdecode`, UTF-8 with `surrogateescape`) and
              `comparePythonStrings()` (Python's `<` between two `str`s, which compares
              code points).

              Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-c-ii-2](../mastra-port/evidence/phase-5.md)

            - [x] 5.3c-iii-b-1-c-ii-3 The upload loop: the per-file `upload_media` call
              with its manifest alt text defaulting to the title, the featured-media
              resolution with its manifest-or-first fallback, and the local-to-remote URL
              rewrite over the rendered HTML.

              Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-c-ii-3](../mastra-port/evidence/phase-5.md)

          - [x] 5.3c-iii-b-1-c-iii The publish workflow itself: the profile and credential
            guards, the create/update branch, the `wp_publish_status` transitions and the
            `publish_start` / `publish_complete` / `publish_error` events with `_fail`.

            Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-c-iii](../mastra-port/evidence/phase-5.md)

        - [x] 5.3c-iii-b-1-d The `output_format == "wordpress"` branch of
          `POST /{post_id}/publish`, starting the workflow above.

          Evidence: [`evidence/phase-5.md` #5.3c-iii-b-1-d](../mastra-port/evidence/phase-5.md)

        - [x] 5.3c-iii-b-2 The Next.js publish workflow (`publish_to_nextjs` in
          `api/src/pipeline/publish.py` plus `api/src/services/nextjs_publish.py`, 188
          lines, with `hmac_signing.py` preserved exactly), the
          `output_format == "nextjs"` branch of `POST /{post_id}/publish` that starts it,
          and the removal of the temporary fall-through recorded under 5.3c-iii-b-1-d.
          Split this again if the HMAC signing and the webhook client turn out to be more
          than one iteration; `packages/create-mdx-blog` consumes that contract and is out
          of scope for changes.

          Split, as that paragraph allowed for. The HMAC half turned out to be *already
          done*: `web/src/lib/hmac-signing.ts` ports `sign_payload` and item 5.9's
          `POST /api/profiles/{id}/nextjs/test` already signs a payload with it, so
          nothing here re-does it. What is left is four things that do not fit one
          iteration, because two of them are content transforms with their own oracles
          before any of it reaches a step:

          - 5.3c-iii-b-2-a `apply_frontmatter_mapping`, the user-configured transform.
          - 5.3c-iii-b-2-b `_apply_mapping_to_content`, which is a `yaml.safe_load` and a
            `yaml.dump(default_flow_style=False, allow_unicode=True)` round trip over the
            post's frontmatter block. PyYAML's emitter decides quoting, key order, line
            width and unicode escaping, and the result is what lands in the reader's repo,
            so it needs its own oracle and probably its own split.
          - 5.3c-iii-b-2-c The payload: content selection, the manifest walk that
            base64-encodes each image off disk, and `json.dumps` of the seven-key body
            whose bytes the signature is computed over.
          - 5.3c-iii-b-2-d The Mastra step and workflow: the three guards, the
            `nextjs_publish_status` transitions, the webhook `POST` and its 200 check, and
            the three SSE events with `_fail`.
          - 5.3c-iii-b-2-e The `output_format == "nextjs"` branch of
            `POST /{post_id}/publish`, which removes the temporary fall-through.

          Closed by 5.3c-iii-b-2-e: all five sub-items are checked with their own
          evidence, the `nextjsPublish` workflow is registered on the Mastra instance,
          and `POST /{post_id}/publish` starts it for an `output_format` of `nextjs`.

          - [x] 5.3c-iii-b-2-a `apply_frontmatter_mapping` from
            `api/src/services/frontmatter_mapping.py`, the transform a user's saved
            mapping runs over a post's frontmatter before the payload is built.

            Evidence: [`evidence/phase-5.md` #5.3c-iii-b-2-a](../mastra-port/evidence/phase-5.md)

          - [x] 5.3c-iii-b-2-b `_apply_mapping_to_content`: the `---` fence split, the
            `yaml.safe_load` of the frontmatter block and the
            `yaml.dump(mapped, default_flow_style=False, allow_unicode=True)` that
            rebuilds it. No JavaScript YAML library emits PyYAML's bytes (js-yaml matched
            12 of 22 representative values, the `yaml` package 10), so `representer.py`,
            `serializer.py`, the block half of `emitter.py`, `resolver.py` and
            `SafeConstructor` are ported in `web/src/mastra/nextjs/pyyaml/`, with the
            `yaml` package (now a direct dependency of `web/`) used for syntax only.
            Verified against a 201-case oracle and 2400 randomly generated documents run
            through the real function, with three documented divergences.

            Evidence: [`evidence/phase-5.md` #5.3c-iii-b-2-b](../mastra-port/evidence/phase-5.md)
          - [x] 5.3c-iii-b-2-c The payload: `post.ready_content or post.final_md_content
            or ""`, the `image_manifest` walk that reads each image off disk and
            base64-encodes it, and the `json.dumps` whose exact bytes the signature covers.
            `json.dumps` is `ensure_ascii=True` with `", "` / `": "` separators, neither of
            which `JSON.stringify` does, so `web/src/mastra/nextjs/json-dumps.ts` ports it
            beside the block in `web/src/mastra/nextjs/payload.ts`. Verified against a
            78-case oracle plus 30 recorded `json.dumps` cases, with four documented
            divergences.

            Evidence: [`evidence/phase-5.md` #5.3c-iii-b-2-c](../mastra-port/evidence/phase-5.md)
          - [x] 5.3c-iii-b-2-d The Mastra step and workflow for `publish_to_nextjs`: the
            profile, webhook-configuration and decrypt guards, the
            `nextjs_publish_status` transitions with `nextjs_published_at`, the webhook
            `POST` with `X-Jena-Signature` and its 200 check, and the `publish_start` /
            `publish_complete` / `publish_error` events with `_fail`. Registered as
            `nextjsPublish`. `web/src/db/schema.ts` widened
            `nextjs_frontmatter_map` to `Record<string, unknown>` and
            `web/src/mastra/no-next-imports.test.ts` gained `yaml`, both as the item
            called for. Unlike its WordPress sibling this workflow carries
            `retryConfig: { attempts: MAX_ATTEMPTS - 1 }`: Python left the payload build
            outside its `try`, so ARQ's `max_tries = 3` applied to it, and the step lets
            that exception through rather than catching it. Verified against a real
            loopback webhook receiver, real files and real rows, with 19 tests and
            32/32 mutations killed.

            Evidence: [`evidence/phase-5.md` #5.3c-iii-b-2-d](../mastra-port/evidence/phase-5.md)

          - [x] 5.3c-iii-b-2-e The `output_format == "nextjs"` branch of
            `POST /{post_id}/publish`: `nextjs_publish_status = "pending"`, the start of
            the new workflow through `web/src/mastra/start-nextjs-publish.ts`, and the
            removal of the temporary fall-through recorded under 5.3c-iii-b-1-d. The
            handler now matches Python branch for branch, including the `both` case,
            which Python could not publish by hand because it compared `output_format`
            for equality twice rather than testing membership.

            Evidence: [`evidence/phase-5.md` #5.3c-iii-b-2-e](../mastra-port/evidence/phase-5.md)
  - [x] 5.3d Exports, logs and analytics (split: five endpoints, and `/export/all`
    needs a zip writer this repo does not have while `/analytics` needs the analytics
    service wired to the route. Split into 5.3d-i the two plain exports, 5.3d-ii
    `/export/all`, 5.3d-iii `/logs` and `/analytics`.) Closed by 5.3d-iii: all three
    sub-items are checked with their own evidence, and the five endpoints
    `GET /{post_id}/export/markdown`, `/export/html`, `/export/all`, `/logs` and
    `/analytics` are all served from `web/src/app/api/posts/[id]/`.
    - [x] 5.3d-i `GET /{post_id}/export/markdown` and `GET /{post_id}/export/html`,
      plus the `strip_leading_h1` port both they and `/export/all` need.

      Evidence: [`evidence/phase-5.md` #5.3d-i](../mastra-port/evidence/phase-5.md)

    - [x] 5.3d-ii `GET /{post_id}/export/all` (the zip).

      Evidence: [`evidence/phase-5.md` #5.3d-ii](../mastra-port/evidence/phase-5.md)

    - [x] 5.3d-iii `GET /{post_id}/logs` and `GET /{post_id}/analytics`.

      Evidence: [`evidence/phase-5.md` #5.3d-iii](../mastra-port/evidence/phase-5.md)

- [x] 5.4 `queue` (all four sub-items done: 5.4a the status counts, 5.4b pause-all and
  resume-all, 5.4c worker-status, 5.4d the dead-letter trio. All seven endpoints are
  ported, and the four ARQ keys are replaced rather than transcribed: `arq:worker:*` and
  `arq:queue` by the `mastra-orchestration` consumer group on the `workflows` topic,
  `WORKER_LAST_COMPLETED_KEY` by `mastra:worker:last_completed`, and `DLQ_KEY` by
  Mastra's own failed run rows plus `stage_logs._error` as the acknowledgement. Every
  tenancy hole `todo.md` recorded for this router is closed.)
  (split: seven endpoints, and four of them are about the ARQ worker
  rather than about posts. `GET /worker-status` reads `arq:worker:*`, `arq:queue` and
  `WORKER_LAST_COMPLETED_KEY`, and the three dead-letter endpoints read and write
  `DLQ_KEY`, a Redis list `api/src/worker.py` writes. None of those four keys exists in
  the Mastra/Redis Streams world, so each needs its equivalent designed rather than
  transcribed. The three post-shaped endpoints do not. Split into 5.4a the status
  counts, 5.4b pause-all and resume-all, 5.4c worker-status, 5.4d the dead-letter trio.)

  Evidence: [`evidence/phase-5.md` #5.4](../mastra-port/evidence/phase-5.md)

  - [x] 5.4a `GET /api/queue`.

    Evidence: [`evidence/phase-5.md` #5.4a](../mastra-port/evidence/phase-5.md)

  - [x] 5.4b `POST /api/queue/pause-all` and `POST /api/queue/resume-all`.

    Evidence: [`evidence/phase-5.md` #5.4b](../mastra-port/evidence/phase-5.md)

  - [x] 5.4c `GET /api/queue/worker-status`. (Both sub-items done: 5.4c-i the
    liveness and backlog reads, 5.4c-ii the last-completed writer and the handler.)

    Evidence: [`evidence/phase-5.md` #5.4c](../mastra-port/evidence/phase-5.md)

    - [x] 5.4c-i The Redis Streams replacements for `worker_alive` and `queued_jobs`.

      Evidence: [`evidence/phase-5.md` #5.4c-i](../mastra-port/evidence/phase-5.md)

    - [x] 5.4c-ii The `last_completed` writer and the `GET /api/queue/worker-status`
      route handler.

      Evidence: [`evidence/phase-5.md` #5.4c-ii](../mastra-port/evidence/phase-5.md)

  - [x] 5.4d `GET /api/queue/dead-letter`, `POST /api/queue/dead-letter/{post_id}/retry`
    and `DELETE /api/queue/dead-letter`. (All four sub-items done: 5.4d-i the writer,
    5.4d-ii the list, 5.4d-iii-a the acknowledgement rule plus the retry, 5.4d-iii-b the
    clear. Both defects this item flagged are fixed rather than carried over: the
    unscoped `session.get(Post, post_id)` closed in 5.4d-iii-a, and all three endpoints
    now scope the queue by user.)

    Evidence: [`evidence/phase-5.md` #5.4d](../mastra-port/evidence/phase-5.md)

    - [x] 5.4d-i A permanently failed pipeline run is recorded on its post.

      Evidence: [`evidence/phase-5.md` #5.4d-i](../mastra-port/evidence/phase-5.md)

    - [x] 5.4d-ii `GET /api/queue/dead-letter`.

      Evidence: [`evidence/phase-5.md` #5.4d-ii](../mastra-port/evidence/phase-5.md)

    - [x] 5.4d-iii-a The acknowledgement rule, and
      `POST /api/queue/dead-letter/{post_id}/retry`.

      Evidence: [`evidence/phase-5.md` #5.4d-iii-a](../mastra-port/evidence/phase-5.md)

    - [x] 5.4d-iii-b `DELETE /api/queue/dead-letter`.

      Evidence: [`evidence/phase-5.md` #5.4d-iii-b](../mastra-port/evidence/phase-5.md)

- [x] 5.5 `events` (all five sub-items done: 5.5a the bus plus `stage_start`, 5.5b
  `stage_complete`/`pipeline_complete`/`stage_error`, 5.5c `execution_logs` and the `log`
  event across all 31 Python call sites, 5.5d the two SSE route handlers, 5.5e resumable
  replay end to end. `api/src/api/events.py` and `publish_event()` are fully ported: the
  message shape `use-sse.ts` parses is unchanged, the source is the Redis Streams topic
  rather than an in-process stream, and the replay is the anchor scheme in 5.5e rather
  than Mastra's own resumable stream, which the transport does not expose to a
  subscriber. What is not proven here is the dashboard running against these handlers in
  a real browser with the Python API stopped; that is Phase 8's job and item 8.1 owns
  it.)
  (SSE keeps `web/src/hooks/use-sse.ts`'s existing message shape; sourced from
  the Redis Streams pub/sub topic, not an in-process stream; uses Mastra resumable-stream
  replay; test disconnects and reconnects mid-run and asserts no gap in the event sequence)

  Evidence: [`evidence/phase-5.md` #5.5](../mastra-port/evidence/phase-5.md)

  - [x] 5.5a The pipeline event bus, and the stage-start row write plus its `stage_start`
    event.

    Evidence: [`evidence/phase-5.md` #5.5a](../mastra-port/evidence/phase-5.md)

  - [x] 5.5b `stage_complete`, `pipeline_complete` and `stage_error`, from the same
    positions Python published them: after each stage's `saveStageOutput` with the
    stage's model and duration, from the completion step, and from the failure path.

    Evidence: [`evidence/phase-5.md` #5.5b](../mastra-port/evidence/phase-5.md)

  - [x] 5.5c `execution_logs` and the `log` event: Python's `append_execution_log()` and
    `publish_stage_log()`, which write the same entry to the column and the bus.
    (All four sub-items done: 5.5c-i the writer plus the three runner entries, 5.5c-ii
    `pipeline_start`, 5.5c-iii the two failure entries, 5.5c-iv all 28 stage call sites.
    Evidence under each.)

    Evidence: [`evidence/phase-5.md` #5.5c](../mastra-port/evidence/phase-5.md)

    - [x] 5.5c-i `appendExecutionLog()`, plus the three entries the runner wrote from
      code the port already has: `stage_start`, `stage_complete` and `pipeline_complete`.

      Evidence: [`evidence/phase-5.md` #5.5c-i](../mastra-port/evidence/phase-5.md)

    - [x] 5.5c-ii `pipeline_start`: the run-level entry Python wrote before the stage
      loop, gated on `is_full_pipeline`. Needs a head step on the chain, symmetric with
      `pipeline-complete`, because the structural rule keeps run logic in a Mastra
      primitive rather than in the route handler that starts the run.

      Evidence: [`evidence/phase-5.md` #5.5c-ii](../mastra-port/evidence/phase-5.md)

    - [x] 5.5c-iii The failure entries from Python's exception branch: the `warning` /
      `retry` entry while attempts remain and the `error` / `stage_error` entry once
      they are spent. These go beside the `stage_error` publish in
      `web/src/mastra/failure-recorder.ts`, and the retry half has to be settled against
      the evented engine's `retryConfig` rather than transcribed from ARQ's `job_try`.

      Evidence: [`evidence/phase-5.md` #5.5c-iii](../mastra-port/evidence/phase-5.md)

      - [x] 5.5c-iii-a The `error` / `stage_error` entry once the attempts are spent.

        Evidence: [`evidence/phase-5.md` #5.5c-iii-a](../mastra-port/evidence/phase-5.md)

      - [x] 5.5c-iii-b The `warning` / `retry` entry while attempts remain (split: the
        entry cannot be written until the port has a retry policy to write it about, and
        deciding that policy moves `attempts` in three places that already have tests.
        Split into 5.5c-iii-b-1 the retry policy, 5.5c-iii-b-2 the entry.)
        - [x] 5.5c-iii-b-1 The retry policy: `pipelineWorkflow.retryConfig`, and the
          `attempts` every failure record derives from it.

          Evidence: [`evidence/phase-5.md` #5.5c-iii-b-1](../mastra-port/evidence/phase-5.md)

        - [x] 5.5c-iii-b-2 The `warning` / `retry` entry itself, written from inside the
          step where `retryCount` and the thrown error are both in hand, since the
          `workflows-finish` listener only ever sees a run whose attempts are spent.

          Evidence: [`evidence/phase-5.md` #5.5c-iii-b-2](../mastra-port/evidence/phase-5.md)

          - [x] 5.5c-iii-b-2-a The entry for the five single-step stages: `research`,
            `outline`, `write`, `edit`, `ready`.

            Evidence: [`evidence/phase-5.md` #5.5c-iii-b-2-a](../mastra-port/evidence/phase-5.md)

          - [x] 5.5c-iii-b-2-b The entry for the `images` stage (split: the measurement
            that unblocks it turned up a real defect, and the entry cannot be written
            until that is fixed. Split into 5.5c-iii-b-2-b-i the measurement plus the
            retry policy it forces onto `imagesWorkflow`, and 5.5c-iii-b-2-b-ii the
            entry itself.)

            - [x] 5.5c-iii-b-2-b-i Settle by measurement whether the parent retries a
              nested workflow entry, and give `imagesWorkflow` a retry policy of its
              own if it does not.

              Evidence: [`evidence/phase-5.md` #5.5c-iii-b-2-b-i](../mastra-port/evidence/phase-5.md)

            - [x] 5.5c-iii-b-2-b-ii The `warning` / `retry` entry itself, written from
              inside the `images` sub-steps. Now unblocked: the attempt number is the
              sub-step's own `retryCount` against `imagesWorkflow`'s policy, which
              5.5c-iii-b-2-b-i measured to be a single ascending sequence.

              Evidence: [`evidence/phase-5.md` #5.5c-iii-b-2-b-ii](../mastra-port/evidence/phase-5.md)

    - [x] 5.5c-iv `publishStageLog()` and the `log` event: the 28 call sites inside the
      six stage nodes, and the module-level `set_event_context` /
      `clear_event_context` they read, which has no equivalent in a step that already
      receives `mastra`.

      Evidence: [`evidence/phase-5.md` #5.5c-iv](../mastra-port/evidence/phase-5.md)

      - [x] 5.5c-iv-a `publishStageLog()` itself, plus the three stages whose call sites
        are the same three lines: `outline`, `write` and `ready`.

        Evidence: [`evidence/phase-5.md` #5.5c-iv-a](../mastra-port/evidence/phase-5.md)

      - [x] 5.5c-iv-b `research`'s five call sites, which sit inside its validator retry
        loop and so are written once per attempt rather than once per stage.

        Evidence: [`evidence/phase-5.md` #5.5c-iv-b](../mastra-port/evidence/phase-5.md)

      - [x] 5.5c-iv-c `edit`'s seven call sites, which report the link-validation and
        quality passes.

        Evidence: [`evidence/phase-5.md` #5.5c-iv-c](../mastra-port/evidence/phase-5.md)

      - [x] 5.5c-iv-d `images`' seven call sites, spread across the nested workflow's
        three sub-steps, including the per-image lines inside the `.foreach()` fan-out.
        (Both sub-items done: 5.5c-iv-d-1 the five in `images_node` before the fan-out,
        5.5c-iv-d-2 the two inside `_generate_one`. Evidence under each.)

        Evidence: [`evidence/phase-5.md` #5.5c-iv-d](../mastra-port/evidence/phase-5.md)

        - [x] 5.5c-iv-d-1 The five call sites in `images_node` before the fan-out, all of
          which land in `web/src/mastra/steps/images-manifest.ts`.

          Evidence: [`evidence/phase-5.md` #5.5c-iv-d-1](../mastra-port/evidence/phase-5.md)

        - [x] 5.5c-iv-d-2 The two call sites inside `_generate_one`, which publish under
          the event names `image_generated` and `image_failed` rather than `log`, each with
          a `data` payload, from inside the `.foreach()` fan-out.

          Evidence: [`evidence/phase-5.md` #5.5c-iv-d-2](../mastra-port/evidence/phase-5.md)

  - [x] 5.5d `GET /api/events/{post_id}` and `GET /api/events`, as Next.js route handlers
    serving `text/event-stream` in `use-sse.ts`'s named-event shape, subscribed to the
    topic rather than to an in-process stream.

    Evidence: [`evidence/phase-5.md` #5.5d](../mastra-port/evidence/phase-5.md)

    - [x] 5.5d-i `GET /api/events/{post_id}`, plus the `text/event-stream` framing and
      the subscription lifecycle both endpoints share.

      Evidence: [`evidence/phase-5.md` #5.5d-i](../mastra-port/evidence/phase-5.md)

    - [x] 5.5d-ii `GET /api/events`, and how the global feed is scoped to the caller's
      own posts.

      Evidence: [`evidence/phase-5.md` #5.5d-ii](../mastra-port/evidence/phase-5.md)

  - [x] 5.5e Resumable replay: a browser that reconnects mid-run recovers the events it
    missed. Test disconnects and reconnects mid-run and asserts no gap in the sequence.
    (All three sub-items done: 5.5e-i the `id:` anchor on every frame, 5.5e-ii the
    server-side skip-to-anchor replay in both handlers, 5.5e-iii the client that carries
    the anchor across its own reconnect. The no-gap test the item asks for is
    `it("resumes where the client stopped, with no gap across the disconnect")` in
    `web/src/app/api/events/events.test.ts`, under 5.5e-ii.)

    Evidence: [`evidence/phase-5.md` #5.5e](../mastra-port/evidence/phase-5.md)

    - [x] 5.5e-i The replay anchor: an `id:` field on every SSE frame.

      Evidence: [`evidence/phase-5.md` #5.5e-i](../mastra-port/evidence/phase-5.md)

    - [x] 5.5e-ii Server-side replay: both handlers accept an anchor (the `Last-Event-ID`
      header and a `last_event_id` query parameter, since `EventSource` can set no
      headers), subscribe with `startFrom: "earliest"` when one is given, drop everything
      up to and including it, and fall back to the anchor's timestamp when the anchor
      event has been trimmed off the stream. Test disconnects and reconnects mid-run and
      asserts no gap in the event sequence.

      Evidence: [`evidence/phase-5.md` #5.5e-ii](../mastra-port/evidence/phase-5.md)

    - [x] 5.5e-iii `use-sse.ts` carries the anchor across the reconnect it performs
      itself: record `MessageEvent.lastEventId` per delivered event and put it on the URL
      of the next `EventSource`, because a fresh `EventSource` sends no `Last-Event-ID`.

      Evidence: [`evidence/phase-5.md` #5.5e-iii](../mastra-port/evidence/phase-5.md)

- [x] 5.6 `rules`

  Evidence: [`evidence/phase-5.md` #5.6](../mastra-port/evidence/phase-5.md)

- [x] 5.7 `links`

  Evidence: [`evidence/phase-5.md` #5.7](../mastra-port/evidence/phase-5.md)

- [x] 5.8 `analytics` (all four sub-items done: 5.8a `/dashboard`, 5.8b `/costs`,
  5.8c `/models`, 5.8d `/logs`. `api/src/api/analytics.py` is fully ported to
  `web/src/app/api/analytics/`; the `DashboardStats`, `CostAnalytics`,
  `ModelAnalytics` and `PaginatedLogs` shapes in `web/src/lib/api.ts` all needed no
  change. 120 new tests across the four endpoints, against the real database and
  real BetterAuth sessions, where Python had none. Two of the four were measured
  byte-for-byte against the live Python endpoint on shared fixtures; `/costs` could
  not be, because its Python original 500s on every call from a FROM-clause bug the
  port fixes. What is not proven here is `/monitor` rendering these payloads in a
  real browser with the Python API stopped; that is Phase 8 item 8.8. Split because
  the four endpoints are 519 lines with unrelated aggregation apiece.)
  - [x] 5.8a `GET /api/analytics/dashboard`.

    Evidence: [`evidence/phase-5.md` #5.8a](../mastra-port/evidence/phase-5.md)

  - [x] 5.8b `GET /api/analytics/costs`.

    Evidence: [`evidence/phase-5.md` #5.8b](../mastra-port/evidence/phase-5.md)

  - [x] 5.8c `GET /api/analytics/models`.

    Evidence: [`evidence/phase-5.md` #5.8c](../mastra-port/evidence/phase-5.md)

  - [x] 5.8d `GET /api/analytics/logs` (both sub-items done: 5.8d-i the
    `datetime.fromisoformat(x).isoformat()` port against a committed 128-case CPython
    oracle, 5.8d-ii the handler. Split because the handler is eight filters, two raw
    statements and a pagination rollup, but ahead of any of that it runs both time
    bounds through that round trip, and it is a parser with its own grammar rather
    than a formatting detail. The handler is byte-for-byte equal to the live Python
    endpoint on twelve queries over shared fixtures; the two deviations are the 422s
    it answers where Python 500s on an unparseable bound or a non-uuid `profile_id`.)
    - [x] 5.8d-i Port `datetime.fromisoformat(x).isoformat()`, the normalisation
      `search_logs()` applies to `since` and `until` before binding them.

      Evidence: [`evidence/phase-5.md` #5.8d-i](../mastra-port/evidence/phase-5.md)

    - [x] 5.8d-ii The handler itself: the eight filters, the `jsonb_array_elements`
      unroll, the count and data statements and the pagination rollup.

      Evidence: [`evidence/phase-5.md` #5.8d-ii](../mastra-port/evidence/phase-5.md)

- [x] 5.9 `wordpress` (split: three endpoints sitting on a REST client that has no
  TypeScript equivalent at all, so the client has to land before the handlers can.
  Split into 5.9a the client's read half, 5.9b the three route handlers.) Closed by
  5.9b: both sub-items are checked with their own evidence, and
  `GET /api/profiles/{profile_id}/wordpress/{test,categories,authors}` are all served
  from `web/src/app/api/profiles/[id]/wordpress/`.
  - [x] 5.9a The read half of `api/src/services/wordpress.py`, ported to TypeScript.

    Evidence: [`evidence/phase-5.md` #5.9a](../mastra-port/evidence/phase-5.md)

  - [x] 5.9b The three route handlers,
    `GET /api/profiles/{profile_id}/wordpress/{test,categories,authors}`, on top of
    5.9a's client. Includes `_get_wp_client`'s two 400s (missing credentials, and a
    `wp_app_password` that will not decrypt), `_get_user_profile`'s user-scoped 404, and
    the fact that `/test` swallows both of those into `{connected: false, error}` while
    `/categories` and `/authors` let them out as real 400s.

    Evidence: [`evidence/phase-5.md` #5.9b](../mastra-port/evidence/phase-5.md)

- [x] 5.10 `nextjs` (HMAC signing from `hmac_signing.py` and the webhook contract with
  `packages/create-mdx-blog` preserved exactly)

  Evidence: [`evidence/phase-5.md` #5.10](../mastra-port/evidence/phase-5.md)

- [x] 5.11 The auto-publish half of `_post_completion_hook` (`api/src/worker.py:439-463`),
  which 4.7b deferred to Phase 5 because it needed the two publish workflows. Both now
  exist (5.3c-iii-b-1-c-iii and 5.3c-iii-b-2-d), so nothing blocks it. A full run that
  ends with `output_format == "wordpress"` and a profile carrying `wp_url`,
  `wp_username` and `wp_app_password` writes `wp_publish_status = "pending"` and starts
  `wordpressPublish`; the same for `nextjs` with `nextjs_webhook_url` and
  `nextjs_webhook_secret` starting `nextjsPublish`. Three details Python's shape hides
  and a translation would lose: it fires only for a full pipeline
  (`is_full_pipeline`), never for a single stage; the hook writes the column but the
  *caller* enqueues, and the caller re-reads the row and enqueues on
  `status == "pending"`, so a post left `pending` by an earlier failed publish is
  re-enqueued even when the configuration check just declined; and `both` matches
  neither branch, exactly as in `POST /{post_id}/publish`.

  Evidence: [`evidence/phase-5.md` #5.11](../mastra-port/evidence/phase-5.md)

## Phase 6: Runtime model configuration

- [x] 6.0 The `settings` primary key. `settings.key` was the whole primary key while
  `user_id` was only an index, so two users could never hold different values for one key
  and per-user per-stage model config was impossible. Alembic revision `012` replaces it
  with a surrogate `id` plus `UNIQUE NULLS NOT DISTINCT (key, user_id)`, verified against
  the running Postgres 17.8 before being relied on. It lands as an Alembic revision only,
  because Alembic still owns the schema until Phase 7 and `conftest.py` builds pytest's
  database from `metadata.create_all()`, so `api/src/models/setting.py` moved with it; the
  post-cutover creation path for a fresh database is item 7.0. The `api_keys` row survives
  the table rewrite byte-identical, and every caller that keyed on `settings.key` (four
  `session.get(Setting, ...)` calls in Python, ten drizzle `onConflictDoUpdate` targets,
  and the two global reads in `api-keys.ts`, which now say `user_id IS NULL` explicitly)
  moved to the new key. One test changed meaning and says so: the case that asserted a
  second user could not write a key now asserts that they can.

  Evidence: [`evidence/phase-6.md` #6.0](../mastra-port/evidence/phase-6.md)

- [x] 6.1 Model IDs, verified against live provider documentation and a real minimal API call
  billed to the key in `settings.api_keys`. `research` keeps `sonar-pro`, the only Sonar tier
  at its level that pairs live grounding with the citations the stage's link extraction needs.
  The five Claude calls (`outline`, `write`, `edit`, `ready`, and the `images` manifest call)
  move to `claude-opus-5`, the strongest tier reachable at `claude-opus-4-6`'s per-token price;
  `claude-fable-5` verified too and was declined at 2x the cost. `images` generation moves to
  `gemini-3-pro-image` per the objective's verified table, re-confirmed here. The model change
  forced a parameter change: `budget_tokens` is rejected on this tier, so `claudeStageOptions`
  now sends adaptive thinking plus `output_config.effort: high`, with the wire `max_tokens`
  unchanged because the provider stops adding a budget term to it. Two costs recorded: about
  +$0.34 per five-image article, and a ~1.3x token-count increase from the 4.7-and-later
  tokenizer at an unchanged rate card. Closing this also closed the images half of the Phase 0
  golden capture that the zero-quota key had blocked, and turned up one wrong assertion (the
  live image test guessed PNG; `gemini-3-pro-image` returns JPEG) that had never executed.

  Evidence: [`evidence/phase-6.md` #6.1](../mastra-port/evidence/phase-6.md)
- [x] 6.2 Extend the `api_settings`-backed settings pattern so each stage has a configurable
  model and, where supported, a reasoning/effort setting, persisted per user, validated on write
  against the allowlist from 6.1, falling back to the verified hardcoded defaults when unset.
  Split because the storage half (which row wins, what is a legal value) and the consumption
  half (an agent building its request from that row) fail in different ways and are provable
  separately. Closed by 6.2a and 6.2b below; the settings page for it is 6.3 and the
  UI-to-provider assertion is 6.4.

- [x] 6.2a The settings-backed layer: `mastra/stage-models.ts` holds the per-stage allowlist
  (only ids with a live provider response behind them in #6.1), the verified defaults, and
  `resolveStageModels()`, which merges defaults, then the global `user_id IS NULL` row, then the
  user's row, field by field so an effort override keeps the operator's model. `PATCH
  /api/settings` validates the `stage_models` key against the allowlist before writing anything,
  which is the only key it does not store verbatim. Effort is offered only where the provider
  documents one, so Anthropic stages only; `images` selects the Gemini generation model and its
  Claude manifest call keeps the shared defaults. 44 tests, 11 mutations killed.

  Evidence: [`evidence/phase-6.md` #6.2a](../mastra-port/evidence/phase-6.md)

- [x] 6.2b The six stage agents build their request from `resolveStageModels()` for the user who
  owns the post, replacing the `*_MODEL_ID` constants and the fixed `CLAUDE_DEFAULT_EFFORT`, so a
  stored override reaches the provider. The user travels on Mastra's `requestContext`, which is
  the only argument a dynamic `model` / `defaultOptions` resolver gets, and comes from
  `posts.profile_id -> website_profiles.user_id` because `posts` has no owner column. Two
  constants stayed on purpose: the `images` manifest call, which this setting does not name, and
  `generateImage`'s own fallback default. 112 tests, 10 of 11 mutations killed, the survivor
  equivalent under a one-entry allowlist with a tripwire test on it.

  Evidence: [`evidence/phase-6.md` #6.2b](../mastra-port/evidence/phase-6.md)
- [ ] 6.3 Settings UI: table of six stages with model and effort selectors, current effective
  value plus default-or-override indicator, save and revert-to-default per stage, real provider
  errors surfaced rather than silent fallback.
- [ ] 6.4 Test asserts that changing a stage's model in the UI changes the model in the outbound
  provider request payload.

## Phase 7: Cutover

- [ ] 7.0 How a fresh database is created after Alembic is deleted. `schema.ts` mirrors
  the Alembic-owned schema today and has no generate workflow (see `drizzle.config.ts`),
  so once `api/` is gone nothing in the repo can build an empty database. Give Drizzle a
  baseline migration generated from `schema.ts` and prove it produces the same shape the
  Alembic chain does, including the settings key from 6.0.
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
