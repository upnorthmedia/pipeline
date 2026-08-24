# todo

- [confirmed] 2026-08-21 The `images` stage's featured-image handling never fires on real
  manifests. `images.py` tests `image_spec.get("placement") == "featured"`, but the manifest
  Claude actually produces (live capture, `docs/mastra-port/golden/how-to-choose-a-crm-for-a-small-team/images.json`)
  sets `placement` to an object (`{"location": "featured_image", "after_section": null}`) and
  carries the featured marker on `type`. Result: the 2K/16:9 override and the 1920px optimise
  width are skipped, and the `featured-<MMDDYY>-<NN>` rename only happens via the `type` branch.
  Port must decide which shape is canonical rather than copying the mismatch (Phase 3.5).

- [confirmed] 2026-08-21 The Gemini API key in the main checkout's `.env` has **zero** image
  quota: every `gemini-3.1-flash-image` call returns 429 `RESOURCE_EXHAUSTED` with
  `limit: 0, model: gemini-3.1-flash-image` on the free tier. No image can be generated in
  any environment using that key. Blocks the images half of Phase 0 golden capture and the
  Phase 5 images-model verification until billing is enabled on that Google project.

- [investigate] 2026-08-21 `ClaudeClient.chat` sends `thinking={"type": "enabled",
  "budget_tokens": 10000}`, which the installed anthropic SDK now warns is deprecated for
  `claude-opus-4-6`: "Use 'thinking.type=adaptive' instead which results in better model
  performance in our testing". Every live pipeline run emits this UserWarning. Decide the
  target thinking configuration during the Phase 3 stage ports rather than copying the
  deprecated shape into TypeScript.

- [confirmed] 2026-08-21 `settings` primary key is `key` alone while `user_id` is only an
  index, so two users cannot hold different values for the same setting key. Phase 6 asks for
  per-user per-stage model settings and the port forbids schema changes, so this needs a
  decision (namespaced keys, or a schema change deferred past the port).
- [confirmed] 2026-08-21 `api/src/models/post.py` disagrees with the Alembic-produced
  database on two defaults: it declares `output_format` server default `"markdown"` and a
  six-stage all-`"auto"` `stage_settings`, while the database has `'both'` and a five-stage
  all-`"review"` map. Rows created through SQLAlchemy and rows created by raw SQL therefore
  get different defaults.

- [confirmed] 2026-08-21 `next build`'s output file tracing does not know about the two
  runtime data files under `web/src/mastra/textstat/data/`, which the port reads with
  `readFileSync` relative to `process.cwd()`. `rules/*.md` has the same shape of dependency
  through `rulesDir()`. Both need to be resolved before the Phase 7 Railway deploy, either by
  copying them into the standalone output or by moving them somewhere the tracer follows.

- [confirmed] 2026-08-22 `_generate_one` gives every featured image the same filename,
  `featured-<MMDDYY>-<randint(10,99)>.webp`, so two featured entries in one manifest collide:
  the later write overwrites the earlier file and both manifest entries record the same URL.
  Proven by `api/scripts/export_image_generation_parity.py`, where four featured entries
  produced one file. Real manifests carry a single featured image, so this is latent, but the
  collision odds for a second one are 1 in 90. A per-image suffix would fix it.
- [confirmed] 2026-08-22 The featured overrides in `_generate_one` rewrite the local
  `aspect_ratio` / `image_size` without touching the manifest entry, so a stored entry can say
  `image_size: "1K"` for a call that was actually made at `2K`, or omit `aspect_ratio`
  entirely for a call made at `16:9`. Anything reading `image_manifest` to report what was
  generated is reading the request that was not sent.
- [confirmed] 2026-08-22 An image spec whose `filename` is the empty string writes a dotfile,
  `<media_dir>/<post_id>/.webp`, and records `/media/<post_id>/.webp`. Hidden from directory
  listings and unservable by most static handlers.
- [investigate] 2026-08-22 Python reads `aspect_ratio`, `image_size` and `filename` out of the
  manifest with `dict.get(key, default)`, which returns an explicit JSON `null` rather than
  the default: `None` then reaches the Gemini SDK, or `Path(None)` raises `TypeError` and the
  image is recorded as failed. `web/src/mastra/images/generate-one.ts` treats a non-string as
  absent instead. No rule asks the model for a null there and no fixture contains one, so the
  divergence is unobserved rather than tested; decide the intended behaviour before Phase 7.
- [confirmed] 2026-08-22 The `posts.stage_settings` column default in the live database is
  `{"edit":"review","write":"review","images":"review","outline":"review","research":"review"}`,
  which predates the gate removal and does not mention `ready` at all. SQLAlchemy sent its own
  all-auto default on every insert, so no post created through FastAPI ever inherited it, but a
  TypeScript insert that omits the column does: with review gates back (item 4.3) such a post
  parks at the `research` gate on its first run. The Phase 5.3 `posts` route handler must send
  `stage_settings` explicitly, the way `api/src/models/post.py` did.
- [confirmed] 2026-08-22 `EventedRun.resume()` resolves with a stale snapshot. It subscribes to
  the shared `workflows-finish` topic and the Redis stream still holds the run's earlier
  `workflow.suspend` event, so the promise resolves with that event the moment it subscribes
  while the resumed run carries on executing behind it. `resumeStream()`'s `.result` has the
  same problem and its `fullStream` replays the pre-suspend events too. Only
  `workflow.getWorkflowRunById(runId)` reports the truth. Anything in Phase 5 that awaits a
  resume (a gate-approval route, the SSE trace) has to poll the persisted state instead.
