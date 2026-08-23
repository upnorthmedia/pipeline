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

## 8.2

`/` (the dashboard home) is the posts list: there is no `/posts` route, only `/posts/new`,
`/posts/batch` and `/posts/[id]`.

```
$ find web/src/app -name page.tsx | sort
web/src/app/auth/[path]/page.tsx
web/src/app/monitor/page.tsx
web/src/app/page.tsx
web/src/app/posts/[id]/page.tsx
web/src/app/posts/batch/page.tsx
web/src/app/posts/new/page.tsx
web/src/app/profiles/[id]/page.tsx
web/src/app/profiles/page.tsx
web/src/app/settings/page.tsx
```

### What the four states were before

Loading and success existed. Empty and error did not, in a way that mattered:
`fetchPosts()` caught every failure into `toast.error("Failed to load posts")` and left
`postList` empty, so a failed load rendered the empty state. The page told a user whose
request had just 500'd that they had no posts and offered them "Create your first post". The
same copy also served a filter that matched nothing, so three different situations rendered
one screen.

### Tests first

The five new or changed cases in `web/src/app/PostsList.test.tsx` against the unchanged page:

```
$ pnpm -C web test --run src/app/PostsList.test.tsx
      Tests  5 failed | 11 passed (16)
 × shows empty state when no posts
 × tells a filtered empty result apart from an empty account
 × shows the server's own message and a retry when the list fails
 × falls back to its own wording when the failure carries no message
 × counts one post without a plural
```

After the change:

```
$ pnpm -C web test --run src/app/PostsList.test.tsx
 ✓ src/app/PostsList.test.tsx (16 tests) 487ms
 Test Files  1 passed (1)
      Tests  16 passed (16)
```

The pre-existing `act(...)` warning in "shows loading skeletons initially" is gone too: the
profile list resolved after the test body finished and set state outside `act`, so that test
now leaves both requests pending.

### The states, live

`pnpm -C web dev` on :3000 against the compose `db` and `redis`, driven with
`npx -y chrome-devtools-axi`. Signed in through the real form as two users: the owner of the
one post from item 7.6, and a second user who owns no profiles and so sees no posts.

Success and the count, read out of the page as the post's owner:

```
$ npx -y chrome-devtools-axi eval '() => document.body.innerText.slice(100,400)'
atch\nNew Post\nAll Posts\nAll profiles\n\tTopic\tStage\tProgress\tPri\tCreated\t\n\t\n
How small businesses choose a local SEO agency\n
how-small-businesses-choose-a-local-seo-agency\n\n\tCOMPLETE\t\n6/6\n\t0\t1h ago\t
```

with the header line reading `1 total post`, not `1 total posts`.

Empty, as the user who owns nothing:

```
No posts yet
Every post starts here and runs the six pipeline stages.
Create your first post
```

Filtered empty, after typing a search that matches nothing:

```
No posts match these filters
Widen the search or the status and profile filters.
Clear filters
```

Error, produced by stopping the database container under a live page and clicking Refresh:

```
$ docker stop objective-port-jena-46c1e6-1-db-1
$ npx -y chrome-devtools-axi eval '() => { ...aria-label="Refresh posts"...click() }'
$ npx -y chrome-devtools-axi eval '() => document.body.innerText.slice(0,600)'
Posts\n\nPost list unavailable\n...\nCould not load posts\n
The request failed and the server gave no reason.\n\nRetry
```

The route answers a 500 with an empty body when its database is gone, which is why the
fallback wording is what the page shows here rather than a message of the server's own:

```
$ npx -y chrome-devtools-axi eval '() => fetch("/api/posts").then(async r => ({status: r.status, body: (await r.text()).slice(0,180)}))'
{"status":500,"body":""}
```

The `{"detail": ...}` path is covered by the test above. Starting the database and clicking
`Retry` in the page recovered it with no reload:

```
$ docker start objective-port-jena-46c1e6-1-db-1
$ npx -y chrome-devtools-axi eval '() => { ...textContent==="Retry"...click() }'
$ npx -y chrome-devtools-axi eval '() => document.body.innerText.slice(100,400)'
No posts yet\n\nEvery post starts here and runs the six pipeline stages.\n\nCreate your first post
```

Loading, captured by making `/api/posts` hang and clicking Refresh, which is also the proof
that the skeletons are now reachable from a refresh and a retry and not only from first mount:

```
Posts\n\nLoading posts...\n\nBatch\nNew Post\nAll Posts\nAll profiles\n\tTopic\tStage\tProgress\tPri\tCreated\t\n\n\t\n\t\n\t\n\t\n\t\n\t\n
```

### Screenshots

Before pairs were captured by checking out `git show HEAD:web/src/app/page.tsx` over the file
with the dev server hot-reloading, driving the same four situations, then restoring the new
version.

| File | State |
| --- | --- |
| `ui/8.2-posts-success-{before,after}.png` | one post, header count singular in the after |
| `ui/8.2-posts-empty-{before,after}.png` | user who owns no posts |
| `ui/8.2-posts-empty-filtered-{before,after}.png` | search matching nothing |
| `ui/8.2-posts-error-{before,after}.png` | database stopped under the page |
| `ui/8.2-posts-loading-after.png` | `/api/posts` hanging |

`8.2-posts-empty-before.png` and `8.2-posts-error-before.png` are byte-identical
(`md5 62ff2c7da1705dbfa2c3b5059dacd235` for both). That is the finding, not a capture
mistake: the old page rendered a failed load and an empty account as the same screen.

### Console

The page had one open Chrome issue before this change, "A form field element should have an
id or name attribute", from the two unnamed row checkboxes and the unlabelled search box.
With `name` and `aria-label` on all three:

```
$ npx -y chrome-devtools-axi console
console:
## Console messages
<no console messages found>
$ npx -y chrome-devtools-axi stop
status: stopped
```

### Gates

```
$ pnpm -C web exec tsc --noEmit
exit=0

$ pnpm -C web lint
exit=0

$ pnpm -C web test
 Test Files  2 failed | 136 passed (138)
      Tests  9 failed | 4545 passed | 7 skipped (4561)

$ pnpm -C web build
build exit=0
```

The 9 failures are the standing baseline (6 in `image-preview.test.tsx`, 3 in
`PostDetail.test.tsx`); the passing count rises by 4, which is the four new cases (the fifth
red case before the change was the existing empty-state test, whose copy this item changed
from "No posts found" to "No posts yet" so that it no longer doubles as the failure state).
`pnpm -C web build` prints
15 `BetterAuthError: You are using the default secret` lines, which are pre-existing: this
worktree's `.env` has no `BETTER_AUTH_SECRET` (`grep -c` returns 0) and `.env.example`
documents it.
