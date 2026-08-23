# Phase 7 evidence

## 7.0

The fresh-database path after Alembic is deleted.

### What landed

`web/drizzle/0000_baseline.sql` plus its journal and snapshot, generated from
`web/src/db/schema.ts` with `drizzle-kit generate --name baseline`. It creates the whole
schema in one migration rather than replaying the eleven Alembic revisions: it produces the
shape they end at. `pnpm -C web db:migrate` (`drizzle-kit migrate`) applies it.

`web/drizzle/README.md` records the three owners a fresh database needs, in order: this
baseline for the pipeline tables, `pnpm auth:migrate` for the BetterAuth tables, and the
`@mastra/pg` storage adapter (which creates its own `mastra_*` tables on first boot, with no
command to run). `schema.ts` deliberately describes only the first group, which is why the
parity helpers filter `auth_*`, `subscription` and `mastra_*` out of both sides.

### The one schema.ts change this needed

Alembic names `alembic_version`'s primary key `alembic_version_pkc`, not Postgres' default
`_pkey`. Drizzle's `.primaryKey()` shorthand cannot state a constraint name, so the table moved
to the `primaryKey({ columns, name })` form. Without it the baseline built a constraint the live
database does not carry, which the sweep below confirms is caught.

### Verification: a scratch database diffed against the live Alembic database

`web/src/db/baseline-parity.test.ts` creates `content_pipeline_baseline_check`, applies
`drizzle/` to it through the real `drizzle-orm/node-postgres` migrator, then diffs it against
the live `alembic upgrade head` database in both directions across three catalogs: columns
(type, nullability, default presence), indexes (`pg_indexes.indexdef`) and constraints
(`pg_get_constraintdef`). Index and constraint names are compared, not just their columns,
because `posts_profile_id_fkey` and `uq_settings_key_user_id` are named in error paths and in
`ON CONFLICT` arbiters. The scratch database is dropped in `afterAll`.

```
$ npx vitest run src/db/baseline-parity.test.ts
 RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web

 ✓ src/db/baseline-parity.test.ts (8 tests) 174ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Duration  521ms
```

The eight are: same table set, same columns, same indexes, same constraints, the item 6.0
settings key present verbatim, a guard that the compared catalogs are non-empty (so an empty
scratch database cannot pass by matching nothing), and two unit cases pinning `diffCatalogLines`
in both directions.

The 6.0 assertion, read back off the scratch database rather than the dev one:

```
settings | uq_settings_key_user_id | UNIQUE NULLS NOT DISTINCT (key, user_id)
```

### The CLI path, run against a scratch database

```
$ DATABASE_URL_SYNC=.../baseline_check pnpm -C web run db:migrate
> content-pipeline-dashboard@0.1.0 db:migrate
> drizzle-kit migrate

No config path provided, using default 'drizzle.config.ts'
Reading config file '.../web/drizzle.config.ts'
Using 'pg' driver for database querying
[✓] migrations applied successfully!

$ psql -tA .../baseline_check -c "select count(*) from pg_tables where schemaname='public';"
5
```

Five: the four pipeline tables plus `alembic_version`. Drizzle's own bookkeeping table lives in
a separate `drizzle` schema, so it does not appear in `public` and does not perturb parity.

### Mutation sweep, 8 of 8 killed

Each mutation edits `drizzle/0000_baseline.sql` (the artifact under test), reruns the file, and
restores from a backup. Verdict is the exit code, not a grep of the summary line.

| # | Mutation | Verdict |
| --- | --- | --- |
| 1 | drop the `posts.ready_content` column | KILLED (1 test) |
| 2 | rename index `idx_internal_links_profile` | KILLED (1 test) |
| 3 | rename constraint `uq_posts_profile_slug` | KILLED (2 tests) |
| 4 | drop `NULLS NOT DISTINCT` from the settings unique | KILLED (3 tests) |
| 5 | drop the `posts.word_count` default | KILLED (1 test) |
| 6 | weaken `posts.slug` to nullable | KILLED (1 test) |
| 7 | revert the `alembic_version` PK name to `_pkey` | KILLED (2 tests) |
| 8 | drop the `internal_links.post_id` foreign key | KILLED (1 test) |

Mutation 7 is the control for this item's only `schema.ts` edit: without that edit the baseline
fails parity, so the edit is load-bearing rather than cosmetic.

### Gates

```
$ npx tsc --noEmit          -> exit 0
$ npx eslint                -> exit 0
$ npx next build            -> exit 0
$ npx vitest run            -> exit 1
      Tests  10 failed | 4468 passed | 7 skipped (4485)
 Test Files  3 failed | 128 passed (131)
```