- [confirmed] 2026-08-22 `web/src/lib/api.ts` types `StageMode` as `"auto"` and `StageStatus`
  without `"review"`, so the dashboard cannot express a gated stage. Item 4.3 writes
  `stage_status[stage] = "review"` when a run parks. Phase 5.3 / Phase 8 must widen both unions
  (and the stage badge) or a parked post renders as an unknown status.
- [confirmed] 2026-08-22 The `mastra worker` bundle does not inherit the dev machine's module
  resolution. Two packages that `next build`, `vitest` and `mastra dev` all resolve fine were
  unresolvable in the worker bundle: `@opentelemetry/api` (undeclared by any package in the
  tree, so the deployer's own import check fails at build time) and `sharp` (native, so its
  `.node` binary cannot be inlined). Both are fixed, but the class of problem is not: any new
  runtime dependency reaching the Mastra instance needs `pnpm -C web worker:build` run against
  a clean `.mastra/worker` before it is trusted. Phase 7's Railway configuration should run
  that build in CI.
- [investigate] 2026-08-22 `mastra worker start` prints `[mastra] Shutting down workers...`
  twice under a process-group signal, because the CLI and the worker it spawns each handle
  their own SIGTERM and the CLI's handler forwards a second one. Cosmetic locally; worth
  checking that Railway's shutdown does not double-run `stopWorkers()` before Phase 7 ships.
- [investigate] 2026-08-22 Item 4.5a only covers `SIGKILL`. A Railway redeploy sends `SIGTERM`,
  which the `mastra worker` entry handles by calling `stopWorkers()`, and `stopWorkers()`
  unsubscribes the transport while a step may still be executing. Whether the in-flight step's
  message is left pending for reclaim, acked, or nacked decides whether a routine worker deploy
  loses or duplicates a stage. Worth answering in 4.5b or Phase 7, not assumed.
- [confirmed] 2026-08-22 The worker bundle resolves `rules/` from its own output directory, so
  it needs `RULES_DIR` set explicitly. `prompts.ts` falls back to
  `path.resolve(process.cwd(), "..", "rules")` and `mastra worker start` runs with cwd set to
  the bundle directory (`web/.mastra/<bundle>`), so the fallback points at
  `web/.mastra/rules`, which does not exist. `loadRules` returns `""` for a missing file rather
  than throwing, so every stage would silently run with its rule file stripped out of the
  prompt. `docker-compose.yml` already sets `RULES_DIR: /app/rules`; item 7.2's Railway
  definitions must set it too, and item 4.5b's durability-gate run was executed without it.
- [confirmed] 2026-08-22 The worker bundle also needs `TEXTSTAT_DATA_DIR` set, and unlike the
  missing rules it is fatal. `textstatDataDir()` falls back to
  `path.resolve(process.cwd(), "src/mastra/textstat/data")`, so under the bundle's cwd it
  resolves to `web/.mastra/<bundle>/src/mastra/textstat/data` and the `edit` stage dies with
  `ENOENT ... cmudict-syllables.txt.gz` (observed on item 4.7's first end-to-end run, run
  ec961af1, after `research`, `outline` and `write` had already been billed). `mastra worker
  build` has no asset-copy option (`BundlerConfig` is externals / sourcemap / minify /
  transpilePackages / dynamicPackages), so the two data files cannot ride inside the bundle
  and the variable is the only lever. Item 7.2 must set `RULES_DIR`, `TEXTSTAT_DATA_DIR` and
  `MEDIA_DIR` on the Railway `worker` service, and 7.1 must set them on the compose `worker`
  service.
- [confirmed] 2026-08-22 `settings.key` is the entire primary key, so two users cannot both hold
  one settings key. `PATCH /api/settings` therefore 500s with a `23505` unique violation when a
  user patches a key another user already owns, in both stacks (Python raises the same
  IntegrityError from the same INSERT). Alembic 010 added `user_id` as an index only. The fix is
  a composite `(key, user_id)` primary key, which section 8 of the port objective forbids as part
  of the port. Asserted as-is in `web/src/app/api/settings/route.test.ts`.
- [investigate] 2026-08-22 BetterAuth has no `BETTER_AUTH_SECRET` in `.env` or `.env.example`, so
  it falls back to its built-in default secret and every session cookie in this deployment is
  signed with a publicly known key. Setting one invalidates existing sessions, which is free now
  (`auth_users` was empty when the tables were created) and expensive later. Belongs with the
  Phase 7 env documentation, item 7.4.
- [confirmed] 2026-08-22 `web/src/app/api/profiles/serialize.ts` formats timestamps with a plain
  `Date.toISOString()`, which always writes exactly three fractional digits. Pydantic 2.12 trims
  trailing zeros and drops the fraction entirely when it is zero, so a profile whose
  `created_at` landed on a whole second is served as `...T12:34:56.000Z` where FastAPI served
  `...T12:34:56Z`. Found while porting `PostRead` for item 5.3a, which added
  `toPydanticIso()` in `web/src/app/api/posts/serialize.ts` to reproduce the pydantic rule.
  Nothing in the dashboard does more than hand these strings to `new Date()`, so this is
  cosmetic, but the two ported serializers should agree: move `toPydanticIso()` somewhere
  shared and use it for profiles too.
- [confirmed] 2026-08-22 `POST /api/posts/{post_id}/duplicate` silently drops `article_type` and
  `additional_info`. `duplicate_post`'s `config_fields` list in `api/src/api/posts.py` names
  eighteen columns and was never extended when those two were added, so a duplicated post loses
  the article type the new-post form set and any extra instructions the user wrote. Reproduced
  and pinned by `does not copy article_type or additional_info` in
  `web/src/app/api/posts/duplicate-batch.test.ts`, where the port keeps the behaviour on
  purpose: item 5.3b-iii is a port, not a bug fix, and changing what duplicate copies is a
  product decision. Fixing it is two names in `CONFIG_COLUMNS` plus flipping that test.
