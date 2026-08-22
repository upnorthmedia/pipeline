# todo

- [confirmed] 2026-08-21 `pytest` writes real image files into `media/test-123/` on every run,
  and 39 of those artifacts are already committed to git. Running the backend suite from the
  host leaves untracked junk in the working tree. The images stage should write to a tmp dir
  under test. Out of scope for the Mastra port ledger; revisit when the images stage is ported
  (Phase 3.5).

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

- [investigate] 2026-08-21 `src/mastra/agents/{edit,research,write}.test.ts` fail
  intermittently under a full `pnpm test` run (seen: 4 extra failures, then 1, then 0 across
  three consecutive runs) while passing when run alone. Suspect shared state across suites:
  they swap `globalThis.fetch` and read the same `settings` rows. Makes the failure baseline
  unreliable, so it is worth pinning down before Phase 5 adds more DB-backed suites.
  2026-08-22: `src/mastra/api-keys.test.ts` joins the list (2 extra failures in one run of
  iteration 32, then 0 on the rerun), which points at the shared `settings.api_keys` row
  rather than at the agent suites specifically.
  2026-08-22: seen again in iteration 38 across three consecutive full runs (edit + ready +
  api-keys, then outline, then none), with `agents/outline.test.ts` new to the list. Still
  only ever 1-2 extra failures and always in the suites that swap `globalThis.fetch` or read
  `settings.api_keys`.

- [confirmed] 2026-08-21 The agent test files' `beforeAll`/`afterAll` key save-and-restore
  makes the placeholder key permanent: a run captures whatever is in `settings.api_keys`,
  writes `sk-ant-not-a-real-key`, then restores what it captured, so once an interrupted run
  leaves the placeholder behind every later run restores it. Found the row still present at
  the start of iteration 31 and deleted it. The restore should skip rows it wrote itself.

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
- [confirmed] 2026-08-22 `api/tests/phase3/test_images_stage.py` writes generated images into
  the repo's real `media/test-123/` instead of a temp directory and never cleans up, so every
  `pytest` run leaves new untracked `.webp` files in the working tree. 39 of them were already
  committed by accident in 5f31ca4. Deleted when `api/` goes in Phase 7, so worth fixing only
  if pytest stays around longer than expected.

- [confirmed] 2026-08-22 A `pnpm test` run writes generated images into the repo's own
  `media/test-123/` rather than a temp directory, and 41 of them are already committed. The
  filenames carry a random suffix, so every run leaves new untracked files behind for the
  next commit to sweep up. `MEDIA_DIR` already exists and the workflow suites set it to a
  `mkdtemp`; the `images-generate` unit tests do not.


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
- [investigate] 2026-08-22 `src/mastra/workflows/scaffold-check.test.ts` intermittently drains
  a `run.stream()` that is missing `workflow-step-start` / `workflow-step-result`: the stream
  ends with `workflow-finish` but only 4 chunks. Seen in 3 of 5 full `pnpm test` runs while
  item 4.5a's suite was present and 0 of 3 with it removed, though the two share no Redis
  database (11 vs 0), no topic and no rows, so the link looks like scheduling pressure rather
  than shared state. Either the stream subscribes after the worker has already published the
  early chunks, or chunks are dropped under load. Phase 8's trace view reads exactly these
  events, so this needs pinning down before it is built on.
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
- [confirmed] 2026-08-22 `web/src/components/__tests__/export-button.test.tsx` writes real files
  into the repo's `media/test-123/` on every `pnpm -C web test` run, leaving untracked `.webp`
  artifacts behind. It never sets `MEDIA_DIR`, unlike the workflow suites, which point it at a
  temp directory in `beforeAll`. Harmless but it dirties the working tree and hides real
  untracked files in `git status`.
- [confirmed] 2026-08-22 Test post ids have to be unique across the whole vitest suite, not just
  within a file: files run in parallel, so two files seeding the same `posts` row delete and
  re-insert it underneath each other. Found when `pipeline-completion.test.ts` reused
  `review-gates.test.ts`'s `...04c1/04c2/04c3` and both files went intermittently red with
  nonsense symptoms (runs reported `suspended` on gates they never configured, a
  `duplicate key ... posts_pkey` two lines after the matching delete). Fixed there; Phase 5 adds
  many more database-backed test files, so a shared id registry may be worth it.
- [confirmed] 2026-08-22 `settings.key` is the entire primary key, so two users cannot both hold
  one settings key. `PATCH /api/settings` therefore 500s with a `23505` unique violation when a
  user patches a key another user already owns, in both stacks (Python raises the same
  IntegrityError from the same INSERT). Alembic 010 added `user_id` as an index only. The fix is
  a composite `(key, user_id)` primary key, which section 8 of the port objective forbids as part
  of the port. Asserted as-is in `web/src/app/api/settings/route.test.ts`.
- [confirmed] 2026-08-22 The six agent test files each rewrite and delete the single global
  `api_keys` settings row (`writeAnthropicKey` / `clearKeys` in
  `web/src/mastra/agents/*.test.ts`), so `pnpm -C web test` flakes between 9 and 10 failures:
  `images.test.ts > resolves its model from the encrypted key in the settings table` fails with
  `anthropic API key not configured` when it races a sibling file. Each file passes alone. The
  row has no `user_id`, so per-file isolation needs either a per-file settings key or serialising
  those files.
- [investigate] 2026-08-22 BetterAuth has no `BETTER_AUTH_SECRET` in `.env` or `.env.example`, so
  it falls back to its built-in default secret and every session cookie in this deployment is
  signed with a publicly known key. Setting one invalidates existing sessions, which is free now
  (`auth_users` was empty when the tables were created) and expensive later. Belongs with the
  Phase 7 env documentation, item 7.4.
