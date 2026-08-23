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

## 8.3

`/posts/[id]`: loading, empty, error and success states, plus the visual hierarchy and
spacing pass.

### What landed

| Change | File |
| --- | --- |
| A load failure now stays on the post and shows the server's message with a Retry, instead of raising a toast and pushing the browser to `/` | `web/src/app/posts/[id]/page.tsx` |
| A failed *refetch* over a page that already has a post shows a banner above the content rather than replacing it | `web/src/app/posts/[id]/page.tsx` |
| One skeleton for both waits: the route's `loading.tsx` and the page's own client fetch | `web/src/app/posts/[id]/post-detail-skeleton.tsx`, `loading.tsx`, `page.tsx` |
| A post that has never run gets a real empty state with the action that fills it (**Run Pipeline**, `POST /run`) in place of six disabled tabs and "No research content yet" | `web/src/app/posts/[id]/page.tsx` |
| The analytics fetch no longer swallows its failure; it renders an error card with a Retry | `web/src/app/posts/[id]/page.tsx` |
| The dead "Cost Tracking" card removed: it reads `stage_logs`, which the ported pipeline never writes except the `_error` key the card filters out | `web/src/app/posts/[id]/page.tsx` |
| Card rhythm made consistent: `gap-0 py-0` on the section cards so the header/rule/content spacing is the card's own 12/16px and not the shadcn default's 24px bands | `page.tsx`, `web/src/components/run-trace.tsx` |
| The six pipeline-progress circles carry their stage name and status as an `aria-label`; they were six unnamed buttons whose label existed only in a hover tooltip | `web/src/components/pipeline-progress.tsx` |

### The removed card was dead, not redundant

`stage_logs` on the post the ported pipeline ran end to end in item 7.6:

```
$ psql -tAc "select stage_logs::text, jsonb_typeof(stage_logs) from posts
             where id='272e38d1-bed9-4237-a48d-bda64aed9795'"
{}|object
```

Nothing in the TypeScript stack writes a stage key to that column:

```
$ grep -rn "stageLogs" web/src --include='*.ts' --include='*.tsx' | grep -v "\.test\."
web/src/app/api/posts/query.ts:71:  ["stage_logs", posts.stageLogs],
web/src/app/api/posts/serialize.ts:115:    stage_logs: row.stageLogs ?? {},
web/src/app/api/posts/[id]/restart/route.ts:65:      stageLogs: {},
web/src/mastra/dead-letter.ts:199:        sql`jsonb_exists(coalesce(${posts.stageLogs}, '{}'::jsonb), '_error')`,
web/src/mastra/post-state.ts:309:      stageLogs: sql`coalesce(${posts.stageLogs}, '{}'::jsonb) || ${JSON.stringify({ _error: error })}::jsonb`,
web/src/mastra/post-state.ts:355:const dropErrorLog = sql`coalesce(${posts.stageLogs}, '{}'::jsonb) - '_error'`
web/src/mastra/post-state.ts:380:      stageLogs: dropErrorLog,
web/src/mastra/post-state.ts:403:    .set({ stageLogs: dropErrorLog, updatedAt: new Date() })
web/src/db/schema.ts:143:    stageLogs: jsonb("stage_logs").$type<Record<string, unknown>>().default({}),
```

The only key the port ever writes there is `_error`, and the card rendered
`Object.keys(post.stage_logs).filter(k => !k.startsWith("_"))`, so it could not have drawn a
row for any post this stack produces. The numbers it used to show are in the run trace from
item 8.1, cross-checked against `stage_status`, which the card was not.

### Red then green

Against the page as it was at `7a5c765` (`git show HEAD:page.tsx > page.tsx`), with the new
test file in place:

```
$ pnpm -C web test --run src/app/posts/PostDetail.test.tsx
     x offers Run Pipeline on a post that has never run
     x reports per-stage cost through the run trace
     x shows the server's message and a working retry when the load fails
     x falls back to its own wording when the failure carries no message
     x keeps the post on screen when a refetch fails and offers a retry
     x shows an analytics error with a retry when analytics fails
 Test Files  1 failed (1)
      Tests  6 failed | 12 passed (18)
```

