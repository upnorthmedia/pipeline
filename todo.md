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

- [confirmed] 2026-08-24 Nothing scans for or repairs `website_profiles` rows that already
  hold a credentialed `wp_url` or `website_url`. P2.107 refuses new ones and reports the
  stored ones on the three `/wordpress/*` endpoints, but a row can sit with a plaintext
  password in it indefinitely. Needs a decision: leave them, or a one-off migration that
  strips the userinfo and names the rows it touched. Everything that reads such a row now
  reports it instead of leaking it (`WordPressClient`'s constructor refuses one), so this is
  a data-hygiene item rather than a live leak.

- [confirmed] 2026-08-24 `stage_review` is a live frame only, never written to
  `execution_logs`. `reviewGate()` publishes it so the dashboard learns a run has parked
  without a reload (ledger P2.109b), but a reader who opens the post after the gate was
  released sees no trace that the run ever waited, and neither does the run trace, which is
  built from `execution_logs`. While the run is parked the only record is
  `stage_status[stage] = "review"` on the row. Every other announcement (`stage_start`,
  `stage_complete`, `stage_error`) writes an entry beside its frame. Found under P2.109b.

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

- [confirmed] 2026-08-25 `PATCH /api/posts/{id}` is the only write path that still cannot
  clear a post's gates on its own terms. `src/app/api/posts/[id]/route.ts` takes
  `stage_settings` as a nullable object with no prefill in front of it, so the value is kept
  as sent, but nothing in the UI edits a created post's gates: the picker added under polish
  ledger P2.114 is on `/posts/new` only, and `/posts/[id]` shows the run's gates without
  offering to change them. A post parked at a gate can be approved, and a post that should
  never have had one has to be recreated. Found under P2.114.

- [confirmed] 2026-08-24 A run that stops for a pause publishes no event, so a second tab
  watching the same post shows it running until the reader reloads. Pausing itself is a real
  control signal since polish ledger P2.115 (every stage step ends the run in front of itself,
  and `currentStageUnlessPaused()` in `web/src/mastra/post-state.ts` stops the finishing stage
  erasing the flag), and the tab that made the request refetches, but nothing goes onto the
  bus: `stage_review` got a frame under P2.109b and a pause did not. Also unsaid on screen: a
  pause during `ready` leaves all six stages complete with `current_stage = "paused"` and no
  `completed_at`, which reads as unfinished. Found while closing P2.115.

- [confirmed] 2026-08-24 A publish that dies with its worker is reported as still publishing,
  forever. `wp_publish_status` / `nextjs_publish_status` move to `publishing` before the step
  touches the destination and only the step itself writes them again, so a worker killed mid
  publish leaves the column there with nothing to reconcile it. The post header says
  `Publishing...` and, since polish ledger P3.2b-ii, the run trace shows a `Publish to
  <target>` row whose elapsed clock counts up from the `publish_start` entry indefinitely. It
  is the same shape as the stage case P2.91 fixed (a `SIGTERM` truncates the running step),
  except that no `XAUTOCLAIM` recovers it, because the publish workflows declare no
  `retryConfig` either. P2.91's drain narrows it the same way: a publish that finishes inside
  `WORKER_DRAIN_TIMEOUT_MS` now completes rather than being truncated, and one that does not is
  handed back to the group rather than parked. Found at polish ledger P3.2b-ii.

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

- [confirmed] 2026-08-24 `GET /api/analytics/dashboard` still counts the way
  `GET /api/queue` did before polish ledger P3.5b: `by_status` groups on `current_stage` and
  `completion_rate` is the share of rows whose column reads `complete`. On `/monitor` that
  puts `Completion Rate 26.7%` (4 of 15) directly above a Queue Controls strip calling three
  of those four Complete and the fourth Finished with errors, because
  `markPipelineComplete()` is unconditional. The completion rate is the number a user would
  quote, so it is the one most worth making agree. Found at polish ledger P3.5b.

- [confirmed] 2026-08-24 `POST /api/queue/pause-all` selects on `current_stage` being
  `["pending", *STAGES]`, which after polish ledger P3.5b is a set the counts beside the
  button no longer describe: Pause All pauses the rows the strip calls Not started and the
  row it calls Failed at Research, and pausing a dead run overwrites the only column that
  said it was dead. Scope the bulk pause to the run states it claims to act on. Distinct from
  the entry above about pausing being a label rather than a control signal. Found at polish
  ledger P3.5b.

- [investigate 2026-08-24] The `/auth` prefix is written in two places that must agree:
  `src/middleware.ts`'s matcher excludes it, and `AppChrome` in
  `web/src/components/app-chrome.tsx` gates the app frame off it. `src/app/brand-mark.test.ts`
  pins the matcher; nothing pins the pair. If one moves, the other silently draws dead
  navigation on a signed-out page again. Found at polish ledger P3.5c.

- [investigate 2026-08-24] Only `sign-in` and `sign-up` of `better-auth-ui`'s `authViewPaths`
  have ever been opened in a browser in this run. `generateStaticParams` builds all of them,
  so `forgot-password`, `reset-password`, `sign-out` and the rest are live routes nobody has
  looked at. Found at polish ledger P3.5c.
