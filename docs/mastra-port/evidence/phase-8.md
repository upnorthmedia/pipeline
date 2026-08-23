# Phase 8 evidence

## 8.1

The run trace view on `posts/[id]`.

### What landed

`web/src/lib/run-trace.ts` (`buildRunTrace`) folds a post's `execution_logs` column and its
`stage_status` map into one row per pipeline step, and `web/src/components/run-trace.tsx`
renders them as a table on the post detail page above the stage tabs, with the run totals in
the card header.

The numbers are Mastra's own usage accounting. Every stage step reads `result.usage` off the
agent's answer (`web/src/mastra/steps/research.ts:158` and its siblings) and
`announceStageComplete()` (`web/src/mastra/steps/stage-io.ts:400`) writes `model`,
`tokens_in`, `tokens_out`, `duration_s` and `cost_usd` into `execution_logs`, which
`GET /api/posts/{id}` serves through. The trace reads the row rather than subscribing to
Mastra's per-run stream because the steps execute in the `worker` service while the dashboard
is served by `web`, and Mastra's per-run watch events are published `localOnly` and never
reach Redis (the note at the top of `web/src/mastra/pipeline-events.ts` records the
measurement behind that). What makes the view live is the SSE feed: the page already refetches
the post on `stage_complete`, `stage_error` and `pipeline_complete`, and now also records the
stage of each `stage_start` frame so the elapsed clock can start before the refetch that would
reveal the matching row entry.

Supporting changes:

* `StageStatus` in `web/src/lib/api.ts` gains `"review"`. `markStageForReview()` has always
  written it; the union omitted it because every reader looked the value up through a
  `Record<string, ...>` with a fallback. The trace has to tell a suspension apart from a stage
  that has not started.

### A defect the live run found

The first live rerun showed `Ready | Running | claude-opus-5 | 33.3s | 8,961 / 3,113 | $0.37`:
the status was current and every number beside it belonged to the attempt before. `POST /rerun`
resets a stage and everything downstream to `pending` and clears their content columns, but
`execution_logs` is append-only, so the superseded `stage_complete` entry is still the last
thing the log says about that stage. `buildRunTrace` now drops a measurement the row has since
disowned: if a stage's most recent log event is `stage_complete` while `stage_status` no longer
calls it `complete` or `failed`, the model, tokens, duration, cost and start time go with it.
Without that the rerun's cost would also have been counted into the run total twice.

Covered by `drops a completed stage's numbers once a rerun resets it to pending` and
`drops them for a stage the row already calls running again` in
`web/src/lib/run-trace.test.ts`.

### Tests

```
$ pnpm -C web exec vitest run src/lib/run-trace.test.ts src/components/__tests__/run-trace.test.tsx
 ✓ src/lib/run-trace.test.ts (17 tests)
 ✓ src/components/__tests__/run-trace.test.tsx (10 tests)

 Test Files  2 passed (2)
      Tests  27 passed (27)
```

Mutation check on the one piece of logic that is not a straight read, the rule that separates
an engine retry from a rerun. Replacing
`restartStage(row, ts, lastEventFor.get(entry.stage) === "retry")` with
`restartStage(row, ts, false)`:

```
     ✓ returns one pending row per stage for a post that has never run
     ...
     × keeps retries recorded before the attempt they caused
     ✓ drops a previous run's retries and numbers when the stage is started again
```

### Live run against the real worker

`pnpm -C web dev` on :3000, `pnpm -C web worker` against the compose `db` and `redis`, signed
in through the real sign-in form as the owner of post
`272e38d1-bed9-4237-a48d-bda64aed9795` (the end-to-end run from item 7.6, 47 execution log
entries).

Completed run, read out of the rendered page:

```
$ npx -y chrome-devtools-axi eval '() => { const t=document.body.innerText; const i=t.indexOf("Run Trace"); return t.slice(i,i+520) }'
Run Trace
72,037 tokens   $2.62   6m 24s
Step        Status     Model              Time     Tokens in / out   Cost
Research    Complete   sonar-pro          1m 13s   1,383 / 4,522     $0.36
Outline     Complete   claude-opus-5      1m 8s    9,702 / 5,125     $0.53
Write       Complete   claude-opus-5      26.6s    7,327 / 2,374     $0.29
Edit        Complete   claude-opus-5      1m 15s   10,731 / 7,154    $0.70
Images      Complete   claude-opus-5      1m 44s   8,267 / 2,949     $0.35
Ready       Complete   claude-opus-5      37.9s    8,961 / 3,542     $0.40
```

