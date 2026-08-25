# todo

- [optimization] 2026-08-24 Mastra's engine logs step failures to a logger the app cannot
  configure, so in the `worker` service a step failure prints `Error executing step <id>:
  <stack>` as plain text on stderr instead of as a line in the configured `PinoLogger`'s JSON
  stream, and `logger.trackException` for it is a no-op. The failure itself is not lost:
  `recordRunFailure` writes `_error` onto the post and announces `stage_error`, which is what
  the dashboard and the dead-letter queue read, so this is log format and not correctness.
  Mechanism, with the two construction sites that never call `__registerMastra`, is documented
  at `web/src/test/engine-step-errors.ts`, which is also how a suite asserts on an expected
  step failure. Demoted from `[confirmed]` at P2.35 and folded into P2.91 there, on the
  assumption that P2.91 would end with a worker entry this repo owns and could install a
  console bridge from. It did not: P2.91a and P2.91b are both a `RedisStreamsPubSub` subclass
  and the generated entry is untouched, so this needs a seam of its own or a `mastra` release
  that registers the processor's logger.

- [investigate] 2026-08-24 One full `pnpm test` run in four reported
  `1 failed | 5262 passed` in `src/app/api/posts/create.test.ts`, about thirty seconds after the
  compose `redis` container was restarted from an `Exited (137)` OOM kill. The file passes on
  its own and three full runs either side are identical at `5263 passed | 9 skipped`, so this is
  either a real cold-Redis race in that file or a residue of the killed run before it. The
  failure text was lost to a truncated capture; the file was identified from the two source
  lines the reporter printed. Reproduce by restarting `redis` and immediately running the full
  suite. Found at polish ledger P2.77b-ii.

- [confirmed] 2026-08-24 The pre-deploy migration hook has never been watched running on
  Railway. Polish ledger P2.77b-ii wired it: `preDeployCommand` on both services in
  `.railway/railway.ts` runs `node scripts/predeploy.mjs`, a bundle `pnpm build` writes into
  the Next standalone output, which applies the `drizzle/` migrations, the BetterAuth tables
  and the `mastra_*` run-state tables under one advisory lock.
  `web/src/db/predeploy.test.ts` runs that bundle against a real database from a directory
  with no `node_modules`, and `pnpm standalone:check` proves the image carries it, but this
  project has no deployed Railway environment, so nobody has seen Railway execute the hook or
  abort a deployment on its exit code.

- [confirmed] 2026-08-25 `web/src/mastra/scripts/full-pipeline.mjs` inserts its post with no
  `profile_id`, by fixed id, and leaves the row behind, which makes it the last writer of
  posts nobody can reach (polish ledger P4.7 closed the two route writers). It is a developer
  evidence script rather than a route, and it makes real paid provider calls, so it was not
  changed while it could not be run; `pnpm posts:orphans --delete` cleans up after it.
  Found under P4.7.

- [confirmed] 2026-08-25 There is no "delete this profile and its posts" path anywhere, and
  no post count on a profile before the Delete press. Since P4.7 a profile with posts answers
  409 and names the count, so an account with fifty posts on one profile has to clear them
  from `/` first, twenty at a time. Filed as the cost of that refusal, not as a regression.
  Found under P4.7.

- [confirmed] 2026-08-25 Deleting a profile with no posts is still one unconfirmed click in
  the `/profiles` row menu, and it is irreversible. P4.7 blocked only the case that destroys
  posts. `AlertDialog` is already used for the two delete confirmations on `/` (polish ledger
  P4.8). Found under P4.7.

- [investigate] 2026-08-24 A credentialed `website_url` is still matched by the profiles
  list search, which reads `profile.website_url` while the row renders the stripped value
  (ledger P2.117). Typing the password finds the profile, which is a thin oracle for a value
  the screen no longer shows. Small, and the row is one press from being cleaned, so it is
  filed rather than chased. Found under P2.117.

- [investigate] 2026-08-25 The `Running <Stage>...` empty state and the read-only editor on
  the stage tabs of `/posts/[id]` look unreachable: the tab trigger is `disabled` for a stage
  with no content, and a stage that is running has produced none yet, so nothing can select
  the tab that would show either. Found while closing polish ledger P5.1, where a test
  written against that copy could not reach it. If it is dead, delete both branches; if
  `activeTab` can land there another way, say how.

