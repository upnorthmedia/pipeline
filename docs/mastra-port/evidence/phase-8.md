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

## 8.5 `/posts/new` and `/posts/batch`: four states

Both routes had exactly one async surface visible on load, `profiles.list()`, and both wrote
it the same way:

```
$ git show HEAD~1:web/src/app/posts/new/page.tsx | grep -n "profiles.list"
89:    profiles.list().then(setProfileList).catch(() => {});

$ git show HEAD~1:web/src/app/posts/batch/page.tsx | grep -n "profiles.list"
121:    profiles.list().then(setProfileList).catch(() => {});
```

A swallowed rejection with no loading, empty or error state, so a dead database, an account
with no profiles and a successful load all rendered the same control: a select whose only
option is "No profile". The before screenshots prove it at the byte level (below).

Both submit paths threw the server's answer away the same way (`catch { toast.error("Failed
to create post") }`), which on a form is the worst place to lose it: the toast is gone in
four seconds and the operator is still looking at a filled-in form with no reason on screen.

### What changed

| Surface | Before | After |
| --- | --- | --- |
| Profile list, in flight | nothing | `Skeleton` the height of the select |
| Profile list, empty account | select with one dead option | "No profiles yet" + what a profile is for + **Create a profile** linking `/profiles` |
| Profile list, failed | select with one dead option | "Could not load profiles" + the server's own `{"detail"}` via `apiErrorMessage` + **Retry** |
| Profile list, success | select | unchanged select, now with `aria-label` and `name` |
| Create submit, failed | 4s toast, generic wording | inline block above the button with the server's own message |
| WordPress categories/authors, failed (`/posts/new`) | two silently empty selects | "Could not load categories and authors" + message + **Retry** |

The picker is one component, `web/src/components/profile-select-card.tsx`, because both pages
render the same card with the same four states and only the description differs.

### Tests

```
$ pnpm exec vitest run src/components/__tests__/profile-select-card.test.tsx \
    src/app/posts/new/PostForm.test.tsx src/app/posts/batch/BatchCreate.test.tsx
 ✓ src/components/__tests__/profile-select-card.test.tsx (6 tests) 213ms
 ✓ src/app/posts/batch/BatchCreate.test.tsx (13 tests) 1008ms
 ✓ src/app/posts/new/PostForm.test.tsx (16 tests) 1383ms

 Test Files  3 passed (3)
      Tests  35 passed (35)
```

New coverage: the four card states plus the retry and the fallback wording; the inline submit
error on both pages with the server's `{"detail"}`, the fallback, and that a resubmit clears
the previous failure; the WordPress lookup failure and its retry; and two behaviours the
refactor touched that had no test at all, profile prefill on `/posts/new` and profile
defaults reaching every row of a batch.

Mutation check, replacing the card's `setError(...)` with `setList([])`:

```
 ✓ shows a skeleton while the profiles are in flight 14ms
 ✓ shows the select once the profiles arrive 61ms
 ✓ hands the picked profile back to the page 84ms
 ✓ points at profile creation when the account has none 13ms
 × shows the server's own message and retries on demand 1003ms
 × falls back to its own wording when the failure carries no message 1003ms
      Tests  2 failed | 4 passed (6)
```

Both `act(...)` warning counts went **down**, because the default profile list in each suite
is now a pending promise rather than one that resolves after a synchronous assertion:

```
$ vitest run src/app/posts/new/PostForm.test.tsx | grep -c "not wrapped in act"
before 5   after 0

$ vitest run src/app/posts/batch/BatchCreate.test.tsx | grep -c "not wrapped in act"
before 4   after 0
```

### Live readouts

Dev server on :3000 against the compose `db`/`redis`, signed in through the real sign-in form.

Error state, `docker compose stop db`:

```
$ chrome-devtools-axi eval "document.body.innerText.match(/Could not load profiles[\s\S]{0,140}/)"
/posts/new:   "Could not load profiles |  | The request failed and the server gave no reason. |  | Retry | Content | ..."
/posts/batch: "Could not load profiles |  | The request failed and the server gave no reason. |  | Retry | CSV Upload | ..."
```

