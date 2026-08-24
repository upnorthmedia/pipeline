/**
 * Proves a deployed image would carry everything `scripts/migrate.mjs` needs.
 *
 * The `runner` and `railway` images are `.next/standalone` copied into an
 * `/app` that holds no other `node_modules`, so a package the app imports
 * through a bundled chunk is not a package a sibling script can import.
 * `drizzle-orm` was exactly that until ledger item P2.77b: the standalone tree
 * carried `drizzle/` and `scripts/` but not the ORM, and
 * `drizzle-orm/node-postgres/migrator` could not be reached from either image.
 *
 * Running the migration here would prove nothing, for the same reason
 * `pnpm worker:check` asserts physical presence rather than resolvability: on a
 * dev machine and in CI the standalone tree sits inside `web/`, and Node's
 * resolution walks up into `web/node_modules`, where everything is installed.
 * So this asks where each file actually is, and holds every package the script
 * imports against the two things that can supply it: the standalone output, or
 * a `COPY` in the Dockerfile that lands it in `/app/node_modules`.
 *
 * Run it after `pnpm build`, through `pnpm standalone:check`.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const standalone = path.join(web, ".next", "standalone")

function fail(message) {
  console.error(`standalone migrate check: ${message}`)
  process.exit(1)
}

// A missing artifact has to be an error rather than a skip, or the gate passes
// on any run where the build step was removed.
if (!fs.existsSync(path.join(standalone, "server.js"))) {
  fail(".next/standalone/server.js is missing; run `pnpm build` first")
}

const script = path.join(standalone, "scripts", "migrate.mjs")
if (!fs.existsSync(script)) {
  fail("scripts/migrate.mjs is not in the standalone output, so no image carries the command")
}

/** The migration folder is data, not an import, so nothing traces it. */
const journalPath = path.join(standalone, "drizzle", "meta", "_journal.json")
if (!fs.existsSync(journalPath)) {
  fail("drizzle/meta/_journal.json is not in the standalone output")
}
const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"))
if (!journal.entries?.length) {
  fail("the standalone journal lists no migrations, which no build of this app produces")
}
for (const entry of journal.entries) {
  if (!fs.existsSync(path.join(standalone, "drizzle", `${entry.tag}.sql`))) {
    fail(`drizzle/${entry.tag}.sql is journalled but not in the standalone output`)
  }
}

/** Package names the Dockerfile places under the runtime `/app/node_modules`. */
function dockerfileVendored() {
  const source = fs.readFileSync(path.join(web, "Dockerfile"), "utf8").replace(/\\\n/g, " ")
  return [...source.matchAll(/^COPY\s+.*?\s\.\/node_modules\/(\S+)\s*$/gm)].map((match) => match[1])
}

const vendored = dockerfileVendored()
const specifiers = [...fs.readFileSync(script, "utf8").matchAll(/^import .*? from "([^"]+)"/gm)]
  .map((match) => match[1])
  .filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("node:"))
if (specifiers.length === 0) {
  fail("scripts/migrate.mjs imports no packages, so this check would pass vacuously")
}

const sources = specifiers.map((specifier) => {
  const parts = specifier.split("/")
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
  if (fs.existsSync(path.join(standalone, "node_modules", ...name.split("/")))) {
    return `${specifier} -> traced into the standalone output`
  }
  if (vendored.includes(name)) {
    return `${specifier} -> copied into /app/node_modules by the Dockerfile`
  }
  return fail(
    `"${name}" is neither in .next/standalone/node_modules nor copied in by the Dockerfile, ` +
      `so \`node scripts/migrate.mjs\` cannot start in an image`,
  )
})

console.log(
  `standalone migrate check: ok, ${journal.entries.length} migrations and ${specifiers.length} packages accounted for\n  ` +
    sources.join("\n  "),
)