- [investigate] 2026-08-25 `GET /api/analytics/dashboard` and `GET /api/queue` read
  `stage_status` server side without `resolveStageStatus()` (polish ledger P5.1), so they are
  the two remaining readers of the raw column. Neither is wrong today, because the dashboard
  already counts a `failed` row's unfinished stage as incomplete and the queue counts by run
  state, but a third rule added to either would have to be added twice. Found under P5.1.

- [investigate] 2026-08-24 A run parked at a gate that is cancelled rather than approved
  leaves an open `stage_review` entry with no `stage_start` behind it. P4.5 makes the release
  the `stage_start`, so an abandoned gate correctly reports no wait, but nothing anywhere
  says the gate was abandoned rather than still waiting. Check what `run.cancel()` leaves on
  the row and whether the trace should name it. Found under P4.5.

- [investigate] 2026-08-24 One `pnpm test` run in five failed one test, twelve seconds after
  a live Mastra worker and a Next dev server that had been executing a real run against the
  same Redis and database were killed. Four runs on the same commit with nothing running
  beside them are clean, and the failing file's name was lost to a `tail -6`. P0.3 proved
  determinism with a worker up and with one never started; the untested third case is a
  worker that has just gone away, whose `mastra-orchestration` consumer group may still hold
  pending entries. Reproduce by starting a worker, running a real pipeline run, killing it,
  and running the suite immediately, capturing the full output. Found under P4.5.

- [investigate] 2026-08-24 The logs tab on `/monitor` renders `entry.event` raw, so the
  `stage_review` entries P4.5 added read as the literal string `stage_review`, as do
  `pipeline_start`, `publish_error` and the rest. Polish ledger P3.3 owns raw enum values in
  the UI; this is one table's worth of them, and a label map beside `STAGE_STATUS_LABELS`
  would cover it. Found under P4.5.

- [confirmed] 2026-08-24 `@mastra/core@1.61.0` signals a failed `EventedExecutionEngine.execute()`
  twice. Its `catch` calls `rejectResult(err)` and then `throw err`, and the `await
  resultPromise` that would have handled that rejection is on the line after the throw
  (`dist/agent-DSxJoGjY.js:7087`). A caller that catches the error from `run.resume()`, which
  is the only thing a caller can do, still leaves one rejected promise with no handler: Node
  emits `unhandledRejection` and vitest exits 1 with every assertion green. Upstream, so this
  is a note rather than a fix; `workflows/registration-key.test.ts` works around it by
  collecting the process's unhandled rejections around the resume and asserting on them. Any
  gate approval route built for P2.109 has to survive the same double signal. Found under
  polish ledger P2.110.

- [investigate] 2026-08-25 `PATCH /api/posts/{id}` still releases nothing. Polish ledger
  P5.3 made `/posts/[id]` clear a gate and then call `POST /api/posts/{id}/approve` when the
  gate cleared is the one holding a parked run, which covers the only editor of an existing
  post's gates today. A caller that is not that page (a script, a future batch editor) still
  saves the setting and leaves the run parked with no message. Decide whether the rule belongs
  in the route, which would mean the mastra singleton in the generic post PATCH module graph
  and three route test files that currently avoid it.

- [investigate] 2026-08-25 The gate release on `/posts/[id]` is two requests, so it can half
  succeed: the gate saved, the release refused or dropped. The message says so and points at
  the approval banner's own button, but nothing reconciles it later. Found under P5.3.

- [confirmed] 2026-08-25 The gates card on `/posts/[id]` offers no way back to the profile's
  gates and no link to the profile. `/posts/new` has both, because it holds the profile it
  prefilled from; the post page never fetches one (it has `profile_id` and nothing else), so
  a reader who wants the profile's gates back on a post has to set six selects by hand.
  Found under P4.6.

- [confirmed] 2026-08-25 A run paused after its last stage can only be finished from
  `/posts/[id]`. `isPausedBeforeFinish()` gives the posts list and `/monitor` the right badge
  (both call `deriveRunState()`), but neither carries the `Finish this run` button, so a
  reader who spots one on a list has to open the post. Same reader gap polish ledger P4.9
  names for a stalled publish. Found while closing P4.4b.

- [confirmed] 2026-08-24 The posts list at `/` holds no event feed open, so a pause or a
  stage that finished elsewhere is invisible on it until the reader navigates or reloads.
  `run_paused` (P4.4a) is a derivation the list would use; the list subscribes to nothing at
  all. A stalled publish is the exception since polish ledger P4.9a, and only because it is
  the one state with no event behind it, so the fix there was a clock rather than a
  subscription. Found while closing P4.4a.

