# Mastra Studio

Studio is the debugging surface for the pipeline. It renders whatever is
registered on the Mastra instance in
[`web/src/mastra/index.ts`](../../web/src/mastra/index.ts): the workflows and
their step graphs, the run input form generated from each workflow's Zod
`inputSchema`, every recent run with its status, and the agents. It reads run
state out of the same `content_pipeline` Postgres the dashboard uses, so it
shows runs it did not start.

It is a local development tool in this repo. It is not deployed.

## Running it locally, alongside `next dev`

```sh
docker compose up -d db redis     # Studio opens both connections at import time
pnpm -C web dev                   # dashboard on http://localhost:3000
pnpm -C web studio                # Studio on http://localhost:4111
```

The two servers are independent processes on different ports and can run at the
same time. Both read the repo-root `.env`, so both point at the same Postgres
and the same Redis: `next dev` through `next.config.ts`, which loads
`../.env`, and Studio through the `--env ../.env` flag baked into the `studio`
script. The Mastra CLI does not find the repo-root `.env` on its own, and
without it the entry point throws on `REDIS_URL` instead of starting against a
default store.

The script is:

```json
"studio": "MASTRA_WORKERS=false mastra dev --env ../.env"
```

### Why `MASTRA_WORKERS=false`

`mastra dev` starts Mastra's execution workers, not just the Studio UI. With
them running the dev server joins the `mastra-orchestration` consumer group on
the Redis Streams `workflows` topic, exactly as the `worker` service does.
Redis Streams delivers each entry to one consumer in a group, so a bare
`mastra dev` will:

- steal steps from the real `worker` service, executing them in the dev process
  rather than the one under test, and
- immediately drain whatever backlog is on the topic, running work nobody asked
  it to run. Booting it against the shared dev Redis failed a batch of old runs
  whose posts had since been deleted.

`MASTRA_WORKERS=false` (read by the `Mastra` constructor in
`@mastra/core@1.61.0`) disables every worker on the instance. Studio still
lists workflows, steps and runs, because those come from storage over HTTP.
Verified: with the flag, no consumer joins the group; without it, one does.

Consequence: with workers disabled, pressing **Run** in Studio publishes the
start event and nothing executes it unless a worker is running
(`pnpm -C web worker`, or the `worker` container). That is the right default,
because it is the real worker you want to exercise. Drop the variable
(`pnpm -C web exec mastra dev --env ../.env`) only when you deliberately want
the dev server itself to execute steps, and only when no other worker is
running.

`next dev` never joins the group: the `web` service starts runs and reads state,
it does not consume the topic.

## What Studio shows for this app

`http://localhost:4111/workflows` lists all seven registered workflows.
`pipeline` is the port's main artifact:

| Workflow | Steps |
| --- | --- |
| `pipeline` | `pipeline-start`, `research`, `outline`, `write`, `edit`, `images`, `ready`, `pipeline-complete` |
| `images` | `images-manifest`, `mapping_images_0`, `images-generate`, `images-assemble` |
| `sitemapCrawl`, `recrawlCheck`, `wordpressPublish`, `nextjsPublish`, `scaffoldCheck` | one or two steps each |

Screenshots: [`studio/7.3-studio-workflows-list.png`](studio/7.3-studio-workflows-list.png)
and [`studio/7.3-studio-pipeline-detail.png`](studio/7.3-studio-pipeline-detail.png),
the latter showing the `8 steps` badge, the linear graph
`Start -> pipeline-start -> research -> outline -> write -> edit -> images ->
ready -> pipeline-complete -> End`, the run form generated from the workflow's
`inputSchema` (`Post Id`, `Stages`), and recent runs in `success`, `suspended`
and `failed` states.

The six agents (`research`, `outline`, `write`, `edit`, `images`, `ready`) are
listed under **Agents**.

## Mount path: `server.studioBase`

This app does not configure `server` on the Mastra instance, so Studio is at
the root of its own port: `http://localhost:4111/`, with the API under
`/api`.

If Studio ever needs to be hosted on a sub-path (sharing a domain with another
service, or sitting behind an access proxy that keys on path), the option is
`server.studioBase` on the `Mastra` config, `ServerConfig["studioBase"]` in
`@mastra/core/dist/server/types.d.ts`, default `/`:

```ts
export const mastra = new Mastra({
  server: { studioBase: "/my-mastra-studio" },
})
```

Studio then serves from `http://<host>:<port>/my-mastra-studio/`. Neighbouring
options in the same type, for when the public address differs from the bind
address: `studioHost`, `studioProtocol`, `studioPort`, and `apiPrefix` for the
API mount.

## Studio is never publicly exposed

Studio can trigger runs, resume suspended runs, read every run's inputs and
outputs, and delete runs. It has no authentication of its own.

- Neither Railway service runs it. Both start commands in
  [`.railway/railway.ts`](../../.railway/railway.ts) are application entry
  points (`node server.js` for `web`, `node .mastra/worker/index.mjs` for
  `worker`); nothing in either image starts a Studio server, and only `web` has
  a public domain.
- Neither compose file exposes it either.
- If it is ever pointed at a deployed environment, it must sit behind
  authentication or on a private network only, never on a public domain. Using
  a Railway private-network address, or an SSH/`railway connect` tunnel to the
  managed Postgres with Studio still running locally, keeps that property.

See also the deployment gaps in [`railway.md`](railway.md).
