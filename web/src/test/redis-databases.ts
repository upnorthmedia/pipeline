/**
 * Which Redis database each suite that needs its own transport owns.
 *
 * Every suite that starts a real Mastra worker shares the same topic name
 * (`workflows`), the same consumer group (`mastra-orchestration`) and the same
 * key prefix, because those are the app's values and a test that changed them
 * would not be testing the app. The only thing keeping two such suites out of
 * each other's events is the Redis database number, and Vitest runs test files
 * concurrently, so two suites that pick the same number are not isolated at
 * all: they are a race that passes on whichever machine happens to schedule
 * them apart.
 *
 * `worker-healthcheck.test.ts` and `reclaim-duplication.test.ts` both claimed
 * database 14 as "a database no worker uses". CI found it; nothing local did.
 * The numbers live here so a new claim is a one-line diff against every
 * existing one, and `redis-databases.test.ts` fails if two owners collide or if
 * a file selects a database this table does not give it.
 *
 * Database 0 is deliberately absent: it is the app's own, and the suites that
 * exercise the app's default wiring use it.
 */

/**
 * Keys are repo-relative paths from `web/`. A value may be a list when one file
 * runs the same probe against two databases.
 */
export const REDIS_TEST_DATABASES: Readonly<Record<string, readonly number[]>> = Object.freeze({
  "src/mastra/scripts/worker-healthcheck.test.ts": [8],
  "src/mastra/workflows/worker-process.test.ts": [9],
  "src/mastra/workflows/web-restart.test.ts": [10],
  "src/mastra/workflows/crash-probe.test.ts": [11],
  "src/mastra/workflows/sigterm-shutdown.test.ts": [7],
  "src/mastra/scripts/durability-gate.mjs": [12],
  "src/mastra/scripts/full-pipeline.mjs": [13],
  "src/mastra/workflows/reclaim-duplication.test.ts": [14, 15],
})

/** The database `owner` may use, or its `index`-th when it claims several. */
export function redisDatabaseFor(owner: string, index = 0): number {
  const databases = REDIS_TEST_DATABASES[owner]
  if (!databases || databases[index] === undefined) {
    throw new Error(
      `no Redis database ${index} registered for ${owner}; add it to src/test/redis-databases.ts`,
    )
  }
  return databases[index]
}

/** `REDIS_URL` pointed at `owner`'s database, whatever host the repo `.env` names. */
export function isolatedRedisUrl(owner: string, index = 0): string {
  const url = new URL(process.env.REDIS_URL!)
  url.pathname = `/${redisDatabaseFor(owner, index)}`
  return url.toString()
}