- [investigate] 2026-08-24 A retry of a WordPress publish that died mid-flight can create a
  second post on the site. `wp_post_id` is written only after `createPost` returns, so an
  attempt killed between the request and that write leaves the row with no id and the next
  attempt takes the `createPost` branch again. The same is true of a step re-delivered by
  `XAUTOCLAIM` rather than by a person. Unverified against a real site: nothing in this repo
  has ever published to one. Found while closing polish ledger P4.3.

- [investigate] 2026-08-25 The `failed` half of `deadPublishes()`
  (`web/src/lib/publish-queries.ts`) has no surface of its own on `/monitor`. The completion
  rate now says `N more finished but never published`, and the card above it names only the
  stalled ones, so a publish the step recorded as `failed` is a number with no way to reach
  the posts behind it except the posts list. Decide whether the card should cover both.
  Found while closing polish ledger P5.2.

- [investigate] 2026-08-25 `avg_duration_s` on `GET /api/analytics/dashboard` averages
  `completed_at - created_at` over every row that has a `completed_at`, including the ones
  P5.2 moved out of `complete` and into `publish_incomplete`. That average is about the run,
  which is defensible, but it is a third rule on one screen and the card says nothing about
  which rows it covers. Found while closing P5.2.

- [investigate] 2026-08-25 The stalled-publish card on `/monitor` renders one row per dead
  publish with no cap, so an account that lost a worker for a day gets an unbounded list at
  the top of the tab. No account here has ever had more than two. Found while closing P4.9b.

- [investigate] 2026-08-25 The posts list marks a stalled publish only on the rows it is
  currently holding, because the 30 second tick added at polish ledger P4.9a is gated on
  `publishInFlight` over `postList`. A stalled publish filtered out of the current view is
  invisible until the filter changes. The list has no pagination today, so nothing is
  currently hidden by this; it becomes a defect the day one is added. Found while closing
  P4.9a.

- [investigate] 2026-08-25 `PublishStallBadge` carries the reason as a `title`, which a
  touch device never shows, so on a phone the posts list says `Publish stalled` and nothing
  else. The post page behind the row has the full banner. Worth checking whether any of this
  app is used on a phone before spending an iteration on a popover. Found while closing
  P4.9a.

- [investigate] 2026-08-24 The run trace does not update during a publish. `use-sse.ts`
  refetches the post on `stage_complete`, `stage_error` and `pipeline_complete`;
  `posts/[id]/page.tsx` handles `publish_start`, `publish_complete` and `publish_error` itself,
  writing the status column optimistically and raising a toast, and does not refetch. So the
  publish row added at polish ledger P3.2b-ii shows its status live and its timing only on the
  next load or the next refetch from another cause. Check whether the optimistic write should
  simply be a refetch before adding a fourth refetch trigger. Found at polish ledger P3.2b-ii.


- [investigate] 2026-08-24 Nothing stops the next nullable field from being interpolated into a
  user-visible sentence. The P3.3c-i sweep found the string `undefined` unreachable in the UI
  today, but only by reading ~140 template literals by hand.
  `@typescript-eslint/restrict-template-expressions` is the rule that would enforce it and it
  needs type-aware linting, which `web/eslint.config.mjs` does not turn on (it composes
  `eslint-config-next` only). Measure the cost of type-aware linting on this repo before
  deciding. Found at polish ledger P3.3c-i.

- [investigate] 2026-08-24 `POST /api/posts/{id}/restart` clears `stage_logs`, which is where
  the per-stage model, token and cost record lives, so starting a post over erases what its
  earlier attempts cost. That is Python's behaviour and the new `Start Over` confirmation now
  says so plainly, but the analytics endpoints read that column, so a restarted post
  disappears from cost reporting entirely rather than showing two runs. Check whether the
  column should be appended to instead. Found at polish ledger P3.3c-ii.

- [investigate] 2026-08-24 A superseded list request is dropped, not cancelled. Polish ledger
  P3.4a added `useLatestRequest` so a stale answer cannot overwrite fresher rows, but the
  request itself still runs to completion server side: the search a typist has already moved
  past still costs a query. `request()` in `web/src/lib/api.ts` takes no `signal`, so wiring an
  `AbortController` through it would fix the class in one place. Check whether the added
  complexity is worth it for the three lists that would use it. Found at polish ledger P3.4a.

