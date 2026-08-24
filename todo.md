# todo

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
- [confirmed] 2026-08-23 The TypeScript port of mistune's `linebreak` and `softbreak`
  inline patterns in `web/src/mastra/wordpress/wp-html.ts` still spells Python's `\s` as
  JavaScript's `\s`. The two sets differ: Python's holds `\x1c`-`\x1f` and `\x85` and not
  `﻿`, JavaScript's is the other way round, so a paragraph whose line ends in one of
  those characters folds differently from the Python original. Found while porting ledger
  item 5.3c-iii-b-1-b-iii-c, which fixed the same mistake in the `emphasis` pattern; the
  file already has `PY_SPACE` for exactly this, so the fix is a two-line swap plus corpus
  cases, but `linebreak` and `softbreak` are outside that item's scope.
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
- [confirmed] 2026-08-24 `both` is the `output_format` column default on both
  `website_profiles` and `posts` (`web/src/db/schema.ts:81` and `:138`) but is not one of
  the three options `OUTPUT_FORMATS` in `web/src/lib/publishing.ts` offers, so a row that
  took the column default renders the Output Format trigger with no label at all, and
  saving the form silently rewrites the value to whatever the user then picks. It is the
  same `both` the publish endpoint refuses with `Publishing not supported for output_format
  'both'` (see the 2026-08-23 entry above). No row currently holds it, because every writer
  in the app sends an explicit value; a row inserted by anything else would. Decide whether
  `both` is a real format or a default that should never have been `both`, then make the
  column and the picker agree. Found while doing ledger item P1.3d-ii, which is where the
  picker's three options moved to.
- [confirmed] 2026-08-23 Perplexity's Sonar Chat Completions endpoint is deprecated with
  support ending 2026-09-27, per `docs.perplexity.ai/getting-started/models`. The
  `research` stage reaches `sonar-pro` through Mastra's model router, which uses the
  OpenAI-compatible `/chat/completions` shape, so research calls stop working after that
  date unless the stage moves to Perplexity's Agent API. Found while verifying model IDs
  for ledger item 6.1; out of scope there, but it has a hard deadline.
- [investigate] 2026-08-23 `next build` inside the web image prints seven
  `[Error [BetterAuthError]: You are using the default secret...]` lines plus a matching
  BetterAuth base-URL warning per route during page-data collection. Non-fatal (the build
  exits 0) and pre-existing, but it is error-shaped output in a green build, which is exactly
  the noise the gate rules forbid introducing. Worth deciding whether the build stage should
  supply throwaway `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL` placeholders the way it now does for
  `DATABASE_URL_SYNC` and `REDIS_URL`, or whether `src/lib/auth.ts` should not be reachable
  from page-data collection at all.

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
  the compose `media` volume. So the post detail page for that run shows four images the dev
  server cannot serve and four console 404s. Since polish item P1.2b those read as "the image
  file is missing from the server" rather than as broken glyphs, and since polish item
  P1.2c-ii a run started after the `post_media` mirror exists is viewable from either, because
  neither disk is what the handler falls back to. Still open only for the images generated
  before the mirror: those bytes exist on one disk and in no shared store, so re-running the
  images stage is the only thing that makes them viewable from the other.

