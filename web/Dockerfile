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
COPY package.json pnpm-lock.yaml* .npmrc pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile

# Copy config files needed for dev server
COPY next.config.ts tsconfig.json postcss.config.mjs eslint.config.mjs components.json ./

# Stage 2: Build
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

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
COPY . .

RUN pnpm run worker:build

# Stage 5: Worker runtime
#
# The bundle carries its own `node_modules`, so this image holds no application
# dependencies. Anything the pipeline reads off disk therefore has to be copied
# in and pointed at explicitly: `mastra worker build` has no asset-copy option
# (its BundlerConfig is externals / sourcemap / minify / transpilePackages /
# dynamicPackages), and every default path in the app resolves from the cwd.
FROM node:22-alpine AS worker

WORKDIR /app

ENV NODE_ENV=production

COPY --from=worker-builder /app/.mastra/worker ./.mastra/worker
COPY --from=worker-builder /app/src/mastra/textstat/data ./src/mastra/textstat/data
COPY --from=worker-builder /app/src/mastra/scripts/worker-healthcheck.mjs ./scripts/

# `rules` and `media` are mounts, so the compose and Railway definitions own
# those two; the textstat corpus ships in the image and is pinned here.
ENV TEXTSTAT_DATA_DIR=/app/src/mastra/textstat/data

CMD ["node", ".mastra/worker/index.mjs"]