Recovery in place, `docker compose start db` then clicking **Retry** without a reload:

```
$ chrome-devtools-axi eval "...{errorGone, combobox}"
{"errorGone":true,"combobox":"No profile"}
```

Empty state, signed in as a second user who owns no profiles:

```
/posts/new:   "No profiles yet |  | A profile carries the niche, tone and publishing defaults so you do not retype them for every post. |  | Create a profile"
/posts/batch: "No profiles yet |  | A profile carries the niche, tone and publishing defaults so you do not retype them for every post. |  | Create a profile"
```

Loading state, captured under `emulate --network "Slow 3G"` with the skeleton counted at
screenshot time:

```
/posts/new:   {"path":"/posts/new","pulse":1}
/posts/batch: {"path":"/posts/batch","pulse":1}
```

Inline submit error carrying a real server message. `POST /api/posts` and
`POST /api/posts/batch` both answer `404 {"detail": "Profile not found"}` when the chosen
profile is not the caller's, so the profile was selected in the UI, its `user_id` moved to the
other account, the form submitted, and the `user_id` moved back:

```
/posts/new:   "Could not create the post |  | Profile not found |  | Cancel | Create Post"
/posts/batch: "Could not create the posts |  | Profile not found |  | Cancel | Create 1 Post"
```

### Screenshots

`docs/mastra-port/ui/`, distinct md5 recorded per file:

| File | md5 |
| --- | --- |
| `new-success-before.png` | `e8d1c5243a016137daa0343309a5bf02` |
| `new-error-before.png` | `e8d1c5243a016137daa0343309a5bf02` |
| `new-empty-before.png` | `e8d1c5243a016137daa0343309a5bf02` |
| `new-success-after.png` | `e8d1c5243a016137daa0343309a5bf02` |
| `new-error-after.png` | `6bd8c25a07a3ee2ed1d01aa0de8aa6bb` |
| `new-empty-after.png` | `fcc3ae6afc6f799c4e1c487bad8abea0` |
| `new-loading-after.png` | `cee5e15d5e31edbcc59d1fcd5b00cf94` |
| `new-submit-error-after.png` | `ae0e3e2928ab3e82a55e90310fb2f853` |
| `batch-success-before.png` | `79c17f18aaf5c1568c9f9d8f88672eeb` |
| `batch-error-before.png` | `79c17f18aaf5c1568c9f9d8f88672eeb` |
| `batch-empty-before.png` | `79c17f18aaf5c1568c9f9d8f88672eeb` |
| `batch-success-after.png` | `79c17f18aaf5c1568c9f9d8f88672eeb` |
| `batch-error-after.png` | `fdbb92d564944ad20030fddb131b69a1` |
| `batch-empty-after.png` | `cd4abe0d995b652e6f43839acd502d05` |
| `batch-loading-after.png` | `cd4b6e45cab918478bfe965bd5418541` |
| `batch-submit-error-after.png` | `1c3667c66aa35da4c49e32c770c56f89` |

Two of those repeated hashes are the finding, not a capture bug. Per route the **before**
success, error and empty captures are one identical file, which is the defect stated exactly:
the old pages could not tell an operator apart from a dead database or an empty account. The
third repeat, `success-after` equal to `success-before`, is the intended result: the success
path is visually untouched by the refactor.

### Console

```
$ chrome-devtools-axi console          # /posts/new, before
msgid=173 [issue] No label associated with a form field (count: 1)
msgid=174 [issue] A form field element should have an id or name attribute (count: 4)
msgid=175 [issue] Incorrect use of <label for=FORM_ELEMENT> (count: 2)
```

Three standing accessibility issues, one of which the new card contributed to (its Radix
`Select` renders a hidden native `select` with no `name`, the fourth of the four). Fixed on
both routes: `name` on every `Select`, `id` on the triggers that a `<Label htmlFor>` pointed
at (`intent` and `articleType` had dangling `for` attributes, `Output Format` had none at
all), and `name` plus `aria-label` on the batch page's per-row inputs and the CSV file input.

```
$ chrome-devtools-axi console          # after
/posts/new:                    <no console messages found>
/posts/batch:                  <no console messages found>
/posts/batch, Manual Entry:    <no console messages found>
```