Live, during a `Rerun Stage` click that re-ran `ready` in the worker. The stage shows no
numbers because it has none yet, and the clock counts up between two reads eight seconds
apart:

```
Ready   Running   -   12.0s   -   -
Ready   Running   -   20.0s   -   -
```

and the totals over that window excluded the disowned stage (`59,534 tokens  $2.22  5m 47s`),
then returned to the full run once `ready` finished with the new attempt's own numbers. The
second rerun's `ready` measured 37.9s / 8,961 / 3,542 / $0.40 against the first run's
33.3s / 8,961 / 3,113 / $0.37, so these are the current attempt's figures and not a cached
copy.

Screenshots, all of the same post and the same viewport:

* `docs/mastra-port/ui/8.1-post-detail-before.png`, the page at HEAD with no trace
* `docs/mastra-port/ui/8.1-post-detail-running.png`, `ready` running with the elapsed clock
* `docs/mastra-port/ui/8.1-post-detail-after.png`, the completed run
* `docs/mastra-port/ui/8.1-post-detail-after-light.png`, the same page with the `dark` class
  removed from `<html>`

`web/src/app/layout.tsx:28` hardcodes `<html lang="en" className="dark">`, so the app has no
theme switch and the first three shots are its only appearance. The fourth was taken by
removing that class by hand, which is the only way to reach the light token set today; both
render legibly. There is no `ThemeProvider` mounted anywhere in the app (`next-themes` is
imported only by `web/src/components/ui/sonner.tsx`), which item 8.10 will have to deal with.

### Console

```
$ npx -y chrome-devtools-axi console --type error
msgid=29 [error] Failed to load resource: the server responded with a status of 404 (Not Found) (0 args) [22 times]
```

The only errors, and they pre-date this change: they are the four generated images embedded in
the ready preview.

```
$ npx -y chrome-devtools-axi eval '() => { const imgs = Array.from(document.images).map(i => ({src: i.currentSrc || i.src, ok: i.naturalWidth > 0})); return JSON.stringify(imgs.filter(i => !i.ok)) }'
[{"src":"http://localhost:3000/media/272e38d1-.../local-seo-service-components.webp","ok":false},
 {"src":"http://localhost:3000/media/272e38d1-.../seo-budget-tiers.webp","ok":false},
 {"src":"http://localhost:3000/media/272e38d1-.../agency-vetting-questions.webp","ok":false},
 {"src":"http://localhost:3000/media/272e38d1-.../ninety-day-timeline.webp","ok":false}]
```

The run in item 7.6 executed in the compose stack and wrote them to the compose `media`
volume; this session's `pnpm -C web dev` serves the repo's own `media/` directory, which holds
other posts' images and not these. Logged in `todo.md`.

The bridge was stopped with `npx -y chrome-devtools-axi stop` (`status: stopped`), and the
dev server and worker were killed.

### Gates

```
$ pnpm -C web exec tsc --noEmit
tsc exit=0

$ pnpm -C web lint
lint exit=0

$ pnpm -C web test
 Test Files  2 failed | 136 passed (138)
      Tests  9 failed | 4541 passed | 7 skipped (4557)

$ pnpm -C web build
build exit=0
```

The 9 failures are the standing baseline recorded in `todo.md` and ledger item 9.1: 6 in
`image-preview.test.tsx` and 3 in `PostDetail.test.tsx`. Re-run alone after this change,
`PostDetail.test.tsx` still fails on exactly the recorded three and for the recorded reasons:

```
$ pnpm -C web exec vitest run src/app/posts/PostDetail.test.tsx
 FAIL  src/app/posts/PostDetail.test.tsx > PostDetailPage > renders stage tabs
 FAIL  src/app/posts/PostDetail.test.tsx > PostDetailPage > shows Run Next and Run All buttons when not running or complete
 FAIL  src/app/posts/PostDetail.test.tsx > PostDetailPage > renders stage logs when present
TestingLibraryElementError: Unable to find an element with the text: Run Next.
TestingLibraryElementError: Unable to find an element with the text: Execution Logs.
      Tests  3 failed | 12 passed (15)
```