- [confirmed] 2026-08-23 The `posts.stage_logs` column is write-only dead weight in the ported
  stack: the only key anything writes is `_error` (`web/src/mastra/post-state.ts`), the
  execution numbers all go to `execution_logs`, and the last UI that read it (the "Cost
  Tracking" card) was removed by ledger item 8.3. `GET /api/posts/{id}` still serves it and
  `PostUpdate` still accepts it, so dropping the column is a schema change to weigh after the
  port, not during it.

- [confirmed] 2026-08-24 `/posts/new` has no per-post pipeline configuration. `stage_settings`
  decides which of the six stages stops at a review gate, and the only editors for it are
  `/profiles/[id]` and `/posts/batch`; the single-post creation form never mentions it, so a
  post created there silently takes the profile's gates with no indication that it did. Found
  under polish ledger item P0.5a while removing `navigation.test.ts`'s stale assertion for a
  "Pipeline Settings" card, which had been describing this hole rather than a renamed card.
  Belongs to polish ledger item P3.1.

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

- [confirmed] 2026-08-24 The route error boundaries print a raw JavaScript exception message as
  user-facing copy. `web/src/app/posts/[id]/error.tsx:24` and
  `web/src/app/profiles/[id]/error.tsx` render `{error.message}` verbatim under "Failed to load
  post" / "Failed to load profile", so a render-time `TypeError` reaches the screen as written by
  V8. Seen while measuring polish ledger P0.5b: the two screens showed "input.entries is not
  iterable" and "Cannot read properties of undefined (reading 'length')". Two things behind it,
  both worth fixing: the boundary needs copy of its own with the raw message kept for the console,
  and `buildRunTrace()` (`web/src/lib/run-trace.ts:176`) throws on a post payload with no
  `execution_logs` instead of treating it as empty, which takes the whole post page down rather
  than the one panel that needs the column. The live API always sends the field, so the trigger
  today is a client-side shape mismatch, not a server response. Belongs to P3.3 ("no stack traces,
  no `undefined` in the UI").

- [confirmed] 2026-08-24 A post created with no profile is unreachable and undeletable through
  the app. `/posts/new` offers "No profile (manual config)"
  (`web/src/components/profile-select-card.tsx:110`) and `POST /api/posts` accepts a body with
  no `profile_id` (`web/src/app/api/posts/route.ts:101`, deliberately, as Python did), but every
  read handler joins `posts` to `website_profiles` to reach `user_id`, and the join is inner. The
  form then redirects to the row it just created and the page reads "Could not load this post /
  Post not found". Measured against the running dev server: create -> `201` with
  `profile_id: null`, `GET /api/posts/{id}` -> `404 {"detail":"Post not found"}`,
  `DELETE /api/posts/{id}` -> `404`, and the row is absent from `GET /api/posts`. So the UI can
  produce an orphan row that only SQL can remove. Two candidate fixes, and the choice is a
  product decision: require a profile on the form, or make `profile_id` nullable in the read
  path. Found while repairing `full-pipeline.test.ts` for polish ledger P0.5c.

- [confirmed] 2026-08-24 There is no surface that lists the posts waiting at a review gate.
  `full-pipeline.test.ts` asserted on a `/queue` page with a "Review Queue" heading;
  `git log --all -- 'web/src/app/queue*'` is empty, so that page never existed in this
  repository and the test was written against something that was only ever planned. The queue
  API is real (`/api/queue`, `/api/queue/dead-letter`, `/api/queue/worker-status`) and
  `/monitor` shows the four aggregate counters, but a post suspended at a gate is discoverable
  only by opening its own detail page, which means an operator has to already know which post is
  blocked. Belongs to P3.2 ("what a review gate is waiting for"). Found at polish ledger P0.5c.

- [confirmed] 2026-08-24 A fresh deploy can lose a service to the same `@mastra/pg` first-init
  race the test suite hit at polish ledger P0.6a. `web` and `worker` both import
  `web/src/mastra/index.ts`, both start Mastra, and the adapter builds its own `mastra_*` schema
  on first init with DDL that is not concurrency-safe: two stores initialising at the same
  moment against a database that has no `mastra_*` tables issue the same `CREATE INDEX` and the
  loser dies with `duplicate key value violates unique constraint "pg_class_relname_nsp_index"`
  (measured: four concurrent `PostgresStore.init()` calls against a virgin database, three
  reject). Railway starts both services together, so a first deploy against an empty database is
  a coin toss. The suite's fix is `ensureMastraStorage()` in `src/test/global-setup.ts`; the
  deploy equivalent is a pre-deploy step that runs it once, which is the same hook P2.77 needs
  for `pnpm db:migrate`. Fix the two together.

- [investigate] 2026-08-24 `pnpm auth:migrate --apply` against a fresh database reports
  `tables to create: auth_users, auth_sessions, auth_accounts, auth_verifications` and no
  `subscription`, but `web/src/lib/auth.ts:77` mounts the `@better-auth/stripe` plugin and both
  `drizzle/README.md` and `src/db/schema-parity.ts` name `subscription` as a BetterAuth-owned
  table. Either the plugin only creates it when configured with real Stripe credentials, or a
  fresh database is missing a table the billing path will query at runtime. Reproduce by hitting
  whatever reads a subscription on a database built by the documented procedure. Found at polish
  ledger P0.6a.

- [confirmed] 2026-08-24 Next 16 deprecates the `middleware` file convention and every dev
  server boot says so: `⚠ The "middleware" file convention is deprecated. Please use "proxy"
  instead. Learn more: https://nextjs.org/docs/messages/middleware-to-proxy`. `web/src/middleware.ts`
  is the only thing standing between an anonymous request and every page (P0.5a), so this is not
  a warning to sit on until it becomes an error: the rename has to be done deliberately, with the
  e2e suite's signed-out redirect test as the guard. Found at polish ledger P0.6b-i.

- [confirmed] 2026-08-24 Signing up logs a Stripe failure on every account when
  `STRIPE_SECRET_KEY` is unset: `WARN [Better Auth]: Stripe customers.search failed, falling back
  to customers.list` then `ERROR [Better Auth]: Failed to create or link Stripe customer: Invalid
  API Key provided: sk_test_********_key`. The sign-up still succeeds, so this is noise rather
  than a broken path, but it is an ERROR line on the happy path of the first thing a user ever
  does, and it means the mock key in `web/src/lib/auth.ts` is reaching Stripe's API rather than
  short-circuiting. Either skip customer creation when the key is the mock, or make the failure a
  debug line. Found at polish ledger P0.6b-i, in the CI dry run's e2e log.

- [investigate] 2026-08-24 CI skips 10 tests where a local run skips 7. The three extra are the
  suites gated on a provider key (`ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, `GEMINI_API_KEY`),
  which `.github/workflows/ci.yml` generates no value for, so the real Perplexity, Anthropic and
  Gemini call paths are the one part of the suite CI cannot certify. Worth deciding deliberately:
  either accept it and say so in `docs/polish/SUMMARY.md`, or give CI repository secrets and let
  the three run on `push` to the default branch only. Found at polish ledger P0.6b-ii, comparing
  the green run's summary (`4661 passed | 10 skipped`) with the local one (`4664 passed |
  7 skipped`).

- [confirmed] 2026-08-24 The PWA has no maskable icon. `web/src/app/manifest.json` declared both
  of its icons `"purpose": "maskable"` while the art carries a transparent margin, which is the
  opposite of the contract: a maskable icon is full bleed with everything important inside the
  centre 80%, and Android crops it to whatever shape the launcher uses. The declaration is now
  `"any"`, which is truthful, but the consequence is that an installed app gets the platform's
  own white badge behind the mark rather than the mark filling the tile. Fixing it means a second
  full-bleed render of `web/public/icon.svg` at 192 and 512 with the page extended to the edges,
  listed alongside the `any` entries. Found at polish ledger P1.1.

- [investigate] 2026-08-24 `web/public/` still carries five unreferenced Next.js starter assets:
  `next.svg`, `vercel.svg`, `file.svg`, `globe.svg`, `window.svg`. Nothing under `web/src` names
  any of them (grepped across `.ts`, `.tsx`, `.json`, `.md`, `.mjs`), so they are served as public
  routes and shipped in the Docker image for no reason. Confirm nothing outside the repo links
  them before deleting. Found at polish ledger P1.1.

- [confirmed] 2026-08-24 A full run stamps `current_stage = "complete"` and `completed_at` even
  when a stage inside it failed. `markPipelineComplete()` (`web/src/mastra/post-state.ts:275`) is
  unconditional by design, ported that way so a run that finished has a finish time, and the
  `images` stage is the one stage that can finish without succeeding: it writes
  `stage_status.images = "failed"` and returns rather than raising, so the run carries on to
  `ready` and ends. After polish ledger P1.2a that branch is reachable for an all-failed image
  stage as well as for an unparseable manifest, so the posts list and `PostsList`'s status
  filter now call such a post finished while its stage badge says failed. Decide which of the two
  the list should read; a post with no pictures is not finished in any sense a user means. Found
  at polish ledger P1.2a.
- [confirmed] 2026-08-24 `wp_url` accepts a URL carrying credentials
  (`https://user:pass@example.com`). `checkWpUrl` in `web/src/app/api/profiles/validation.ts`
  refuses a query string, a fragment and surrounding whitespace because those break the REST
  path concatenation, but userinfo passes through `fetch` unharmed, so it is not that defect.
  It does mean a password can land in `website_profiles.wp_url`, which is stored in plain
  text while `wp_app_password` is Fernet-encrypted. Found at polish ledger item P1.3b.

- [confirmed] 2026-08-24 The run trace does not render publish events. `RunTrace`
  (`web/src/components/run-trace.tsx`) builds its table from the six pipeline stages and reads
  `execution_logs` entries by `stage`, and both publish steps write their entries with
  `stage: ""`, so `publish_start`, `publish_complete` and `publish_error` are invisible there.
  A publish is the last thing a run does and the thing most likely to fail on something
  outside this app, and the view built for watching a run says nothing about it. The post
  header now carries a failure panel (polish ledger P1.3d-iii), so the reason is reachable;
  this is about the trace being the complete account it presents itself as. Found at polish
  ledger P1.3d-iii.

- [confirmed] 2026-08-24 The Next standalone output copies the whole `web/src/` tree into the
  production image, test files included: `/app/src/mastra/**/*.test.ts` is present in the
  `runner` and `railway` images. Two costs. It ships test code and fixtures (including the
  parity corpora, which are large) to production, and it is what makes the readability corpus
  resolve there by accident rather than by declaration, which item P2.7 pinned down instead of
  relying on. Worth narrowing once there is a build gate that would catch the regression.


- [confirmed] 2026-08-24 A run parked at a review gate can never be resumed: nothing in the app
  calls `run.resume()`. `stage-io.ts` suspends the run and writes `stage_status[stage] =
  "review"`, and the only way forward the UI offers is `POST /api/posts/{id}/run` or
  `/run-all`, which start a *new* run. So the suspended run stays suspended in
  `mastra_workflow_snapshot` forever while a second run redoes the chain from the stage the
  first one had already reached, and the trace view shows a run stuck at "Awaiting review"
  beside the one that actually finished. The port's own comment on `reviewGate` says the point
  of suspending rather than returning is that "approving it continues into the remaining stages
  instead of starting a second run"; nothing exercises that outside `review-gates.test.ts`. A
  gate approval route has to poll `getWorkflowRunById` rather than await the resume, for the
  reason `evented-resume.test.ts` pins. Found at polish ledger P2.16.

- [confirmed] 2026-08-24 Five of the seven workflow registration keys in
  `web/src/mastra/index.ts` differ from the workflow's own `id`, and a resume resolves by id.
  `EventedExecutionEngine.resolveWorkflow` calls `Mastra.getWorkflow(workflowId)`, and
  `getWorkflow` looks its argument up by registration *key*, so `scaffoldCheck` /
  `sitemapCrawl` / `recrawlCheck` / `wordpressPublish` / `nextjsPublish` would answer
  `MASTRA_GET_WORKFLOW_BY_ID_NOT_FOUND` on any resume of `scaffold-check`, `sitemap-crawl`,
  `recrawl-check`, `wordpress-publish` or `nextjs-publish`. Latent today: none of those five
  suspends, and the two that can (`pipeline`, `images`) are the two whose key matches. The
  failure mode is a workflow that starts, runs and then 404s the moment a step in it suspends,
  which is the least obvious time to find out. Reproduced under polish ledger P2.16, where the
  probe was registered under a camelCase key and its `start()` succeeded while its `resume()`
  threw. Renaming the keys also renames what Mastra Studio lists and what the
  `mastra.getWorkflow(...)` call sites pass, so it is a small change with a wide surface. The
  same constraint is already known for *nested* workflows and honoured there
  (`nested-retry.test.ts` keys its five registrations by id, and `images`, the one nested
  workflow the app registers, matches); the resume path is the second place it bites.