- [confirmed] 2026-08-22 `PostAnalytics.seo_checklist` in `web/src/lib/api.ts` is typed
  `Record<string, boolean>` but the endpoint has always returned a mixed map: `_seo_checklist`
  in `api/src/services/analytics.py` puts `internal_link_count` and `external_link_count` in
  alongside the seven booleans, so the real shape is `Record<string, boolean | number>`. Proven
  by the oracle at `web/src/app/api/posts/data/logs-analytics-parity.json`, whose
  `seo_checklist` values include `"internal_link_count": 2`. The consequence is visible, not
  just typed: `SeoChecklist` in `web/src/components/analytics-bar.tsx` maps over every entry, so
  the two counts render as SEO checks and inflate the `passed/total` fraction. Found while
  porting `/analytics` for item 5.3d-iii, which reproduces the shape exactly because the item is
  a port. Fixing it means widening the type in `api.ts` and in `SeoChecklistProps`, then
  deciding in the UI whether to filter the counts out or render them as counts; that is Phase 8
  work, not a route-handler change.
- [confirmed] 2026-08-22 `retry_dead_letter()` in `api/src/api/queue.py` looks the post up with
  an unscoped `session.get(Post, post_id)`, so any authenticated user can reset another user's
  post to `pending`, strip its `_error` log and re-enqueue it. The other two dead-letter
  endpoints (`GET /api/queue/dead-letter`, `DELETE /api/queue/dead-letter`) take a `user`
  dependency and then ignore it entirely, returning and clearing the whole shared list.
  `GET /api/queue/worker-status` had a milder version, its `active_jobs` count querying every
  post in the database rather than the caller's; that one is closed, the ported handler scopes
  it through `website_profiles.user_id` (item 5.4c-ii). `GET /api/queue/dead-letter` is closed
  too: the ported handler joins each failed run's post through `website_profiles.user_id`
  (item 5.4d-ii), which is the user dimension the Redis list never had. `retry_dead_letter()`
  is closed as well: the ported handler looks the post up through the same join, so another
  user's post answers 404 (item 5.4d-iii-a). `DELETE /api/queue/dead-letter` is closed last:
  the ported handler pops `_error` only off the posts the caller's own entries name, so a
  clear can no longer wipe another tenant's queue (item 5.4d-iii-b). Found while splitting
  item 5.4; recorded there too. All four holes in this router are now closed.
- [investigate] 2026-08-22 Mastra's engine logs step failures to a logger the app cannot
  configure. `MastraBase`'s constructor gives every primitive its own `ConsoleLogger`
  (`base-BeUQ6mLP.js:12`) and only adopts the Mastra instance's logger in
  `__registerMastra`, which the workflow event processor never calls on its `StepExecutor`.
  So `Error executing step <id>: <stack>` goes to `console.error` and never reaches the
  configured `PinoLogger`, which in the `worker` service means step failures are outside
  the app's structured logs. Found in item 5.4d-i, where capturing that line in a test
  needed a `console.error` spy. Worth checking whether a later `@mastra/core` wires it, or
  whether the worker entry should install a console bridge.
- [confirmed] 2026-08-22 The `cost_usd` on every `stage_complete` execution log entry is
  priced at Anthropic Opus rates regardless of provider. `api/src/worker.py:244` hardcodes
  15.0 / 75.0 per million tokens and ignores `MODEL_COSTS` in
  `api/src/pipeline/helpers.py`, so the `research` stage's Perplexity tokens and the
  `images` stage's Gemini tokens are both billed as Opus in what
  `GET /api/analytics/logs` reports. Reproduced verbatim in the TypeScript port
  (`stageCostUsd` in `web/src/mastra/execution-log.ts`) because the analytics endpoint
  serves these entries straight through and correcting it during the port would make a
  run's reported cost jump at the cutover. Found while porting item 5.5c-i. Worth fixing
  once `MODEL_COSTS` has a TypeScript home, which is Phase 6's per-stage model config.
- [confirmed] 2026-08-22 The port's stage retries are immediate where Python spaced them
  10 seconds apart. `WorkerSettings.retry_delay = 10` (`api/src/worker.py:610`) has no
  equivalent in Mastra's evented engine: the processor's only `retryConfig` reference is
  the retry branch at `workflow-event-processor-Dp87-e6z.js:3434`, which reads
  `attempts` and republishes `workflow.step.run` straight away, and its `abortableSleep`
  helper is used only by sleep steps. So a provider that rate-limits us takes three rapid
  failures instead of three spaced ones, which is likelier to spend all three attempts on
  the same 429. Found setting the retry policy for item 5.5c-iii-b-1. A fix would be a
  backoff inside the step (it can read `retryCount`) rather than a `delay` on the
  workflow, which would read as honoured and would not be.
- [investigate] 2026-08-22 A step that is resumed from a review gate and then throws loses
  its `resumeData` on retry, so it re-suspends at the same gate instead of retrying. The
  engine's retry branch republishes `workflow.step.run` with `retryCount + 1` and does not
  carry `resumeData` forward (same branch, `workflow-event-processor-Dp87-e6z.js:3452`),
  while `reviewGate()` short-circuits only on `resumeData?.approved`. Not reproduced yet,
  and no test covers it: the gate suite has no failing-after-approval case. Noticed while
  reading the retry branch for item 5.5c-iii-b-1. If real, the user-visible effect is a
  second approval prompt rather than a lost run, and the fix is probably to treat a
  `stage_status` of `running` for this stage as approval.