With the change in place:

```
$ pnpm -C web test --run src/app/posts/PostDetail.test.tsx
 Test Files  1 passed (1)
      Tests  18 passed (18)
```

Three of those 18 were the standing `PostDetail.test.tsx` failures recorded in `todo.md`, and
all three were expectation drift this item resolves rather than silences:

| Test | Was | Now |
| --- | --- | --- |
| `renders stage tabs` | asserted a tab named "Final"; no such label exists (the label is "Editing"), and after 8.1 `getByText("Research")` also matched the run trace's own table cell | asserts by `getByRole("tab", ...)` with the labels the page actually renders |
| `shows Run Next and Run All buttons ...` | those two buttons were deleted pre-port in `e9311cc` | asserts the **Run Pipeline** empty state this item adds, on the same never-run fixture |
| `renders stage logs when present` | asserted a card headed "Execution Logs"; the card was headed "Cost Tracking" and is now removed as dead | asserts the same numbers through the run trace, and that no "Cost Tracking" card remains |

### The four states, live

Dev server on :3000 against the compose `db`/`redis`, signed in through the real sign-in form.
The empty state needed a post nothing had ever executed against, which post creation cannot
produce (`POST /api/posts` starts the pipeline), so one was inserted directly:

```
$ psql -c "insert into posts (...) values ('11111111-1111-4111-8111-111111111111',
           'never-run-empty-state', ...)"
INSERT 0 1
```

**Error.** With `db` stopped, the old page left the post entirely:

```
$ docker compose stop db
 Container objective-port-jena-46c1e6-1-db-1  Stopped
$ chrome-devtools-axi open http://localhost:3000/posts/272e38d1-...
$ chrome-devtools-axi eval "() => location.pathname"
result: "\"/\""
```

The new one stays and says why:

```
$ chrome-devtools-axi eval "() => location.pathname"
result: "\"/posts/272e38d1-bed9-4237-a48d-bda64aed9795\""
$ chrome-devtools-axi snapshot
    uid=g1876:6_2 StaticText "Could not load this post"
    uid=g1876:6_3 StaticText "The request failed and the server gave no reason."
    uid=g1876:6_4 button "Retry"
```

`GET /api/posts/{id}` answers 500 with an empty body when its database is gone (the same
finding as item 8.2), so the fallback wording is what a user sees. Retry recovers in place:

```
$ docker compose start db
 Container objective-port-jena-46c1e6-1-db-1  Started
$ chrome-devtools-axi click g1878:6_4        # the Retry button
$ chrome-devtools-axi eval "() => document.querySelector('h1').textContent"
result: "\"Content Crew\""
$ chrome-devtools-axi snapshot | head -30
    uid=g1880:9_2 heading "How small businesses choose a local SEO agency" level="1"
    uid=g1880:9_5 button "Rerun Stage"
    uid=g1880:9_14 StaticText "Run Trace"
    uid=g1880:9_15 StaticText "72,037"
```

**Empty.**

```
$ chrome-devtools-axi open http://localhost:3000/posts/11111111-1111-4111-8111-111111111111
$ chrome-devtools-axi snapshot
    uid=g1882:12_2 heading "Choosing a local SEO agency: what to ask first" level="1"
    uid=g1882:12_4 StaticText "RESEARCH"
    uid=g1882:12_5 button "Run Pipeline"
    uid=g1882:12_12 StaticText "Run Trace"
    uid=g1882:12_13 StaticText "No run yet. Start the pipeline to see per-step status, timing, tokens and cost."
    uid=g1882:12_14 StaticText "This post has not run yet"
    uid=g1882:12_15 StaticText "Stage output appears here as the pipeline writes it. Start the run to fill Research, Outline, Write, Edit, Images and Ready."
    uid=g1882:12_16 button "Run Pipeline"
```

`Rerun Stage` and `Force Restart` are absent there by design: neither verb means anything
before a first run.

