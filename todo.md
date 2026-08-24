# todo

- [confirmed] 2026-08-24 A worker redeploy parks any in-flight post for over fifteen minutes
  and then re-bills the stage. `Mastra.stopWorkers()` drains the reader, not the work:
  `RedisStreamsPubSub.#deliverMessage` never awaits the step callback, so unsubscribing and
  `process.exit(0)` truncate a running step exactly as a `SIGKILL` would. The step's
  `workflow.step.run` message is left pending in `mastra-orchestration`, neither acked nor
  nacked (proven in `web/src/mastra/workflows/sigterm-shutdown.test.ts`), so nothing is lost
  or duplicated, but recovery is the `XAUTOCLAIM` timer at `RECLAIM_IDLE_MS` (15 minutes)
  plus up to one 30s tick, and the reclaiming worker re-runs the stage from the beginning.
  The fix has to drain in-flight steps before exiting, which means owning the worker entry
  rather than using the one `mastra worker build` generates. Ledger item P2.91. Now also
  owns the console bridge the demoted engine-logger finding needed, whose mechanism is
  documented at `web/src/test/engine-step-errors.ts`.

- [confirmed] 2026-08-24 `MODEL_COSTS` prices `claude-opus-4-6` at 15.0 / 75.0 per million
  tokens, which is that model's launch price; Anthropic publishes 5.0 / 25.0 for it now.
  The row was pinned value for value from Python so historic `stage_logs` costs would agree
  with the `model_costs_reference` the same response ships, but item 6.1 put the model on
  the `outline`, `write`, `edit` and `ready` allowlists, so a stage a user configures for it
  today is priced 3x over in the run trace and in `GET /api/analytics/logs`. Found while
  fixing the entry above it, and left alone there because repricing a row also rewrites what
  pre-cutover runs are reported to have cost, which is a decision of its own. The two other
  Python rows are unaffected: `sonar-pro` and `gemini-3.1-flash-image-preview` still match
  their providers' published rates. Ledger item P2.93.

- [confirmed] 2026-08-24 The three non-pipeline workflows lost Python's job retry entirely:
  `sitemapCrawlWorkflow`, `recrawlCheckWorkflow` and `wordpressPublishWorkflow` declare no
  `retryConfig`, so each gets a single attempt where `WorkerSettings.max_tries =
  MAX_ATTEMPTS` gave all four entries of `functions = [run_pipeline_stage,
  crawl_profile_sitemap, publish_to_wordpress, publish_to_nextjs]` three. A WordPress
  publish that meets one 502 therefore fails for good. `nextjsPublishWorkflow` did get the
  policy. Found closing P2.39. Ledger item P2.94.

- [confirmed] 2026-08-24 The retry pause added by P2.39 covers the eight pipeline stage
  steps only, because it lives in `recordStageRetry()` and nothing else calls it.
  `nextjsPublishWorkflow` retries three times with no gap between them, where Python's
  `retry_delay = 10` was a `WorkerSettings` key and spaced every job function's retries
  equally. Ledger item P2.95.

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

- [confirmed] 2026-08-23 The objective's literal typecheck gate `pnpm -C web tsc --noEmit`
  does not run on the installed pnpm (10.26.2): it exits 254 with
  `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "web" not found`, because `tsc` is not a
  script in `web/package.json`. The working form is `pnpm -C web exec tsc --noEmit`
  (exit 0). Item 9.1 has to paste every gate command, so it needs the `exec` form or a
  `typecheck` script in `web/package.json`. Ledger item P2.79.

- [confirmed] 2026-08-23 The global `stage_models` row is borrowed the way `api_keys` used to
  be: `src/mastra/stage-models.test.ts`, `src/app/api/settings/stage-models/route.test.ts` and
  `src/app/settings/stage-models-to-provider.test.tsx` each hold the pre-borrow value in a
  module-level variable and write it back in `afterAll`, so a killed run loses it and the next
  run adopts whatever the dead one left. Polish item P0.3a fixed this shape for `api_keys` by
  moving the snapshot into a backup row (`web/src/test/borrowed-rows.ts`), and this row can
  move to the same helper. Lower stakes than `api_keys`, since it holds model ids rather than
  credentials, which is why it was not done inline: `stage-models.test.ts` also restores the
  row's `updated_at`, which the shared helper does not carry yet. Ledger item P2.89.

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
  path. Found while repairing `full-pipeline.test.ts` for polish ledger P0.5c. Ledger item
  P2.97.

- [investigate] 2026-08-24 `pnpm auth:migrate --apply` against a fresh database reports
  `tables to create: auth_users, auth_sessions, auth_accounts, auth_verifications` and no
  `subscription`, but `web/src/lib/auth.ts:77` mounts the `@better-auth/stripe` plugin and both
  `drizzle/README.md` and `src/db/schema-parity.ts` name `subscription` as a BetterAuth-owned
  table. Either the plugin only creates it when configured with real Stripe credentials, or a
  fresh database is missing a table the billing path will query at runtime. Reproduce by hitting
  whatever reads a subscription on a database built by the documented procedure. Found at polish
  ledger P0.6a. Ledger item P2.100.

- [confirmed] 2026-08-24 Next 16 deprecates the `middleware` file convention and every dev
  server boot says so: `⚠ The "middleware" file convention is deprecated. Please use "proxy"
  instead. Learn more: https://nextjs.org/docs/messages/middleware-to-proxy`. `web/src/middleware.ts`
  is the only thing standing between an anonymous request and every page (P0.5a), so this is not
  a warning to sit on until it becomes an error: the rename has to be done deliberately, with the
  e2e suite's signed-out redirect test as the guard. Found at polish ledger P0.6b-i. Ledger
  item P2.101.

