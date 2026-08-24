# Polish ledger

The worklist for the "make Jena AI work correctly and feel well made" run. One small
verified committed change per iteration, working the topmost unchecked item. Sections are in
priority order: an earlier section done properly beats all of it half done.

**Priority change, 2026-08-24.** P0 and P1 are done, so P3 now outranks the remaining P2
items and sits above them here. The P2 tail was triaged in the same pass rather than worked
entry by entry: `[optimization]` entries that touched neither correctness, data integrity,
security nor anything a user can see were deleted, as were `[investigate]` entries that do
not reproduce and `[confirmed]` entries whose subject was the deleted `api/` tree. Each
deletion is a checked box below carrying its one-line reason, and the matching `todo.md`
entry is gone. Trivial survivors are batched into **P2.C1** instead of one iteration apiece.
Reasons in full: [evidence](evidence/p2.md#p2-triage).

Evidence for every item goes in `docs/polish/evidence/<section>.md` under a `## <item-id>`
heading. This file carries the link and nothing else, because it is re-read every iteration.

Splitting: an item may be split two levels deep at most (`2` -> `2a` -> `2a-i`). Below that,
finish it in one iteration however long it takes, or mark it `[blocked]` with a reason and
move on. A split is not an iteration on its own: split and complete the first child together.

---

## P0. Nothing is failing, and CI proves it

- [x] **P0.1** The 6 failing tests in `web/src/components/__tests__/image-preview.test.tsx`.
      [evidence](evidence/p0.md#p01)
- [x] **P0.2** `src/mastra/workflows/scaffold-check.test.ts` fails deterministically whenever a
      Mastra worker is running: it uses the default Redis database and topic while
      `worker-process.test.ts` (db 9), `web-restart.test.ts` (db 10) and `crash-probe.test.ts`
      (db 11) isolate. Isolate it. [evidence](evidence/p0.md#p02)
- [x] **P0.3** Make the suite deterministic. Suites borrow the global `settings.api_keys` row,
      swap `globalThis.fetch`, collide on post ids and write real files into the repo. Prove it
      with three identical `pnpm test` runs, worker running and not running.
  - [x] **P0.3a** The global `settings.api_keys` row nine files borrow: the snapshot lives in
        the database, so a killed run cannot lose the developer's keys and the next run repairs
        the row instead of adopting the placeholder. [evidence](evidence/p0.md#p03a)
  - [x] **P0.3b** `pipeline-events.test.ts > carries Python's log payload and nothing else`:
        the gap is in the recording subscriber, not the Redis Streams fan-out. The transport
        invokes callbacks in stream order but does not await them, so the test's own row read
        decided the order of `received`. Covers P2.37, P2.42, P2.48 and P2.69.
        [evidence](evidence/p0.md#p03b)
  - [x] **P0.3c** The suites that swap `globalThis.fetch`. Not P2.8's suspects: those eight
        restore correctly, and the three files that did leak were `api.test.ts`,
        `images-generate.test.ts` and `stage-models-to-provider.test.tsx`. All eleven now go
        through `src/test/swapped-fetch.ts`, and a guard in `setup.ts` fails any test that
        finds the transport left swapped. [evidence](evidence/p0.md#p03c)
  - [x] **P0.3d** Post ids colliding across files, which vitest runs in parallel against one
        database (P2.25, P2.43). The registry is `src/test/unique-test-ids.test.ts`: a UUID
        literal belongs to exactly one test file, and the three ids nothing ever inserts live in
        `src/test/absent-ids.ts`. Ten duplicate groups found and cleared.
        [evidence](evidence/p0.md#p03d)
  - [x] **P0.3e** The proof: six full runs, three with no worker and three with the real
        `.mastra/worker` bundle competing on the same Redis, all `145 passed / 4644 passed |
        7 skipped`, exit 0, tree clean. Carries P2.90's fix (`shouldAdvanceTime` moved the
        frozen clock 20ms under load) and closes P2.8, P2.20, P2.29, P2.36, P2.60, P2.65,
        P2.73, P2.74, P2.78 and P2.88. [evidence](evidence/p0.md#p03e)
- [x] **P0.4** The suite must not dirty the working tree: tests write to a temp dir, and the
      committed image files under `media/test-123/` come out. The whole run shares one
      `MEDIA_DIR` under `tmpdir`, `media/` is gone and gitignored, and 51 committed artifacts
      are deleted. Closes P2.14, P2.24, P2.33 and P2.49. [evidence](evidence/p0.md#p04)
- [x] **P0.5** `pnpm test:e2e` is stale and fails. Repair the Playwright suite against the
      current UI. Baseline 31 failed / 4 passed / 7.3m; the single cause of all 31 is that the
      suite ran signed out, so `src/middleware.ts` served every route as the sign-in page.
      Closed at P0.5c: 34 passed / 0 failed in 24.7s, twice. Closes P2.72.
  - [x] **P0.5a** The session, plus `navigation.test.ts`. A `setup` project signs one fixed
        account in over the real BetterAuth endpoints, clears its rows and saves the cookie
        jar; `auth.test.ts` guards the precondition with its own kill check. Five stale
        assertions in `navigation.test.ts` repaired against the source. 31/4 -> 12/26, and
        `navigation.test.ts` is 14/14 in 9.6s. Closes P2.86.
        [evidence](evidence/p0.md#p05a)
  - [x] **P0.5b** `post-editor.test.ts` (7) and `profile-flow.test.ts` (2). Both stubbed the
        app's own API with `page.route`, which `CLAUDE.md` forbids, and both fixtures had
        drifted far enough to crash the page they fed. `e2e/seed.ts` now creates the rows over
        the real API and six stale assertions are repaired against the source. 12/26 -> 3/35,
        2.4m -> 34.8s. [evidence](evidence/p0.md#p05b)
  - [x] **P0.5c** `full-pipeline.test.ts` (3 failed, 4 more asserting nothing). `/queue` never
        existed in this repository, so that test is deleted and the queue counters it was
        reaching for are asserted on `/monitor` instead. The file now drives the real profile
        and post forms end to end rather than duplicating `navigation.test.ts`. 3/8 -> 0/6,
        whole suite 34 passed. [evidence](evidence/p0.md#p05c)
- [x] **P0.6** CI. Add `.github/workflows` running tsc, lint, test, build and e2e on push and
      PR with Postgres and Redis services. Green on a real run, URL in the evidence. This is
      the acceptance criterion for all of P0, and it is met:
      [run 32693869900](https://github.com/upnorthmedia/pipeline/actions/runs/32693869900).
  - [x] **P0.6a** What a machine that has never run this repo needs. Measured with a fresh
        clone against a fresh Postgres and Redis: `pnpm db:migrate` could not reach the
        database at all (drizzle-kit has no env loader), seven suites died on
        `pg_class_relname_nsp_index` racing `@mastra/pg`'s first-init DDL, and a database
        built from this repo's own migrations carried no `alembic_version` row. Virgin-run
        `9 failed (146)` -> `148 passed (148)`, twice, plus tsc, lint and build in the same
        clone. [evidence](evidence/p0.md#p06a)
  - [x] **P0.6b** `.github/workflows/ci.yml` itself: tsc, lint, test, build and e2e on
        `ubuntu-latest` with Postgres and Redis service containers. Green on a real run with
        nothing flaky: [run 32693869900](https://github.com/upnorthmedia/pipeline/actions/runs/32693869900),
        8m25s, `150 passed`, tree clean, build, `34 passed` e2e under
        `--fail-on-flaky-tests`.
    - [x] **P0.6b-i** The workflow file, and everything about it provable without GitHub.
          One `gates` job with health-gated `postgres:17-alpine` and `redis:7-alpine`,
          following `web/README.md`'s own setup; `actionlint` clean; all four action major
          tags read from the API. Dry-run on Linux found the one defect macOS hides: six
          files declare test-level wait budgets of 10s to 30s while Vitest cuts a test off
          at 5s, so under load `events.test.ts` died on `Test timed out in 5000ms` instead
          of naming what never arrived. `testTimeout: 45_000` plus
          `src/test/wait-budgets.test.ts` keep the two in step, and the `webServer` block is
          hardened for CI. Whole sequence on Linux: `149 passed`, build, `34 passed` e2e.
          [evidence](evidence/p0.md#p06b-i)
    - [x] **P0.6b-ii** The real run. First push failed on one test the runner could show
          and macOS could not: `worker-healthcheck.test.ts` and `reclaim-duplication.test.ts`
          both claimed Redis database 14, so a real probe worker answered the healthcheck's
          "no worker is consuming" claim. `src/test/redis-databases.ts` is now the one owner
          table and `redis-databases.test.ts` fails on a second claim or an unregistered one.
          The green run then reported `1 flaky` on `full-pipeline.test.ts`, a `toHaveURL`
          against Playwright's 5s default after a `Create Post` that starts a run, so
          `expect.timeout` is 15s and the e2e step runs `--fail-on-flaky-tests`: a run that
          is green by retry cannot be the acceptance criterion for all of P0. Three
          consecutive green runs. [evidence](evidence/p0.md#p06b-ii)

## P1. The three things a user sees immediately

- [x] **P1.1** The logo is broken. `web/public/icon.svg` was a devtools element capture whose
      whole content is a `<foreignObject>`, so it rasterises to zero painted pixels. Replaced
      by a 561-byte hand-authored vector, copied to `src/app/icon0.svg` and regenerated into
      all five rasters, so one mark serves the sidebar, the favicon and the manifest. A second
      cause underneath it: `src/middleware.ts` 307ed six of the eight brand assets for a
      signed-out browser, including the SVG favicon and both manifest icons.
      [evidence](evidence/p1.md#p11)
- [x] **P1.2** Post images are broken. Two media directories hold 0 files while their manifests
      claim 4 and 5 images, 4 manifest entries carry an `error`, and `stage_status.images`
      still reads `complete`. Both causes get fixed: the stage reporting success when every
      image failed, and the UI rendering entries as `<img>` without checking for an error or a
      missing file. A failed image reads as a failure with its reason and a retry. Includes
      WordPress publishing uploading no images (P2.63) and generated images being unreachable
      from the `web` service on Railway (P2.76).
  - [x] **P1.2a** The stage reporting success when every image failed. `STATUS_FAILED` reached
        `stage_status.images` only when the *manifest* would not parse, so both golden
        fixtures, captured with no Gemini quota, store five and six entries that all carry an
        `error` under a stage the row calls complete. That is what made the stage unretryable:
        `shouldRunStage` skipped it, `/rerun` and `/run` picked the stage after it, and a
        named-stage rerun stamped the post finished. `imagesStageStatus()` now fails a stage
        that asked for images and got none back, while a partial failure and an empty manifest
        stay complete. [evidence](evidence/p1.md#p12a)
  - [x] **P1.2b** The UI: a manifest entry with an `error` rendered as a bare `Failed` badge
        with no reason and no retry, and an entry claiming `generated: true` whose file is gone
        rendered as a broken `<img>`; `content-preview.tsx` had the same hole for the ready
        article. `failureReason()` is now the one rule for whether an entry has an image, a
        failed entry renders its reason in place of the image, a banner counts the failures and
        carries a `Retry images` button wired to `POST /run?stage=images`, and
        `image-with-fallback.tsx` catches a 404 at both call sites so no broken glyph is
        reachable. Verified in a real browser, before and after in `ui/p12b-images-tab-*.png`.
        Closes the `todo.md` bare-badge finding. [evidence](evidence/p1.md#p12b)
  - [x] **P1.2c** The two image gaps outside the dashboard: WordPress publishing uploads no
        images at all (P2.63), and generated images are unreachable from the `web` service on
        Railway (P2.76). Both closed below.
    - [x] **P1.2c-i** WordPress publishing uploaded no images (P2.63). The media sweep typed
          files with the port of `mimetypes.guess_type` as `python:3.12-slim` runs it, and
          `.webp` only reached that table in 3.13, so every file the images stage writes was
          skipped: no uploads, no featured image, and the local `/media/...` srcs left in the
          published HTML. `guessMediaType()` is the sweep's own resolver now, one entry over
          Python's answer; `guessTypeFromFilename()` keeps answering as the oracle recorded.
          [evidence](evidence/p1.md#p12c-i)
    - [x] **P1.2c-ii** Generated images were unreachable from the `web` service on Railway
          (P2.76). One `MEDIA_DIR` is one store only while both processes share a disk, and
          Railway attaches a volume to a single service. The images stage now mirrors every
          file it writes into `post_media`, which both services already reach, and the
          `/media` handler and the zip export read it when the local disk does not have the
          file. Postgres rather than a bucket: no new dependency or credential, a few hundred
          KB per post, and the filesystem stays exactly as the parity-pinned publish walks
          need it. Verified in a real browser against two different disks,
          `ui/p12cii-images-tab-*.png`. [evidence](evidence/p1.md#p12c-ii)
- [x] **P1.3** Publishing is incomprehensible. One obvious place to configure and test a
      connection, a visible connection status, output formats that disable themselves with an
      explanation when their target is not configured, and a publish action that reports what
      happened. Fix the broken endpoints underneath it (P2.57, P2.58, P2.59, P2.61).
  - [x] **P1.3a** The three `wordpress` connection endpoints answered a 500 with an empty body
        for every failure the install reports (P2.58, P2.59), and the profile page dropped two
        of them on the floor. `upstreamFailure()` answers a 502 carrying WordPress's own
        message for a `WordPressError` and a sentence naming the missing key for a payload the
        projection cannot read; `/test` reports a `/wp-json` root that is not a JSON object
        through its own `{connected: false, error}` channel instead of raising. `fetchWpData`
        uses `allSettled` and renders the reason under the pickers. Verified against a real
        WordPress install, `ui/p13a-wordpress-card-*.png`. [evidence](evidence/p1.md#p13a)
  - [x] **P1.3b** `wp_url` validation (P2.57), batched with `website_url` (P2.87), which is
        the same hole in the same file. `WordPressClient` concatenates its REST paths onto the
        raw value, so a query string, a fragment or surrounding whitespace lands in the middle
        of every endpoint and every call 404s, while the profile stored the URL anyway.
        `checkWpUrl` / `checkWebsiteUrl` refuse it at the boundary; `apiErrorMessage()` now
        joins a 422's field errors instead of falling back, and the two Test Connection
        buttons report the reason instead of swallowing it. Verified against a real WordPress
        install, `ui/p13b-wp-url-*.png`. [evidence](evidence/p1.md#p13b)
  - [x] **P1.3c** `markdown_to_wp_html` raised `AttributeError: No renderer "'inline_html'"`
        for any article whose markdown carries an HTML tag mistune's block layer declines
        (P2.61), so the publish crashed in the converter before it reached WordPress, and the
        run reported an internal token type. `rules/blog-ready.md` asks the ready stage for
        HTML, and an LLM writes `<br />` and `<sup>` unasked, so the token is one the
        pipeline produces. `renderToken` emits the tag as it was written; every other
        unknown type still raises. The 25 oracle cases that record the crash are kept and
        each now asserts both the record and the string that replaced it. Verified by a real
        publish to a real WordPress install, read back with `context=edit`.
        [evidence](evidence/p1.md#p13c)
  - [x] **P1.3d** The UI: one obvious place to configure and test a connection, a connection
        status derived from a real test rather than from two fields being non-empty, output
        formats that disable themselves with an explanation, and a publish action that reports
        what happened.
    - [x] **P1.3d-i** The connection is findable and its badge means something. Both
          integration cards were conditional on the output format that their own fields
          configure, so a profile that had never picked a target had nowhere to enter one;
          `Connected` was derived from two non-empty strings rather than any test, so an
          expired application password read Connected forever; and WordPress writes its REST
          errors for a browser, so `<strong>Error:</strong>` reached the user as literal
          angle brackets. Both cards now render always, a five-state `ConnectionStatus` is
          set only by a real `/wordpress/test` (run on load, because it is a read of
          `/wp-json`), the Next.js status stays `Not tested` until asked because testing it
          POSTs to the customer's site, and `src/lib/plain-message.ts` turns an upstream
          message into the sentence it was meant to be. Verified against a real WordPress
          install, `ui/p13d-*.png`. [evidence](evidence/p1.md#p13d-i)
    - [x] **P1.3d-ii** Output formats that disable themselves with an explanation when their
          target is not configured, in `/posts/new` and in the profile editor. Both selects
          offered all three formats unconditionally, including `wordpress` on `/posts/new`
          with no profile selected at all, which no publish step can survive. The profile
          response also dropped both ciphertext columns, so a profile with a WordPress URL
          and username but no application password was indistinguishable from a working one.
          `serialize.ts` gains `wp_app_password_set` and `nextjs_webhook_secret_set`, the one
          deliberate addition to `ProfileRead`; `src/lib/publishing.ts` holds the two publish
          steps' preconditions and nothing else; `OutputFormatSelect` disables a format and
          prints its reason under the field whether or not the list is open, with the
          selected format's reason as a `role="alert"`. Reachability is deliberately not part
          of it: a configured site that is down is a failure the connection card reports.
          Verified in a real browser, `ui/p13dii-*.png`. [evidence](evidence/p1.md#p13d-ii)
    - [x] **P1.3d-iii** A publish action that reports what happened. `handlePublish` had a
          bare `catch` that replaced the handler's own refusal (`No content to publish`,
          `Publishing not supported for output_format '<x>'`) with `Failed to publish`; it
          wrote `publishing` on a 202 that had stored `pending`, so a post whose worker never
          picked the event up read `Publishing...` forever; and the reason a publish failed
          was not durable anywhere the UI reads. `src/lib/publish-report.ts` reads the last
          `publish_error` entry off `execution_logs` and a `role="alert"` panel under the
          header carries it with the retry next to it. `steps/nextjs-publish.ts`'s `fail` now
          appends that entry, the one deliberate divergence from Python, which left a failed
          Next.js publish with no reason on the row at all. Verified in a real browser,
          `ui/p13diii-*.png`. [evidence](evidence/p1.md#p13d-iii)

## P3. UI and UX

Not a repaint: the shadcn and Tailwind v4 foundation stays. Simple, fast, legible, and
organised so the next action is obvious. Dark mode and the accessibility checklist are
explicitly out of scope.

- [x] **P3.1** Information architecture. Settings, profiles and per-post configuration overlap
      and nothing says which owns what. Decide, move things, write the reasoning in the
      evidence file. Publishing configuration drives this. Carried P2.111 (`/posts/new` has
      no per-post gate editor while `/profiles/[id]` and `/posts/batch` both do), closed at
      P3.1a. All three children are done: the decision (a), the profile editor (b) and the
      settings boundary (c). `/posts/[id]`'s per-post configuration is untouched and belongs
      to P3.2, which owns the post surface.
  - [x] **P3.1a** The decision, and the surface it settles first. Three owners, one concern
        each: the account owns keys, stage models and rules; the site profile owns identity,
        voice, publishing connections and the defaults new posts start from; the post owns the
        article and per-run overrides. `/posts/new` broke both rules that follow: nine values
        arrive from the profile as plain editable inputs with nothing saying where they came
        from, and `stage_settings`, which decides where the run stops, was never mentioned at
        all. A `Pipeline` card now names what each of the six stages will do, summarises where
        the run will stop and links to the profile that owns the gates; `Writing Config` names
        the profile it was filled from. Read-only on purpose: `applyProfilePrefill` copies the
        profile's gates over any submission equal to the schema default, so a per-post editor
        that cleared every gate would be discarded silently. Closes P2.111.
        `ui/p31a-newpost-gates-*.png`. [evidence](evidence/p3.md#p31a)
  - [x] **P3.1b** `/profiles/[id]`: seven cards in one scroll, mixing site identity with
        publishing connections with an action (Crawl Sitemap) and a data table (Internal
        Links). Now four tabs, one per row of the ownership table: `Site` (identity, voice),
        `Publishing` (destination and both connections), `New post defaults` (article, image
        and stage defaults), `Internal links` (crawl and inventory). The WordPress card's
        title moves from y=1728 of a 3235-tall page to y=439 of a 1279-tall tab. One form
        spans the three settings tabs and a sticky save bar submits it by `form=` id, so
        `Re-crawl Schedule` saves from the tab it lives on. `?tab=` is read and written with
        the History API, and the new-post gate link now points at `?tab=defaults`.
        `ui/p31b-profile-*.png`. [evidence](evidence/p3.md#p31b)
  - [x] **P3.1c** `/settings` against `/profiles/[id]`: the boundary is right but invisible.
        Neither page links to the other, "Settings" is the sidebar label for the account-wide
        page while every per-site setting lives under "Profiles", and `Default Stage Settings`
        on the profile is the only editor for a value four other surfaces read. The nav item
        is now `Account`, because the page holds the three things that do not vary per site.
        Five sentences state the boundary and carry the link across it: both page headers, the
        `Stage Models` card, the `Default Stage Settings` card and the profiles list. The
        fourth reader of `default_stage_settings`, `/posts/batch`, gains the `Pipeline` card
        with a `subject` prop, because "This run" is a lie on a page that creates twenty.
        `ui/p31c-*.png`. [evidence](evidence/p3.md#p31c)
- [x] **P3.2** The pipeline is the product: make its state readable at a glance. What stage a
      post is in, what is blocked and why, what a review gate waits for, what a failure was
      and how to retry it. Make the run-trace view the thing you would actually watch.
      Carries P2.98 (no surface lists the posts waiting at a gate, closed at P3.2b-i), P2.108
      (the trace renders no publish events, closed at P3.2b-ii), P2.106 (a run with a failed stage still reads
      "complete", closed at P3.2a) and P2.47 (the SSE hook drops `image_generated` and
      `image_failed`, closed at P3.2c).
  - [x] **P3.2a** The one line every surface shows about a run was not true. Both the posts
        list and the post header rendered `current_stage` alone, uppercased, so a run whose
        `images` stage failed but which reached the end read `COMPLETE` beside its own red
        progress dot: `markPipelineComplete()` is unconditional by design and the images stage
        finishes without succeeding. `deriveRunState()` in `src/lib/run-state.ts` now reads
        both columns and is the only thing the UI asks; `RunStateBadge` replaces `StageBadge`
        and prints its label rather than the enum. `/posts/[id]` gains one banner per failed
        stage with the reason read out of the same `execution_logs` the trace reads and a
        `Re-run <Stage>` button. The two row states written *over* a run in flight
        (`failed`, `paused`) outrank the stage map, because they leave it stale: a browser
        pass caught a dead run reading `Running Research` forever. Closes P2.106, files
        P2.115. `ui/p32a-*.png`. [evidence](evidence/p3.md#p32a)
  - [x] **P3.2b-i** The gate queue. Every value in the posts list's state filter went to the
        server as `status`, which filters `current_stage`, and that column cannot answer this:
        `markStageForReview()` leaves it on the stage it suspended in, so a post waiting on a
        person looks exactly like one waiting on a provider (`GET /api/queue` says as much in
        its own docblock). `GET /api/posts` gains `awaiting_review=true`, an `OR` of six jsonb
        containment tests over `stage_status`, and `/` gains `Waiting for review` as the
        second entry in the filter, with the count and the empty state worded for the queue
        and read off the filter the rows were fetched under rather than the live control.
        `StageStatusJson` was missing `review`, which no writer had caught because
        `mergeStageStatus()` builds raw SQL. Closes P2.98. `ui/p32b-*.png`.
        [evidence](evidence/p3.md#p32b-i)
  - [x] **P3.2b-ii** The publish leg of the trace. The reading side dropped every publish
        entry, because `buildRunTrace()` keys on the six pipeline stages and both steps write
        `stage: ""`. The writing side was thinner than P2.108 says: neither step wrote a
        `publish_start` entry at all (the start went to the bus only, and an SSE frame is gone
        on delivery) and `nextjs-publish.ts` wrote nothing on success, so nothing could time a
        publish or show one in flight. Both steps now append `publish_start`, Next.js appends
        `publish_complete`, and every entry carries `data.target`; `publish-report.ts` owns
        the message prefixes that identify a historic entry's destination. `buildRunTrace()`
        returns a `PublishTrace` read the way a stage is: status off the row's publish column,
        timing and reason off the log, attributed only to the destination on screen, with the
        reason dropped once a later attempt succeeded. It stays out of the run totals, which
        are stage measurements. Closes P2.108. `ui/p32bii-*.png`.
        [evidence](evidence/p3.md#p32b-ii)
  - [x] **P3.2c** Live image events. `EventSource` delivers a named frame only to a listener
        for that exact name, so the two the fan-out publishes were received, parsed and
        discarded; `buildRunTrace()` let both fall through its `default` as well, so the
        stored copies were unread too. `images` is the only stage where that matters: it is
        the only fan-out, so `running` hides how much is done and `complete` hides that some
        of it failed. Both names join `NAMED_EVENTS` and the page's `debugEvents`;
        `StageTrace` gains `images`, counted per manifest index so a retried image counts
        once, cleared by an `images` `stage_start` and by a rerun the row has disowned; the
        trace row reads `3 images generated, 2 failed`, live off `liveImages` before any
        refetch. Closes P2.47. `ui/p32c-*.png`. [evidence](evidence/p3.md#p32c)
- [x] **P3.3** Naming and copy. Stage names, buttons and errors in the user's terms. No raw
      enum values, no stack traces, no `undefined` in the UI.
  - [x] **P3.3a** The route error boundaries. All three printed the exception's own message as
        body copy, and that is always wrong here rather than merely ugly: every request goes
        through `request()` and every page that makes one catches the throw and renders the
        server's complaint through `apiErrorMessage()`, so a boundary only ever receives a
        render-time exception V8 worded for whoever is reading the stack. The old heading was
        wrong for the same reason ("Failed to load post" describes a load that has already
        succeeded). One `RouteError` component now carries a per-route title, one sentence
        saying what the failure did not touch, the back link and retry, and the message plus
        digest under a closed `Technical details` disclosure, where the person who has to
        report it is one click away. `technicalDetail()` falls back to the error's name so an
        empty message never renders a blank line or the string `undefined`. P2.96's second
        half (`buildRunTrace()` throwing on a missing `execution_logs`) does not reproduce:
        the column is `NOT NULL DEFAULT '[]'`, `serializePost()` coalesces it anyway and the
        client type is not optional, so it is deleted rather than fixed. Closes P2.96.
        `ui/p33a-*.png`. [evidence](evidence/p3.md#p33a)
  - [x] **P3.3b** Raw enum values in the UI. Five sites reached the screen with a stored
        value, three of them found by the sweep. `ImagePreview` printed `featured_image` for
        the featured entry and a bare heading for a content one, so neither half of the
        manifest's placement said what it meant; `placementLabel()` now reads
        `After "<heading>"` or a humanised location, with only `after_heading` needing copy of
        its own because the generic humaniser already spells `featured_image` correctly.
        `pipeline-progress.tsx` said "Awaiting review" in its `aria-label` and "Review" in the
        tooltip body a mouse user reads. `/profiles/[id]` printed `crawl_status` where
        `/profiles` had named all four values since it was written; both now read one shared
        `CrawlStatusBadge`. `GlobalNotifications` titled its toasts "research complete", and
        "unknown complete" on a frame carrying no stage. The images fan-out's message counts
        from one while `data.index` and the operator's logger line stay on the manifest
        position. Three more sites produce the right string by coincidence and were recorded
        rather than changed. Closes P2.112. `ui/p33b-*.png`. [evidence](evidence/p3.md#p33b)
  - [x] **P3.3c-i** No `undefined` in the UI. Swept: four greps over every user-visible
        template literal, every `new Date(` and every label-map index. The literal string is
        not reachable today, and in every case but one the guard is already there; the
        exception, `Post ${postId?.slice(0, 8)}...`, is unreachable one layer up because
        `payloadOf()` drops a frame with no string `post_id`. Recorded as a measurement, not
        claimed as a fix. Reading that site found the real defect on the same three lines:
        `GlobalNotifications` is mounted from the root layout, so `/posts/[id]` raised a
        second toast for every `stage_complete` and `stage_error` frame, worded "research
        complete" against the global one's "Research complete", and the global one named the
        post by an id fragment. A toast can only name a post if it knows the name, and the
        topic exists only on the server: both event endpoints already read the row, so
        `pipelineEventStream()`'s `matches` predicate became a `select` function returning the
        payload to send, `ownedByUser()` selects `posts.topic` instead of `1`, and the column
        is spread over the payload so a published `topic` cannot spoof it. The page's
        duplicate toasts are gone, the `View` action is withheld on the post's own page, and
        `Re-running from write` reads `Re-running from Write`. `ui/p33ci-*.png`.
        [evidence](evidence/p3.md#p33c-i)
  - [x] **P3.3c-ii** Buttons and errors in the user's terms. `Rerun Stage` did not re-run a
        stage: `POST /rerun` resumes the pipeline from the first stage `stage_status` does not
        call complete, and the button sat two inches from `Re-run Edit`, which is the per-stage
        retry and a different endpoint. It reads `Resume from Edit` now, off a `resumeStage()`
        that derives the stage the way the handler does, fallback included. `Force Restart`
        named the force and not the loss; it is `Start Over` behind a confirmation that names
        the six stage outputs and the cost record it discards and the settings it keeps.
        `handlePause`, `handleRerun` and `handleRestart` swallowed the server's reason where
        every neighbour used `apiErrorMessage`. The upstream cause of that class was not on the
        page: `apiErrorMessage()` preferred the 500 placeholder over every caller's fallback,
        so a bare 500 read `Internal Server Error` instead of the action that failed, and
        `withServerError()` writes that string precisely because it has no complaint to report.
        `WP_DECRYPT_FAILED` told the reader to check `WP_ENCRYPTION_KEY`; it now tells them to
        type the application password in again, with Python's wording kept as
        `PY_WP_DECRYPT_FAILED` and mapped through a `reworded()` in the parity suite, the same
        mechanism P1.3a used. Seven raw stage names gone from `stage-models-card.tsx` and
        `/profiles/[id]`. `ui/p33cii-*.png`. [evidence](evidence/p3.md#p33c-ii)
- [x] **P3.4** Speed where it is felt: layout shift, avoidable spinners on cached data, lists
      that refetch everything on a single-row change.
  - [x] **P3.4a** A keystroke was a server round trip. All three server-backed search boxes
        (`/`, `/profiles/[id]?tab=links`, `/monitor` logs) read their filter straight into the
        effect that fetches, so a five-letter word was five requests, and the posts list sent
        five more because its mount effect refetches the profile filter's options beside the
        rows: ten requests for one word, measured in Chrome. None of the three checked that an
        answer was still the one being waited for either, so of two searches in flight the one
        that answered last won. `useDebouncedValue` (300ms, first value not held back) and
        `useLatestRequest` are the two hooks; each page now records the query its rows came
        from (`shownQuery`, `shownLinksSearch`) so a cleared search does not read as an empty
        account while its replacement is in flight, and the logs tab keeps its rows instead of
        flashing skeletons on every character. One request per word in the browser, on all
        three. `ui/p34a-*.png`. [evidence](evidence/p3.md#p34a)
  - [x] **P3.4b** The rest of P3.4. `/monitor`'s overview called `fetchData()` (six aggregate
        queries over `posts`) from its SSE callback with no condition on the frame, so the 20
        frames the images fan-out publishes for one post cost 20 round trips that could not
        change a number on it: both endpoints group over `current_stage`, and only the four
        stage frames accompany a write to it. Those four now refetch, coalesced into one
        request per 500ms burst; everything else is a feed entry only. Measured in Chrome, 21
        requests to 1. Layout shift was then measured across seven screens, six of which sit
        at or under 0.0002. `/settings` was 0.0965 to 0.0997, because its Stage Models
        placeholder drew six flat 36px bars where a loaded row is a 92px bordered box, and its
        API Keys placeholder left out the separator and save row. Both are now built from the
        loaded shape, in the card and in `loading.tsx`: CLS 0 on three runs.
        `ui/p34b-*.png`. [evidence](evidence/p3.md#p34b)
- [x] **P3.5** One screen per iteration, verified with `npx -y chrome-devtools-axi`, before and
      after PNGs committed under `docs/polish/ui/`, no new console errors. Closed with its
      three children: P3.5a swept the eleven screens a signed-in session can reach, P3.5b took
      `/monitor` and P3.5c the two `/auth/*` screens, which is every route under
      `web/src/app/`. Every remaining P3 concern is a `todo.md` entry with its own P2 number,
      not a screen nobody has opened.
  - [x] **P3.5a** The app-wide sweep. Eleven screens opened, read for console messages and
        captured full page: no errors and no warnings on any of them, the only two non-empty
        readings being Next.js' own Fast Refresh log and a Chrome verbose DOM hint. One
        defect, on `/profiles/[id]?tab=publishing`: the Output Format trigger rendered with no
        text at all, because all three seeded profiles held `output_format = 'both'`, the
        column default, which is not one of the three formats `OUTPUT_FORMATS` offers and so
        matches no `SelectItem`. `both` names no destination any publish step handles, so
        `drizzle/0003` moves both columns' default to `markdown` and rewrites the rows that
        took the old one, which is behaviour-preserving: both values publish nowhere. The
        column stays a bare `varchar(20)` and both validators still take `z.string()`, so the
        picker also stopped rendering an unoffered value as nothing: it reads `Unrecognised
        format` and says what is stored under the field. Closes P2.113. `ui/p35-*.png`.
        [evidence](evidence/p3.md#p35a)
  - [x] **P3.5b** `/monitor`. The Queue Controls strip read `Running: 11` for an account whose
        posts list called five of those rows running, two Not started, two Failed and two
        Waiting for you. `GET /api/queue` grouped on `current_stage` and summed every group
        whose key is a stage name, which is Python's arithmetic and is a statement about where
        a run got to, not what it is doing: a post created and never started, and a post whose
        research stage threw, both carry `current_stage = 'research'`. It now hands every owned
        post to `deriveRunState()`, the function the badge column already used, and returns one
        count per `RunStateKind`; `total` is consequently the sum of the buckets. The strip
        reads those buckets in the badge column's own words, with Finished with errors hiding
        at zero, and all six readings now match `/` row for row. The chart beside it keeps its
        `current_stage` grouping and is renamed `Posts by Stage` to say which question it
        answers. `ui/p35b-*.png`. [evidence](evidence/p3.md#p35b)

  - [x] **P3.5c** `/auth/sign-in` and `/auth/sign-up`, the only screens a visitor without an
        account can be on, which P3.5a's sweep could not open because every capture in it
        carried a session. The root layout drew the sidebar and the mobile header around them,
        so the first screen of the product held four nav links that the middleware bounces
        straight back, in the tab order and ahead of the email field. The auth layout hid them
        under `fixed inset-0 z-50`, an opaque sheet, which is also why the sign-up form could
        not be finished under about a 480px viewport: a fixed sheet does not scroll, the card
        is 466px tall, and `Sign In` sat 62px past a page that would not move. The frame moves
        into `AppChrome`, a client component that reads `usePathname()` and gives `/auth` and
        `/auth/*` the page alone, SSR included; `src/app/auth/layout.tsx` is deleted, having
        nothing left to do, and the page now names the product itself, which the sidebar was
        the only thing doing. Fixed `full-pipeline.test.ts` on the way, stale since P3.5b
        renamed the queue counters: `pnpm test:e2e` is 39 green. `ui/p35c-*.png`.
        [evidence](evidence/p3.md#p35c)

## P2. Clear the backlog in `todo.md`

Worked top to bottom against `todo.md`, one numbered entry per finding in that file's order.
P2.1 to P2.95 are a snapshot of that file taken at the first iteration; P2.96 and up were
appended at the 2026-08-24 triage from findings filed since, in `todo.md` order. Numbers are
only ever appended, never reassigned. `todo.md` is the authority for what is left, not this
list. For each: fix it, or delete it with a one-line reason in the evidence file if it is
stale or wrong. Every `[confirmed]` item affecting correctness, data integrity, security or
anything a user can see gets fixed. Every `[investigate]` item gets verified before it is
acted on, and demoted or deleted when it does not reproduce.

High value, done first within P2: P2.51 (`delete_link()` ownership check), P2.87
(`POST /api/profiles` accepting any string as a website URL), P2.83 (`GET /api/posts`
answering 500 with an empty body), P2.84 (`/posts/[id]` naming two of the six stages twice),
P2.31 (duplicate silently dropping `article_type`), P2.77 (migrations never running on
deploy), P2.71 (Perplexity's deprecated Sonar Chat Completions endpoint).

- [x] **P2.1** `[confirmed]` `src/mastra/workflows/scaffold-check.test.ts` fails whenever a real Mastra worker is running against the same Redis, because it uses the default ... Fixed by P0.2; entry removed from `todo.md`. [evidence](evidence/p0.md#p02)
- [x] **P2.2** `[confirmed]` The `images` stage's featured-image handling never fires on real manifests. `images.py` tests `image_spec.get("placement") == "featured"`, but ... Fixed: one `isFeatured` predicate behind all four featured decisions, accepting the shapes `rules/blog-images.md` documents. [evidence](evidence/p2.md#p22-p210-p211-p212-p213)
- [x] **P2.3** `[confirmed]` The Gemini API key in the main checkout's `.env` has **zero** image quota: every `gemini-3.1-flash-image` call returns 429 `RESOURCE_EXHAUSTED` ... Verified stale: both Gemini image tiers answer HTTP 200 with real JPEG bytes on the key in `settings.api_keys`; the model also moved to `gemini-3-pro-image` in item 6.1. Entry deleted. [evidence](evidence/p2.md#p23-p24-p25-p26-p27-p215-p226)
- [x] **P2.4** `[investigate]` `ClaudeClient.chat` sends `thinking={"type": "enabled", "budget_tokens": 10000}`, which the installed anthropic SDK now warns is deprecated for ... Verified stale: `claudeStageOptions` sends `thinking: { type: "adaptive" }`, accepted live by `claude-opus-5` and pinned by five agent suites. Entry deleted. [evidence](evidence/p2.md#p23-p24-p25-p26-p27-p215-p226)
- [x] **P2.5** `[confirmed]` `settings` primary key is `key` alone while `user_id` is only an index, so two users cannot hold different values for the same setting key. ... Verified fixed: Alembic 012 gave `settings` a surrogate `id` and a `NULLS NOT DISTINCT` unique `(key, user_id)`. Entry deleted. [evidence](evidence/p2.md#p23-p24-p25-p26-p27-p215-p226)
- [x] **P2.6** `[confirmed]` `api/src/models/post.py` disagrees with the Alembic-produced database on two defaults: it declares `output_format` server default `"markdown"` ... Verified unreachable: `postCreateSchema` sends both defaults on every insert path and `create.test.ts` asserts them; the subject file no longer exists. Entry deleted. [evidence](evidence/p2.md#p23-p24-p25-p26-p27-p215-p226)
- [x] **P2.7** `[confirmed]` `next build`'s output file tracing does not know about the two runtime data files under `web/src/mastra/textstat/data/`, which the port reads ... Half true and now declared: the `runner` stage carried the corpus only by accident of the standalone output, so it copies it and sets `TEXTSTAT_DATA_DIR` explicitly, guarded by `runtime-data-files.test.ts`. [evidence](evidence/p2.md#p23-p24-p25-p26-p27-p215-p226)
- [x] **P2.8** `[investigate]` `src/mastra/agents/{edit,research,write}.test.ts` fail intermittently under a full `pnpm test` run (seen: 4 extra failures, then 1, then 0 ... 0 failures in six full runs (three worker-up), on top of P0.3a and P0.3c fixing both causes it named; entry removed from `todo.md`. [evidence](evidence/p0.md#p03e)
- [x] **P2.9** `[confirmed]` The agent test files' `beforeAll`/`afterAll` key save-and-restore makes the placeholder key permanent: a run captures whatever is in ... Fixed by P0.3a; entry removed from `todo.md`. [evidence](evidence/p0.md#p03a)
- [x] **P2.10** `[confirmed]` `_generate_one` gives every featured image the same filename, `featured-<MMDDYY>-<randint(10,99)>.webp`, so two featured entries in one manifest ... Fixed: `featuredFilename` takes the entry's index, which is unique within a manifest by construction. [evidence](evidence/p2.md#p22-p210-p211-p212-p213)
- [x] **P2.11** `[confirmed]` The featured overrides in `_generate_one` rewrite the local `aspect_ratio` / `image_size` without touching the manifest entry, so a stored entry ... Fixed: the entry records the request that was actually made. [evidence](evidence/p2.md#p22-p210-p211-p212-p213)
- [x] **P2.12** `[confirmed]` An image spec whose `filename` is the empty string writes a dotfile, `<media_dir>/<post_id>/.webp`, and records `/media/<post_id>/.webp`. Hidden ... Fixed: an empty or dot-leading stem falls back to `image-<index>`. [evidence](evidence/p2.md#p22-p210-p211-p212-p213)
- [x] **P2.13** `[investigate]` Python reads `aspect_ratio`, `image_size` and `filename` out of the manifest with `dict.get(key, default)`, which returns an explicit JSON ... Decided: a non-string is the key unanswered and its documented default is the answer; pinned by two cases. [evidence](evidence/p2.md#p22-p210-p211-p212-p213)
- [x] **P2.14** `[confirmed]` A `pnpm test` run writes generated images into the repo's own `media/test-123/` rather than a temp directory, and 41 of them are already ... Fixed by P0.4: no TypeScript suite writes an image file to the media root at HEAD, and the run-wide `MEDIA_DIR` covers the directories it does write; entry removed from `todo.md`. [evidence](evidence/p0.md#p04)
- [x] **P2.15** `[confirmed]` The `posts.stage_settings` column default in the live database is ... Verified unreachable, with P2.6: no insert path omits `stage_settings`. Entry deleted. [evidence](evidence/p2.md#p23-p24-p25-p26-p27-p215-p226)
- [x] **P2.16** `[confirmed]` `EventedRun.resume()` resolves with a stale snapshot. It subscribes to the shared `workflows-finish` topic and the Redis stream still holds the ... Verified at HEAD and pinned by `evented-resume.test.ts`, with the cause isolated by draining the topic; nothing in the app awaits a resume, so no code change was needed. Entry removed from `todo.md`. [evidence](evidence/p2.md#p216)
- [x] **P2.17** `[confirmed]` `web/src/lib/api.ts` types `StageMode` as `"auto"` and `StageStatus` without `"review"`, so the dashboard cannot express a gated stage. Item 4.3 ... Half stale (`StageStatus` already carried `review`) and half fixed: `StageMode` is the three values `stage_settings` holds, cross-checked against the gate's own `REVIEW_MODES`, and a parked stage now reads as awaiting review in the progress bar and in the profile picker. [evidence](evidence/p2.md#p217)
- [x] **P2.18** `[confirmed]` The `mastra worker` bundle does not inherit the dev machine's module resolution. Two packages that `next build`, `vitest` and `mastra dev` all ... Fixed: CI now builds the bundle from a clean `.mastra/worker` and boots it, because `mastra worker build` exits 0 for a bundle that cannot import. Entry removed from `todo.md`. [evidence](evidence/p2.md#p218)
- [x] **P2.19** `[investigate]` `mastra worker start` prints `[mastra] Shutting down workers...` twice under a process-group signal, because the CLI and the worker it spawns ... Answered: three times, not two, and only under the CLI wrapper; the deployed `node .mastra/worker/index.mjs` signalled the way a container signals PID 1 prints once and exits 0. Cosmetic and local; entry deleted from `todo.md`. [evidence](evidence/p2.md#p219-p221)
- [x] **P2.20** `[investigate]` `src/mastra/workflows/scaffold-check.test.ts` intermittently drains a `run.stream()` that is missing `workflow-step-start` / ... 0 failures in six full runs after P0.2's isolation; entry removed from `todo.md`. [evidence](evidence/p0.md#p03e)
- [x] **P2.21** `[investigate]` Item 4.5a only covers `SIGKILL`. A Railway redeploy sends `SIGTERM`, which the `mastra worker` entry handles by calling `stopWorkers()`, and ... Answered against real Redis: left pending for reclaim, neither acked nor nacked, so a redeploy loses no stage and duplicates none. What it does cost, a 15-minute stall and a re-billed stage, is filed as P2.91 and pinned by `sigterm-shutdown.test.ts`. [evidence](evidence/p2.md#p219-p221)
- [x] **P2.22** `[confirmed]` The worker bundle resolves `rules/` from its own output directory, so it needs `RULES_DIR` set explicitly. `prompts.ts` falls back to ... Fixed: every image and compose service already named it, and `runtime-data-files.test.ts` now pins the compose half too, but the miss was silent: `loadRules` answered `""` and six stages ran, billed and reported `complete` on prompts with the rule file stripped out. It throws now, naming the stage, the path and the variable. Entry removed from `todo.md`. [evidence](evidence/p2.md#p222-p223)
- [x] **P2.23** `[confirmed]` The worker bundle also needs `TEXTSTAT_DATA_DIR` set, and unlike the missing rules it is fatal. `textstatDataDir()` falls back to ... Fixed: the variable is set everywhere the worker runs and the compose half is now pinned, and `textstatDataFile()` is the one resolver for the corpus, so the `edit` stage's death names the variable instead of being a bare `ENOENT` on a path. Entry removed from `todo.md`. [evidence](evidence/p2.md#p222-p223)
- [x] **P2.24** `[confirmed]` `web/src/components/__tests__/export-button.test.tsx` writes real files into the repo's `media/test-123/` on every `pnpm -C web test` run, ... Stale: that file imports no `node:fs` and renders against a mocked `@/lib/api`, so it cannot write a file; entry deleted from `todo.md`. [evidence](evidence/p0.md#p04)
- [x] **P2.25** `[confirmed]` Test post ids have to be unique across the whole vitest suite, not just within a file: files run in parallel, so two files seeding the same ... Fixed by P0.3d, which adds the registry the entry asked for; entry removed from `todo.md`. [evidence](evidence/p0.md#p03d)
- [x] **P2.26** `[confirmed]` `settings.key` is the entire primary key, so two users cannot both hold one settings key. `PATCH /api/settings` therefore 500s with a `23505` ... Duplicate of P2.5, verified fixed: the route test now asserts one value per user rather than the 500. Entry deleted. [evidence](evidence/p2.md#p23-p24-p25-p26-p27-p215-p226)
- [x] **P2.27** `[fixed]` The six agent test files each rewrote and deleted the single global `api_keys` settings row (`writeAnthropicKey` / `clearKeys` in ...
- [x] **P2.28** `[investigate]` BetterAuth has no `BETTER_AUTH_SECRET` in `.env` or `.env.example`, so it falls back to its built-in default secret and every session cookie in ... Confirmed and fixed: better-auth adopts its published fallback `DEFAULT_SECRET` in silence outside production, so `src/lib/auth.ts` now resolves the secret itself and throws at import when it is missing or is that fallback. [evidence](evidence/p2.md#p228-p254-p275)
- [x] **P2.29** `[investigate]` `scaffold-check.test.ts > emits the workflow lifecycle events the trace view will read` failed once in a full `pnpm -C web test` run with ... 0 failures in six full runs after P0.2's isolation; entry removed from `todo.md`. [evidence](evidence/p0.md#p03e)
- [x] **P2.30** `[confirmed]` `web/src/app/api/profiles/serialize.ts` formats timestamps with a plain `Date.toISOString()`, which always writes exactly three fractional ... Fixed, and the helper it was told to reuse was wrong too: pydantic writes six fractional digits or none and never trims, measured against pydantic 2.12.5 and FastAPI 0.141.1. `toPydanticIso()` corrected, and profiles and settings both routed through it. Entry removed from `todo.md`. [evidence](evidence/p2.md#p230)
- [x] **P2.31** `[confirmed]` `POST /api/posts/{post_id}/duplicate` silently drops `article_type` and `additional_info`. `duplicate_post`'s `config_fields` list in ... Fixed: both columns are in the duplicate's whitelist, and both are prompt inputs read by all six stages, so a duplicate no longer runs on a strictly smaller prompt than its original. Entry removed from `todo.md`. [evidence](evidence/p2.md#p231)
- [x] **P2.32** `[confirmed]` `PostAnalytics.seo_checklist` in `web/src/lib/api.ts` is typed `Record<string, boolean>` but the endpoint has always returned a mixed map: ... Fixed: the client type is `Record<string, boolean | number>` and `SeoChecklist` partitions by type, so the two link counts render as counts instead of inflating the pass fraction and painting a red dot at zero. Entry removed from `todo.md`. [evidence](evidence/p2.md#p232)
- [x] **P2.33** `[confirmed]` 39 generated image files under `media/test-123/` are committed to the repo. They are test output: the media-writing tests in the images-stage ... Fixed by P0.4: 51 files removed and `/media/` gitignored; entry removed from `todo.md`. [evidence](evidence/p0.md#p04)
- [x] **P2.34** `[confirmed]` `retry_dead_letter()` in `api/src/api/queue.py` looks the post up with an unscoped `session.get(Post, post_id)`, so any authenticated user can ... Already closed during the port: all four handlers in this router scope through `website_profiles.user_id`, and the entry's own text recorded each closure without retiring it. Verified against the three dead-letter suites (57 tests). Entry removed from `todo.md`. [evidence](evidence/p2.md#p234-p235)
- [x] **P2.35** `[investigate]` Mastra's engine logs step failures to a logger the app cannot configure. `MastraBase`'s constructor gives every primitive its own ... Reproduces at `@mastra/core` 1.61.0 and there is no seam: the processor is private on both owners and the only registration hook fires before it exists. Impact is log format on stderr, not a lost failure, so the entry is demoted to `[optimization]` and the fix folded into P2.91's worker entry. The four `console.error` workarounds are now one helper, `web/src/test/engine-step-errors.ts`, which carries the finding. [evidence](evidence/p2.md#p234-p235)
- [x] **P2.36** `[investigate]` `src/mastra/workflows/scaffold-check.test.ts > emits the workflow lifecycle events the trace view will read` failed once on a full `vitest run` ... 0 failures in six full runs after P0.2's isolation; entry removed from `todo.md`. [evidence](evidence/p0.md#p03e)
- [x] **P2.37** `[investigate]` `src/mastra/pipeline-events.test.ts > carries Python's log payload and nothing else` failed once on a full `vitest run` during item 5.5e-i, ... Fixed by P0.3b; entry removed from `todo.md`. [evidence](evidence/p0.md#p03b)
- [x] **P2.38** `[confirmed]` The `cost_usd` on every `stage_complete` execution log entry is priced at Anthropic Opus rates regardless of provider. `api/src/worker.py:244` ... Fixed: `stageCostUsd()` takes the model and reads `MODEL_COSTS`, `announceStageComplete()` passes the id it already stored beside the cost, and `model-costs.test.ts` fails when an allowlisted model has no price. `research` was 5x over, `claude-fable-5` had no price at all. Entry removed from `todo.md`. [evidence](evidence/p2.md#p238)
- [x] **P2.39** `[confirmed]` The port's stage retries are immediate where Python spaced them 10 seconds apart. `WorkerSettings.retry_delay = 10` (`api/src/worker.py:610`) ... Fixed: `RETRY_DELAY_MS` and an abortable pause in `recordStageRetry()`, held after the retry entry is written and before the error is rethrown, so the spacing is real where a `delay` on the workflow would have been ignored. All eight stage steps pass their `abortSignal`. The suite sets `STAGE_RETRY_DELAY_MS: "0"`. Entry removed from `todo.md`. [evidence](evidence/p2.md#p239)
- [x] **P2.40** `[investigate]` A step that is resumed from a review gate and then throws loses its `resumeData` on retry, so it re-suspends at the same gate instead of ... Deleted at triage: unreachable until the app has a resume path at all, and the mechanism (the engine's retry branch does not carry `resumeData` forward) is carried into P2.109, which owns that path.
- [x] **P2.41** `[confirmed, fixed 2026-08-22]` `images` stage did not retry at all, where Python's job retry re-ran it like any other stage. Measured under ledger item 5.5c-iii-b-2-b-i ...
- [x] **P2.42** `[confirmed]` `received` in `web/src/mastra/pipeline-events.test.ts` is not in delivery order, so any assertion built on its ordering is unsound. Its ... Fixed by P0.3b; entry removed from `todo.md`. [evidence](evidence/p0.md#p03b)
- [x] **P2.43** `[confirmed, fixed 2026-08-23]` test files shared post id `00000000-0000-4000-8000-0000000055d1`: `web/src/mastra/steps/stage-log.test.ts` and ...
- [x] **P2.44** `[confirmed, fixed 2026-08-23]` in `web/src/mastra/failure-recorder.test.ts` returned as soon as `current_stage` read `failed`, which is a snapshot that can predate the ...
- [x] **P2.45** `[optimization 2026-08-23]` carries three literal U+2014 em dashes in source (the `em-dash(es)` warning message, the `ACTION REQUIRED` prompt line, and one comment), where ... Deleted at triage: the two product strings are a wire contract and a prompt contract whose bytes must not change, the third is a comment, and none of the three touches correctness, security or anything a user can see.
- [x] **P2.46** `[confirmed]` `web/src/mastra/steps/images-manifest.ts` renders the manifest's `error` value into its parse-failure message with `String(...)` where Python's ... Fixed: `manifestErrorText()` returns a string untouched and renders a container as compact JSON, so a model that answers a structured error reaches the run trace as `{"reason":"..."}` instead of `[object Object]`. A deliberate deviation from Python's `repr`, which has no renderer left to agree with. Entry removed from `todo.md`. [evidence](evidence/p2.md#p246-p253-p262-p266)
- [x] **P2.47** Closed at P3.2c. `web/src/hooks/use-sse.ts` did not listen for `image_generated` or `image_failed`. `NAMED_EVENTS` listed eight names and neither was among them, ...
- [x] **P2.48** `[investigate]` New sighting of the `received`-ordering defect recorded above: `pipeline-events.test.ts > carries Python's log payload and nothing else` failed ... Fixed by P0.3b; entry removed from `todo.md`. [evidence](evidence/p0.md#p03b)
- [x] **P2.49** `[investigate]` Running `pnpm -C web test` leaves untracked WebP files in the repo's `media/test-123/` directory (six appeared during the 5.5c-iv-d-2 iteration, ... Explained and fixed by P0.4: the writer was the deleted pytest suite under `api/`, and the `MEDIA_DIR` default the entry proposed is now in place; entry removed from `todo.md`. [evidence](evidence/p0.md#p04)
- [x] **P2.50** `[optimization]` `GET /api/events/{post_id}` opens one `RedisStreamsPubSub` subscription per connected browser, and each one costs a dedicated Redis connection ... Deleted at triage: connection count per open tab, teardown already proven by a test, nothing has hit a limit; `[optimization]` with no correctness, security or user-visible effect.
- [x] **P2.51** `[confirmed]` `delete_link()` in `api/src/api/links.py` has no ownership check: unlike the other two endpoints in that router it never calls ... Stale: `api/` is gone from the repo and the port scopes the delete to the caller with two tests on it; entry removed from `todo.md`. [evidence](evidence/p2.md#p251)
- [x] **P2.52** `[confirmed]` `cost_analytics()` in `api/src/api/analytics.py` has never run. Its raw SQL puts the `website_profiles` join inside the second `FROM` item ... Deleted at triage: `api/` was deleted at ledger item 7.1c (`f917348`), and the TypeScript replacement `web/src/app/api/analytics/costs/route.ts` puts the join on `posts` and has 30 tests.
- [x] **P2.53** `[confirmed]` `web/src/app/api/analytics/costs/route.ts` (ledger item 5.8b) reads its two optional query parameters with `url.searchParams.get("profile_id")` ... Fixed: both filters read `getAll(...).at(-1)`, the reading `parseDays()` and `/models` already used, so a repeated key answers on its last value the way Starlette did. Entry removed from `todo.md`. [evidence](evidence/p2.md#p246-p253-p262-p266)
- [x] **P2.54** `[confirmed]` `npx next build` in `web/` prints 15 `[Error [BetterAuthError]: You are using the default secret. Please set BETTER_AUTH_SECRET ...]` lines ... Fixed with P2.28: the build imported `/api/auth/[...all]` once per page-data worker, so the 15 lines were 15 workers rather than 15 routes. Build is now clean, or fails naming the variable. [evidence](evidence/p2.md#p228-p254-p275)
- [x] **P2.55** `[confirmed]` `GET /api/analytics/logs` in `api/src/api/analytics.py` answers a 500 for any `since` or `until` that `datetime.fromisoformat()` rejects. The ... Deleted at triage: same deleted `api/` tree, and the port already answers pydantic's `datetime_from_date_parsing` 422 for a malformed `since`/`until` (item 5.8d-ii).
- [x] **P2.56** `[confirmed]` The whole `/api/analytics/logs` result set is ordered and bounded by a *text* comparison on `log_entry->>'ts'`, in both stacks. That is only ... Fixed: both bounds and the ordering run on `(log_entry->>'ts')::timestamptz`, so a `Z`-suffixed or offset-carrying entry sorts and filters by the instant it names. The writer's rendering was already pinned by a test, which is what makes the cast safe; the third rendering `todo.md` named (a fractionless timestamp) does not reproduce and is in the suite as a control. Entry removed from `todo.md`. [evidence](evidence/p2.md#p256-p264)
- [x] **P2.57** `[confirmed]` `WordPressClient.__init__` in `api/src/services/wordpress.py` appends its REST paths to the raw `wp_url` after nothing but a trailing-slash ...
- [x] **P2.58** `[confirmed]` `GET /api/profiles/{profile_id}/wordpress/categories` and `/authors` answer a 500 for every failure the WordPress install reports, because ... Fixed by P1.3a: both handlers answer a 502 carrying the install's own message, or a sentence naming the key the payload is missing; entry removed from `todo.md`. [evidence](evidence/p1.md#p13a)
- [x] **P2.59** `[confirmed]` `GET /api/profiles/{profile_id}/wordpress/test` answers a 500, not `{connected: false}`, when the configured `wp_url` serves valid JSON that is ... Fixed by P1.3a: a `/wp-json` root that is not a JSON object is reported as `{connected: false, error}` like every other failure the endpoint knows about; entry removed from `todo.md`. [evidence](evidence/p1.md#p13a)
- [x] **P2.60** `[confirmed]` `src/mastra/workflows/scaffold-check.test.ts > emits the workflow lifecycle events the trace view will read` fails inside a full `pnpm test` run ... 0 failures in six full runs after P0.2's isolation; entry removed from `todo.md`. [evidence](evidence/p0.md#p03e)
- [x] **P2.61** `[confirmed]` `markdown_to_wp_html` raises `AttributeError: No renderer "'inline_html'"` for any article whose markdown contains an HTML tag mistune's block ...
- [x] **P2.62** `[confirmed]` The TypeScript port of mistune's `linebreak` and `softbreak` inline patterns in `web/src/mastra/wordpress/wp-html.ts` still spells Python's `\s` ... Fixed: both rules read `PY_SPACE`, so a line starting with U+001C is swallowed and one starting with U+FEFF is kept, both measured through `markdownToWpHtml` before the swap. New `wp-html-inline-breaks.test.ts` carries the three cases, there being no parity corpus for these two rules. Entry removed from `todo.md`. [evidence](evidence/p2.md#p246-p253-p262-p266)
- [x] **P2.63** `[confirmed]` WordPress publishing uploads no images at all in production. The media sweep in `api/src/pipeline/publish.py` keeps a file only when ... Fixed by P1.2c-i; entry removed from `todo.md`. [evidence](evidence/p1.md#p12c-i)
- [x] **P2.64** `[confirmed]` The local-to-remote image URL rewrite in `api/src/pipeline/publish.py` corrupts a media URL that is a prefix of another one. The loop is `for ... Fixed: `rewriteImageUrls()` matches every key in one pass, longest key first, so a key that prefixes another no longer eats its prefix and a `source_url` carrying a later key is no longer rewritten twice. A deliberate divergence from the oracle, which keeps Python's recorded answer. Entry removed from `todo.md`. [evidence](evidence/p2.md#p256-p264)
- [x] **P2.65** `[investigate]` `src/mastra/workflows/pipeline-completion.test.ts > ... (`Date.parse(recorded)` at line 328) failed once in a full `pnpm test` run during ledger ... 0 failures in six full runs; entry removed from `todo.md`. [evidence](evidence/p0.md#p03e)
- [x] **P2.66** `[confirmed]` `pythonJsonDumps` in `web/src/mastra/prompts.ts` does not escape U+007F. Its regex is `[\u0080-\uffff]`, but Python's `ESCAPE_ASCII` is `[^\ ... Fixed by widening the class one code point rather than by the proposed `encodeBasestringAscii` reuse, which would mean re-implementing `json.dumps` with `indent=2`. Everything below `\x20` already agrees byte for byte, checked against CPython. Entry removed from `todo.md`. [evidence](evidence/p2.md#p246-p253-p262-p266)
- [x] **P2.67** `[investigate]` The `pg` driver parses a JSONB column with `JSON.parse`, which erases Python's int/float distinction and loses digits past 2^53 before any port ... Deleted at triage: it reproduces mechanically, but the only thing the divergence broke was byte parity against the Python stack, which no longer exists; the eleven cases stay pinned in `PARSE_DIVERGENCES`.
- [x] **P2.68** `[confirmed]` `POST /api/posts/{post_id}/publish` cannot publish a post whose `output_format` is `both`, which is the column's default value. `publish_post()` ... Fixed by closing the vocabulary rather than widening the dispatch: `both` was already gone from the defaults and the picker (`drizzle/0003`, P3.5a), so the residue was that both write boundaries took the field as `z.string()`. `src/app/api/output-format.ts` now refuses anything outside the three formats on all four post and profile write endpoints, and the publish refusal is three sentences that name neither the column nor a raw enum. The parity corpus keeps its two recorded `both` bodies and a test asserts they are now refused. Closes the copy entry that was waiting on this decision; both entries removed from `todo.md`. [evidence](evidence/p2.md#p268)
- [x] **P2.69** `[confirmed]` `web/src/mastra/pipeline-events.test.ts > a run that executes every stage > carries Python's log payload and nothing else` is flaky: it reads ... Fixed by P0.3b; entry removed from `todo.md`. [evidence](evidence/p0.md#p03b)
- [x] **P2.70** `[confirmed]` The vitest suites that borrow the global `settings.api_keys` row can destroy live credentials. `web/src/mastra/api-keys.test.ts` deletes the row ... Fixed by P0.3a; entry removed from `todo.md`. [evidence](evidence/p0.md#p03a)
- [x] **P2.71** `[confirmed]` Perplexity's Sonar Chat Completions endpoint is deprecated with support ending 2026-09-27, per `docs.perplexity.ai/getting-started/models`. The ... Closed across P2.71a (the client), P2.71b-i (the stage swap) and P2.71b-ii (the accounting); both entries removed from `todo.md`.
  - [x] **P2.71a** Reach the replacement at all. Nothing installed could: `@ai-sdk/perplexity`
        4.0.31 still builds `${baseURL}/chat/completions`, Mastra's own `perplexity-agent`
        registry entry builds an OpenAI *chat* model and 404s, and `@ai-sdk/openai`'s Responses
        schema parses `output[]` with a closed union that has no `search_results` member, so it
        would reject exactly the grounded answers this stage exists for. Added
        `web/src/mastra/perplexity/agent-api.ts`, a `LanguageModelV2` over `POST /v1/agent`,
        with a recorded live response as the mapping oracle and a live case that drives a real
        Mastra `Agent` end to end. [evidence](evidence/p2.md#p271a)
  - [x] **P2.71b** Move the `research` stage onto it. Split, because the swap is not a
        transport change: the Agent API accepts exactly one Perplexity search model and it is
        not `sonar-pro`.
    - [x] **P2.71b-i** The swap. `GET /v1/models` lists `perplexity/sonar` and no other
          Perplexity search model, and `/v1/agent` refuses every spelling of `sonar-pro`, so
          the output comparison this item was waiting on decided whether the stage could move
          at all. It can: on the stage's real prompt the Agent API answer was 22,750
          characters against 9,708, filled the same rule template, left 13 distinct source
          URLs in the saved column against 3, passed `isValidResearch`, and cost $0.0242
          against $0.0413. The agent, the allowlist, the default, `MODEL_COSTS`, the run-log
          line and the analytics model picker all moved; `storedSettings()` now falls back per
          stage so retiring an allowlist entry cannot silently discard another stage's stored
          override. [evidence](evidence/p2.md#p271b-i)
    - [x] **P2.71b-ii** The accounting gap the swap leaves. `MODEL_COSTS` prices tokens only,
          and the Agent API bills `web_search` separately at $0.0025 an invocation. Fixed by
          carrying the provider's own price rather than by adding a fee column: the adapter
          puts `usage.cost` on `providerMetadata` (both `doGenerate` and the stream's `finish`
          part), `researchStep` sums it across attempts onto a new optional `reportedCostUsd`,
          and `stageCostUsd()` prices a stage at a reported number when it has one. Measured
          live at $0.016587 estimated against a $0.01909 bill, the whole $0.0025 gap being one
          search. Four Claude stages and the Gemini stage still estimate, because their
          providers report no price. [evidence](evidence/p2.md#p271b-ii)
- [x] **P2.72** `[confirmed]` The Playwright suite (`pnpm -C web test:e2e`) is stale. A full run during ledger item 7.1b ended `4 passed (7.4m)` with failures listed across ... Fixed across P0.5a, P0.5b and P0.5c: 34 passed / 0 failed, twice; entry removed from `todo.md`. [evidence](evidence/p0.md#p05c)
- [x] **P2.73** `[confirmed]` `src/mastra/workflows/scaffold-check.test.ts` fails intermittently under a full `pnpm -C web test` run with `Error: Hook timed out in 60000ms` ... 0 failures in six full runs after P0.2's isolation; entry removed from `todo.md`. [evidence](evidence/p0.md#p03e)
- [x] **P2.74** `[confirmed]` A worker process running outside the test suite breaks the suite. While a `jena-worker` container was up against the shared dev Redis, a full ... Contradicted: three worker-up runs are identical to three worker-down runs; entry removed from `todo.md`. [evidence](evidence/p0.md#p03e)
- [x] **P2.75** `[investigate]` `next build` inside the web image prints seven `[Error [BetterAuthError]: You are using the default secret...]` lines plus a matching BetterAuth ... Fixed with P2.28: the builder stage carries build-only `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` placeholders beside the database and Redis ones, and no runtime stage inherits either. Image build verified clean. [evidence](evidence/p2.md#p228-p254-p275)
- [x] **P2.76** `[confirmed]` Generated images are unreachable from the `web` service on Railway. The `/media` volume is mounted on `worker`, which writes them, but Railway ... Fixed by P1.2c-ii; entry removed from `todo.md`. [evidence](evidence/p1.md#p12c-ii)
- [x] **P2.77** `[confirmed]` Nothing runs database migrations on deploy. `deploy.preDeployCommand` is the documented Railway hook, but neither runtime image carries ... Split, because a pre-deploy hook pointed at a script nothing has ever executed fails the deploy rather than migrating anything.
  - [x] **P2.77a** The commands have to run at all. `pnpm auth:migrate` had been dead since
        `c24f196` (P2.28) added a `@/`-aliased import to `src/lib/auth.ts`, which the script
        loads under bare node: `ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'`. Fixed by
        importing the sibling relatively and with the real extension, the spelling
        `tsconfig.json`'s `allowImportingTsExtensions` comment already names. `src/db/migration-scripts.test.ts`
        now runs both documented commands as commands against a scratch database, which is the
        thing `baseline-parity.test.ts` cannot do: it calls `migrate()` as a library and stayed
        green through the whole outage. [evidence](evidence/p2.md#p277a)
  - [x] **P2.77b** Ship them and run them. Split again, because the image change was the only
        part the rest depends on and it had a wrong answer in it.
    - [x] **P2.77b-i** A migration command a runtime image can run. `pnpm db:migrate` was
          `drizzle-kit migrate`, a devDependency installed in no runtime stage, so it is now
          `scripts/migrate.mjs` over `drizzle-orm`'s own migrator: one implementation for the
          dev command and the deploy hook, proven to write the same
          `drizzle.__drizzle_migrations` rows as drizzle-kit in both directions. The ORM is
          copied into the image by the Dockerfile rather than named in
          `outputFileTracingIncludes`, which Next expands against all sixteen aliases of the
          package in pnpm's virtual store and takes `.next/standalone` from 151MB to 426MB.
          Run inside the built image against a real Postgres. [evidence](evidence/p2.md#p277b-i)
    - [x] **P2.77b-ii** Run it on deploy. `preDeployCommand` on **both** services runs
          `node scripts/predeploy.mjs`, which applies the `drizzle/` migrations, the BetterAuth
          tables and the `mastra_*` run-state tables under one lock, so P2.99 closes with it:
          a hook on `web` alone leaves `worker` starting into the same first-init race. The
          BetterAuth half is bundled rather than vendored, because `better-auth` sits under
          `.pnpm/` with no top-level entry and `@better-auth/stripe`, `stripe`, `resend` and
          `@mastra/pg` are compiled into the server chunks; `pnpm build` writes one 7.5MB
          esbuild output into the standalone tree. The obvious `pg_advisory_lock` deadlocks
          against `@mastra/pg`'s `CREATE INDEX CONCURRENTLY`, so the lock is polled with
          `pg_try_advisory_lock`. [evidence](evidence/p2.md#p277b-ii)
- [x] **P2.78** `[confirmed]` `scaffold-check.test.ts > emits the workflow lifecycle events the trace view will read` fails under a full parallel `pnpm -C web test` while ... 0 failures in six full runs after P0.2's isolation; entry removed from `todo.md`. [evidence](evidence/p0.md#p03e)
- [x] **P2.79** `[confirmed]` The objective's literal typecheck gate `pnpm -C web tsc --noEmit` does not run on the installed pnpm (10.26.2): it exits 254 with ... Closed in the **P2.C1** batch: typechecking is a `typecheck` script, so every gate takes the `-C` form, and CI and both doc gate blocks call it. [evidence](evidence/p2.md#p2c1)
- [x] **P2.80** `[confirmed]` The 6 failing tests in `web/src/components/__tests__/image-preview.test.tsx`. The same finding as P0.1, removed from `todo.md`. [evidence](evidence/p0.md#p01)
- [x] **P2.81** `[confirmed]` The app has no theme switch: `web/src/app/layout.tsx:28` hardcodes `<html lang="en" className="dark">` and no `ThemeProvider` is mounted ... Deleted at triage: dark mode is explicitly out of scope for this run. The product is dark-only and that is a `docs/polish/SUMMARY.md` gap line, not an item.
- [x] **P2.82** `[investigate]` `pnpm -C web dev` serves the repo's own `media/` directory, but the item 7.6 end-to-end run executed in the compose stack and wrote its five ... Deleted at triage: superseded by the `post_media` mirror (P1.2c-ii). Only images generated before that mirror existed are affected, and re-running the images stage makes them viewable from either process.
- [x] **P2.83** `[investigate]` `GET /api/posts` answers `500` with an empty body when its database is unreachable (verified by stopping the compose `db` container under a live ... Reproduced without stopping anything (`?q=%00`, a NUL byte Postgres refuses) and fixed for every handler: App Router has no error boundary for route handlers, so `withServerError` in `src/lib/route-error.ts` wraps all 55 of them, answering Starlette's own `{"detail": "Internal Server Error"}` and putting the cause in the log rather than the body. A guard test asserts every `route.ts` is wrapped. [evidence](evidence/p2.md#p283)
- [x] **P2.84** `[confirmed]` `/posts/[id]` names two of the six stages twice: the tab strip in `web/src/app/posts/[id]/page.tsx` labels them "Draft" and "Editing" while the ... Seven surfaces each arrived at a stage's name their own way, four through a private label map and three through a CSS `capitalize` on the enum, so two of them drifted. `src/lib/stages.ts` is the one owner and a guard test fails on a second map; the e2e suite had encoded the divergence as two lists. Entry removed from `todo.md`. [evidence](evidence/p2.md#p284)
- [x] **P2.85** `[confirmed]` The `posts.stage_logs` column is write-only dead weight in the ported stack: the only key anything writes is `_error` ... Deleted at triage: a write-only column is dead weight, not a defect; dropping it is a post-run schema change with no correctness or user-visible effect, recorded as a `SUMMARY.md` gap.
- [x] **P2.86** `[confirmed]` `web/e2e/navigation.test.ts:56` asserts a "Pipeline Settings" card on `/posts/new` and no such card exists in `web/src/app/posts/new/page.tsx` ... Fixed by P0.5a: the assertion is removed, and the real hole it was describing (no per-post stage-gate editor anywhere on `/posts/new`, while `/profiles/[id]` and `/posts/batch` both have one) is recorded for P3.1; entry replaced in `todo.md`. [evidence](evidence/p0.md#p05a)
- [x] **P2.87** `[confirmed]` `POST /api/profiles` accepts any string as `website_url`: creating a profile with the literal value `not a url` succeeded during item 8.6's live ...
- [x] **P2.88** `[confirmed]` `pnpm -C web test` is not deterministic above the known `image-preview.test.tsx` baseline: one extra database-backed test fails per full-suite ... Six identical summaries; entry removed from `todo.md`. [evidence](evidence/p0.md#p03e)
- [x] **P2.89** `[confirmed]` The global `stage_models` row is borrowed the way `api_keys` used to be: three files hold the pre-borrow value in memory and write it back in `afterAll`, so a killed run loses it. Same shape P0.3a fixed for `api_keys`; move it onto `web/src/test/borrowed-rows.ts`, which first needs to carry `updated_at`. Done: the helper carries the stamp (through the backup row as an ISO string, since `jsonb` has no date type, and it matters because `GET /api/settings` serves `updated_at` for every row), `stage-models-row.ts` is a borrow rather than a bare lock, and the three borrowers lost their snapshot variables. Measured against a planted row and against the rows a killed borrower leaves: the next run repairs the row instead of adopting the placeholder. `row-lock.ts` now has one importer and a guard test says so. The move turned up six suites under `src/mastra/agents/` that read the global row with no borrow at all and assert on the default it resolves to: they now borrow it with a new `clear` option, since the borrow alone still leaves whatever a human put in the row (11 failures on a planted operator row, 0 after). [evidence](evidence/p2.md#p289)
- [x] **P2.90** `[confirmed]` `images-manifest.test.ts > writes only the running marker` drifts 20ms under parallel load: `vi.useFakeTimers({ shouldAdvanceTime: true })` lets real elapsed time move the frozen clock, so an exact-stamp assertion is a race. Found while running P0.3d's affected suites together; belongs to P0.3e. Fixed: `shouldAdvanceTime: false`, with a test pinning the frozen clock; entry removed from `todo.md`. [evidence](evidence/p0.md#p03e)
- [ ] **P2.91** `[confirmed]` `stopWorkers()` drains the reader, not the work: a `SIGTERM` truncates the running stage and leaves its message pending, recovered only by `XAUTOCLAIM` at `RECLAIM_IDLE_MS` (15 minutes). A routine worker redeploy therefore parks any in-flight post for over fifteen minutes and then re-runs and re-bills that stage. Found by P2.21.
- [x] **P2.92** `[investigate]` One unidentified single-test failure in a full `pnpm test` run during P2.30 (`1 failed | 4932 passed`), output piped through `tail -8` so the name was lost. Five consecutive clean runs after it. Either a residual flake P0.3 did not reach or an artefact of that one run; `tee` the next full runs and name it, or delete this if it does not recur. Deleted at triage: does not reproduce. Zero failures in the six certified full runs at P0.3e and in every full run since, including the CI runs.
- [ ] **P2.93** `[confirmed 2026-08-24]` `MODEL_COSTS` prices `claude-opus-4-6` at 15.0 / 75.0 per MTok, which is that model's launch price; Anthropic publishes 5.0 / 25.0 for it now. The row was pinned value-for-value from Python so historic `stage_logs` costs would agree with the `model_costs_reference` the same response ships, but the model is on four stages' allowlists, so a run configured for it today is priced 3x over. Found by P2.38. Repricing the row rewrites what pre-cutover runs are reported to have cost, which is why it was not done inline.
- [ ] **P2.94** `[confirmed 2026-08-24]` `sitemapCrawlWorkflow`, `recrawlCheckWorkflow` and `wordpressPublishWorkflow` declare no `retryConfig`, so each gets a single attempt where Python's `WorkerSettings.max_tries = MAX_ATTEMPTS` gave all four `functions` entries three. A WordPress publish that meets one 502 fails for good. Found by P2.39.
- [ ] **P2.95** `[confirmed 2026-08-24]` P2.39's retry pause covers the eight pipeline stage steps only, because it lives in `recordStageRetry()`. `nextjsPublishWorkflow` retries three times with no gap, where Python's `retry_delay` was a worker-wide setting. Found by P2.39.

- [x] **P2.96** `[confirmed 2026-08-24]` The route error boundaries print a raw JavaScript
      exception as user-facing copy. Fixed at P3.3a; the `buildRunTrace()` half of the finding
      was measured and does not reproduce, so it was deleted rather than fixed.
      [evidence](evidence/p3.md#p33a)

- [ ] **P2.97** `[confirmed 2026-08-24]` A post created with no profile is unreachable and
      undeletable through the app. `/posts/new` offers "No profile (manual config)" and
      `POST /api/posts` accepts a null `profile_id`, but every read handler inner-joins
      `website_profiles` to reach `user_id`, so the form redirects to "Post not found" and
      `GET`/`DELETE /api/posts/{id}` both 404. Only SQL can remove the row.
- [x] **P2.98** `[confirmed 2026-08-24]` There is no surface that lists the posts waiting at a
      review gate. The queue API is real and `/monitor` shows aggregate counters, but a
      suspended post is discoverable only by opening its own detail page. Fixed at P3.2b-i:
      `GET /api/posts?awaiting_review=true` and the `Waiting for review` filter on `/`.
      [evidence](evidence/p3.md#p32b-i)
- [x] **P2.99** `[confirmed 2026-08-24]` A fresh deploy can lose a service to the `@mastra/pg`
      first-init race: `web` and `worker` both build the `mastra_*` schema on first init with
      DDL that is not concurrency-safe, and Railway starts both together. Closed with P2.77b-ii:
      `ensureMastraStorage()` moved to `src/lib/` and runs inside the pre-deploy hook, which is
      on both services precisely so no process opens a store against a database that has no
      `mastra_*` tables. [evidence](evidence/p2.md#p277b-ii)
- [ ] **P2.100** `[investigate 2026-08-24]` `pnpm auth:migrate --apply` against a fresh
      database creates no `subscription` table, though `src/lib/auth.ts` mounts the
      `@better-auth/stripe` plugin and `schema-parity.ts` names the table. Either the plugin
      only creates it with real Stripe credentials, or a fresh database is missing a table the
      billing path queries at runtime.
- [ ] **P2.101** `[confirmed 2026-08-24]` Next 16 deprecates the `middleware` file convention
      and says so on every dev boot. `web/src/middleware.ts` is the only thing between an
      anonymous request and every page, so the rename to `proxy` has to be deliberate, with
      the e2e signed-out redirect test as the guard.
- [ ] **P2.102** `[confirmed 2026-08-24]` Signing up logs a BetterAuth ERROR on every account
      when `STRIPE_SECRET_KEY` is unset: the mock key in `src/lib/auth.ts` reaches Stripe's
      API rather than short-circuiting. The sign-up succeeds, so it is noise, but it is an
      ERROR line on the happy path of the first thing a user ever does.
- [ ] **P2.103** `[investigate 2026-08-24]` CI skips 10 tests where a local run skips 7. The
      three extra are the suites gated on a provider key, which CI has no value for, so the
      real Perplexity, Anthropic and Gemini call paths are the one part of the suite CI cannot
      certify. Decide deliberately: repository secrets on the default branch, or say so in
      `SUMMARY.md`.
- [ ] **P2.104** `[confirmed 2026-08-24]` The PWA has no maskable icon. `manifest.json` now
      declares `"any"`, which is truthful, but an installed app gets the platform's white
      badge behind the mark instead of the mark filling the tile. Needs a second full-bleed
      render of the mark at 192 and 512.
- [x] **P2.105** `[investigate 2026-08-24]` `web/public/` carries five unreferenced Next.js
      starter assets (`next.svg`, `vercel.svg`, `file.svg`, `globe.svg`, `window.svg`), served
      as public routes and shipped in the Docker image. Reproduced by repo-wide grep and
      deleted in the **P2.C1** batch, along with `icon.png`, an 11KB byte-duplicate of the 512
      manifest icon that the new `public/` guard found. [evidence](evidence/p2.md#p2c1)
- [x] **P2.106** A full run stamps `current_stage = "complete"` and `completed_at` even when a
      stage inside it failed, and both summary surfaces read that column alone. Closed at
      P3.2a: `deriveRunState()` reads `current_stage` and `stage_status` together and such a
      run reads `Finished with errors` with a banner naming the stage, its reason and a retry.
      The write is unchanged and still stamps `complete`. [evidence](evidence/p3.md#p32a)
- [ ] **P2.107** `[confirmed 2026-08-24]` `wp_url` accepts a URL carrying credentials
      (`https://user:pass@example.com`), so a password can land in `website_profiles.wp_url`,
      which is stored in plain text while `wp_app_password` is Fernet-encrypted.
- [x] **P2.108** `[confirmed 2026-08-24]` The run trace does not render publish events.
      `RunTrace` reads `execution_logs` by `stage` and both publish steps write theirs with
      `stage: ""`, so `publish_start`, `publish_complete` and `publish_error` are invisible in
      the one view built for watching a run. Closed at P3.2b-ii, which also found that neither
      step wrote a `publish_start` entry and that Next.js wrote none on success.
      [evidence](evidence/p3.md#p32b-ii)
- [ ] **P2.109** `[confirmed 2026-08-24]` A run parked at a review gate can never be resumed:
      nothing in the app calls `run.resume()`. The only way forward the UI offers starts a
      *new* run, so the suspended run stays in `mastra_workflow_snapshot` forever while a
      second run redoes the chain. A gate approval route has to poll `getWorkflowRunById`
      rather than await the resume, for the reason `evented-resume.test.ts` pins. Carries the
      deleted P2.40: the engine's retry branch does not carry `resumeData` forward, so a step
      that throws after approval may re-suspend at the same gate.
- [ ] **P2.110** `[confirmed 2026-08-24]` Five of the seven workflow registration keys in
      `web/src/mastra/index.ts` differ from the workflow's own `id`, and a resume resolves by
      id, so those five would answer `MASTRA_GET_WORKFLOW_BY_ID_NOT_FOUND` the moment a step
      in them suspends. Latent today; blocks P2.109.
- [x] **P2.111** `/posts/new` had no per-post pipeline configuration, so a post created on the
      single-post form silently took the profile's gates. Closed at P3.1a with a read-only
      `Pipeline` card that names what each of the six stages will do and links to the profile
      that owns the gates; a per-post editor is not possible while P2.114 stands.
      [evidence](evidence/p3.md#p31a)
- [x] **P2.112** `ImagePreview` renders `placement.location` as the raw enum. Fixed at P3.3b
      along with the rest of that class. [evidence](evidence/p3.md#p33b)
- [x] **P2.113** `both` was the `output_format` column default on both `website_profiles` and
      `posts` and not one of the three `OUTPUT_FORMATS` offers, so a row holding it rendered
      the picker with no label at all. Observed in the browser at P3.5a on three real
      profiles, not only in theory. `both` is a default that should never have been `both`:
      it names no destination any publish step handles. `drizzle/0003` moves both defaults to
      `markdown` and rewrites the rows; the picker also names an unoffered value rather than
      rendering nothing, because the column takes any string. [evidence](evidence/p3.md#p35a)
- [ ] **P2.115** `[confirmed 2026-08-24]` Pausing is a label, not a control signal: the pause
      route writes `current_stage = "paused"` and nothing else, and no worker reads it, so the
      running stage finishes and the next one starts. `deriveRunState()` puts `paused` above
      the stage map (a pause leaves a stale `running` entry behind), so the badge now says
      `Paused` over a stage that is still billing. Found by P3.2a.
- [ ] **P2.114** `[confirmed 2026-08-24]` `applyProfilePrefill` makes a per-post gate edit
      unexpressible: it copies the profile's `default_stage_settings` over any submitted
      `stage_settings` equal to the schema default, and that default is six `auto`s, so
      clearing every gate for one post is silently written back to the profile's gates. A
      faithful port of Python's rule that the parity oracle asserts, so changing it is a
      deliberate deviation. Found under P3.1a.
- [x] **P2.C1** Cleanup batch, one iteration for both: P2.79 (no `typecheck` script in
      `web/package.json`, so the objective's literal `pnpm -C web tsc --noEmit` exits 254) and
      P2.105 (five unreferenced starter assets). P2.53 and P2.66 were the other two members
      and were closed with P2.46 and P2.62 instead, that batch being the topmost four
      unchecked entries rather than the bottom four. Both guarded: `src/gate-commands.test.ts`
      holds every documented `pnpm -C web` form to a real script, and `brand-mark.test.ts`
      holds `public/` to files the app actually names. [evidence](evidence/p2.md#p2c1)

## Done

- [ ] `cd web && pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm test`, `pnpm build` all exit 0
      with zero failing tests, three runs with identical results, worker running and not.
      True as measured at P0.3e ([evidence](evidence/p0.md#p03e)); left unchecked because it is
      an acceptance condition for the finished run and has to be re-measured at the end.
- [ ] `pnpm test:e2e` passes. True as measured at P0.5c
      ([evidence](evidence/p0.md#p05c)); left unchecked because it is an acceptance condition
      for the finished run and has to be re-measured at the end.
- [ ] CI green on a real run, URL in the evidence. Met at P0.6b-ii:
      [run 32693869900](https://github.com/upnorthmedia/pipeline/actions/runs/32693869900),
      all five gates plus the clean-tree check, nothing flaky
      ([evidence](evidence/p0.md#p06b-ii)); left unchecked like its siblings because the
      condition is about the finished run and every later commit has to stay green.
- [ ] `pnpm test` leaves the working tree clean. True as measured at P0.4
      ([evidence](evidence/p0.md#p04)); left unchecked because it is an acceptance condition
      for the finished run and has to be re-measured at the end.
- [ ] The logo renders, verified by committed screenshot.
- [ ] No broken image is reachable in the UI, and a failed image reads as a failure with a
      reason and a retry.
- [ ] WordPress publishing works end to end against a real site, or every layer below the
      credential boundary is proven with real request assertions and the gap is stated.
- [ ] A user can find and test a publishing connection without being told where it is.
- [ ] `todo.md` holds no `[confirmed]` item affecting correctness, data integrity, security or
      the visible product.
- [ ] `docs/polish/SUMMARY.md` exists with an honest gap list. Four gaps are already owed to
      it by the 2026-08-24 P2 triage (dark-only product, the dead `posts.stage_logs` column,
      `web/src/` shipped in the production image, one Redis connection per open tab):
      [evidence](evidence/p2.md#p2-triage).