**Loading.** Captured under a throttled network, counting the skeleton elements on screen at
the moment of the screenshot:

```
$ chrome-devtools-axi emulate --network "Fast 3G"
$ chrome-devtools-axi open http://localhost:3000/posts/272e38d1-... && chrome-devtools-axi screenshot
$ chrome-devtools-axi eval "() => document.querySelectorAll('[class*=animate-pulse]').length"
old page: result: "{\"p\":\"/posts/272e38d1-...\",\"n\":3}"
new page: result: "{\"p\":\"/posts/272e38d1-...\",\"n\":46}"
```

3 grey bars before, the full layout mirror after, which is the same skeleton `loading.tsx`
was already rendering for the route wait.

**Success.** The completed 7.6 post, before and after the spacing pass: full-page height
2160px -> 2029px with no content removed, because the shadcn `Card` default (`gap-6 py-6`)
was adding a 24px band above and below every separator on top of each card's own `py-3`
header padding.

### Screenshots

| State | Before | After |
| --- | --- | --- |
| Success | `ui/8.3-post-detail-success-before.png` | `ui/8.3-post-detail-success-after.png` |
| Empty | `ui/8.3-post-detail-empty-before.png` | `ui/8.3-post-detail-empty-after.png` |
| Error | `ui/8.3-post-detail-error-before.png` (the redirect to `/`) | `ui/8.3-post-detail-error-after.png` |
| Loading | `ui/8.3-post-detail-loading-before.png` | `ui/8.3-post-detail-loading-after.png` |

All eight are distinct files (`md5` differs pairwise).

### Console

The never-run post is silent:

```
$ chrome-devtools-axi open http://localhost:3000/posts/11111111-1111-4111-8111-111111111111
$ chrome-devtools-axi console
<no console messages found>
```

The completed post has three errors, all the same pre-existing one:

```
$ chrome-devtools-axi console --type error
msgid=70 [error] Failed to load resource: the server responded with a status of 404 (Not Found) [3 times]
$ chrome-devtools-axi eval "() => [...document.querySelectorAll('img')].filter(i => !i.complete || i.naturalWidth === 0).map(i => i.getAttribute('src'))"
result: "[\"/media/272e38d1-.../local-seo-service-components.webp\", ...]"
```

Those are the article's generated images, which live in the compose `media` volume while
`pnpm -C web dev` serves the repo's own `media/`. That split is the `[investigate]` entry
`todo.md` recorded on 2026-08-23; it is not this item's code and no new message appeared.

```
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
      Tests  7 failed | 4550 passed | 7 skipped (4564)

$ pnpm -C web build
✓ Compiled successfully in 6.5s
✓ Generating static pages using 15 workers (42/42) in 278.8ms
exit=0
```

The standing baseline was 9 failures. Six are `image-preview.test.tsx`, unchanged. The three
in `PostDetail.test.tsx` are fixed by this item. The seventh is the known
`scaffold-check.test.ts` flake `todo.md` records as failing in two runs of three under the
full suite; it passes on its own immediately afterwards:

```
$ pnpm -C web test --run src/mastra/workflows/scaffold-check.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

## 8.4

The posts list at `/`. Its four states landed under 8.2 (same route, same file), so what this
item covers is the visual hierarchy and spacing pass.

### What landed

| Change | File |
| --- | --- |
| The page is capped at `max-w-6xl mx-auto`, the width `/posts/[id]`, `/settings` and `/posts/new` already use; it was the only full-bleed page in the app | `web/src/app/page.tsx` |
| The selection controls moved into the filter row; as a block of their own they pushed the table down 74px the moment a row was ticked | `web/src/app/page.tsx` |
| Filters and table are one group (`space-y-3`) under the header's `space-y-6`, so the controls read as belonging to the table rather than as a third peer section | `web/src/app/page.tsx` |
| The topic no longer truncates at a fixed `max-w-xs` while the column had three times that much space; the slug under it moved from a one-off `text-[11px]` onto the `text-xs` scale | `web/src/app/page.tsx` |
| The `Pri` column header is spelled `Priority` | `web/src/app/page.tsx` |

### Measured, live, at a 1600x1000 viewport

Before, `/` stretched to the viewport while every page it links to is capped:

```
$ chrome-devtools-axi resize 1600 1000
$ chrome-devtools-axi eval '() => ...root/table widths and child offsets...'
{"vw":1600,"rootW":1376,"tableW":1326,"docH":1000,
 "kids":[{"cls":"flex items-center justify-between","top":24,"h":56},
         {"cls":"flex flex-wrap items-center gap-3","top":104,"h":36},
         {"cls":"rounded-md border border-border","top":164,"h":147}]}
