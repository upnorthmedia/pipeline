// @vitest-environment node
/**
 * The invariant behind `redis-databases.ts`: one Redis database, one owner.
 *
 * Two suites claiming the same database are not isolated, they are a race, and
 * the race is invisible on a machine that happens to schedule them apart. This
 * checks the table for collisions and then checks the source for claims the
 * table does not know about, because a registry nobody uses is worse than no
 * registry: it reads as a guarantee.
 *
 * Needs no services.
 */
import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { REDIS_TEST_DATABASES, isolatedRedisUrl, redisDatabaseFor } from "./redis-databases"

const WEB_ROOT = path.resolve(__dirname, "../..")

/**
 * How a file selects a Redis database: a literal path on a `URL` built from
 * `REDIS_URL`, or the `REDIS_DB` constant the two standalone `.mjs` scripts
 * use. Both forms are matched with the literal digits, so a template
 * interpolation (`/${database}`) is not a claim: the number it carries came
 * from somewhere, and that somewhere is what this looks for.
 */
const CLAIM_PATTERNS = [/\.pathname\s*=\s*[`"']\/(\d+)[`"']/g, /REDIS_DB\s*=\s*"(\d+)"/g]

/** The registry itself holds the numbers; scanning it would report every claim twice. */
const SELF = ["src/test/redis-databases.ts", "src/test/redis-databases.test.ts"]

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.name === "node_modules") continue
    if (entry.isDirectory()) found.push(...sourceFiles(full))
    else if (/\.(tsx?|mjs)$/.test(entry.name)) found.push(full)
  }
  return found
}

/** Every claim in the tree, as `{ file, database }`, file relative to `web/`. */
function scanClaims(): { file: string; database: number }[] {
  const files = [...sourceFiles(path.join(WEB_ROOT, "src")), ...sourceFiles(path.join(WEB_ROOT, "e2e"))]
    .map((full) => path.relative(WEB_ROOT, full))
    .filter((file) => !SELF.includes(file))
  const claims: { file: string; database: number }[] = []
  for (const file of files) {
    const source = fs.readFileSync(path.join(WEB_ROOT, file), "utf8")
    for (const pattern of CLAIM_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        claims.push({ file, database: Number(match[1]) })
      }
    }
  }
  return claims
}

describe("the Redis test-database registry", () => {
  it("gives every database exactly one owner", () => {
    const owners = new Map<number, string[]>()
    for (const [owner, databases] of Object.entries(REDIS_TEST_DATABASES)) {
      for (const database of databases) {
        owners.set(database, [...(owners.get(database) ?? []), owner])
      }
    }
    const shared = [...owners.entries()].filter(([, files]) => files.length > 1)
    expect(shared, "two suites on one Redis database are a race, not isolation").toEqual([])
  })

  it("claims no database outside the 1-15 a default Redis offers, and never 0", () => {
    // `databases 16` is the Redis default, so 15 is the last one, and 0 belongs
    // to the app: a suite that lands there sees the developer's own worker.
    for (const [owner, databases] of Object.entries(REDIS_TEST_DATABASES)) {
      for (const database of databases) {
        expect(database, `${owner} claims database ${database}`).toBeGreaterThan(0)
        expect(database, `${owner} claims database ${database}`).toBeLessThan(16)
      }
    }
  })

  it("names files that exist", () => {
    for (const owner of Object.keys(REDIS_TEST_DATABASES)) {
      expect(fs.existsSync(path.join(WEB_ROOT, owner)), `${owner} is not in the tree`).toBe(true)
    }
  })

  it("resolves an owner's database and refuses one it does not have", () => {
    expect(redisDatabaseFor("src/mastra/workflows/reclaim-duplication.test.ts", 1)).toBe(15)
    expect(() => redisDatabaseFor("src/mastra/workflows/crash-probe.test.ts", 1)).toThrow(
      /no Redis database 1 registered/,
    )
    expect(() => redisDatabaseFor("src/nothing/here.test.ts")).toThrow(/add it to/)
  })

  it("points a url at the owner's database and keeps the .env host", () => {
    const configured = new URL(process.env.REDIS_URL!)
    const isolated = new URL(isolatedRedisUrl("src/mastra/workflows/web-restart.test.ts"))
    expect(isolated.host).toBe(configured.host)
    expect(isolated.pathname).toBe("/10")
  })
})

describe("the source of every Redis database claim", () => {
  const claims = scanClaims()

  it("finds the claims it is meant to police", () => {
    // Anti-vacuity: a scan that matches nothing would make every assertion
    // below pass. The two standalone scripts are the floor because they cannot
    // import the registry; they run as bare `node` outside the TypeScript build.
    expect(claims.map((claim) => claim.file)).toContain("src/mastra/scripts/durability-gate.mjs")
    expect(claims.map((claim) => claim.file)).toContain("src/mastra/scripts/full-pipeline.mjs")
  })

  it("selects only a database the registry gives that file", () => {
    for (const { file, database } of claims) {
      expect(
        REDIS_TEST_DATABASES[file] ?? [],
        `${file} selects Redis database ${database}; register it in src/test/redis-databases.ts`,
      ).toContain(database)
    }
  })
})
