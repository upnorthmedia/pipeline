/**
 * Ledger item 4.7: the full workflow, end to end, against the real database.
 *
 * Everything before this proved one property at a time against a pipeline that
 * was always bounded somewhere: stage selection skipped stages, the gate suite
 * parked runs before they billed, and the durability gate deliberately gated
 * `edit` so a run about `write` never reached image generation. Nothing had yet
 * run all six stages to `ready` with real providers on the deployable artifact.
 *
 * The claim, stated so it can fail:
 *
 *   A run started by a `web` process that then exits is executed by the
 *   `worker` bundle through all six stages against the real database, every
 *   stage commits its own column exactly once, `images` writes a manifest whose
 *   generated entries have files on disk, `ready` assembles those images into
 *   `ready_content`, and the post is promoted to `current_stage = complete`.
 *
 * It is a script rather than a suite member because it bills Perplexity once,
 * Anthropic five times (`outline`, `write`, `edit`, the image manifest,
 * `ready`) and Gemini once per manifest entry, and takes roughly twenty
 * minutes. `pnpm test` must not do either.
 *
 * `word_count` is 900 because `rules/blog-images.md` maps anything under 1500
 * words to four images (one featured, three content). That is the smallest
 * setting that still exercises the `.foreach()` fan-out with a featured image
 * and content images, so it bounds the spend without narrowing what runs.
 *
 * Evidence beyond "the value looks the same": a temporary audit trigger scoped
 * to the seeded row records every UPDATE to all six content columns with its
 * md5, so "written once" is a count over a write history rather than an
 * inference from a final value. The trigger and its table are dropped in
 * `finally`.
 *
 * `RULES_DIR` and `TEXTSTAT_DATA_DIR` are set explicitly, because the worker
 * bundle's cwd is its own output directory and both defaults are resolved from
 * `process.cwd()`. `rulesDir()` would point at `web/.mastra/rules`, and
 * `loadRules` returns `""` for a missing file rather than throwing, so every
 * stage would silently lose its rule file. `textstatDataDir()` would point at
 * `web/.mastra/<bundle>/src/mastra/textstat/data`, and the first run of this
 * script proved that one is fatal: `edit` died with `ENOENT ...
 * cmudict-syllables.txt.gz`. `docker-compose.yml` already sets `RULES_DIR` for
 * the Python worker; the Railway definitions in 7.2 have to set both.
 *
 * The three provider keys are read from the environment, encrypted under a
 * throwaway Fernet key with the same `encryptWithKey` the app uses, and written
 * to the `settings` row the agents read; the previous row is restored on exit.
 * No key is printed, and no key is written anywhere but that row.
 *
 * Usage, from `web/`, with `docker compose up -d db redis` already running:
 *
 *   set -a; . ../.env
 *   eval "$(grep -E '^(ANTHROPIC|PERPLEXITY|GEMINI)_API_KEY=' /path/to/main/.env)"
 *   set +a
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *     src/mastra/scripts/full-pipeline.mjs
 *
 * Exits 0 only if every check passes. The report is printed to stdout and
 * written to `.mastra/full-pipeline/report.json`.
 */
import { execFile, spawn } from "node:child_process"
import { mkdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { RedisStreamsPubSub } from "@mastra/redis-streams"
import pg from "pg"

import { encryptWithKey } from "../../lib/crypto.ts"

const runCommand = promisify(execFile)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = path.resolve(HERE, "../../..")
const REPO_ROOT = path.resolve(WEB_ROOT, "..")
const BUNDLE_REL = ".mastra/worker-e2e"
const BUNDLE_DIR = path.join(WEB_ROOT, BUNDLE_REL)
const BUNDLE_MASTRA = path.join(BUNDLE_DIR, "mastra.mjs")
const WEB_FIXTURE = path.join(WEB_ROOT, "src", "mastra", "workflows", "web-service.fixture.mjs")
const OUT_DIR = path.join(WEB_ROOT, ".mastra", "full-pipeline")
const MEDIA_DIR = path.join(OUT_DIR, "media")
const RULES_DIR = path.join(REPO_ROOT, "rules")
const TEXTSTAT_DATA_DIR = path.join(WEB_ROOT, "src", "mastra", "textstat", "data")

/** Its own Redis database: 9 to 12 belong to the suites and the durability gate. */
const REDIS_DB = "13"

/** A throwaway Fernet key, so the real `WP_ENCRYPTION_KEY` is never needed. */
const TEST_ENCRYPTION_KEY = "wDnmGSXAn3lPzz0GDW0jgcpn7XMDrnxLoO4XQb4Zwss"

const POST_ID = "00000000-0000-4000-8000-0000000004f7"
const POST_SLUG = "full-pipeline-end-to-end"
const AUDIT_TABLE = "full_pipeline_writes"

const POLL_MS = 3_000
/** `ready` is the fifth Opus call of the run, so the whole thing is slow. */
const WAIT_FOR_RUN_MS = 45 * 60_000
/** How long the run is left unconsumed before the worker is spawned. */
const PRE_WORKER_HOLD_MS = 5_000

const STAGES = ["research", "outline", "write", "edit", "images", "ready"]

const CONTENT_COLUMNS = {
  research: "research_content",
  outline: "outline_content",
  write: "draft_content",
  edit: "final_md_content",
  images: "image_manifest",
  ready: "ready_content",
}

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`)
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set`)
  return value
}