```

After, the content is 1152px wide and the filters and table are one two-child group:

```
{"rootW":1152,"tableW":1102,"tableTop":153,
 "kids":[{"cls":"flex items-center justify-betwee","top":24,"h":56},
         {"cls":"space-y-3","top":104,"h":196}]}
```

The selection jump, measured by reading the table's viewport offset either side of a click on
the first row's checkbox.

Before:

```
$ chrome-devtools-axi eval '() => { before = table.top; rowCheckbox.click(); }'
{"before":165,"rows":2}
$ chrome-devtools-axi eval '() => ({ after: table.top })'
{"after":239}
```

74px. After:

```
{"before":153}
{"after":153,"selectedText":["1 selected"]}
```

Zero, and the count still reads `1 selected`, which is what
`PostsList.test.tsx > shows bulk action bar when items selected` asserts.

The filtered-empty state still renders inside the new grouping, and does not move the table
either:

```
$ chrome-devtools-axi eval '() => set search to "zzzz-no-such-post"'
{"body":"No posts match these filters Widen the search or the status and profile filters. Clear filters","tableTop":153}
```

### Screenshots

| State | Before | After |
| --- | --- | --- |
| Success | `ui/8.4-posts-list-success-before.png` | `ui/8.4-posts-list-success-after.png` |
| One row selected | `ui/8.4-posts-list-selected-before.png` | `ui/8.4-posts-list-selected-after.png` |
| Filtered, no match | (captured under 8.2 at the old width) | `ui/8.4-posts-list-filtered-empty-after.png` |

```
$ md5 docs/mastra-port/ui/8.4-posts-list-*.png
MD5 (8.4-posts-list-selected-after.png)  = 84ee342d4b64763b9bee38e66c8712d0
MD5 (8.4-posts-list-selected-before.png) = 6dfc32a0c5d6652f3899559d8f4292fc
MD5 (8.4-posts-list-success-after.png)   = 3443b9a4905f86f8aba0da586a621851
MD5 (8.4-posts-list-success-before.png)  = 2e8e89e1310227f98be0756d7f46ce21
```

### Console

```
$ chrome-devtools-axi console
## Console messages
Showing 1-2 of 2 (Page 1 of 1).
msgid=27 [log] [Fast Refresh] rebuilding (1 args)
msgid=28 [log] [Fast Refresh] done in 206ms (1 args)
```

No errors and no warnings; both messages are the dev server's own hot reload.

### Gates

```
$ pnpm -C web exec tsc --noEmit
exit=0

$ pnpm -C web lint
exit=0

$ pnpm -C web test
 Test Files  1 failed | 137 passed (138)
      Tests  6 failed | 4551 passed | 7 skipped (4564)

$ pnpm -C web build
✓ Compiled successfully in 6.6s
✓ Generating static pages using 15 workers (42/42) in 285.3ms
exit=0
```

All six remaining failures are `image-preview.test.tsx`, the standing baseline `todo.md`
records. The three `PostDetail.test.tsx` failures item 8.3 fixed stayed fixed, and
`scaffold-check.test.ts` passed in this run rather than hitting its recorded flake.
The build's `BetterAuthError` lines are the standing environmental noise from
`BETTER_AUTH_SECRET` being absent from the repo `.env`; the build still exits 0.
