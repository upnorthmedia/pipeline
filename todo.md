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

- [confirmed] 2026-08-24 The `posts` rows already written with `profile_id = NULL` are still
  unreachable and undeletable through the app, and always will be: ownership lives on
  `website_profiles.user_id` alone, so an orphan row has no owner to restore it to and only SQL
  can remove one. Polish ledger P2.97 closed the writers (`profile_id` is required on
  `postCreateSchema` and the picker offers no "none"), so no new orphan can be created, and the
  column stays nullable for the rows that predate it. Needs a decision on the existing rows:
  leave them, or a one-off cleanup that names them in a migration.

- [investigate] 2026-08-24 A credentialed `website_url` is still matched by the profiles
  list search, which reads `profile.website_url` while the row renders the stripped value
  (ledger P2.117). Typing the password finds the profile, which is a thin oracle for a value
  the screen no longer shows. Small, and the row is one press from being cleaned, so it is
  filed rather than chased. Found under P2.117.

- [confirmed] 2026-08-24 A stage that died into the dead-letter queue is still called
  `Running` by the run trace, with an elapsed clock that counts forever. Reproduced on
  `2ed65d71-e3b0-497c-bf13-303f87ad30dd`: three attempts failed on a missing Perplexity key,
  `recordRunFailure()` wrote `current_stage = 'failed'` and a `stage_error` entry, and
  `stage_status.research` was left on `running`. The page header reads `Failed` from
  `deriveRunState()` and the trace four inches below reads `Running` at `7m 7s`, because
  `buildRunTrace()` takes each row's status straight from `stage_status`. This is the
  stage-level twin of polish ledger P4.9. Either the failure recorder should stamp the stage
  it failed, or the trace should read a run-level failure over a stale `running`. Found under
  P4.5.

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

- [confirmed] 2026-08-25 Clearing the gate of the stage a run is already parked at does not
  release the run. The suspended workflow resumes only through
  `POST /api/posts/{id}/approve`, so after setting `outline` back to `auto` on a post parked
  at Outline, the gates card reads `This post will go from Research to Ready without
  stopping.` while the row is still `stage_status.outline = "review"` and the approval banner
  is still on screen. Two true statements that read as one contradiction. Found under P4.6.

- [confirmed] 2026-08-25 The gates card on `/posts/[id]` offers no way back to the profile's
  gates and no link to the profile. `/posts/new` has both, because it holds the profile it
  prefilled from; the post page never fetches one (it has `profile_id` and nothing else), so
  a reader who wants the profile's gates back on a post has to set six selects by hand.
  Found under P4.6.

- [confirmed] 2026-08-25 Two em dashes survive in shipped UI copy, which the repo's own
  convention forbids: `Ready — Live Preview` in `web/src/app/posts/[id]/page.tsx` and the `—`
  placeholder for a missing image version in `web/src/components/image-preview.tsx`. Both are
  one-character fixes and belong in a cleanup batch, not an iteration. Found while closing
  P4.4b.

- [confirmed] 2026-08-25 A run paused after its last stage can only be finished from
  `/posts/[id]`. `isPausedBeforeFinish()` gives the posts list and `/monitor` the right badge
  (both call `deriveRunState()`), but neither carries the `Finish this run` button, so a
  reader who spots one on a list has to open the post. Same reader gap polish ledger P4.9
  names for a stalled publish. Found while closing P4.4b.

- [confirmed] 2026-08-24 The posts list at `/` holds no event feed open, so a pause, a stall
  or a stage that finished elsewhere is invisible on it until the reader navigates or reloads.
  `run_paused` (P4.4a) and `publishStall()` (P4.3) are both derivations the list would use;
  the list subscribes to nothing at all. Same reader gap polish ledger P4.9 names for a
  stalled publish. Found while closing P4.4a.

- [investigate] 2026-08-24 A retry of a WordPress publish that died mid-flight can create a
  second post on the site. `wp_post_id` is written only after `createPost` returns, so an
  attempt killed between the request and that write leaves the row with no id and the next
  attempt takes the `createPost` branch again. The same is true of a step re-delivered by
  `XAUTOCLAIM` rather than by a person. Unverified against a real site: nothing in this repo
  has ever published to one. Found while closing polish ledger P4.3.

- [confirmed] 2026-08-24 A stalled publish is legible only on `/posts/[id]`. The posts list
  and `/monitor` show nothing about it, and the run trace's `Publish to <target>` row still
  counts its elapsed clock up indefinitely rather than saying the attempt went quiet. Polish
  ledger P4.3 added `publishStall()` in `src/lib/publish-report.ts`; those three readers do
  not call it. Found while closing P4.3.

- [investigate] 2026-08-24 The run trace does not update during a publish. `use-sse.ts`
  refetches the post on `stage_complete`, `stage_error` and `pipeline_complete`;
  `posts/[id]/page.tsx` handles `publish_start`, `publish_complete` and `publish_error` itself,
  writing the status column optimistically and raising a toast, and does not refetch. So the
  publish row added at polish ledger P3.2b-ii shows its status live and its timing only on the
  next load or the next refetch from another cause. Check whether the optimistic write should
  simply be a refetch before adding a fourth refetch trigger. Found at polish ledger P3.2b-ii.


- [confirmed] 2026-08-24 `WordPressTestResponse.site_name` is typed `string` in
  `web/src/lib/api.ts` but `GET /api/profiles/{id}/wordpress/test` returns `siteName(info)`,
  which is `unknown`: it forwards `record.name` verbatim from the WordPress root response
  without checking its type. A site whose root answers with a non-string `name` puts that value
  through `Connected to ${status.siteName}` on `/profiles/[id]`, which is `[object Object]` for
  an object. WordPress core answers a string, so this is a type lie rather than a live defect.
  Found at polish ledger P3.3c-i.

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

- [confirmed] 2026-08-24 The two delete confirmations on `/` (`web/src/app/page.tsx`, the
  single delete and the bulk delete) style their destructive action with
  `className="bg-destructive text-destructive-foreground hover:bg-destructive/90"`, which does
  nothing: `AlertDialogAction` renders a `Button` and passes the child's `className` to the
  inner `Radix Action`, so the button's own `variant="default"` classes win the cascade and
  the confirm button for "permanently delete the post and its generated images" renders in the
  ordinary primary colour. `AlertDialogAction` takes a `variant` prop; both sites should pass
  `variant="destructive"`. Found at polish ledger P3.3c-ii.

- [confirmed] 2026-08-24 The logs tab does not reset its page when a filter changes.
  `web/src/app/monitor/_components/logs-tab.tsx` holds `page` in state and only `handleSearch`
  (the form submit) and `resetFilters` set it back to 1, so a search typed while on page 3 asks
  for page 3 of a result set that may have one page and answers with an empty table over a
  filter that does match rows. Found at polish ledger P3.4a.

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

- [confirmed] 2026-08-24 `pnpm -C web db:migrate` cannot run against a dev database carried
  over from the Python stack. `drizzle.__drizzle_migrations` is empty on it, because Alembic
  built the schema, so `drizzle-kit migrate` starts at `0000_baseline` and dies on
  `relation "alembic_version" already exists`. Every migration after the baseline therefore
  has to be applied by hand locally, which is how `0003_output_format_default.sql` reached the
  dev database. Either backfill the ledger with the migrations the baseline represents, or
  document the hand-application in `web/drizzle/README.md`, which currently tells the reader
  to run `db:migrate`. Compounds the entry above about nothing running migrations on deploy.
  Found at polish ledger P3.5a.

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