### Gates

```
$ pnpm -C web exec tsc --noEmit
exit=0

$ pnpm -C web lint
exit=0

$ pnpm -C web test
 Test Files  1 failed | 138 passed (139)
      Tests  6 failed | 4564 passed | 7 skipped (4577)

$ pnpm -C web build
✓ Compiled successfully in 6.5s
exit=0
```

All six failures are `image-preview.test.tsx`, the standing baseline in `todo.md`. The
build's `BetterAuthError` lines are the standing `BETTER_AUTH_SECRET` noise.

## 8.6 `/profiles` and `/profiles/[id]`: four states

Both routes treated a failed request as an absence. `/profiles` caught every list failure with
`toast.error("Failed to load profiles")` and then rendered its empty state, so a dead database
told the operator they had no profiles and offered to create their first one. `/profiles/[id]`
was worse: a failed `profiles.get()` pushed the browser back to `/profiles`, throwing away both
the URL that identifies the profile and the server's reason for refusing it. Its links table
had no error state at all, so a failed first page of links also read as "No internal links yet".

### The tests, red before the change

```
$ cd web && npx vitest run src/app/profiles/ProfilesList.test.tsx
 ×  shows the server's own message and a working retry when the list fails
 ×  falls back to its own wording when the failure carries no message
 ×  clears the search from the no-match empty state
 ×  keeps a rejected create inline in the dialog
 Test Files  1 failed (1)
      Tests  4 failed | 12 passed (16)

$ cd web && npx vitest run src/app/profiles/ProfileDetail.test.tsx
 ×  shows the server's own message and a working retry when the load fails
 ×  falls back to its own wording when the load failure carries no message
 ×  shows a links error with a retry instead of an empty links table
 ×  renders skeleton rows while the first page of links is in flight
 ×  keeps a rejected save inline above the button
 Test Files  1 failed (1)
      Tests  5 failed | 13 passed (18)
```

Green after:

```
$ cd web && npx vitest run src/app/profiles
 ✓ src/app/profiles/ProfilesList.test.tsx  (16 tests) 755ms
 ✓ src/app/profiles/ProfileDetail.test.tsx (18 tests) 983ms
 Test Files  2 passed (2)
      Tests  34 passed (34)
```

`ProfileDetail.test.tsx`'s `redirects on fetch error` case is gone, replaced by the two
load-failure cases above. That is an intended behaviour change, not drift: the redirect it
pinned is the defect this item fixes.

### The four states, driven live

Dev server on `:3000`, the compose `db` and `redis`. Two accounts: one owning the profile
`714bf8bd` ("Compose Stack Check", 393 internal links) and one owning none.

**`/profiles`, before.** Signed in as the account with no profiles, then with the database
stopped:

```
# before, empty account
"Website Profiles\n\n0 total profiles\n ... No profiles yet\n\nCreate your first profile"

# before, database stopped, Refresh clicked
"Website Profiles\n\n0 total profiles\n ... No profiles yet\n\nCreate your first profile\nFailed to load profiles"
```

The two states differ only by a four-second toast: the table said "No profiles yet" either way.

**`/profiles`, after.** Same two drives:

```
# after, empty account
"Website Profiles\n\n0 total profiles\n ... No profiles yet\n\nA profile holds the site,
 voice and links every post is written against.\n\nCreate your first profile"

# after, database stopped, Refresh clicked
"Website Profiles\n\nProfile list unavailable\n ... Could not load profiles\n\nThe request
 failed and the server gave no reason.\n\nRetry"
```

The wording of the failure is the client's fallback because a route handler whose database is
gone answers 500 with an empty body (recorded in `todo.md` during 8.2). Retry recovers:

```
# database stopped
document.body.innerText.includes("Could not load profiles")   -> true
# `docker compose start db`, then Retry clicked
{ recovered: true, text: "Website Profiles\n\n0 total profiles ..." }
```

**Loading.** Under `chrome-devtools-axi emulate --network "Slow 3G"`, `open` then `screenshot`
then read the DOM:

