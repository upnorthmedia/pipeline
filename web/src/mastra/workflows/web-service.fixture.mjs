/**
 * Stand-in for the `web` Railway service, used by `web-restart.test.ts`
 * (ledger item 4.4b).
 *
 * The real `web` service is `next start`, but its entire interaction with
 * Mastra is the three calls below: `createRun()`, `startAsync()` (publish
 * `workflow.start` onto Redis Streams and return) and `getWorkflowRunById()`
 * (read run state back out of Postgres storage). Nothing it does executes a
 * step, because it never calls `mastra.startWorkers()`.
 *
 * It is deliberately a separate short-lived process driven by argv rather than
 * a helper inside the test: the point of the item is that the process which
 * starts a run can die and the run still finishes, and a function call in the
 * vitest process cannot die.
 *
 * It loads the *built worker bundle's* Mastra instance, which is the same
 * `src/mastra/index.ts` both Railway services import, so the run it publishes
 * carries exactly the workflow graph the worker will execute.
 *
 *   node web-service.fixture.mjs <path-to-bundle/mastra.mjs> <spec-json>
 *
 * spec: { workflow?: string, start?: string[], read?: string[], hold?: boolean }
 *   start  post ids to start runs for, in order
 *   read   run ids to read persisted state for
 *   hold   stay alive after printing instead of exiting, so the caller can
 *          decide how this process dies
 *
 * Prints one JSON line: { started: [{postId, runId}], read: [{runId, ...}] }
 */
import { pathToFileURL } from "node:url"

const [, , mastraModulePath, specJson] = process.argv
const spec = JSON.parse(specJson)

/**
 * The bundle's exports are minified to single letters, so the instance is
 * found by shape rather than by name: `Mastra` the class is also exported, but
 * it is a function and carries `getWorkflow` on its prototype, not on itself.
 */
const bundle = await import(pathToFileURL(mastraModulePath).href)
const mastra = Object.values(bundle).find(
  (value) => value !== null && typeof value === "object" && typeof value.getWorkflow === "function",
)
if (!mastra) {
  throw new Error(`no Mastra instance exported by ${mastraModulePath}`)
}

const workflow = mastra.getWorkflow(spec.workflow ?? "pipeline")

const started = []
for (const postId of spec.start ?? []) {
  const run = await workflow.createRun()
  const { runId } = await run.startAsync({ inputData: { postId } })
  started.push({ postId, runId })
}

const read = []
for (const runId of spec.read ?? []) {
  const state = await workflow.getWorkflowRunById(runId)
  read.push({
    runId,
    status: state?.status ?? null,
    suspendedPaths: state?.suspendedPaths ?? null,
    steps: Object.keys(state?.steps ?? {}),
  })
}

process.stdout.write(`${JSON.stringify({ started, read })}\n`, () => {
  // The Postgres pool and the Redis connections keep the loop alive, and a
  // `web` container that is being replaced does not drain them either.
  if (!spec.hold) process.exit(0)
})

if (spec.hold) {
  setInterval(() => {}, 1 << 30)
}