- [confirmed] 2026-08-24 Signing up logs a Stripe failure on every account when
  `STRIPE_SECRET_KEY` is unset: `WARN [Better Auth]: Stripe customers.search failed, falling back
  to customers.list` then `ERROR [Better Auth]: Failed to create or link Stripe customer: Invalid
  API Key provided: sk_test_********_key`. The sign-up still succeeds, so this is noise rather
  than a broken path, but it is an ERROR line on the happy path of the first thing a user ever
  does, and it means the mock key in `web/src/lib/auth.ts` is reaching Stripe's API rather than
  short-circuiting. Either skip customer creation when the key is the mock, or make the failure a
  debug line. Found at polish ledger P0.6b-i, in the CI dry run's e2e log. Ledger item
  P2.102.

- [investigate] 2026-08-24 CI skips 10 tests where a local run skips 7. The three extra are the
  suites gated on a provider key (`ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, `GEMINI_API_KEY`),
  which `.github/workflows/ci.yml` generates no value for, so the real Perplexity, Anthropic and
  Gemini call paths are the one part of the suite CI cannot certify. Worth deciding deliberately:
  either accept it and say so in `docs/polish/SUMMARY.md`, or give CI repository secrets and let
  the three run on `push` to the default branch only. Found at polish ledger P0.6b-ii, comparing
  the green run's summary (`4661 passed | 10 skipped`) with the local one (`4664 passed |
  7 skipped`). Ledger item P2.103.

- [confirmed] 2026-08-24 The PWA has no maskable icon. `web/src/app/manifest.json` declared both
  of its icons `"purpose": "maskable"` while the art carries a transparent margin, which is the
  opposite of the contract: a maskable icon is full bleed with everything important inside the
  centre 80%, and Android crops it to whatever shape the launcher uses. The declaration is now
  `"any"`, which is truthful, but the consequence is that an installed app gets the platform's
  own white badge behind the mark rather than the mark filling the tile. Fixing it means a second
  full-bleed render of `web/public/icon.svg` at 192 and 512 with the page extended to the edges,
  listed alongside the `any` entries. Found at polish ledger P1.1. Ledger item P2.104.

- [investigate] 2026-08-24 `web/public/` still carries five unreferenced Next.js starter assets:
  `next.svg`, `vercel.svg`, `file.svg`, `globe.svg`, `window.svg`. Nothing under `web/src` names
  any of them (grepped across `.ts`, `.tsx`, `.json`, `.md`, `.mjs`), so they are served as public
  routes and shipped in the Docker image for no reason. Confirm nothing outside the repo links
  them before deleting. Found at polish ledger P1.1. Ledger item P2.105.

- [confirmed] 2026-08-24 `wp_url` accepts a URL carrying credentials
  (`https://user:pass@example.com`). `checkWpUrl` in `web/src/app/api/profiles/validation.ts`
  refuses a query string, a fragment and surrounding whitespace because those break the REST
  path concatenation, but userinfo passes through `fetch` unharmed, so it is not that defect.
  It does mean a password can land in `website_profiles.wp_url`, which is stored in plain
  text while `wp_app_password` is Fernet-encrypted. Found at polish ledger item P1.3b.
  Ledger item P2.107.

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
  reason `evented-resume.test.ts` pins. Found at polish ledger P2.16. Ledger item P2.109.

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
  workflow the app registers, matches); the resume path is the second place it bites. Ledger
  item P2.110.

- [confirmed] 2026-08-24 `applyProfilePrefill` makes a per-post gate edit unexpressible.
  `src/app/api/posts/prefill.ts` copies the profile's `default_stage_settings` over the
  submitted `stage_settings` whenever the submitted value equals the schema default, and that
  default is six `auto`s. So "clear one gate, leave another" survives the create, and "clear
  them all", which is what a user reaches for, is silently written back to the profile's gates
  with a 201 and no warning. It is a faithful port of Python's rule and the parity oracle in
  `src/app/api/posts/create.test.ts` asserts it, so changing it is a deliberate deviation, not
  a fix in passing. Found under polish ledger P3.1a, which is why the new `Pipeline` card on
  `/posts/new` is read-only and links to the profile instead of offering an edit. Ledger item
  P2.114.

- [confirmed] 2026-08-24 Pausing a post is a label, not a control signal, and the dashboard now
  states the label as if it were the fact. `POST /api/posts/{id}/pause`
  (`web/src/app/api/posts/[id]/pause/route.ts`) writes `current_stage = "paused"` and nothing
  else, and its own docblock records that no worker reads that value, so the stage already
  executing runs to completion and the next stage still starts. `deriveRunState()`
  (`web/src/lib/run-state.ts`, polish ledger P3.2a) puts `paused` above the stage map, because
  the pause overwrites `current_stage` while leaving a stale `running` entry behind, so a paused
  post reads `Paused` over a stage that is still billing. Either make the pause reach the worker
  or say what it actually does. Found at polish ledger P3.2a. Ledger item P2.115.

- [confirmed] 2026-08-24 A publish that dies with its worker is reported as still publishing,
  forever. `wp_publish_status` / `nextjs_publish_status` move to `publishing` before the step
  touches the destination and only the step itself writes them again, so a worker killed mid
  publish leaves the column there with nothing to reconcile it. The post header says
  `Publishing...` and, since polish ledger P3.2b-ii, the run trace shows a `Publish to
  <target>` row whose elapsed clock counts up from the `publish_start` entry indefinitely. It
  is the same shape as the stage case in this file's `stopWorkers()` entry (a `SIGTERM`
  truncates the running step), except that no `XAUTOCLAIM` recovers it, because the publish
  workflows declare no `retryConfig` either. Found at polish ledger P3.2b-ii.

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