```
{ skeletons: 25, header: "Website Profiles\n\nLoading profiles...\n\nNew Pro" }
```

**Create dialog.** With the database stopped, filling the dialog and pressing Create:

```
# before
document.body.innerText.includes("Failed to create profile")   -> true   (toast only)

# after
"Create Profile\n\nName the site and give its URL. Everything else is editable once the
 profile exists.\n\nName\nWebsite URL\n\nCould not create the profile\n\nThe profile could
 not be created.\n\nCancel\nCreate\nClose"
```

The dialog keeps the operator's two fields and the reason together. The `DialogDescription`
in that readout is a second fix: the dialog had none, which Radix reports on every open as
`Warning: Missing 'Description' or 'aria-describedby={undefined}' for {DialogContent}` and
which showed up in this suite's own test output.

**`/profiles/[id]`, load failure.** Opening a profile id that this account does not own:

```
# before
{ path: "/profiles", text: "Content Crew ... Website Profiles\n\n1 total profiles ..." }

# after
{ path: "/profiles/00000000-0000-0000-0000-000000000000",
  text: "Could not load this profile\n\nProfile not found\n\nRetry" }
```

`GET /api/profiles/<id>` answers `{"detail": "Profile not found"}` for an unowned id, so this
is the server's own wording. Retry, proven by moving the real profile's `user_id` to the other
account, opening it, moving it back and pressing Retry:

```
"Could not load this profile\n\nProfile not found\n\nRetry"
-> Retry
{ path: "/profiles/714bf8bd-...", err: false }
{ name: "Compose Stack Check", links: 20 }
```

**`/profiles/[id]`, links failure on first load.** Driven by patching `window.fetch` to fail
`/links` and then navigating client-side from `/profiles` (a client navigation keeps the patch,
a fresh `open` does not):

```
# before
{ path: "/profiles/714bf8bd-...", emptyState: true, errState: false, msg: false, rows: 1 }

# after
{ path: "/profiles/714bf8bd-...", emptyState: false, errState: true, msg: true, rows: 1 }
```

`Retry links` recovers once the patch is lifted:

```
{ err: false, rows: 20 }
```

A links *refetch* that fails (typing in the links search while the profile has been moved to
another account) keeps the last good rows rather than blanking them, before and after:

```
{ emptyState: false, toast: true, rows: 20 }
```

**`/profiles/[id]`, links loading.** With `/links` left pending:

```
{ combo: 25, inRow: 25 }     # 5 skeleton rows x 5 cells inside <tbody>
```

Before, that same window rendered an empty `<tbody>` with a detached spinner underneath.

**`/profiles/[id]`, page loading.** Under Slow 3G, `open` then `screenshot` then count:

```
# before                       # after
{ skeletons: 3 }               { skeletons: 25 }
```

The route already had a full-layout `loading.tsx`; the client fetch rendered three grey bars
instead. `profile-detail-skeleton.tsx` is now the single definition both use.

**`/profiles/[id]`, save failure.** With the profile moved to the other account, pressing
Save Profile:

```
"Could not save this profile\n\nProfile not found\n\nSave Profile\nCrawl Sitemap ..."
```

### Accessibility

`/profiles` was already clean. `/profiles/[id]` reported three issues:

```
$ chrome-devtools-axi console --type issue      # /profiles/[id], before
[issue] No label associated with a form field (count: 2)
[issue] An element doesn't have an autocomplete attribute (count: 1)
[issue] A form field element should have an id or name attribute (count: 8)
```

The eight unnamed fields were seven Radix `Select`s (Radix renders a hidden native `select`
for form compatibility whether or not it is given a `name`) and the links search input. The two
unassociated labels were `Output Format` and `Re-crawl Schedule`, both `<Label>` with no
`htmlFor` next to a Radix trigger with no `id`. The autocomplete issue was the profile `Name`
input, which browser autofill recognises by id and would offer a person's name for.

```
$ chrome-devtools-axi console --type issue      # /profiles/[id], after
<no console messages found>

$ chrome-devtools-axi console --type error      # both routes, after
<no console messages found>
```

DOM cross-check on the after build:

```
{ unnamed: [], badLabels: [] }
```

