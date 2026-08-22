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