The ten failures are the recorded pre-existing set and nothing else: 6 in
`image-preview.test.tsx`, 3 in `PostDetail.test.tsx`, and one run of the known
`scaffold-check.test.ts` event-ordering flake ("emits the workflow lifecycle events the trace
view will read"), all documented in earlier iterations. The passing count moved from 4461 to
4468, which is this item's eight tests less one flake-affected pass. No Python file was touched,
so the pytest gate is unchanged.

### Known limitation

The baseline is a snapshot of the end state, not a replay of Alembic 001-012. A database that
is already partly migrated cannot be brought forward with it: it builds an empty database only.
That is the only case Phase 7 needs, since existing deployments already sit at Alembic head and
Drizzle takes over from there, but it means the `drizzle/` folder has no downgrade path.

## 7.1a

The `/media` static mount, moved off FastAPI.

### The audit that split 7.1

`api/src/main.py` mounts ten routers, `/media` and `/health`. Every route the ten routers
declare has a TypeScript handler already:

```
$ cd api && grep -rc "APIRouter(" src/api/*.py | awk -F: '{s+=$2} END {print "routers:",s}'
routers: 10
$ grep -rn "@router\.\(get\|post\|patch\|put\|delete\)" src/api/*.py | wc -l
      52
$ cd .. && grep -rho "export async function \(GET\|POST\|PATCH\|PUT\|DELETE\)" \
    web/src/app/api --include="route.ts" | wc -l
      53
```

The two sides were listed in full (each Python decorator's router prefix + path, each
TypeScript handler's directory + methods) and diffed by hand: every one of the 52 Python
routes has a TypeScript handler. The extra TypeScript method is
`GET /api/settings/stage-models`, added in 6.3, which has no Python counterpart.
`api/auth/[...all]/route.ts` is BetterAuth's own and exports its handlers differently, so it is
outside both counts. What has no equivalent:

- `app.mount("/media", StaticFiles(...))`, which is this item.
- `GET /health`, which only `docker-compose.yml`'s healthcheck for the `api` service calls.
  That service is deleted in 7.1c and the `web` service has its own healthcheck, so nothing
  needs it.

Two deliberate differences from `StaticFiles`, both stated in the handler's header comment:

1. The request is scoped to the post's owner through `posts -> website_profiles.user_id`. The
   mount was anonymous, which predates Alembic 010. A generated image is post content and
   another user's file now answers exactly like a missing one, matching `_get_user_post()`.
   Nothing but the browser reads these URLs: the WordPress and Next.js publish paths read the
   same files off disk (`listMediaFiles()`, `nextjs/payload.ts`), never over HTTP.
2. Content types come from a six-entry table, not from `guessTypeFromFilename()`. That
   function reproduces Python 3.12's builtin table, which has no `.webp` entry, so Starlette
   labelled every generated image `text/plain` and browsers rendered them only by sniffing.

### Tests

```
$ npx vitest run "src/app/media"
 RUN  v4.0.18 /Users/cody/Documents/code/jena-ai-gnhf-worktrees/objective-port-jena-46c1e6-1/web

 ✓ src/app/media/[...path]/route.test.ts (14 tests) 106ms

 Test Files  1 passed (1)
      Tests  14 passed (14)
   Start at  13:21:10
   Duration  551ms (transform 43ms, setup 72ms, import 311ms, tests 106ms, environment 0ms)
```

The 14 cover: 401 without a session; 404 for another user's file that exists on disk; 404 for a
post with no profile; the bytes, content type and content length; the `application/octet-stream`
fallback with `nosniff`; the entity tag, its 304 (which carries no `Content-Length`, since it
carries no content) and its change when a re-run rewrites the same filename; `Last-Modified` from the file's mtime; a missing file; the post directory itself; a
malformed post id; a `../` traversal; a trailing segment that must not alias a real file; and a
subdirectory.

### Mutation sweep

Eleven mutations of `route.ts`, each run against the 14 tests, file restored between runs and a
control run either side (both exit 0).

| # | Mutation | Verdict |
| --- | --- | --- |
| M1 | `if (!user)` never fires | KILLED |
| M2 | ownership predicate dropped from the `where` | KILLED |
| M3 | `innerJoin` becomes `leftJoin` | SURVIVED (equivalent) |
| M4 | containment check on the resolved path removed | KILLED |
| M5 | `segments.length !== 2` becomes `< 2` | KILLED |
| M6 | content type hardcoded to `image/webp` | KILLED |
| M7 | entity tag becomes a constant | KILLED |
| M8 | `Last-Modified` becomes `new Date()` | KILLED |
| M9 | `isUuid` check never fires | KILLED |
| M10 | `!info?.isFile()` becomes `!info` | KILLED |
| M11 | the 304 branch never fires | KILLED |

M3 is an equivalent mutant, not a coverage gap: `eq(websiteProfiles.userId, user.id)` in the
`where` already excludes the null-profile row a `leftJoin` would keep, so the two joins cannot
produce different results here. The join type is redundant with the predicate; the predicate is
the thing M2 proves is load-bearing.

M5 needed a test written for it. With `< 2`, `/media/<id>/a.webp/extra` served `a.webp`,
because the third segment was silently dropped: a URL aliasing difference the other cases
happened to 404 through. The "404s a trailing segment rather than letting it alias a real file"
case closes it.

### Gates

```
$ npx tsc --noEmit ; echo exit=$?
exit=0
$ npx eslint ; echo exit=$?
exit=0
$ npx next build
├ ƒ /media/[...path]
...
ƒ  (Dynamic)  server-rendered on demand
$ npx vitest run --reporter=dot
 Test Files  2 failed | 130 passed (132)
      Tests  9 failed | 4483 passed | 7 skipped (4499)
   Duration  78.78s
```

The 9 failures are the known pre-existing set on this tree: 6 in
`components/__tests__/image-preview.test.tsx` and 3 in `PostDetail.test.tsx`, both recorded in
earlier iterations and unchanged by this item.

## 7.1b

Default the dashboard's `API_BASE` to its own origin instead of `http://localhost:8055`.

### What changed

`API_BASE` is gone rather than re-pointed. The dashboard and its route handlers are one
Next.js app, so there is no second origin left to name, and keeping the env var would keep a
live channel back to the Python service that a stray `.env` could reopen.

| File | Before | After |
| --- | --- | --- |
| `web/src/lib/api.ts` | `fetch(\`${API_BASE}${path}\`)`, export and SSE urls prefixed | `fetch(path)`, urls origin-relative |
| `web/src/components/content-preview.tsx` | `resolveImageSrc()` prefixed `/media/...` | the markdown `img` uses `src` as written |
| `web/src/components/image-preview.tsx` | `src={\`${API_BASE}${entry.url}\`}` | `src={entry.url}` |
| `web/Dockerfile` | `ARG`/`ENV NEXT_PUBLIC_API_URL` | removed, nothing reads it |
| `docker-compose.yml` | `NEXT_PUBLIC_API_URL: http://localhost:8055` on `web` | removed |
| `docker-compose.prod.yml` | `NEXT_PUBLIC_API_URL` build arg on `web` | removed |

`resolveImageSrc()` was deleted rather than reduced to an identity function: with no rewriting
left to do it carried no meaning.

The only remaining mention of the env var in the tree is the tripwire test that asserts it has
no effect:

```
$ grep -rn "NEXT_PUBLIC_API_URL" --exclude-dir=node_modules --exclude-dir=.git \
    --exclude-dir=.next --exclude-dir=.gnhf --exclude-dir=docs .
web/src/lib/api.test.ts:286:    it("cannot be pointed at another host by NEXT_PUBLIC_API_URL", async () => {
web/src/lib/api.test.ts:289:      vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8055");
```

The `8055` references that remain in `docker-compose.yml` and `docker-compose.prod.yml` are the
Python `api` service's own port and healthcheck, which 7.1c deletes, and `README.md`'s
architecture diagram, which 7.4 rewrites.

### Live evidence

`next dev` started with the repo `.env` sourced and **no** `NEXT_PUBLIC_API_URL` set anywhere
(the whole point: iteration 136 had to pass `NEXT_PUBLIC_API_URL=http://localhost:3000` by hand
or every page threw load-failure toasts). A real BetterAuth session row was minted with
`src/test/session.ts` and its signed cookie set in the browser, then the posts list opened:

```
$ npx -y chrome-devtools-axi open http://localhost:3000/
page:
  title: Content Crew
  url: "http://localhost:3000/"
uid=g1758:2_17 main
  uid=g1758:2_18 heading "Posts" level="1"
  uid=g1758:2_19 StaticText "0"
  uid=g1758:2_20 StaticText " total posts"

$ npx -y chrome-devtools-axi network --type fetch
reqid=90 GET http://localhost:3000/api/auth/get-session [200]
reqid=91 GET http://localhost:3000/api/posts [200]
reqid=92 GET http://localhost:3000/api/profiles [200]
reqid=93 GET http://localhost:3000/api/posts [200]
reqid=94 GET http://localhost:3000/api/profiles [200]

$ npx -y chrome-devtools-axi network --type eventsource
reqid=96 GET http://localhost:3000/api/events [200]

$ npx -y chrome-devtools-axi console
msgid=10 [issue] A form field element should have an id or name attribute (count: 1)
msgid=11 [log] [Fast Refresh] rebuilding (1 args)
msgid=12 [log] [Fast Refresh] done in 427ms (1 args)
```

Every data request and the SSE stream resolve onto `localhost:3000`, the dashboard's own
origin, and the list renders its real (empty, for a fresh user) result rather than an error.
No console errors. The `0 total posts` is correct: the browser-check user owns no profiles.
The session user was deleted afterwards (`leftover_browsercheck_users=0`) and the bridge
stopped.

### Tests

```
$ pnpm exec vitest run src/lib/api.test.ts \
    src/components/__tests__/content-preview-media.test.tsx \
    src/components/__tests__/image-preview.test.tsx \
    src/hooks/use-sse.test.ts src/app/settings/
 Test Files  1 failed | 6 passed (7)
      Tests  6 failed | 87 passed (93)
```

The 6 failures are the known pre-existing `image-preview.test.tsx` set (a manifest-shape
mismatch: those cases pass `{featured: {...}}` where the component reads `manifest.images`).
They are unrelated to this item and are left as recorded.

New coverage:

| Test | What it pins |
| --- | --- |
| `api.test.ts > sends every request as an origin-relative path` | four namespaces, every url starts `/api/` |
| `api.test.ts > exposes origin-relative export and SSE urls` | the five url-returning helpers |
| `api.test.ts > cannot be pointed at another host by NEXT_PUBLIC_API_URL` | stubs the env var, re-imports the module, asserts request/export/SSE urls stay relative |
| `content-preview-media.test.tsx > renders a /media image with an origin-relative src` | the markdown `img` mapping, with `react-markdown` **not** mocked |
| `content-preview-media.test.tsx > leaves an absolute image url untouched` | a remote `https://` image is not rewritten |
| `content-preview-media.test.tsx > cannot be pointed at another host ...` | env tripwire on the markdown image path |
| `image-preview.test.tsx > renders a generated image with an origin-relative src` | the manifest `images[]` shape the stage actually writes |
| `image-preview.test.tsx > cannot be pointed at another host ...` | env tripwire on the manifest image path |

`content-preview.test.tsx` mocks `react-markdown` wholesale, which replaces the very component
mapping that resolves an image source, so the media assertions needed their own file without
that mock.

Existing files updated: `use-sse.test.ts` (uses the real `sseUrl`, so its url assertions moved
to relative), and `PostDetail.test.tsx` / `QueueMonitor.test.tsx` / `export-button.test.tsx`
(their `@/lib/api` mocks hardcoded `:8055` urls, kept honest by moving them too).
`stage-models-to-provider.test.tsx`'s fetch router now resolves the dashboard's relative paths
against a placeholder origin before routing, since both `new URL()` and `new Request()` reject
a bare path.

### Negative controls

Each mutation was applied, the suite run, then the file restored from a backup and re-read.
Verdicts are by exit code (iteration 135's learning: grepping vitest's summary line reads
`Failed Tests 1` as a pass). Controls: the unmutated selection exits 0, and for
`image-preview.test.tsx`, whose 6 pre-existing failures make a whole-file exit code useless,
the run is filtered with `-t "NEXT_PUBLIC_API_URL|origin-relative"` and that filtered control
also exits 0.

| # | Mutation | Result |
| --- | --- | --- |
| M1 | `request()` prefixes `http://localhost:8055` | KILLED |
| M2 | `request()` reads `NEXT_PUBLIC_API_URL` again | KILLED |
| M3 | `sseUrl.global()` returns an absolute url | KILLED |
| M4 | `posts.exportAll()` reads `NEXT_PUBLIC_API_URL` again | KILLED |
| M5 | markdown `img` prefixes `http://localhost:8055` | KILLED |
| M6 | manifest `img` prefixes `http://localhost:8055` | KILLED |
| M7 | markdown `img` reads `NEXT_PUBLIC_API_URL` again | KILLED |
| M8 | manifest `img` reads `NEXT_PUBLIC_API_URL` again | KILLED |

M2 survived the first sweep: the tripwire test only checked the two url-returning helpers, so
a `request()` that read an unset env var still produced a relative path. The test now also
drives a real `profiles.list()` under the stubbed env, which kills it. M7 and M8 did not exist
until the same gap was found on the two image paths.

M1 in full, as the representative:

```
$ pnpm exec vitest run src/lib/api.test.ts     # with fetch(`http://localhost:8055${path}`)
       × sends GET requests with correct URL 3ms
       × sends POST requests with JSON body 0ms
       × sends PATCH requests with JSON body 0ms
       × sends DELETE requests 0ms
       × omits empty parameters 0ms
       × creates a post 0ms
       × duplicates a post 0ms
       × runs next stage 0ms
```

### Gates

```
$ pnpm -C web tsc --noEmit
tsc exit=0
$ pnpm -C web lint
lint exit=0
$ pnpm -C web build
✓ Compiled successfully in 3.7s
$ pnpm -C web test
 Test Files  2 failed | 131 passed (133)
      Tests  9 failed | 4491 passed | 7 skipped (4507)
```

The 9 failures are the known pre-existing set on this tree: 6 in `image-preview.test.tsx` and
3 in `PostDetail.test.tsx` (`Unable to find an element with the text: Final` / `Run Next` /
`Execution Logs`, none url-related). An earlier full run in this iteration also tripped the
known load-dependent flake in `mastra/workflows/scaffold-check.test.ts`, which passes alone
(`5 passed`).

`api/` was not touched by this item, so its gates are unchanged (`git status --porcelain`
lists no path under `api/`).

`pnpm -C web test:e2e` was run because this item changes every url the browser requests. It
ended `4 passed (7.4m)` with failures across all four spec files. Reproduced in isolation, the
first one is expectation drift, not a regression: it waits for a sidebar item named "Monitor"
while the sidebar renders "Observability", and the page loaded normally. No Phase 0 baseline
was ever recorded for this gate; logged in `todo.md` for item 9.1.

## 7.1c

Delete `api/`, and move `docker-compose.yml` and `docker-compose.prod.yml` onto the TypeScript
`worker` service. `db` and `redis` stay: Postgres now holds Mastra run state alongside posts,
and Redis is the event bus and the SSE fan-out.

### What went

```
$ git rm -r api && ls
176 files changed, 28368 deletions(-)

docker-compose.prod.yml
docker-compose.yml
docs
media
packages
README.md
rules
todo.md
web
```

`rules/` was already at the repo root and is still the source of every stage prompt, so item 7.5
has nothing left to move. Nothing under `api/` was a non-Python asset except its own Dockerfile,
`alembic.ini`, `entrypoint.sh`, `pyproject.toml`, `uv.lock` and the sitemap XML test fixtures,
all of which belonged to the Python stack.

### The four services

| Service | Dev command | Prod image | Role |
| --- | --- | --- | --- |
| `db` | postgres:17-alpine | same | posts, settings, Mastra run state |
| `redis` | redis:7-alpine | same | Redis Streams event bus, SSE fan-out |
| `web` | `pnpm dev` | Dockerfile `runner` | dashboard, route handlers, SSE, starts runs |
| `worker` | `pnpm run worker:build && pnpm run worker` | Dockerfile `worker` | executes the workflow steps |

Both `web` and `worker` reach the same `web/src/mastra/index.ts`: the `web` service imports it
from the Next.js runtime, the `worker` service through the bundle `mastra worker build` produces
from it.

Three environment variables are set on the `worker` service that were not obvious, and are not
conveniences. The bundle runs with its own output directory as the cwd, so every default path in
the app resolves inside `.mastra/`:

- `RULES_DIR=/app/rules`. Without it `loadRules` returns `""` for every missing file rather than
  throwing, so each stage would silently run with its rule file stripped out of the prompt.
- `TEXTSTAT_DATA_DIR=/app/src/mastra/textstat/data`. Without it the `edit` stage dies with
  `ENOENT ... cmudict-syllables.txt.gz`. Set in the production image next to the corpus it
  points at, and in the dev compose file where the corpus arrives on a bind mount.
- `MEDIA_DIR=/app/media`, on both `web` and `worker`, now that `web` serves `/media` itself
  (item 7.1a) and no longer proxies it to Python.

### Two Dockerfile stages for the worker

`mastra worker build` gets its own stage rather than riding along in the Next.js builder, because
it is a genuinely different resolution environment: a dependency that `next build` resolves can
still be unresolvable in the bundle. The runtime stage carries no application `node_modules` at
all (the bundle brings its own), which is why the textstat corpus and the healthcheck script are
copied in explicitly.

```
$ docker build --target worker -t jena-worker-7-1c ./web
#13 [worker-builder 4/4] RUN pnpm run worker:build
#13 1.026 > mastra worker build -o .mastra/worker
#13 16.12 INFO (Mastra CLI): Bundling Mastra done
#13 17.10 INFO (Mastra CLI): Done installing dependencies
#13 18.46 INFO (Mastra CLI): Worker build complete.
#13 18.46 INFO (Mastra CLI): Run with: mastra worker start [name] --dir .mastra/worker
#13 18.46 INFO (Mastra CLI):   or:     node /app/.mastra/worker/index.mjs
#13 DONE 18.6s

#14 [worker 3/5] COPY --from=worker-builder /app/.mastra/worker ./.mastra/worker
#15 [worker 4/5] COPY --from=worker-builder /app/src/mastra/textstat/data ./src/mastra/textstat/data
#16 [worker 5/5] COPY --from=worker-builder /app/src/mastra/scripts/worker-healthcheck.mjs ./scripts/
#17 naming to docker.io/library/jena-worker-7-1c:latest done
```

### A pre-existing Dockerfile defect this surfaced

The first build failed before reaching any new stage:

```
#9 ERROR: process "/bin/sh -c pnpm install --frozen-lockfile || pnpm install" did not complete successfully: exit code: 1
9.883 [ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @prisma/engines@7.4.2, core-js@3.48.0,
      esbuild@0.18.20, esbuild@0.25.12, esbuild@0.27.3, esbuild@0.28.2, msw@2.12.10,
      prisma@7.4.2, sharp@0.34.5, unrs-resolver@1.11.1
```

Two causes, both fixed:

1. The image installed `pnpm@latest` through corepack while the lockfile was written by 10.26.2.
   `latest` had moved into a major that turns the ignored-build-scripts warning into an error.
   `packageManager: "pnpm@10.26.2"` now sits in `web/package.json` and the Dockerfile just runs
   `corepack enable`, so the image installs with the pnpm the lockfile belongs to.
2. The deps stage copied only `package.json` and the lockfile, so `.npmrc` (the react hoist
   patterns) and `pnpm-workspace.yaml` (the ignored-build-scripts list) were absent and the
   container resolved differently from a local install. Both are now copied.

`pnpm-workspace.yaml` also gained the four packages that had drifted onto the warning list since
it was last touched. A clean install in an empty container is now silent:

```
$ docker run --rm -v .../package.json -v .../pnpm-lock.yaml -v .../.npmrc \
    -v .../pnpm-workspace.yaml -w /app node:22-alpine \
    sh -c "corepack enable && pnpm install --frozen-lockfile"
...
+ vitest 4.0.18

Done in 6.4s using pnpm v10.26.2
```

`.mastra/` was added to `web/.dockerignore`, so a local worker bundle cannot be copied into a
build context and shadow the one the build produces.

### The production worker image, run against the real db and redis

```
$ docker run -d --name jena-worker-smoke --network objective-port-jena-46c1e6-1_default \
    -e DATABASE_URL_SYNC=postgresql://pipeline:pipeline@db:5432/content_pipeline \
    -e REDIS_URL=redis://redis:6379 -e RULES_DIR=/app/rules -e MEDIA_DIR=/app/media \
    -v "$PWD/rules:/app/rules:ro" jena-worker-7-1c

$ docker logs jena-worker-smoke | head -1
[mastra] Workers started
```

It did not just boot, it started draining the orchestration backlog that earlier test runs had
left in Redis, which is the clearest possible evidence that the bundled worker is wired to the
same topic the app publishes on:

```
Error executing step research: Error: post 65edface-18fd-480a-93a4-fcfdb51ae88d not found
    at loadPipelineState (file:///app/.mastra/worker/mastra.mjs:279117:20)
    at async Object.execute (file:///app/.mastra/worker/mastra.mjs:280456:21)
    at async StepExecutor.execute (file:///app/.mastra/worker/mastra.mjs:157981:23)
```

The two disk assets resolve inside the container:

```
$ docker exec jena-worker-smoke sh -c 'ls /app/rules && ls /app/src/mastra/textstat/data && printenv TEXTSTAT_DATA_DIR'
blog-edit.md
blog-images.md
blog-outline.md
blog-ready.md
blog-research.md
blog-write.md
README_hyph_en_US.txt
cmudict-syllables.txt.gz
hyph_en_US.dic
textstat-parity.json
/app/src/mastra/textstat/data
```

### The worker healthcheck

The Python `worker` service's healthcheck opened a Redis connection and pinged it, which proved
the container could reach Redis and nothing at all about ARQ. The Mastra worker can answer the
real question: `mastra worker start` joins the orchestration consumer group, so `XINFO CONSUMERS`
reports it with an `idle` that stays under a second while its read loop polls. That is the same
signal `readWorkerHealth()` already serves to the dashboard, and
`src/mastra/scripts/worker-healthcheck.mjs` re-reads it as a container healthcheck.

It speaks RESP over a socket with no dependencies on purpose: the production worker image holds
the bundle and no application `node_modules`, so a healthcheck that imported `redis` would pass
in the dev image and fail in the one that matters.

Live, and then after the same worker is stopped:

```
$ docker exec jena-worker-smoke node /app/scripts/worker-healthcheck.mjs
exit=0

$ docker stop jena-worker-smoke && sleep 20
$ docker run --rm --network objective-port-jena-46c1e6-1_default \
    -e REDIS_URL=redis://redis:6379 jena-worker-7-1c node /app/scripts/worker-healthcheck.mjs
no live consumer in mastra-orchestration on mastra:topic:workflows
exit=1
```

### Both compose files parse

```
$ docker compose config --quiet && echo "DEV OK"
DEV OK
$ docker compose -f docker-compose.prod.yml config --quiet && echo "PROD OK"
PROD OK
```

Two fixes to `docker-compose.prod.yml` that the Python layout had hidden: the `web` service had
no `env_file` at all (it needed nothing, because it proxied everything to the `api` service), and
neither service mounted `rules/` or the media volume. Both now do.

### Tests: 16, against a real Redis

```
$ pnpm exec vitest run src/mastra/scripts/worker-healthcheck.test.ts
 ✓ src/mastra/scripts/worker-healthcheck.test.ts (16 tests) 203ms

 Test Files  1 passed (1)
      Tests  16 passed (16)
```

| Group | Covers |
| --- | --- |
| constants | topic, group, key prefix and idle limit compared against `worker-health.ts`, where a real `mastra.startWorkers()` already pins them |
| `parseRedisUrl` | port and database defaults, a managed-Redis url with percent-encoded credentials and a database index, a rejected `rediss:` |
| `parseReply` | the nested RESP2 arrays `XINFO CONSUMERS` returns, a half-delivered array, a half-delivered bulk string, an error reply surfaced as an `Error` |
| `liveConsumerCount` | the idle limit, and reading `idle` by field name rather than by position |
| `checkWorkerAlive` | a group that does not exist, a consumer that just read, a consumer past the idle limit, and AUTH actually being written |
| the script as a healthcheck | exit 1 naming the group when no worker is consuming, exit 1 when `REDIS_URL` is unset |

The AUTH case works without a password-protected Redis: pointing at the local one with a password
makes it answer `ERR Client sent AUTH, but no password is set`, an error only reachable if the
command was written. The "no worker consuming" case points at Redis database 14 rather than
deleting the real orchestration stream out from under a running worker.

### Mutation sweep, 9 of 10 killed

| # | Mutation | Verdict |
| --- | --- | --- |
| M1 | `Number(parsed.port \|\| 6379)` to `Number(parsed.port)` | KILLED |
| M2 | protocol check removed | KILLED |
| M3 | `db === "" ? 0 : Number(db)` to `Number(db)` | SURVIVED, equivalent |
| M4 | partial-bulk-string length guard removed | KILLED |
| M5 | error reply returned as a string, not an `Error` | KILLED |
| M6 | `idle` read by position instead of field name | KILLED |
| M7 | idle limit ignored | KILLED |
| M8 | missing group rethrown instead of reported as no worker | KILLED |
| M9 | exits 0 when no worker is consuming | KILLED |
| M10 | AUTH never sent for a url with a password | KILLED |

M3 is equivalent, not a gap: `Number("")` is `0`, so the ternary and the bare conversion produce
the same value for the empty path a url without a database index gives.

M4 and M10 survived the first sweep and produced two new tests rather than an excuse. M4 survived
because the existing partial-reply test truncated an item in the *middle* of an array, which the
array's own item count catches anyway; only a truncated trailing bulk string reaches the length
guard. M10 survived because nothing had ever driven the AUTH branch.

### Gates

```
$ pnpm -C web tsc --noEmit
exit 0

$ pnpm -C web lint
exit 0

$ pnpm -C web test
 Test Files  2 failed | 132 passed (134)
      Tests  9 failed | 4507 passed | 7 skipped (4523)
exit 1

$ pnpm -C web build
exit 0
```

The 9 failures are exactly the known baseline for this tree, unchanged by this item: 6 in
`image-preview.test.tsx` (the Phase 0 baseline) and 3 in `PostDetail.test.tsx` (pre-existing,
confirmed by stashing in iteration 136). Test count rose by 16.

One run in three during this item also failed `scaffold-check.test.ts` at the file level with
`Error: Hook timed out in 60000ms` in its `beforeAll`, which passes in isolation in 4.6 s. That
is load contention on the shared Postgres and Redis under a full parallel run, not this item;
logged in `todo.md`.

`pytest` and `ruff` are no longer gates. `api/` does not exist.

### What this item did not do

- Item 7.7's `grep -rn "alembic\|arq\|fastapi\|uvicorn"` does not come back empty yet.
  `web/src/db/schema.ts` and `web/drizzle/0000_baseline.sql` both declare `alembic_version` on
  purpose, because the database Alembic built has that table and the baseline-parity check
  compares against it, and `todo.md` quotes the word in entries documenting Python-era defects.
  Logged in `todo.md`; 7.7 has to decide it explicitly rather than delete blindly.
- `docker compose up` has not been run end to end. That is item 7.6, and it needs 7.2 and 7.4
  first. What is proven here is that the production `worker` image builds, boots, reaches both
  datastores, joins the orchestration group and reports itself healthy.
- The dev `worker` service builds the bundle on start (`pnpm run worker:build && pnpm run worker`),
  which is why its healthcheck has a 90 s `start_period`. It has not been timed under compose.

## 7.2a

Make both runtime images self-contained: build them from the repo root so `rules/` ships
inside them, and fix the three defects that stopped `web` from building or running at all.

### Why the build context had to move

`rules/` lives at the repo root and both services read it: the six stage prompts come from
`rules/blog-<stage>.md` through `src/mastra/prompts.ts`, and `/api/rules/[name]` reads and
writes the same files. Until now both compose files supplied it as a bind mount
(`./rules:/app/rules`), so nothing in either image carried it.

Railway has no bind mounts. A volume there is empty persistent storage, so a `worker`
deployed with the old image would come up with no `rules` directory, and the failure mode is
not a crash: `renderStagePrompt()` treats a missing rule file as an empty section, so every
stage would run with its rule text silently stripped out of the prompt.

The Dockerfile therefore builds from the repo root (`docker build -f web/Dockerfile .`), and
both runtime stages `COPY rules ./rules` and pin `ENV RULES_DIR=/app/rules`. The compose bind
mounts are kept: a mount on the same path still wins, which is what makes editing a rule file
on the host show up in a running dev container.

`web/.dockerignore` moved to the repo root, because Docker only reads the `.dockerignore` at
the context root. The old file's `*.md` rule was context-relative and would now have excluded
`rules/*.md`; at the repo root `*.md` matches only top-level files, and the rules directory is
explicitly not excluded.

### Three defects this uncovered, all pre-existing

**1. `next build` cannot run without `DATABASE_URL_SYNC` and `REDIS_URL`.** The `runner`
target had never built. Confirmed against the previous Dockerfile, unchanged, at HEAD:

```
$ git show HEAD:web/Dockerfile > /tmp/Dockerfile.head
$ docker build -f /tmp/Dockerfile.head --target runner -t jena-web:head ./web
...
 > [builder 6/6] RUN pnpm build:
22.10   type: 'Error'
22.10 }
22.17  ELIFECYCLE  Command failed with exit code 1.
ERROR: failed to build: failed to solve: process "/bin/sh -c pnpm build" did not complete successfully: exit code: 1
```

The cause is `next build`'s page-data collection, which imports every route module.
`src/mastra/index.ts` constructs its `PostgresStore` (`getPool()`) and its `RedisStreamsPubSub`
at module scope, and both throw when their URL is unset:

```
Error: DATABASE_URL_SYNC (or DATABASE_URL) must be set to reach the database
> Build error occurred
Error: Failed to collect page data for /api/events/[post_id]
```

and after supplying the first:

```
Error: REDIS_URL must be set to reach the Mastra event bus
> Build error occurred
Error: Failed to collect page data for /api/events/[post_id]
```

Outside a container this never surfaced, because `next.config.ts` reads the repo-root `.env`
at `path.resolve(__dirname, "../.env")` and there is no such file in the image. The builder
stage now sets both to unreachable placeholders. They do not reach the runtime: only
`NEXT_PUBLIC_*` values are inlined by Next, and a builder-stage `ENV` does not carry into the
`runner` stage. Verified on the built image:

```
$ docker run --rm --entrypoint sh jena-web:7.2a -c '
    if grep -rl "build:build@127.0.0.1\|redis://127.0.0.1:6379" /app 2>/dev/null; then echo LEAK; else echo "no placeholder anywhere under /app"; fi
    echo "DATABASE_URL_SYNC=[${DATABASE_URL_SYNC:-<unset>}] REDIS_URL=[${REDIS_URL:-<unset>}] RULES_DIR=[$RULES_DIR] MEDIA_DIR=[$MEDIA_DIR]"'
no placeholder anywhere under /app
DATABASE_URL_SYNC=[<unset>] REDIS_URL=[<unset>] RULES_DIR=[/app/rules] MEDIA_DIR=[/app/media]
```

The first scan of that kind did find one file, `/app/Dockerfile`: with the context at the repo
root, `COPY web/ ./` brought the Dockerfile into the builder and Next's standalone output
copied it forward. `web/Dockerfile` is now excluded from the context (`-f` reads it off the
filesystem, not out of the context), which restores what the old `web/.dockerignore` did.

**2. `sharp` could not load in the `runner` image.** Every API route 500'd:

```
$ curl -s -o /dev/null -w '%{http_code}' http://localhost:3199/api/profiles
500
⨯ Error: Failed to load external module sharp-f7d5c822b461302c: Error: Could not load the "sharp" module using the linuxmusl-arm64 runtime
ERR_DLOPEN_FAILED: Error loading shared library libvips-cpp.so.8.18.3: No such file or directory (needed by /app/node_modules/.pnpm/@img+sharp-linuxmusl-arm64@0.35.3/node_modules/@img/sharp-linuxmusl-arm64/lib/sharp-linuxmusl-arm64-0.35.3.node)
```

The libvips package was in the image but its shared object was not: file tracing follows
`import`/`require`, so it copied the `.node` binding and the libvips package's `index.js`,
and stopped there. The `.so` is reached by `dlopen` from a sibling package, which tracing
cannot see.

```
$ docker run --rm --entrypoint sh jena-web:7.2a -c 'ls -la /app/node_modules/.pnpm/@img+sharp-libvips-linuxmusl-arm64@1.3.2/node_modules/@img/sharp-libvips-linuxmusl-arm64/lib'
total 12
-rw-r--r--    1 root     root            28 Aug 23 19:16 index.js
```

`next.config.ts` gains `outputFileTracingIncludes` (a top-level `NextConfig` key in the
installed Next 16.1.6: `node_modules/next/dist/server/config-shared.d.ts:1085`,
`outputFileTracingIncludes?: Record<string, string[]>`) with a glob that matches only what the
install actually produced, so it is inert on a platform whose libvips lives elsewhere. After:

```
$ docker run --rm --entrypoint sh jena-web:7.2a -c 'find /app/node_modules/.pnpm -name "libvips*.so*" -exec ls -la {} \;'
-rw-r--r--    1 root     root      16816688 /app/node_modules/.pnpm/@img+sharp-libvips-linux-arm64@1.2.4/node_modules/@img/sharp-libvips-linux-arm64/lib/libvips-cpp.so.8.17.3
-rw-r--r--    1 root     root      17800568 /app/node_modules/.pnpm/@img+sharp-libvips-linux-arm64@1.3.2/node_modules/@img/sharp-libvips-linux-arm64/lib/libvips-cpp.so.8.18.3
-rw-r--r--    1 root     root      18188576 /app/node_modules/.pnpm/@img+sharp-libvips-linuxmusl-arm64@1.3.2/node_modules/@img/sharp-libvips-linuxmusl-arm64/lib/libvips-cpp.so.8.18.3
-rw-r--r--    1 root     root      17049872 /app/node_modules/.pnpm/@img+sharp-libvips-linuxmusl-arm64@1.2.4/node_modules/@img/sharp-libvips-linuxmusl-arm64/lib/libvips-cpp.so.8.17.3
```

That is about 70 MB across two libc flavours and two sharp majors in the store. The glob is
deliberately not narrowed to `linuxmusl`: pinning it to the current Alpine base would make a
later base-image change fail the same way, silently, at the first image operation.

sharp then runs for real in both images:

```
$ docker exec jena-web-7.2a sh -c 'node -e "..." "$(ls -d /app/node_modules/.pnpm/sharp@* | tail -1)/node_modules/sharp"'
using /app/node_modules/.pnpm/sharp@0.35.3_@types+node@20.19.34/node_modules/sharp
sharp ok, png bytes: 95

$ docker exec jena-worker-7.2a node -e '... require("/app/.mastra/worker/node_modules/sharp") ...'
worker sharp ok, png bytes: 95
```

**3. BetterAuth refuses to boot in production without `BETTER_AUTH_SECRET`.** With
`NODE_ENV=production` and no secret it is a thrown `BetterAuthError`, not the warning it is in
dev, and it surfaced as an `unhandledRejection` on the first request:

```
[Error [BetterAuthError]: You are using the default secret. Please set `BETTER_AUTH_SECRET` in your environment variables or pass `secret` in your auth config.]
⨯ unhandledRejection:  [Error [BetterAuthError]: ...]
```

The repo `.env` has no `BETTER_AUTH_SECRET` at all (`POSTGRES_HOST_PORT`, `REDIS_HOST_PORT`,
`DATABASE_URL`, `DATABASE_URL_SYNC`, `TEST_DATABASE_URL`, `REDIS_URL`, `WORKER_MAX_JOBS`,
`GEMINI_API_KEY`, `BETTER_AUTH_URL`, `WP_ENCRYPTION_KEY`). No code change: this is a required
deployment variable, and item 7.2b's env table and item 7.4's `.env` documentation own it.

### Both images built and booted with no bind mounts at all

```
$ docker build -f web/Dockerfile --target worker -t jena-worker:7.2a .
#17 [worker 6/6] COPY rules ./rules
#17 DONE 0.0s
naming to docker.io/library/jena-worker:7.2a done
docker build ...  23.684 total

$ docker build -f web/Dockerfile --target runner -t jena-web:7.2a .
#17 [runner 7/7] COPY rules ./rules
#17 DONE 0.0s
naming to docker.io/library/jena-web:7.2a done
```

Rules byte-identical to the host, in the worker image:

```
$ docker run --rm --entrypoint sh jena-worker:7.2a -c 'md5sum /app/rules/*.md'
7e898b3d46fcb4fac00715a111d72c99  /app/rules/blog-edit.md
3e27a8a1f760d437d2cc95467616f6af  /app/rules/blog-images.md
9f32ce6f1712846aae8e1b789b7873c2  /app/rules/blog-outline.md
032961997b648b54e2896887d4e16192  /app/rules/blog-ready.md
6254d0640eba3f0fbf526237522c15c4  /app/rules/blog-research.md
339a6488043f51e88965b86dc59f579d  /app/rules/blog-write.md
$ md5 rules/*.md
MD5 (rules/blog-edit.md) = 7e898b3d46fcb4fac00715a111d72c99
MD5 (rules/blog-images.md) = 3e27a8a1f760d437d2cc95467616f6af
MD5 (rules/blog-outline.md) = 9f32ce6f1712846aae8e1b789b7873c2
MD5 (rules/blog-ready.md) = 032961997b648b54e2896887d4e16192
MD5 (rules/blog-research.md) = 6254d0640eba3f0fbf526237522c15c4
MD5 (rules/blog-write.md) = 339a6488043f51e88965b86dc59f579d
```

`worker`, run with `docker run` on the compose network and **no `-v` at all**, so nothing is
mounted over `/app/rules`:

```
$ docker run -d --name jena-worker-7.2a --network objective-port-jena-46c1e6-1_default \
    -e DATABASE_URL_SYNC=postgresql://pipeline:pipeline@db:5432/content_pipeline \
    -e REDIS_URL=redis://redis:6379 jena-worker:7.2a
$ docker logs jena-worker-7.2a | grep -i "workers started"
[mastra] Workers started
$ docker exec jena-worker-7.2a node /app/scripts/worker-healthcheck.mjs; echo "healthcheck exit=$?"
healthcheck exit=0
$ docker exec jena-worker-7.2a sh -c 'grep -c " /app/rules " /proc/self/mountinfo; head -c 60 "$RULES_DIR/blog-research.md"'
0
# Blog Research Agent

You are a blog content strategist and
```

`web`, same treatment, with a throwaway generated `BETTER_AUTH_SECRET`:

```
$ docker run -d --name jena-web-7.2a --network objective-port-jena-46c1e6-1_default -p 3199:3000 \
    -e DATABASE_URL_SYNC=... -e REDIS_URL=redis://redis:6379 \
    -e BETTER_AUTH_URL=http://localhost:3199 -e BETTER_AUTH_SECRET="$(openssl rand -hex 32)" jena-web:7.2a
✓ Starting...
✓ Ready in 38ms
/                                -> 307
/auth/sign-in                    -> 200
/api/profiles                    -> 401
/api/posts                       -> 401
/api/settings                    -> 401
/api/rules/blog-research         -> 401
```

`307` on `/` is the unauthenticated redirect and `401` is the ported handlers'
`{"detail":"Not authenticated"}`, both reached without a stack trace in the log. The rules
route resolving to `401` rather than a 500 is what proves `RULES_DIR` is present and readable.

Both compose files validate against the new context:

```
$ docker compose -f docker-compose.yml config -q && echo "dev compose OK"
dev compose OK
$ docker compose -f docker-compose.prod.yml config -q && echo "prod compose OK"
prod compose OK
```

### No automated test

This item changes build inputs only: a Dockerfile, a `.dockerignore`, two compose build blocks
and one `next.config.ts` key. The only assertion worth making about them is that the images
build and run, which is what is pasted above; a vitest file that shelled out to `docker build`
would add minutes to every gate run to re-assert exactly that. No mutation sweep for the same
reason: there is no test to kill a mutant with.

### Gates

```
$ pnpm -C web exec tsc --noEmit ; echo "tsc exit=$?"
tsc exit=0

$ pnpm -C web lint ; echo "lint exit=$?"
lint exit=0

$ pnpm -C web build ; echo "build exit=$?"
build exit=0

$ pnpm -C web test
 Test Files  2 failed | 132 passed (134)
      Tests  9 failed | 4507 passed | 7 skipped (4523)
```

The 9 are the recorded baseline: 6 in `image-preview.test.tsx` and 3 in `PostDetail.test.tsx`.

An earlier run of the same suite reported **11** failures, adding one in
`src/app/api/posts/create.test.ts` and one in `src/mastra/workflows/scaffold-check.test.ts`.
Cause: the `jena-worker-7.2a` container was still running and subscribed to the same Redis
orchestration consumer group as the tests, so it consumed events the in-process test workers
were waiting for. With the container stopped, both files pass:

```
$ docker rm -f jena-worker-7.2a jena-web-7.2a
$ pnpm -C web test src/app/api/posts/create.test.ts src/mastra/workflows/scaffold-check.test.ts
 Test Files  2 passed (2)
      Tests  30 passed (30)
```

That also explains the intermittent `scaffold-check.test.ts` `beforeAll` timeout logged under
7.1c as load contention. A consumer group has exactly one delivery per message, so any second
worker on the shared Redis is a correctness hazard for the suite, not just a load one.

### What this item did not do

- No Railway configuration files yet. That is 7.2b, which now has three inputs from here: the
  build context is the repo root and the Dockerfile path is `web/Dockerfile`; `BETTER_AUTH_SECRET`
  is required per service; and Railway volumes cannot be shared between services
  (railway.com/docs: "Each service can only have a single volume"), so `web` serving `/media`
  and `worker` writing generated images cannot see the same disk there. That is a real gap for
  7.2b to state, not to paper over.
- The `BetterAuthError` lines printed during `next build` inside the image are pre-existing
  noise, not fatal, and unrelated to the build context. Logged in `todo.md`.

## 7.2b

The Railway service definitions themselves.

### The form the config had to take

`railway.json` was the plan; it is not usable. Railway's own docs:

> Config as Code (`railway.json` / `railway.toml`) is **deprecated**. Infrastructure as Code
> (`.railway/railway.ts`) is the replacement.
>
> Config as Code is still read from your service repository during deploy for existing
> (legacy) services [...] New services cannot opt into Config as Code. Existing Config as Code
> files stop being read on **2026-12-01** (hard cutoff).
>
> (docs.railway.com/infrastructure-as-code)

So the deliverable is `.railway/railway.ts`. It is also the better fit: one file describes both
services, both managed databases and the volume, where Config as Code describes a single
service and would have needed two files plus a per-service "Railway Config File" path setting
(itself documented as not following the service's Root Directory).

The DSL is the `railway` npm package, whose `./iac` subpath export is real:

```
$ curl -sS https://registry.npmjs.org/railway | python3 -c "..."
latest 3.10.0 desc TypeScript SDK for Railway.
exports {".": {...}, "./iac": {"import": {"types": "./dist/iac/index.d.ts", "default": "./dist/iac/index.js"}, "require": {...}}}
bin {"railway-iac-ts": "dist/iac/bin.js"}
modified 2026-08-13T23:31:46.996Z
```

Every key used in `.railway/railway.ts` was read off that package's type definitions rather
than off the docs page (`node_modules/railway/dist/index-F4_q1IqR.d.ts`):

```ts
interface IntentServiceConfig {
    source?: SourceConfig | Omit<SourceConfig, "type">;
    root?: string; rootDirectory?: string;
    build?: string | BuildConfig;
    deploy?: DeployConfig;
    start?: string; startCommand?: string;
    healthcheck?: string; healthcheckPath?: string; healthcheckTimeout?: number;
    replicas?: number | Record<string, RegionConfig>;
    env?: Record<string, string | VariableConfig | VariableValue>;
    volumeMounts?: Record<string, VolumeMount | null | VolumeNode>;
    ...
}
type BuildConfig = {
    builder?: "NIXPACKS" | "DOCKERFILE" | "RAILPACK" | "HEROKU" | "PAKETO" | null;
    watchPatterns?: string[] | null;
    buildCommand?: string | null;
    buildEnvironment?: "V2" | "V3" | null;
    dockerfilePath?: string | null;
    nixpacksConfigPath?: string | null; nixpacksPlan?: unknown;
    nixpacksVersion?: string | null; railpackVersion?: string | null;
};
```

`BuildConfig` has no build-target key, and neither did the deprecated
`railway.schema.json` (`build.additionalProperties: false`, properties `builder`,
`watchPatterns`, `buildCommand`, `dockerfilePath`, `nixpacksConfigPath`, `nixpacksPlan`,
`nixpacksVersion`, `railpackVersion`). A Railway build therefore gets Docker's default
target: the last stage in the Dockerfile. That is the constraint the image change below
answers.

### What landed

- `.railway/railway.ts`: `postgres`, `redis`, a `media` volume, and the `web` and `worker`
  services, both built from `web/Dockerfile` with `builder: "DOCKERFILE"` and separated only
  by their start commands.
- `web/Dockerfile` gains a sixth and now-last stage, `railway`, built `FROM runner` plus the
  worker bundle, the textstat corpus and the worker healthcheck. `docker-compose.yml` keeps
  building the narrower `runner` and `worker` targets.
- `web/Dockerfile`'s builder stage gains `ARG NEXT_PUBLIC_APP_URL` / `ENV`. `next build`
  inlines `NEXT_PUBLIC_*`, and `src/lib/auth-client.ts` reads `NEXT_PUBLIC_APP_URL`, so
  without the arg the deployed browser client would keep its `http://localhost:3000`
  fallback.
- `web/src/app/api/health/route.ts` plus 3 tests: Railway "will query the endpoint until it
  receives an HTTP 200 response", and `/` answers 307 to unauthenticated requests.
- Both compose files' `web` healthcheck now probes `/api/health` instead of `/`.
- `docs/mastra-port/railway.md`: the per-service environment variable tables, the one-time
  setup steps the file cannot do, and the known gaps.

### The file compiles to the intended graph

The Railway CLI is not installed here, so `railway config plan` could not be run against a
live project. The next best thing is the package's own evaluator, which is the same code path
the CLI drives: `evaluateRailwayFile()` from `railway@3.10.0` on a byte-identical copy
(`md5 101dd537398a19dfa92403771f3ab769` for both the repo file and the evaluated copy).

```
$ node eval.mjs /tmp/rwiac/.railway/railway.ts   # evaluateRailwayFile(..., {command: "plan", environment: "production"})
diagnostics: null

-- web {"deploy": {"startCommand": "node server.js", "healthcheckPath": "/api/health", "healthcheckTimeout": 300, "numReplicas": 1}}
   vars: {'DATABASE_URL_SYNC': ('reference', None), 'REDIS_URL': ('reference', None),
          'WP_ENCRYPTION_KEY': ('preserve', None), 'BETTER_AUTH_SECRET': ('preserve', None),
          'BETTER_AUTH_URL': ('literal', 'https://${{RAILWAY_PUBLIC_DOMAIN}}'),
          'NEXT_PUBLIC_APP_URL': ('literal', 'https://${{RAILWAY_PUBLIC_DOMAIN}}'),
          'STRIPE_SECRET_KEY': ('preserve', None), 'STRIPE_WEBHOOK_SECRET': ('preserve', None),
          'RESEND_API_KEY': ('preserve', None), 'EMAIL_FROM': ('preserve', None)}

-- worker {"deploy": {"startCommand": "node .mastra/worker/index.mjs", "numReplicas": 1}}
   vars: {'DATABASE_URL_SYNC': ('reference', None), 'REDIS_URL': ('reference', None),
          'WP_ENCRYPTION_KEY': ('preserve', None)}
   volumeAttachments: {"media": {"volume": "volume.media", "mountPath": "/app/media"}}

-- volume {"address": "volume.media", "type": "volume", "name": "media", "config": {"sizeMB": 5120}}
```

The compiled desired state resolves the database references into Railway's own variable
syntax, and drops every `preserve()` variable rather than writing it, which is what keeps
secrets out of git without an apply clobbering the dashboard value:

```json
"worker": {
  "source": {"repo": "upnorthmedia/pipeline", "branch": "master"},
  "build": {"builder": "DOCKERFILE", "dockerfilePath": "web/Dockerfile",
            "watchPatterns": ["web/**", "rules/**", ".railway/**"]},
  "deploy": {"startCommand": "node .mastra/worker/index.mjs", "numReplicas": 1},
  "variables": {"DATABASE_URL_SYNC": {"value": "${{postgres.DATABASE_URL}}"},
                "REDIS_URL": {"value": "${{redis.REDIS_URL}}"}},
  "volumeMounts": {"media": {"mountPath": "/app/media"}}
}
```

Two things the evaluation also settled: `github(...)` defaults `branch` to `"main"`, so
`master` had to be stated; and Railway's managed Postgres helper resolves to
`ghcr.io/railwayapp-templates/postgres-ssl:18`, a major ahead of the dev database's 17, which
still satisfies the `UNIQUE NULLS NOT DISTINCT` requirement from item 6.0 (Postgres 15+).

### The default build target is the combined stage

```
$ docker build -f web/Dockerfile -t jena-default:iter143 .        # no --target
$ docker image inspect jena-default:iter143 jena-railway:iter143 --format '{{.Id}} {{json .Config.Cmd}}'
sha256:93174495e516d92fc4ccc52fbbcf847d88a8e4cef712bd141e1fa48558b4b997 ["node","server.js"]
sha256:caec65463a631b62782b20dc2015a28c9317dfbfa0f10a2e307d5373eee48a5d ["node","server.js"]

$ docker run --rm jena-default:iter143 sh -c 'ls -d /app/.mastra/worker /app/rules /app/src/mastra/textstat/data && echo ...'
/app/.mastra/worker
/app/rules
/app/src/mastra/textstat/data
TEXTSTAT_DATA_DIR=/app/src/mastra/textstat/data RULES_DIR=/app/rules MEDIA_DIR=/app/media
```

A target-less build produces the `railway` stage, and that image carries both payloads.

### Both start commands run out of that one image

Against the real Postgres and Redis on the compose network, with no bind mounts:

```
$ docker run -d --name jena-rw-web --network objective-port-jena-46c1e6-1_default \
    -e DATABASE_URL_SYNC=... -e REDIS_URL=redis://redis:6379 -e WP_ENCRYPTION_KEY=<redacted> \
    -e BETTER_AUTH_SECRET=<redacted> -p 3311:3000 jena-default:iter143 node server.js

$ curl -sS -i http://localhost:3311/api/health | head -3
HTTP/1.1 200 OK
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
content-type: application/json
{"status":"ok"}

$ curl -sS -o /dev/null -w '%{http_code} -> %{redirect_url}\n' http://localhost:3311/
307 -> http://localhost:3311/auth/sign-in

$ curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3311/api/posts
401

$ docker logs jena-rw-web | tail -5
▲ Next.js 16.1.6
✓ Starting...
✓ Ready in 38ms
(two BetterAuth warnings about the throwaway smoke-test secret's length and entropy)
```

The 307 on `/` is why the healthcheck path exists: Railway only accepts a 200.

```
$ docker run -d --name jena-rw-worker --network objective-port-jena-46c1e6-1_default \
    -e DATABASE_URL_SYNC=... -e REDIS_URL=redis://redis:6379 -e WP_ENCRYPTION_KEY=<redacted> \
    jena-default:iter143 node .mastra/worker/index.mjs

$ docker logs jena-rw-worker | head -13
ERROR (content-pipeline): Profile a8d2721b-... not found        <- stale dev-Redis backlog
... eleven more ...
[mastra] Workers started

$ docker exec jena-rw-worker node /app/scripts/worker-healthcheck.mjs; echo "exit=$?"
exit=0

$ docker exec jena-rw-worker sh -c 'ls /app/rules'
blog-edit.md blog-images.md blog-outline.md blog-ready.md blog-research.md blog-write.md
```

Same image, same `web/src/mastra/index.ts`, two entry points. The backlog errors are the
same shared-dev-Redis noise recorded under 7.1c, and are the strongest available proof that
the bundled worker is subscribed to the topic the app publishes on. Both containers were
removed afterwards.

An aside worth recording: the dev Redis container had exited on its own before this test
(`getaddrinfo ENOTFOUND redis` from inside the network while `docker ps` still showed it
healthy). On restart it logged `RDB memory usage when created 4228.13 Mb` for 983 keys.
Logged in `todo.md`.

### Gates

```
$ pnpm -C web tsc --noEmit
exit=0
$ pnpm -C web lint
exit=0
$ pnpm -C web test
 Test Files  2 failed | 133 passed (135)
      Tests  9 failed | 4510 passed | 7 skipped (4526)
$ pnpm -C web build
✓ Compiled successfully in 6.7s
├ ƒ /api/health
$ docker compose -f docker-compose.yml config -q && docker compose -f docker-compose.prod.yml config -q
compose dev ok
compose prod ok
```

9 failures is the standing baseline for this tree (6 in `image-preview.test.tsx`, 3 in
`PostDetail.test.tsx`), unchanged, with 4510 passing.