### Screenshots

Twenty files under `docs/mastra-port/ui/`, prefixed `8.6-`:

| File | md5 |
| --- | --- |
| `8.6-list-success-before.png` | `004059d95176d655673c5c9876fe0564` |
| `8.6-list-success-after.png` | `6fcbf9d726f9bddca1c6f6b2b067774a` |
| `8.6-list-empty-before.png` | `5debac38484e8c3b2dc919ef6e9e37c6` |
| `8.6-list-empty-after.png` | `94af9796d9a0ddf56fb01dd3ddeced60` |
| `8.6-list-error-before.png` | `f7ae7a674495bd007b77b28faa3ad6c1` |
| `8.6-list-error-after.png` | `4bd58656bcd5e227be942edd5dd94701` |
| `8.6-list-loading-after.png` | `65a8962d7be9ed7b4db654bc5ed5ff1c` |
| `8.6-list-create-error-before.png` | `d9650e99b9205456655cd28318d13d4a` |
| `8.6-list-create-error-after.png` | `952c99e65d82f12618cce820c5cfe6d0` |
| `8.6-detail-success-before.png` | `5aeb908fbb50307ee596246e3a0aad62` |
| `8.6-detail-success-after.png` | `5aeb908fbb50307ee596246e3a0aad62` |
| `8.6-detail-loading-before.png` | `1151ce8ba80d71d90937a8ebfce48f29` |
| `8.6-detail-loading-after.png` | `91b38b7a6f73fb8183d41145c316313c` |
| `8.6-detail-load-error-before.png` | `54b98592d66f8f454a07d77629074fc7` |
| `8.6-detail-load-error-after.png` | `47edae11a8b7042d86f46e7d0a8fa27d` |
| `8.6-detail-links-firstload-error-before.png` | `60538476b9dc565731250a5f3f530c6d` |
| `8.6-detail-links-firstload-error-after.png` | `c0939b5feb690e82fd14c943a0a66a9e` |
| `8.6-detail-links-error-before.png` | `b7529dccbcafea622b1aa39deffd4ae5` |
| `8.6-detail-links-loading-after.png` | `30bfbfad098f35ed3f1e6e6c8514e961` |
| `8.6-detail-save-error-after.png` | `27eb20638d6a3f6673ef10a70f1b57c3` |

`8.6-detail-success-before.png` and `8.6-detail-success-after.png` are byte-identical, and that
is the intended result: nothing on this item touched the success render of `/profiles/[id]`
beyond `id`, `name` and `autoComplete` attributes. `8.6-list-success-{before,after}.png` differ
only because the count line now reads "1 total profile" rather than "1 total profiles".

### Gates

```
$ pnpm -C web exec tsc --noEmit
exit=0

$ pnpm -C web lint
exit=0

$ pnpm -C web test
 Test Files  1 failed | 138 passed (139)
      Tests  6 failed | 4572 passed | 7 skipped (4585)

$ pnpm -C web build
✓ Compiled successfully in 6.5s
✓ Generating static pages using 15 workers (42/42) in 282.2ms
exit=0
```

All six failures are `image-preview.test.tsx`, the standing baseline in `todo.md`.

## 8.7 `/settings`: four states, plus visual hierarchy and spacing pass

Dev server on :3000 against the compose `db`/`redis`, signed in as the owner of the global
`api_keys` settings row. The `settings` table holds one row (`api_keys`, `user_id` NULL) with
all three providers configured, so every account resolves the same success state.

### What was wrong

`/settings` renders three cards. Only one of them, the Stage Models card added in 6.3, had an
error state. The other two turned every failure into a four-second toast and then rendered
something that reads as a normal, successful page.

With `docker compose stop db` every request from the page fails, and the old page said so
nowhere on screen:

```
$ docker compose stop db
 Container objective-port-jena-46c1e6-1-db-1 Stopped
$ chrome-devtools-axi open http://localhost:3000/settings
$ chrome-devtools-axi eval "() => { const t=document.querySelector('textarea');
    const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Save blog-research'));
    return JSON.stringify({badges:[...document.querySelectorAll('[data-slot=badge]')].map(x=>x.textContent),
                           ruleText:t.value, ruleSaveDisabled:b.disabled}) }"
result: "{\"badges\":[],\"ruleText\":\"\",\"ruleSaveDisabled\":false}"
```

