# Build context is the repo root, not `web/`, so that `rules/` can be copied
# into the runtime images. Build with:
#   docker build -f web/Dockerfile --target runner .
# `docker-compose.yml` and the Railway service definitions both point here.

# Stage 1: Install dependencies
FROM node:22-alpine AS deps

WORKDIR /app

# No version here: corepack resolves `packageManager` out of package.json, so
# the image installs with the same pnpm the lockfile was written by. `latest`
# tracked into a pnpm major that turns the ignored-build-scripts warning into
# an error and broke the build.
RUN corepack enable

# `.npmrc` and `pnpm-workspace.yaml` carry the hoist patterns and the
# ignored-build-scripts list; without them the container install resolves
# differently from the local one.
COPY web/package.json web/pnpm-lock.yaml* web/.npmrc web/pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile

# Copy config files needed for dev server
COPY web/next.config.ts web/tsconfig.json web/postcss.config.mjs web/eslint.config.mjs web/components.json ./

# Stage 2: Build
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY web/ ./

ENV NEXT_TELEMETRY_DISABLED=1

# `next build` collects page data by importing every route module, and
# `src/mastra/index.ts` builds its Postgres store and its Redis pub/sub at
# module scope, so the build needs both URLs to be parseable even though it
# never opens either connection. Outside a container `next.config.ts` supplies
# them by reading the repo-root `.env`, which is why this only ever failed in an
# image. Neither placeholder reaches the runtime: Next inlines only
# `NEXT_PUBLIC_*` values, and a builder-stage `ENV` does not carry into the
# runner stage.
ENV DATABASE_URL_SYNC="postgresql://build:build@127.0.0.1:5432/build"
ENV REDIS_URL="redis://127.0.0.1:6379"

# `NEXT_PUBLIC_*` values are inlined into the client bundle by `next build`, so
# the dashboard's BetterAuth client takes its base URL from here and not from
# the runtime environment. Railway passes a service's variables to the build,
# which is what this `ARG` reads; an empty value leaves the client on its
# `http://localhost:3000` fallback, so a deployment has to set it.
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL

RUN pnpm build

# Stage 3: Production runtime
FROM node:22-alpine AS runner

WORKDIR /app

RUN corepack enable

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Copy only what's needed to run
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# The stage prompts and the rules editor read these off disk. Baked in rather
# than mounted so a deployment without bind mounts still has them; a compose
# bind mount on the same path still wins.
COPY rules ./rules
ENV RULES_DIR=/app/rules

# Generated images. A volume is mounted here in every deployment; the default
# is pinned so an unmounted container writes inside /app instead of /.
ENV MEDIA_DIR=/app/media

EXPOSE 3000

ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]

# Stage 4: Build the Mastra worker bundle
#
# `mastra worker build` is a different resolution environment from `next build`,
# so it gets its own stage rather than riding along in the builder above: a
# dependency that resolves for Next.js can still be unresolvable in the bundle.
FROM node:22-alpine AS worker-builder

WORKDIR /app

RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY web/ ./

RUN pnpm run worker:build

# Stage 5: Worker runtime
#
# The bundle carries its own `node_modules`, so this image holds no application
# dependencies. Anything the pipeline reads off disk therefore has to be copied
# in and pointed at explicitly: `mastra worker build` has no asset-copy option
# (its BundlerConfig is externals / sourcemap / minify / transpilePackages /
# dynamicPackages), and every default path in the app resolves from the cwd,
# which for the bundle is its own output directory.
FROM node:22-alpine AS worker

WORKDIR /app

ENV NODE_ENV=production

COPY --from=worker-builder /app/.mastra/worker ./.mastra/worker
COPY --from=worker-builder /app/src/mastra/textstat/data ./src/mastra/textstat/data
COPY --from=worker-builder /app/src/mastra/scripts/worker-healthcheck.mjs ./scripts/
COPY rules ./rules

ENV TEXTSTAT_DATA_DIR=/app/src/mastra/textstat/data
ENV RULES_DIR=/app/rules
ENV MEDIA_DIR=/app/media

CMD ["node", ".mastra/worker/index.mjs"]

# Stage 6: the image both Railway services run
#
# Railway has no way to select a build target: neither the deprecated
# `railway.json` schema nor the `.railway/railway.ts` `BuildConfig`
# (`builder`, `watchPatterns`, `buildCommand`, `buildEnvironment`,
# `dockerfilePath`, `nixpacks*`, `railpackVersion`) carries one, so a Railway
# build gets Docker's default, which is the last stage in the file. This stage
# is therefore last on purpose, and holds both entry points: the `web` service
# starts `node server.js` and the `worker` service starts
# `node .mastra/worker/index.mjs`, the same split `docker-compose.yml` gets
# from its two targets.
#
# Both still import the same `web/src/mastra/index.ts`: `web` through the Next
# standalone server's traced modules, `worker` through the bundle.
FROM runner AS railway

COPY --from=worker-builder /app/.mastra/worker ./.mastra/worker
COPY --from=worker-builder /app/src/mastra/textstat/data ./src/mastra/textstat/data
COPY --from=worker-builder /app/src/mastra/scripts/worker-healthcheck.mjs ./scripts/

# Set here rather than only in the `worker` stage because the Next standalone
# server has the same problem for a different reason: file tracing does not
# follow a runtime `path.resolve` into a data directory, so the readability
# scores in the `edit` stage need the corpus pointed at explicitly in both
# entry points.
ENV TEXTSTAT_DATA_DIR=/app/src/mastra/textstat/data

CMD ["node", "server.js"]