function isolatedRedisUrl(base) {
  const url = new URL(base)
  url.pathname = `/${REDIS_DB}`
  return url.toString()
}

function pgConnectionString() {
  const url = process.env.DATABASE_URL_SYNC ?? requireEnv("DATABASE_URL")
  return url.replace(/^postgresql\+\w+:\/\//, "postgresql://")
}

const REDIS_URL = isolatedRedisUrl(requireEnv("REDIS_URL"))

/**
 * `NODE_PATH` is deleted, not inherited: item 4.4a found a bundle that could
 * not boot hiding behind pnpm's flat virtual store leaking into child
 * processes. A deploy has no such path.
 */
function deployEnv(extra = {}) {
  const env = {
    ...process.env,
    REDIS_URL,
    WP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    RULES_DIR,
    TEXTSTAT_DATA_DIR,
    MEDIA_DIR,
    NODE_ENV: "production",
    ...extra,
  }
  delete env.NODE_PATH
  return env
}

function watch(child, name) {
  let out = ""
  let err = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    out += chunk
  })
  child.stderr.on("data", (chunk) => {
    err += chunk
  })
  return {
    name,
    child,
    stdout: () => out,
    stderr: () => err,
    exit: new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = await predicate()
    if (hit) return hit
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(POLL_MS)
  }
}

const COLUMN_LIST = Object.values(CONTENT_COLUMNS)

async function readPost(client) {
  const { rows } = await client.query(
    `SELECT id, slug, current_stage, stage_status, stage_settings, image_manifest, ready_content,
            ${COLUMN_LIST.map((c) => `md5(coalesce(${c}::text, '')) AS ${c}_md5`).join(", ")},
            ${COLUMN_LIST.map((c) => `length(${c}::text) AS ${c}_len`).join(", ")}
       FROM posts WHERE id = $1`,
    [POST_ID],
  )
  return rows[0] ?? null
}

async function readAudit(client) {
  const { rows } = await client.query(`SELECT * FROM ${AUDIT_TABLE} ORDER BY id`)
  return rows
}

/** Number of distinct non-empty values a column ever held. */
function distinctValues(audit, column) {
  return new Set(audit.filter((row) => row[`${column}_len`]).map((row) => row[`${column}_md5`])).size
}

async function installAudit(client) {
  await client.query(`DROP TRIGGER IF EXISTS full_pipeline_trg ON posts`)
  await client.query(`DROP FUNCTION IF EXISTS full_pipeline_log()`)
  await client.query(`DROP TABLE IF EXISTS ${AUDIT_TABLE}`)
  await client.query(`
    CREATE TABLE ${AUDIT_TABLE} (
      id bigserial PRIMARY KEY,
      at timestamptz NOT NULL DEFAULT clock_timestamp(),
      op text NOT NULL,
      ${COLUMN_LIST.map((c) => `${c}_md5 text, ${c}_len int`).join(", ")},
      stage_status jsonb
    )`)
  await client.query(`
    CREATE FUNCTION full_pipeline_log() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.id = '${POST_ID}'::uuid THEN
        INSERT INTO ${AUDIT_TABLE}
          (op, ${COLUMN_LIST.map((c) => `${c}_md5, ${c}_len`).join(", ")}, stage_status)
        VALUES
          (TG_OP,
           ${COLUMN_LIST.map(
             (c) => `md5(coalesce(NEW.${c}::text, '')), length(NEW.${c}::text)`,
           ).join(", ")},
           NEW.stage_status);
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql`)
  await client.query(`
    CREATE TRIGGER full_pipeline_trg AFTER INSERT OR UPDATE ON posts
    FOR EACH ROW EXECUTE FUNCTION full_pipeline_log()`)
}