Read that against the same page with the database up and no keys configured: three inputs
placeheld `Enter <provider> API key`, no badges, reveal buttons disabled. Identical. A dead
database and an account that has never pasted a key rendered the same card.

The rule editor is worse than indistinguishable. `rules.get()` failing set the editor to `""`
and left `Save blog-research` **enabled**, and `PUT /api/rules/{name}` writes whatever it is
given. One failed read plus one click truncates a file in `rules/`, which `CLAUDE.md` names as
the product's prompt IP. `ruleSaveDisabled: false` above is that path, measured. It was not
driven to completion live, because doing so would have truncated a real rule file; it is
pinned by a unit test instead (`does not offer to save an empty editor over a rule file that
failed to load`).

The server's own reason was discarded on every write path too: `catch { toast.error("Failed to
save API keys") }` and `` catch { toast.error(`Failed to save ${activeRule}`) } ``.

### The four states, live

**Loading.** Unchanged and already correct: 34 skeleton elements under a Slow 3G throttle,
before and after.

```
$ chrome-devtools-axi emulate --network "Slow 3G"
$ chrome-devtools-axi open http://localhost:3000/settings
$ chrome-devtools-axi eval "() => document.querySelectorAll('[data-slot=skeleton]').length"
result: "34"
```

`8.7-settings-loading-before.png` and `-after.png` are byte-identical (md5
`f571d120db7b3710c20f46ddb6bb87fa` both) and that is the honest result: nothing on this path
changed. `loading.tsx`, the route-transition mirror, did change: it had two bordered cards
while the page has three, so it stopped short of the Stage Models table. That is pinned by
`mirrors all three cards the page renders`, which fails when the new block is deleted.

**Error.** With `db` stopped, all three cards now name what failed, carry the server's own
reason, and offer a retry:

```
$ chrome-devtools-axi eval "() => JSON.stringify([...document.querySelectorAll('p')]
    .map(p=>p.textContent).filter(t=>t.includes('Could not')))"
result: "[\"Could not load API key status\",
          \"Could not load stage models\",
          \"Could not check which rule files exist: the server gave no reason.\",
          \"Could not load blog-research\"]"
```

`GET /api/settings/api-keys` returns a bare `500` with an empty body when the database is
down, so `apiErrorMessage` falls through to the app's shared wording, `The request failed and
the server gave no reason.`, the same fallback `/`, `/profiles` and the profile picker use.

The save button goes with the error:

```
$ chrome-devtools-axi eval "() => [...document.querySelectorAll('button')]
    .find(x=>x.textContent.includes('Save blog-research')).disabled"
result: "true"
```

**Retry.** With `db` restarted, clicking all three retries recovers in place, no reload:

```
$ docker compose start db
$ chrome-devtools-axi eval "() => { const b=[...document.querySelectorAll('button')]
    .filter(x=>/Retry/.test(x.getAttribute('aria-label')||'')); b.forEach(x=>x.click());
    return b.map(x=>x.getAttribute('aria-label')).join(', ') }"
result: "Retry API keys, Retry stage models, Retry blog-research"

$ chrome-devtools-axi eval "() => JSON.stringify({
    badges:[...document.querySelectorAll('[data-slot=badge]')].map(b=>b.textContent).slice(0,3),
    ruleChars: document.querySelector('textarea').value.length,
    saveDisabled: [...document.querySelectorAll('button')]
      .find(x=>x.textContent.includes('Save blog-research')).disabled,
    stillFailing: document.body.innerText.includes('Could not load') })"
result: "{\"badges\":[\"Configured\",\"Configured\",\"Configured\"],\"ruleChars\":5312,
          \"saveDisabled\":false,\"stillFailing\":false}"
