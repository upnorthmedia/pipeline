/**
 * Boot the worker bundle `mastra worker build` produced, without starting it.
 *
 * `mastra worker build` is a different module-resolution environment from
 * `next build`, `vitest` and `mastra dev`: a dependency every other gate
 * resolves can still be unresolvable in the bundle. Two already have been,
 * `@opentelemetry/api` (undeclared by anything in the tree) and `sharp` (native,
 * so its `.node` binary cannot be inlined).
 *
 * The build alone does not catch that. Dropping `sharp` from
 * `bundler.externals` inlines it, `mastra worker build` exits 0, and the
 * artifact throws `Could not load the "sharp" module` on its first import. The
 * only thing that answers "will this deploy boot" is importing it.
 *
 * This imports `mastra.mjs`, the module that constructs the instance, and not
 * the `index.mjs` entry point, which calls `startWorkers()` and would join the
 * `mastra-orchestration` consumer group and steal steps from a real worker.
 *
 * Run it after `pnpm worker:build`, through `pnpm worker:check` so the
 * repo-root `.env` is loaded: the instance reads `DATABASE_URL_SYNC` and
 * `REDIS_URL` at module scope and throws without them. It opens no connection.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const bundle = path.join(web, ".mastra", "worker")

function fail(message) {
  console.error(`worker bundle check: ${message}`)
  process.exit(1)
}

// A missing artifact has to be an error rather than a skip, or the gate passes
// on any run where the build step was removed.
for (const file of ["index.mjs", "mastra.mjs", "package.json"]) {
  if (!fs.existsSync(path.join(bundle, file))) {
    fail(`${path.join(".mastra/worker", file)} is missing; run \`pnpm worker:build\` first`)
  }
}

/**
 * Every external is installed beside the bundle rather than inlined into it, so
 * each one is a package the deploy target has to have. This is the half
 * `@opentelemetry/api` failed.
 *
 * The question is physical presence under the bundle's own `node_modules` and
 * not whether Node can resolve it, because on a dev machine and in CI the
 * bundle sits inside `web/` and Node's resolution walks up into
 * `web/node_modules`, where every one of these is installed anyway. The
 * `worker` image copies `.mastra/worker` alone into an `/app` with no
 * `node_modules`, so an external the build did not install is only missing
 * there, which is the one place it cannot be discovered by running the gate.
 */
const manifest = JSON.parse(fs.readFileSync(path.join(bundle, "package.json"), "utf8"))
const dependencies = Object.keys(manifest.dependencies ?? {})
if (dependencies.length === 0) {
  fail("the generated package.json declares no dependencies, which no build of this app produces")
}

for (const dependency of dependencies) {
  const installed = path.join(bundle, "node_modules", ...dependency.split("/"))
  if (!fs.existsSync(installed)) {
    fail(
      `the bundle declares "${dependency}" but did not install it into ` +
        `.mastra/worker/node_modules, so the worker image will not carry it`,
    )
  }
}

let bundleModule
try {
  bundleModule = await import(pathToFileURL(path.join(bundle, "mastra.mjs")).href)
} catch (error) {
  fail(`the bundle does not import: ${error.message}`)
}

// The export names are minified, so the instance is found by the method
// `index.mjs` calls on it rather than by its name.
const instance = Object.values(bundleModule).find(
  (value) => typeof value?.startWorkers === "function",
)
if (!instance) {
  fail("the bundle imported but exports no Mastra instance to start")
}

const workflows = Object.keys(instance.listWorkflows())
console.log(
  `worker bundle check: ok, ${dependencies.length} externals installed beside it and ${workflows.length} workflows registered (${workflows.join(", ")})`,
)

// The instance holds a Postgres pool and a Redis client, neither connected.
// Exiting explicitly keeps a lazily created handle from holding the gate open.
process.exit(0)