async function removeAudit(client) {
  await client.query(`DROP TRIGGER IF EXISTS full_pipeline_trg ON posts`)
  await client.query(`DROP FUNCTION IF EXISTS full_pipeline_log()`)
  await client.query(`DROP TABLE IF EXISTS ${AUDIT_TABLE}`)
}

/**
 * Every image file the manifest claims was generated, checked on disk.
 *
 * `url` is the public path the dashboard serves (`/media/<postId>/<file>`), so
 * the on-disk location is that path's last component under the media directory
 * the worker was given.
 */
async function checkImageFiles(manifest) {
  const entries = Array.isArray(manifest?.images) ? manifest.images : []
  const results = []
  for (const entry of entries) {
    if (entry?.generated !== true) {
      results.push({ id: entry?.id ?? null, generated: false, error: entry?.error ?? null })
      continue
    }
    const filename = String(entry.url ?? "").split("/").pop()
    const file = path.join(MEDIA_DIR, POST_ID, filename)
    let bytes = null
    try {
      bytes = (await stat(file)).size
    } catch {
      bytes = null
    }
    results.push({
      id: entry.id ?? null,
      generated: true,
      url: entry.url ?? null,
      filename,
      declaredBytes: entry.size_bytes ?? null,
      bytesOnDisk: bytes,
    })
  }
  return results
}