```

**Empty.** The API keys card had no empty state: three "Not configured" badges over three
blank inputs, and nothing saying what a run needs. Driven by patching `window.fetch` to answer
`GET /api/settings/api-keys` with all three unconfigured, then navigating client-side so the
patch survives:

```
$ chrome-devtools-axi eval "() => JSON.stringify({
    badges:[...document.querySelectorAll('[data-slot=badge]')].map(b=>b.textContent).slice(0,3),
    emptyLine: [...document.querySelectorAll('p')].map(p=>p.textContent)
                 .find(t=>t.includes('No provider keys')) })"
result: "{\"badges\":[\"Not configured\",\"Not configured\",\"Not configured\"],
          \"emptyLine\":\"No provider keys are configured yet. A run needs Perplexity for
          research, Anthropic for outline, write, edit and ready, and Gemini for images.
          Paste a key below and save it.\"}"
```

The rule editor has its own empty case: a file that does not exist yet. All six exist in this
repo, so it was driven by patching `GET /api/rules` to report `blog-images` absent and its
content empty. The tab already said `(new)`; the editor said nothing.

```
$ chrome-devtools-axi eval "() => JSON.stringify({
    note: [...document.querySelectorAll('span')].map(s=>s.textContent)
            .find(t=>t.includes('does not exist yet')),
    textareaChars: document.querySelector('textarea').value.length })"
result: "{\"note\":\"blog-images.md does not exist yet. The stage runs without rules until
          you save one.\",\"textareaChars\":0}"
```

"The stage runs without rules" is `loadRules()` in `web/src/mastra/prompts.ts`, which returns
`""` for a missing file rather than throwing.

**Success.** Three Configured badges, six stage rows, the rule editor with 5312 characters of
`blog-research.md`.

### Failed writes keep the server's wording

Both save paths driven live against patched responses, on one page:

```
$ chrome-devtools-axi eval "() => JSON.stringify([...document.querySelectorAll('p')]
    .map(p=>p.textContent).filter(t=>t.includes('read only')||t.includes('invalid key')))"
result: "[\"anthropic: invalid key format\",\"rules directory is read only\"]"
```

Both sit inline next to the control that was clicked and stay there. Previously both were
replaced by a fixed string in a toast that expires after four seconds.

### Visual hierarchy and spacing

The shared shadcn `Textarea` carries `field-sizing: content`, and the rule editor had no
maximum height, so it grew to the whole file:

| | before | after |
| --- | --- | --- |
| `document.documentElement.scrollHeight` | 5556px | 2839px |
| textarea height | 3958px | 1217px (60vh) |
| `Save blog-research` top offset | 5471px | 2754px |

Measured at a 2029px viewport, which is generous; on a laptop the button was roughly six
screens below the editor it saves. `max-h-[60vh] overflow-auto` caps it, `resize-y` still lets
a user grow it, and the button now sits directly under the editor.

```
$ chrome-devtools-axi eval "() => { const t=document.querySelector('textarea');
    const save=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Save blog-research'));
    return JSON.stringify({docHeight: document.documentElement.scrollHeight,
      textareaHeight: Math.round(t.getBoundingClientRect().height),
      saveTop: Math.round(save.getBoundingClientRect().top + scrollY), viewport: innerHeight}) }"
result: "{\"docHeight\":2839,\"textareaHeight\":1217,\"saveTop\":2754,\"viewport\":2029}"
```

The other two hierarchy changes: the editor gained a `blog-research.md` label above it, so the
filename being edited is stated rather than implied by a tab, and the Stage Models card's
error state was rebuilt to the same icon / heading / reason / retry shape as the two cards
either side of it, replacing a bare line of red text with a plain button.

### Accessibility

One standing Chrome issue on the page, and one introduced and removed during the work.

```
$ chrome-devtools-axi console            # before
msgid=100 [issue] A form field element should have an id or name attribute (count: 1)
$ chrome-devtools-axi eval "() => [...document.querySelectorAll('input,select,textarea')]
    .filter(e=>!e.id && !e.name).map(e=>e.tagName)"