- [confirmed] 2026-08-24 `web/src/app/monitor/QueueMonitor.test.tsx` prints 16 React
  `not wrapped in act(...)` warnings on every run. It passes, and no other suite in the repo
  emits them, so the state updates its assertions do not await are the ones landing outside
  `act`. Test-output noise, not a product defect, but it is the only source of it left in
  `pnpm test`. Found at polish ledger P3.4b.

- [investigate] 2026-08-24 Layout shift on `/settings` was measured and fixed at one viewport
  only. A loaded Stage Models row wraps its controls line onto two lines at a narrow viewport
  while the placeholder introduced at polish ledger P3.4b keeps its three bars on one, which
  would put the height gap back on a phone. Measure `/settings` CLS at 390x844 before deciding
  whether the placeholder needs the same wrap. Found at polish ledger P3.4b.

- [investigate] 2026-08-24 The "Posts by Stage" chart on `/monitor` and the Queue Controls
  strip below it both have a bar reading `Complete`, and on an account with a run that
  finished with a failed stage they disagree by design: the chart counts rows sitting on
  `current_stage = 'complete'` (4) and the strip counts runs `deriveRunState()` calls
  complete (3). Polish ledger P4.2 fixed the completion rate and put `3 of 15 runs finished
  cleanly` under it to reconcile them, and deliberately left the chart on the column, since
  making it a second copy of the run states would duplicate the strip. Check whether the
  chart's `Complete` bar should be relabelled to say it means the row reached the end.
  Found under P4.2.

- [investigate] 2026-08-24 `POST /api/posts/{id}/pause` still pauses whatever row the reader
  pressed it on, including one parked at a review gate and one that already died, and the
  same `deriveRunState()` precedence then reports both as Paused. Polish ledger P4.1 scoped
  the *bulk* pause away from those two states and deliberately left the per-post one alone,
  on the grounds that the reader chose that row. Check whether a per-post pause on a parked
  run should be refused, or should say what it is about to hide. Found under P4.1.

- [investigate 2026-08-24] The `/auth` prefix is written in two places that must agree:
  `src/middleware.ts`'s matcher excludes it, and `AppChrome` in
  `web/src/components/app-chrome.tsx` gates the app frame off it. `src/app/brand-mark.test.ts`
  pins the matcher; nothing pins the pair. If one moves, the other silently draws dead
  navigation on a signed-out page again. Found at polish ledger P3.5c.

- [investigate 2026-08-24] Only `sign-in` and `sign-up` of `better-auth-ui`'s `authViewPaths`
  have ever been opened in a browser in this run. `generateStaticParams` builds all of them,
  so `forgot-password`, `reset-password`, `sign-out` and the rest are live routes nobody has
  looked at. Found at polish ledger P3.5c.

- [confirmed] 2026-08-25 Ten icon-only `<Button size="icon">` elements carry no accessible
  name: `src/components/sidebar.tsx:114`, `src/app/settings/page.tsx:413`,
  `src/app/posts/new/page.tsx:243`, `src/app/posts/batch/page.tsx:256` and `:437`,
  `src/app/posts/[id]/page.tsx:707`, `src/app/profiles/[id]/page.tsx:794` and `:1608`,
  `src/app/monitor/_components/models-tab.tsx:120` and `costs-tab.tsx:190`. Filed for
  testability rather than for a11y: this is the third iteration running (P4.7's profiles row
  menu, P4.8's logs pager) where a test could not reach a control until it was named, so
  every one of these is a control no test can press. One sweep, one `aria-label` each.
  Found at polish ledger P4.8.

- [investigate] 2026-08-25 `pnpm db:migrate --baseline` (polish ledger P4.8) trusts the
  operator that the database it is adopting matches `web/drizzle/`. Nothing checks, so a
  database whose schema has drifted can be stamped and will then be reported up to date.
  `src/db/baseline-parity.test.ts` already contains the column, index and constraint
  comparison that would answer this; check whether it can be lifted into the script as a
  refusal (or a `--check`) without dragging the test harness into the runtime image.
  Found at polish ledger P4.8.

- [investigate] 2026-08-25 `scripts/predeploy.ts` has no answer for a production database in
  the pre-port state. It now reports the same sentence `pnpm db:migrate` prints and fails the
  deploy, which is deliberate (adopting a database is a claim only a person can make), but it
  means the first deploy against such a database fails and needs a human with `psql` reach.
  Check whether the hook should accept an explicit `MIGRATE_BASELINE=1` for that one deploy.
  Found at polish ledger P4.8.