async function main() {
  const anthropicKey = requireEnv("ANTHROPIC_API_KEY")
  const perplexityKey = requireEnv("PERPLEXITY_API_KEY")
  const geminiKey = requireEnv("GEMINI_API_KEY")

  // The bundle reads REDIS_URL at import time, and this process is an observer
  // on the same isolated database as the worker it spawns.
  process.env.REDIS_URL = REDIS_URL
  process.env.WP_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY

  await rm(MEDIA_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  const pool = new pg.Pool({ connectionString: pgConnectionString() })
  const client = await pool.connect()

  const pubsub = new RedisStreamsPubSub({ url: REDIS_URL })

  let worker
  let savedSettings
  let auditInstalled = false
  const report = { checks: [], timings: {}, stages: {} }

  const check = (id, ok, detail) => {
    report.checks.push({ id, ok: Boolean(ok), detail })
    log(`${ok ? "PASS" : "FAIL"}  ${id}: ${detail}`)
  }

  try {
    // A leftover stream would replay an interrupted earlier run of this script
    // against the same post id.
    await pubsub.clearTopic("workflows")
    await pubsub.clearTopic("workflows-finish")

    log("building the worker bundle from scratch")
    await rm(BUNDLE_DIR, { recursive: true, force: true })
    const build = await runCommand("pnpm", ["exec", "mastra", "worker", "build", "-o", BUNDLE_REL], {
      cwd: WEB_ROOT,
      maxBuffer: 32 * 1024 * 1024,
    })
    report.build = `${build.stdout}${build.stderr}`.trim().split("\n").slice(-3).join("\n")

    log("seeding the post with every stage on `auto`")
    await client.query(`DELETE FROM posts WHERE id = $1`, [POST_ID])
    await client.query(
      `INSERT INTO posts (id, slug, topic, target_audience, niche, intent, word_count,
                          output_format, article_type, tone, current_stage, stage_settings,
                          stage_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11::jsonb, '{}'::jsonb)`,
      [
        POST_ID,
        POST_SLUG,
        "How small engineering teams pick a task queue for background jobs",
        "Engineering leads at small SaaS teams",
        "developer tooling",
        "informational",
        900,
        "markdown",
        "how-to guide",
        "practical and direct",
        JSON.stringify(Object.fromEntries(STAGES.map((stage) => [stage, "auto"]))),
      ],
    )

    log("installing the write audit trigger")
    await installAudit(client)
    auditInstalled = true

    log("writing the provider keys into the settings row")
    const { rows: settingsRows } = await client.query(
      `SELECT value FROM settings WHERE key = 'api_keys' LIMIT 1`,
    )
    savedSettings = settingsRows[0]
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('api_keys', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        JSON.stringify({
          anthropic: encryptWithKey(anthropicKey, TEST_ENCRYPTION_KEY),
          perplexity: encryptWithKey(perplexityKey, TEST_ENCRYPTION_KEY),
          gemini: encryptWithKey(geminiKey, TEST_ENCRYPTION_KEY),
        }),
      ],
    )

    // The observer: the same instance both Railway services import, loaded here
    // only to read run state. It never calls startWorkers().
    const bundle = await import(pathToFileURL(BUNDLE_MASTRA).href)
    const mastra = Object.values(bundle).find(
      (value) =>
        value !== null && typeof value === "object" && typeof value.getWorkflow === "function",
    )
    if (!mastra) throw new Error(`no Mastra instance exported by ${BUNDLE_MASTRA}`)
    const workflow = mastra.getWorkflow("pipeline")

    log("starting the run from a separate `web` process that then exits")
    const web = watch(
      spawn(process.execPath, [WEB_FIXTURE, BUNDLE_MASTRA, JSON.stringify({ start: [POST_ID] })], {
        cwd: WEB_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: deployEnv(),
      }),
      "web",
    )
    const webExit = await web.exit
    if (webExit.code !== 0) throw new Error(`web fixture failed: ${web.stderr()}`)
    const runId = JSON.parse(web.stdout()).started[0].runId
    report.runId = runId
    report.webExit = webExit
    log(`run ${runId} published, no worker alive yet`)

    // With no consumer alive, nothing can have executed. The snapshot is what
    // makes "the worker executed it" an observation rather than an assumption.
    await sleep(PRE_WORKER_HOLD_MS)
    const beforeWorker = await readPost(client)
    report.beforeWorker = {
      currentStage: beforeWorker.current_stage,
      stageStatus: beforeWorker.stage_status,
      lens: Object.fromEntries(COLUMN_LIST.map((c) => [c, beforeWorker[`${c}_len`]])),
    }

    worker = watch(
      spawn(process.execPath, ["index.mjs"], {
        cwd: BUNDLE_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        env: deployEnv(),
      }),
      "worker",
    )
    report.workerPid = worker.child.pid
    log(`worker spawned (pid ${worker.child.pid})`)
    const startedAt = Date.now()

    // Stage-by-stage progress, so a stall is visible in the log rather than
    // showing up only as a timeout at the end.
    const seen = new Set()
    const settled = await waitFor(
      async () => {
        const row = await readPost(client)
        for (const stage of STAGES) {
          const status = row?.stage_status?.[stage]
          const key = `${stage}:${status}`
          if (status && !seen.has(key)) {
            seen.add(key)
            report.timings[key] = (Date.now() - startedAt) / 1000
            log(`stage_status.${stage} = ${status} at ${report.timings[key].toFixed(1)}s`)
          }
        }
        const state = await workflow.getWorkflowRunById(runId)
        return state && state.status !== "running" && state.status !== "pending" ? state : null
      },
      WAIT_FOR_RUN_MS,
      "the run to settle",
    )
    report.timings.settledAfterS = (Date.now() - startedAt) / 1000
    log(`run settled as ${settled.status} after ${report.timings.settledAfterS.toFixed(1)}s`)

    const afterRow = await readPost(client)
    const audit = await readAudit(client)
    const steps = settled.steps ?? {}

    for (const stage of STAGES) {
      const output = steps[stage]?.output ?? {}
      report.stages[stage] = {
        stepStatus: steps[stage]?.status ?? null,
        stageStatus: afterRow.stage_status?.[stage] ?? null,
        model: output.model ?? null,
        tokensIn: output.tokensIn ?? null,
        tokensOut: output.tokensOut ?? null,
        durationS: output.durationS ?? null,
        columnChars: afterRow[`${CONTENT_COLUMNS[stage]}_len`] ?? 0,
        writes: distinctValues(audit, CONTENT_COLUMNS[stage]),
      }
    }
    report.stages.images.gemini = steps.images?.output?.gemini ?? null
    report.stages.images.totalGenerated = steps.images?.output?.totalGenerated ?? null
    report.stages.images.totalFailed = steps.images?.output?.totalFailed ?? null

    const manifest = afterRow.image_manifest ?? {}
    const files = await checkImageFiles(manifest)
    report.images = files
    report.manifestKeys = Object.keys(manifest)
    report.auditRows = audit.length

    check(
      "nothing-ran-before-the-worker",
      Object.keys(beforeWorker.stage_status ?? {}).length === 0 &&
        COLUMN_LIST.every((c) => !beforeWorker[`${c}_len`]),
      `${PRE_WORKER_HOLD_MS / 1000}s after the run was published and before any worker existed, ` +
        `stage_status was ${JSON.stringify(beforeWorker.stage_status)} and every content column ` +
        `was empty`,
    )
    check(
      "run-succeeded",
      settled.status === "success",
      `run ${runId} settled as ${settled.status} after ` +
        `${report.timings.settledAfterS.toFixed(1)}s`,
    )
    check(
      "six-steps-succeeded",
      STAGES.every((stage) => steps[stage]?.status === "success"),
      STAGES.map((stage) => `${stage}=${steps[stage]?.status ?? "absent"}`).join(" "),
    )
    check(
      "six-stages-complete",
      STAGES.every((stage) => afterRow.stage_status?.[stage] === "complete"),
      `stage_status ${JSON.stringify(afterRow.stage_status)}`,
    )
    check(
      "post-promoted-to-complete",
      afterRow.current_stage === "complete",
      `current_stage is ${afterRow.current_stage}`,
    )
    check(
      "six-columns-written",
      STAGES.every((stage) => afterRow[`${CONTENT_COLUMNS[stage]}_len`] > 0),
      STAGES.map(
        (stage) => `${CONTENT_COLUMNS[stage]}=${afterRow[`${CONTENT_COLUMNS[stage]}_len`]}`,
      ).join(" "),
    )
    check(
      "each-column-written-once",
      STAGES.every((stage) => distinctValues(audit, CONTENT_COLUMNS[stage]) === 1),
      `distinct values over ${audit.length} logged writes: ` +
        STAGES.map(
          (stage) => `${CONTENT_COLUMNS[stage]}=${distinctValues(audit, CONTENT_COLUMNS[stage])}`,
        ).join(" "),
    )
    check(
      "no-stage-billed-nothing",
      STAGES.every((stage) => (steps[stage]?.output?.skipped ?? true) === false),
      STAGES.map((stage) => `${stage}.skipped=${steps[stage]?.output?.skipped}`).join(" "),
    )

    const manifestShapeKeys = ["version", "post_slug", "style_brief", "images", "total_generated"]
    check(
      "manifest-shape",
      manifestShapeKeys.every((key) => key in manifest) && Array.isArray(manifest.images),
      `image_manifest keys ${JSON.stringify(Object.keys(manifest))}`,
    )
    const generated = files.filter((file) => file.generated)
    check(
      "images-generated",
      generated.length > 0 && generated.length === (manifest.total_generated ?? -1),
      `${generated.length} of ${files.length} manifest entries generated, ` +
        `total_generated=${manifest.total_generated} total_failed=${manifest.total_failed}`,
    )
    check(
      "image-files-on-disk",
      generated.length > 0 &&
        generated.every((file) => file.bytesOnDisk && file.bytesOnDisk === file.declaredBytes),
      generated
        .map((file) => `${file.filename} ${file.bytesOnDisk}B (declared ${file.declaredBytes}B)`)
        .join(", "),
    )
    check(
      "featured-image-present",
      files.some((file) => file.id === "featured" && file.generated),
      `entry ids ${JSON.stringify(files.map((file) => file.id))}`,
    )

    const readyContent = afterRow.ready_content ?? ""
    const referenced = generated.filter((file) => readyContent.includes(file.url))
    check(
      "ready-content-embeds-the-images",
      generated.length > 0 && referenced.length === generated.length,
      `${referenced.length} of ${generated.length} generated image urls appear in ready_content ` +
        `(${readyContent.length} chars)`,
    )
    // Reported, not checked: `rules/blog-ready.md` tells the model to drop the
    // publishing notes, but an assertion over generated prose is a coin flip,
    // and the stage's contract is the column write, not the wording.
    report.readyHasPublishingNotes = /publishing notes/i.test(readyContent)
    check(
      "worker-stayed-up",
      worker.child.exitCode === null,
      `worker pid ${worker.child.pid} exitCode ${worker.child.exitCode}, ` +
        `stderr ${worker.stderr().length} chars`,
    )
  } finally {
    worker?.child.kill("SIGKILL")
    if (worker) {
      await writeFile(path.join(OUT_DIR, "worker.log"), worker.stdout() + worker.stderr())
    }
    if (auditInstalled) await removeAudit(client)
    if (savedSettings) {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ('api_keys', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(savedSettings.value)],
      )
    } else {
      await client.query(`DELETE FROM settings WHERE key = 'api_keys'`)
    }
    client.release()
    await pool.end()
    await pubsub.close()
  }

  await writeFile(path.join(OUT_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`)

  const failed = report.checks.filter((entry) => !entry.ok)
  log(`${report.checks.length - failed.length}/${report.checks.length} checks passed`)
  return failed.length === 0 ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exit(1)
  },
)