result: "[\"TEXTAREA\"]"
```

The rule editor had neither `id` nor `name` nor a label, only a placeholder. It now has all
three. The first fix introduced a second finding: the filename `<Label htmlFor="rule-content">`
sat outside the loading and error branches, so during those the `for` pointed at nothing.

```
msgid=250 [issue] Incorrect use of <label for=FORM_ELEMENT> (count: 1)
```

It is a plain `<span>` in those two branches now. All three states re-checked:

```
$ chrome-devtools-axi console --type issue     # success
<no console messages found>
$ chrome-devtools-axi console --type issue     # Slow 3G, loading
<no console messages found>
$ chrome-devtools-axi console --type issue     # db stopped, error
<no console messages found>
```

DOM cross-check on the settled page: no form field without `id` or `name`, no label whose
`for` has no target, no button without an accessible name.

```
result: "{\"bad\":[],\"dangling\":[],\"unnamedButtons\":1}"
```

The one unnamed button is the Next.js dev overlay, not application markup.

### Tests

14 new cases in `SettingsPage.test.tsx` (13 red first, plus the `loading.tsx` mirror), taking
the file from 13 to 27. Two existing cases changed, both deliberately:

| case | why it changed |
| --- | --- |
| `shows validation failure toast` -> `keeps a validation failure inline` | the reason a save was rejected now stays next to the keys that were pasted; the old string also carried an em dash, which the repo forbids |
| `surfaces the server's own message on a failed load, with a retry` (stage models) | `getByRole("button", {name: "Retry"})` is ambiguous now that the page carries three retries, so each names itself |

Red run, before the implementation:

```
$ npx vitest run src/app/settings/SettingsPage.test.tsx
 Test Files  1 failed (1)
      Tests  13 failed | 13 passed (26)
```

Green:

```
$ npx vitest run src/app/settings/
 Test Files  3 passed (3)
      Tests  42 passed (42)
```

Three mutations, each killed:

| mutation | result |
| --- | --- |
| `loadRule`'s catch stops calling `setRuleError` (the old behaviour) | 3 failed \| 23 passed |
| `Save {rule}` drops `!!ruleError` from `disabled` | 1 failed \| 25 passed |
| `loading.tsx` loses the Stage Models block | 1 failed \| 26 passed |

### Screenshots

`docs/mastra-port/ui/`, full page, dark (the app forces `class="dark"` on `<html>`):

| file | md5 |
| --- | --- |
| `8.7-settings-loading-before.png` | `f571d120db7b3710c20f46ddb6bb87fa` |
| `8.7-settings-loading-after.png` | `f571d120db7b3710c20f46ddb6bb87fa` (identical, unchanged path) |
| `8.7-settings-empty-before.png` | `11cc290f6f442353d9d03f7641477224` |
| `8.7-settings-empty-after.png` | `ff6609b8c3a68d7286eebc81755f8000` |
| `8.7-settings-error-before.png` | `64bd3dd930fb6e89446e1044ddb67435` |
| `8.7-settings-error-after.png` | `6fac2c007a26461aa92c52223bf67df2` |
| `8.7-settings-success-before.png` | `493c61fa4c0afe3508a90407ff163c31` |
| `8.7-settings-success-after.png` | `fab983b6ebbebb9b044168b96283fe81` |
| `8.7-settings-rule-new-after.png` | `105484105d113888e43c78303e093bae` |
| `8.7-settings-save-error-after.png` | `df7bb8ea25b315dfc60dcb99672e4a4e` |

### Gates

```
$ pnpm -C web exec tsc --noEmit
exit 0

$ pnpm -C web lint
exit 0

$ pnpm -C web test
 Test Files  1 failed | 138 passed (139)
      Tests  6 failed | 4587 passed | 7 skipped (4600)
exit 1
```

The 6 are the standing `image-preview.test.tsx` baseline, unchanged by this item and tracked
by 9.1. The Phase 0 baseline was 9 in 2 files; item 8.3 resolved the 3 in `PostDetail.test.tsx`.

```
$ pnpm -C web build
exit 0
```

### Not covered

- The rule-file truncation path was proven only up to the enabled button, not driven to a real
  `PUT` with an empty body, because that would have destroyed a file in `rules/`.
- `loading.tsx` is asserted by unit test, not screenshot: the settings route has no server-side
  await, so a full page load never renders it and a client transition to it is too brief to
  capture reliably.