- [confirmed, fixed 2026-08-22] The `images` stage did not retry at all, where Python's
  job retry re-ran it like any other stage. Measured under ledger item 5.5c-iii-b-2-b-i
  (`web/src/mastra/workflows/nested-retry.test.ts`): a parent that declares `attempts`
  around a nested workflow that declares none runs the nested workflow's failing step
  exactly once, because `runLeafStep` returns as soon as it publishes `workflow.start`
  for a nested entry (`workflow-event-processor-Dp87-e6z.js:3310`) and never reaches the
  retry branch below it. The earlier guess in this entry, that the nested entry is
  dispatched like a plain step and so inherits the parent's policy, was wrong. Fixed by
  declaring `retryConfig: { attempts: MAX_ATTEMPTS - 1 }` on `imagesWorkflow` itself.
  Note the residual asymmetry, deliberate: the policy now applies per sub-step, so a
  failing `images-generate` re-runs only that fan-out entry where Python's job retry
  re-entered the stage from the manifest.
- [confirmed, fixed 2026-08-23] `waitForFailure()` in
  `web/src/mastra/failure-recorder.test.ts` returned as soon as `current_stage` read
  `failed`, which is a snapshot that can predate the `stage_error` execution_logs entry:
  `recordRunFailure` writes the row, publishes, and only then appends (item 5.5c-iii-a
  reproduces Python's order for that one pair). The three trail assertions built on that
  snapshot failed intermittently. Measured at HEAD before the 5.5c-iv-b change (12 failed
  against the 9-failure baseline), so it was pre-existing. Fixed by having the poll also
  require the entry to be present.
- [optimization 2026-08-23] `web/src/mastra/steps/edit.ts` carries three literal U+2014 em
  dashes in source (the `em-dash(es)` warning message, the `ACTION REQUIRED` prompt line,
  and one comment), where the port's writing rule bans the character and item 5.5c-iv-b
  established the `\u2014` escape for the one message that needs it. All three predate
  that convention. The two product strings are wire and prompt contracts, so any rewrite
  has to keep the bytes identical; a byte-comparison test against the Python source would
  make that safe. Left alone under item 5.5c-iv-c to keep the diff scoped.
- [confirmed] 2026-08-23 `web/src/mastra/steps/images-manifest.ts` renders the manifest's
  `error` value into its parse-failure message with `String(...)` where Python's f-string
  applies `str(...)`. The two agree on every scalar but not on a container:
  `str({'a': 1})` is `{'a': 1}` and `String({a: 1})` is `[object Object]`. The branch is
  reachable, because `pythonTruthy` deliberately treats a non-empty dict or list as a
  truthy `error`, so a model that writes `"error": {"reason": "..."}` produces a
  divergent SSE message and execution_logs entry. The stored `data.error` is unaffected:
  it carries the raw JSON value in both stacks. A fix means porting Python's `str()` for
  arbitrary JSON (container `repr`, `True`/`False`/`None`, single-quoted strings), which
  is its own item; left alone under ledger item 5.5c-iv-d-1 to keep that diff scoped.
- [confirmed] 2026-08-23 `web/src/hooks/use-sse.ts` does not listen for `image_generated`
  or `image_failed`. `NAMED_EVENTS` lists eight names and neither is among them, so the
  two per-image lines the `images` fan-out publishes are delivered as named SSE events
  and dropped by `EventSource` before any handler sees them. Verified with
  `grep -n "image_generated\|image_failed" web/src/hooks/use-sse.ts
  web/src/components/debug-log-panel.tsx`, which exits 1. This is Python's behaviour
  reproduced, not a regression: the Python stack published the same two names onto the
  same channel and the same hook dropped them there too, so a browser has never seen
  per-image progress. Both lines do reach `posts.execution_logs`, so
  `GET /api/posts/{id}/logs` shows them. Whether the hook should gain the two names is a
  contract decision for ledger item 5.5d (the SSE route handlers), not a bug fix; left
  alone under 5.5c-iv-d-2 because adding names to `NAMED_EVENTS` changes what
  `debug-log-panel.tsx` renders mid-run.
- [optimization] 2026-08-23 `GET /api/events/{post_id}` opens one `RedisStreamsPubSub`
  subscription per connected browser, and each one costs a dedicated Redis connection plus
  a private `__fanout-<uuid>` consumer group (verified in `@mastra/redis-streams`'s
  `subscribe()`: it calls `createClient()` and `xGroupCreate()` per call). That mirrors
  Python's `redis.pubsub()` per request, so it is not a regression, but it scales with open
  tabs rather than with `web` processes: a user with the posts list, the monitor and a post
  detail open holds three. The fix, if connection count ever matters, is one process-wide
  subscription per `web` instance fanned out in memory to the connected `ReadableStream`s;
  it must stay ungrouped so two `web` replicas each see every event rather than splitting
  them. Not done now because nothing has hit the limit and the teardown path
  (`request.signal` -> `unsubscribe()`) already prevents the leak, proven by a test.
- [confirmed] 2026-08-23 `delete_link()` in `api/src/api/links.py` has no ownership check:
  unlike the other two endpoints in that router it never calls `_get_profile_or_404()`, so
  it matches on `link_id` and `profile_id` alone and any authenticated user who knows both
  ids can delete another tenant's internal link. The TypeScript port
  (`web/src/app/api/profiles/[id]/links/[link_id]/route.ts`, ledger item 5.7) scopes the
  delete to the caller and has a test for it, so the new stack is not affected; this entry
  exists because the Python router is still serving until Phase 7 deletes it. No fix
  applied to `api/` because Phase 7 removes the file and the port already closes the hole.
- [confirmed] 2026-08-23 `cost_analytics()` in `api/src/api/analytics.py` has never run.
  Its raw SQL puts the `website_profiles` join inside the second `FROM` item
  (`FROM posts p, jsonb_each(...) AS sl(...) JOIN website_profiles wp ON p.profile_id = wp.id`),
  and `JOIN` binds tighter than the comma, so `p` is referenced from a part of the query it
  is not visible in. Postgres rejects the statement before any parameter is bound
  (`asyncpg.exceptions.UndefinedTableError: invalid reference to FROM-clause entry for table "p"`),
  so `GET /api/analytics/costs` answers 500 on every input, and has since the file was added
  in `5f31ca4`. The ten `TestCosts` cases in `api/tests/phase12/test_analytics.py` never
  caught it because they all fail earlier on authentication. The TypeScript port
  (`web/src/app/api/analytics/costs/route.ts`, ledger item 5.8b) moves the join onto `posts`
  and has 30 tests, so the new stack is correct; this entry exists because the Python router
  is still serving until Phase 7 deletes it. No fix applied to `api/` for the same reason.
  Worth checking whether `/models` and `/logs` share the shape before porting them (items
  5.8c and 5.8d).
- [confirmed] 2026-08-23 `web/src/app/api/analytics/costs/route.ts` (ledger item 5.8b) reads
  its two optional query parameters with `url.searchParams.get("profile_id")` and
  `url.searchParams.get("model")`, which return the *first* value of a repeated key.
  Starlette's `QueryParams.get()` returns the *last*, so `?model=a&model=b` filters on `a` in
  the port and on `b` in the Python endpoint. Found while porting `/models` (item 5.8c),
  which reads `getAll("model").at(-1)` and has a test for it. Two one-line changes plus two
  tests; left out of 5.8c to keep that iteration to one ledger item. `/dashboard` is already
  correct (`parseDays()` in `web/src/app/api/analytics/days.ts` uses `getAll().at(-1)`).
- [confirmed] 2026-08-23 `npx next build` in `web/` prints 15 `[Error [BetterAuthError]: You
  are using the default secret. Please set BETTER_AUTH_SECRET ...]` lines while collecting
  page data for the 15 prerendered `/auth/[path]` routes. The build still exits 0. Cause is
  environmental, not code: the repo `.env` has no `BETTER_AUTH_SECRET`
  (`grep -c BETTER_AUTH_SECRET .env` answers `0`), so BetterAuth falls back to its default
  secret at build time. It has to be gone before item 9.1 can claim a build with no errors in
  its output, and Phase 7's `.env` documentation (item 7.4) is where the variable should be
  written down. Note this contradicts the iteration 95 note that the build *fails* without it;
  measured at HEAD on 2026-08-23 it exits 0 either way.
- [confirmed] 2026-08-23 `GET /api/analytics/logs` in `api/src/api/analytics.py` answers a
  500 for any `since` or `until` that `datetime.fromisoformat()` rejects. The parse sits
  outside any `try`, the parameters are declared `str | None` so pydantic never validates
  them, and the `ValueError` escapes the handler. Verified against the real router mounted
  under `TestClient(raise_server_exceptions=False)`: `?since=nope`, `?until=nope` and
  `?since=2026-13-01` all return `500 Internal Server Error`, while `?page=0` and
  `?per_page=201` correctly return 422. Found while porting the `fromisoformat` round trip
  (ledger item 5.8d-i). Resolved for the port in item 5.8d-ii: the TypeScript handler
  answers pydantic's `datetime_from_date_parsing` 422, matching the 5.8b precedent. No fix
  applied to `api/`, which is still serving until Phase 7 deletes it.
- [confirmed] 2026-08-23 The whole `/api/analytics/logs` result set is ordered and bounded by
  a *text* comparison on `log_entry->>'ts'`, in both stacks. That is only correct because
  every writer renders the timestamp with `datetime.now(UTC).isoformat()`, which always
  produces the same width and the same `+00:00` offset. Nothing enforces it: an entry
  written with a `Z` suffix, a non-UTC offset, or a whole-second timestamp with no fraction
  sorts wrongly against its neighbours and can fall on the wrong side of `since`/`until`.
  Found while porting the handler (ledger item 5.8d-ii). Ported faithfully rather than
  fixed, because changing the comparison to a cast (`(log_entry->>'ts')::timestamptz`) would
  change which rows a given bound returns and defeat the parity oracle. Worth revisiting
  once the TypeScript writers are the only ones producing `execution_logs` entries: item
  5.5c's `log` publisher is the single writer, so pinning its format in one place is cheap.
- [confirmed] 2026-08-23 `WordPressClient.__init__` in `api/src/services/wordpress.py`
  appends its REST paths to the raw `wp_url` after nothing but a trailing-slash strip and a
  suffix strip, so a profile whose `wp_url` carries a query string or a fragment produces a
  nonsense endpoint. Measured against the real client: `https://example.com/?a=1` yields
  `api_url = https://example.com/?a=1/wp-json/wp/v2`, and every call against it 404s. Found
  while porting the read half of the client (ledger item 5.9a) and reproduced faithfully in
  `web/src/mastra/wordpress/index.ts`, because changing it would change which URL a stored
  profile reaches. The fix belongs with the profile form's `wp_url` validation, not in the
  client: nothing today stops a user pasting a URL with a query string into it.
- [confirmed] 2026-08-23 `GET /api/profiles/{profile_id}/wordpress/categories` and
  `/authors` answer a 500 for every failure the WordPress install reports, because
  `api/src/api/wordpress.py` catches no `WordPressError` in either handler. A profile with
  an expired application password, a user without `list_users` capability, or a site behind
  a login wall all surface in the dashboard's category and author pickers as a bare server
  error with no reason attached, while `/test` on the same profile reports the real message.
  The same two handlers also 500 on a WordPress payload missing `id`, `name` or `slug`,
  because the projection subscripts rather than `.get`s. Both reproduced faithfully in
  `web/src/app/api/profiles/[id]/wordpress/` while porting ledger item 5.9b; the fix is to
  catch `WordPressError` and answer a 502 carrying `error.message`, which changes a
  documented response shape and so belongs with the Phase 8 pass over the profile page.
- [confirmed] 2026-08-23 `GET /api/profiles/{profile_id}/wordpress/test` answers a 500,
  not `{connected: false}`, when the configured `wp_url` serves valid JSON that is not an
  object at `/wp-json`: `info.get("name", "")` raises `AttributeError` and the handler's
  `except WordPressError` does not cover it. A parked domain returning `[]` or `null` is the
  realistic trigger. Reproduced in the port (ledger item 5.9b) with three oracle scenarios
  so the behaviour is pinned rather than accidental; the one-line fix is to widen the
  `except`, which changes the response for that input and needs a UI decision first.
- [confirmed] 2026-08-23 `markdown_to_wp_html` raises `AttributeError: No renderer
  "'inline_html'"` for any article whose markdown contains an HTML tag mistune's block
  layer declines. `_GutenbergRenderer` in `api/src/services/wp_html.py` implements
  `block_html` but not `inline_html`, so `<custom-tag />`, `<span>x</span>` mid paragraph,
  or a block tag on the line after a paragraph all crash the WordPress publish path rather
  than rendering. Found while porting ledger item 5.3c-iii-b-1-b-ii-3-a, which records five
  such inputs in `web/src/mastra/wordpress/data/wp-html-html-parity.json` under `declines`.
  The fix is a two-line `inline_html` method returning `token["raw"]`, but it changes the
  output of a currently-crashing path and belongs with the Phase 3 images/ready work rather
  than with the tokenizer port.
- [confirmed] 2026-08-23 The TypeScript port of mistune's `linebreak` and `softbreak`
  inline patterns in `web/src/mastra/wordpress/wp-html.ts` still spells Python's `\s` as
  JavaScript's `\s`. The two sets differ: Python's holds `\x1c`-`\x1f` and `\x85` and not
  `﻿`, JavaScript's is the other way round, so a paragraph whose line ends in one of
  those characters folds differently from the Python original. Found while porting ledger
  item 5.3c-iii-b-1-b-iii-c, which fixed the same mistake in the `emphasis` pattern; the
  file already has `PY_SPACE` for exactly this, so the fix is a two-line swap plus corpus
  cases, but `linebreak` and `softbreak` are outside that item's scope.
- [confirmed] 2026-08-23 WordPress publishing uploads no images at all in production. The
  media sweep in `api/src/pipeline/publish.py` keeps a file only when
  `mimetypes.guess_type(img_file.name)` returns an `image/*` type, and the images stage
  writes every file as `.webp` (`_optimize_image` in `api/src/pipeline/stages/images.py`
  returns `".webp"`). `.webp` is not in the Python 3.12 builtin mimetypes table; it arrived
  in 3.13. The deployed image is `python:3.12-slim`, which has no file from
  `mimetypes.knownfiles`, so the builtin table is the whole table there and
  `guess_type("x.webp")` is `(None, None)`. Verified with
  `docker run --rm python:3.12-slim python -c "import mimetypes; print(mimetypes.guess_type('a.webp'))"`
  → `(None, None)`. The bug is invisible on a macOS developer machine, where
  `/etc/apache2/mime.types` exists and grows the table from 152 entries to 1036, so
  `.webp` resolves there. Consequence: the WordPress post is published with no uploaded
  media, no featured image and the local `/media/...` URLs left unrewritten in its HTML.
  Ledger item 5.3c-iii-b-1-c-ii-1 ports the Python behaviour faithfully, bug included, and
  pins it with an oracle; the fix is one table entry in
  `web/src/mastra/wordpress/mimetypes.ts` (plus the same in Python while `api/` still
  exists) but it changes what publishing does, so it needs to be a deliberate change rather
  than a side effect of the port.
- [confirmed] 2026-08-23 The local-to-remote image URL rewrite in
  `api/src/pipeline/publish.py` corrupts a media URL that is a prefix of another one. The
  loop is `for local, remote in image_map.items(): wp_html = wp_html.replace(local, remote)`
  over a map keyed in the walk's sorted order, so with both `a.png` and `a.png.png` in the
  media directory the shorter key rewrites the longer URL's prefix first and the longer
  file's `source_url` is never inserted: `/media/p1/a.png.png` becomes
  `https://wp.example/one.png.png`, which 404s. Recorded verbatim in
  `web/src/mastra/wordpress/data/wp-media-upload-parity.json` (case "an earlier local URL
  that prefixes a later one rewrites its prefix") and reproduced by the port under ledger
  item 5.3c-iii-b-1-c-ii-3. Not reachable through the images stage, which names every file
  with a timestamp, so the fix (rewrite longest key first, or one pass with a single
  alternation) is a deliberate behaviour change rather than part of the port.
- [confirmed] 2026-08-23 `pythonJsonDumps` in `web/src/mastra/prompts.ts` does not escape
  U+007F. Its regex is `[\u0080-\uffff]`, but Python's `ESCAPE_ASCII` is `[^\ -~]`, so
  `json.dumps("\x7f")` is `"\u007f"` while that function leaves the character literal. The
  `ready` stage embeds the image manifest through it, so a manifest carrying a DEL renders
  a prompt one character different from the Python stack's. Confirmed against the deployed
  interpreter in `web/src/mastra/nextjs/data/nextjs-payload-parity.json` (case
  "escaping: delete character"). The fix is to reuse `encodeBasestringAscii` from
  `web/src/mastra/nextjs/json-dumps.ts`, which is a behaviour change to a rendered prompt
  and therefore not part of ledger item 5.3c-iii-b-2-c.
- [investigate] 2026-08-23 The `pg` driver parses a JSONB column with `JSON.parse`, which
  erases Python's int/float distinction and loses digits past 2^53 before any port sees the
  value. `json.dumps` re-emits the two differently (`1.0` stays `1.0`, `1e2` becomes
  `100.0`), and JavaScript additionally reorders integer-like object keys to the front, so
  a number or a nested numeric-keyed object inside `image_manifest.alt_text` signs
  different bytes than Python did. Eleven cases are listed in `PARSE_DIVERGENCES` in
  `web/src/mastra/nextjs/payload.test.ts`. Not reachable from anything the pipeline itself
  writes, only from model output. The fix, if it is ever needed, is a custom `pg` type
  parser for JSONB that produces the `PyFloat`/`bigint` markers
  `web/src/mastra/nextjs/pyyaml/values.ts` already defines.
- [confirmed] 2026-08-23 `POST /api/posts/{post_id}/publish` cannot publish a post whose
  `output_format` is `both`, which is the column's default value. `publish_post()` in
  `api/src/api/posts.py` compares `output_format == "wordpress"` and then `== "nextjs"`,
  by equality twice rather than once by membership, so `both` reaches the trailing
  `Publishing not supported for output_format 'both'` 400. Ported as-is under ledger item
  5.3c-iii-b-2-e with its own test, because widening it would start two publish runs from
  one request and that is a behaviour change, not a port. `_post_completion_hook`'s
  auto-publish half has the same shape, so a `both` post is not auto-published either.
- [confirmed] 2026-08-23 Perplexity's Sonar Chat Completions endpoint is deprecated with
  support ending 2026-09-27, per `docs.perplexity.ai/getting-started/models`. The
  `research` stage reaches `sonar-pro` through Mastra's model router, which uses the
  OpenAI-compatible `/chat/completions` shape, so research calls stop working after that
  date unless the stage moves to Perplexity's Agent API. Found while verifying model IDs
  for ledger item 6.1; out of scope there, but it has a hard deadline.
- [confirmed] 2026-08-23 The Playwright suite (`pnpm -C web test:e2e`) is stale. A full run
  during ledger item 7.1b ended `4 passed (7.4m)` with failures listed across all four spec
  files. The failures are expectation drift, not a regression from the port: the one
  reproduced in isolation, `navigation.test.ts > sidebar navigation items are visible`,
  waits for a sidebar item named "Monitor" while the sidebar renders "Observability", and
  the page itself loaded fine. No baseline for this gate was ever recorded in Phase 0, so
  there is nothing to compare against; item 9.1 needs it green, which means auditing every
  spec against the current UI and giving the ones that need data a real session.

- [investigate] 2026-08-23 `next build` inside the web image prints seven
  `[Error [BetterAuthError]: You are using the default secret...]` lines plus a matching
  BetterAuth base-URL warning per route during page-data collection. Non-fatal (the build
  exits 0) and pre-existing, but it is error-shaped output in a green build, which is exactly
  the noise the gate rules forbid introducing. Worth deciding whether the build stage should
  supply throwaway `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL` placeholders the way it now does for
  `DATABASE_URL_SYNC` and `REDIS_URL`, or whether `src/lib/auth.ts` should not be reachable
  from page-data collection at all.

- [confirmed] 2026-08-23 Generated images are unreachable from the `web` service on Railway.
  The `/media` volume is mounted on `worker`, which writes them, but Railway documents "Each
  service can only have a single volume" and its IaC reference says "A volume can be attached
  to one service", so `web` serving `/media/<post_id>/<file>` reads a different disk and
  answers 404. No configuration closes this; the fix is object storage (Railway's `bucket()`
  resource exists in the same DSL), which means changing where the images stage writes and
  where `web/src/app/media/[...path]/route.ts` reads. Stated in `docs/mastra-port/railway.md`
  and belongs in the SUMMARY.md gap list for item 9.3.

- [confirmed] 2026-08-23 Nothing runs database migrations on deploy. `deploy.preDeployCommand`
  is the documented Railway hook, but neither runtime image carries `drizzle-kit` or the
  `drizzle/` folder, so a fresh Railway environment needs `pnpm -C web db:migrate` and
  `pnpm -C web auth:migrate` run by hand against the Postgres service's `DATABASE_PUBLIC_URL`.
  Either ship the migrator in the image and set a preDeploy command, or accept the manual step
  and keep it documented.

- [confirmed] 2026-08-23 The objective's literal typecheck gate `pnpm -C web tsc --noEmit`
  does not run on the installed pnpm (10.26.2): it exits 254 with
  `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "web" not found`, because `tsc` is not a
  script in `web/package.json`. The working form is `pnpm -C web exec tsc --noEmit`
  (exit 0). Item 9.1 has to paste every gate command, so it needs the `exec` form or a
  `typecheck` script in `web/package.json`.

- [confirmed] 2026-08-23 The app has no theme switch: `web/src/app/layout.tsx:28` hardcodes
  `<html lang="en" className="dark">` and no `ThemeProvider` is mounted anywhere
  (`next-themes` is imported only by `web/src/components/ui/sonner.tsx`, whose `useTheme()`
  therefore always reads the default). Removing the class by hand shows the light token set
  renders legibly, so the tokens are there and only the provider and a control are missing.
  Ledger item 8.10 ("dark mode correct on every screen touched") cannot be demonstrated as a
  user-reachable state until this is decided: either mount the provider or record that the
  product is dark-only.

- [investigate] 2026-08-23 `pnpm -C web dev` serves the repo's own `media/` directory, but the
  item 7.6 end-to-end run executed in the compose stack and wrote its five generated images to
  the compose `media` volume. So the post detail page for that run shows four broken images
  and four console 404s under a local dev server. Harmless for that post, but it means the
  compose volume and the repo directory are two different stores of the same namespace, and
  a run started in one is only fully viewable in the other's absence. Related to the already
  recorded Railway gap where `web` and `worker` cannot share `/media` at all.

- [investigate] 2026-08-23 `GET /api/posts` answers `500` with an empty body when its database
  is unreachable (verified by stopping the compose `db` container under a live page:
  `{"status":500,"body":""}`), so the client has nothing of the server's own to show and the
  new error state on `/` falls back to its own wording. Every ported handler returns
  `{"detail": "..."}` for the failures it anticipates; an unanticipated throw appears to reach
  Next's default 500 instead. Worth deciding whether the route handlers need a shared catch
  that answers `{"detail": ...}` for unexpected errors too, since Phase 8's error states are
  only as informative as the bodies they get.

- [confirmed] 2026-08-23 `/posts/[id]` names two of the six stages twice: the tab strip in
  `web/src/app/posts/[id]/page.tsx` labels them "Draft" and "Editing" while the pipeline
  progress bar and the run trace both say "Write" and "Edit", so one screen shows two names
  for one step. Not renamed under item 8.3 because `web/e2e/post-editor.test.ts:106` asserts
  `getByRole("tab", { name: "Draft" })` and the rename would need that suite updated with it.

- [confirmed] 2026-08-23 The `posts.stage_logs` column is write-only dead weight in the ported
  stack: the only key anything writes is `_error` (`web/src/mastra/post-state.ts`), the
  execution numbers all go to `execution_logs`, and the last UI that read it (the "Cost
  Tracking" card) was removed by ledger item 8.3. `GET /api/posts/{id}` still serves it and
  `PostUpdate` still accepts it, so dropping the column is a schema change to weigh after the
  port, not during it.

- [confirmed] 2026-08-23 `web/e2e/navigation.test.ts:56` asserts a "Pipeline Settings" card on
  `/posts/new` and no such card exists in `web/src/app/posts/new/page.tsx` (the page's cards
  are Website Profile, Content, Writing Config, SEO & Research and a conditional WordPress
  Publishing). Found while working item 8.5; it is one instance of the broadly failing e2e
  drift item 9.1 has to settle, recorded here so that pass knows the assertion is stale rather
  than the page being wrong.

- [confirmed] 2026-08-23 `POST /api/profiles` accepts any string as `website_url`: creating a
  profile with the literal value `not a url` succeeded during item 8.6's live checks. This is
  a faithful port (`web/src/app/api/profiles/validation.ts` uses `z.string()` where Pydantic
  used `str`), so it is a product gap rather than a port defect, but the sitemap crawl and the
  internal-link resolver both assume the field parses as a URL. Tightening it changes an API
  contract the dashboard and `packages/create-mdx-blog` both sit on, so it is a decision to
  take deliberately after the port rather than inside it.

- [confirmed] 2026-08-23 `ImagePreview` shows a failed image as a bare `Failed` badge and
  nothing else. `generateOneImage` records the reason on the entry as `error`, and the
  component never reads it, so the user sees that an image failed but not why, and has no way
  to retry it. Belongs to polish ledger item P1.2.

- [confirmed] 2026-08-23 `ImagePreview` renders `placement.location` as the raw enum the model
  writes, so a featured image's placement reads `featured_image` in the UI. Belongs to polish
  ledger item P3.3.

- [investigate] 2026-08-23 `src/mastra/crossprocess-events.test.ts:109` calls
  `mastra.startWorkers()` on the *production* Mastra instance and so joins the
  `mastra-orchestration` consumer group on the default `mastra:topic:workflows`. Since
  polish P0.2 isolated `scaffold-check.test.ts`, this is the only file in the suite still
  there, which makes it the remaining party exposed to having its step events claimed by a
  stray worker or a `mastra dev`. It passed 3/3 with a real worker up, so it is exposure
  rather than a reproduced failure; recorded because P0.3 has to certify the whole suite with
  a worker running and this is where to look first if it does not.
  Update 2026-08-23 (polish P0.3e): it did not fail in any of the three full worker-up runs
  that certified the suite, so it stays exposure rather than an observed failure. It is still
  the only file in the suite on the default prefix.

- [confirmed] 2026-08-23 The global `stage_models` row is borrowed the way `api_keys` used to
  be: `src/mastra/stage-models.test.ts`, `src/app/api/settings/stage-models/route.test.ts` and
  `src/app/settings/stage-models-to-provider.test.tsx` each hold the pre-borrow value in a
  module-level variable and write it back in `afterAll`, so a killed run loses it and the next
  run adopts whatever the dead one left. Polish item P0.3a fixed this shape for `api_keys` by
  moving the snapshot into a backup row (`web/src/test/borrowed-rows.ts`), and this row can
  move to the same helper. Lower stakes than `api_keys`, since it holds model ids rather than
  credentials, which is why it was not done inline: `stage-models.test.ts` also restores the
  row's `updated_at`, which the shared helper does not carry yet.

- [confirmed] 2026-08-23 The test suite leaves unconsumed `pipeline` events on the default
  `mastra-orchestration` topic. Starting the worker bundle after three full `pnpm test` runs
  drained a backlog of 27 `Error executing step research: Error: post <id> not found` lines
  before it went quiet: the suite published `workflow.start` events for posts it then deleted
  and nothing consumed them. Nothing fails over it, because the tests that publish do not await
  execution, but the topic never reaches zero and the next process to join the group pays for it
  with a burst of error-shaped stderr against rows that are gone. Found during polish item P0.3e.
