/**
 * Ledger item 4.5b: the pipeline durability gate.
 *
 * Item 4.5a proved the engine property for free, on a two-step provider-free
 * workflow: a step whose worker is `SIGKILL`ed is redelivered to a later worker
 * in the same consumer group and completes, while the step that had already
 * finished is not re-executed. This applies that property to the real thing.
 *
 * The claim, stated so it can fail:
 *
 *   A full pipeline run whose worker is killed while `write` is executing
 *   resumes on a replacement worker, `research` and `outline` are neither
 *   re-executed nor rewritten, and the run continues past `write` into `edit`.
 *
 * It is a script rather than a suite member because it bills Anthropic for two
 * `write` calls plus one `outline`, and Perplexity for one `research`, and it
 * takes roughly ten minutes end to end. `pnpm test` must not do either.
 *
 * Scope, deliberately bounded: the seeded post gates `edit`, `images` and
 * `ready`, so the run parks at the `edit` review gate the moment `write`
 * commits. That is ordinary production behaviour for a post with a review gate,
 * it is a real terminal state (`suspended`), and it stops the procedure from
 * spending on image generation to prove something about `write`.
 *
 * Evidence beyond "the value looks the same": the script installs a temporary
 * audit trigger on the seeded row for the duration of the run, so every UPDATE
 * to the three content columns is recorded with its md5. "Not rewritten"
 * becomes a count over that log rather than an inference from a final value.
 * The trigger and its table are dropped in `finally`.
 *
 * Both provider keys are read from the environment, encrypted under a
 * throwaway Fernet key with the same `encryptWithKey` the app uses, and written
 * to the `settings` row the agents read; the previous row is restored on exit.
 * No key is printed, and no key is written anywhere but that row.
 *
 * Usage, from `web/`, with `docker compose up -d db redis` already running:
 *
 *   set -a; . ../.env
 *   eval "$(grep -E '^(ANTHROPIC|PERPLEXITY)_API_KEY=' /path/to/main/.env)"
 *   set +a
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *     src/mastra/scripts/durability-gate.mjs
 *
 * Exits 0 only if every check passes. The report is printed to stdout and
 * written to `.mastra/durability-gate/report.json`.
 */
import { execFile, spawn } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { RedisStreamsPubSub } from "@mastra/redis-streams"
import pg from "pg"

import { encryptWithKey } from "../../lib/crypto.ts"

const runCommand = promisify(execFile)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = path.resolve(HERE, "../../..")
const BUNDLE_REL = ".mastra/worker-durability"
const BUNDLE_DIR = path.join(WEB_ROOT, BUNDLE_REL)
const BUNDLE_MASTRA = path.join(BUNDLE_DIR, "mastra.mjs")
const WEB_FIXTURE = path.join(WEB_ROOT, "src", "mastra", "workflows", "web-service.fixture.mjs")
const OUT_DIR = path.join(WEB_ROOT, ".mastra", "durability-gate")

/** Its own Redis database: 9, 10 and 11 belong to the three suites. */
const REDIS_DB = "12"

/** A throwaway Fernet key, so the real `WP_ENCRYPTION_KEY` is never needed. */
const TEST_ENCRYPTION_KEY = "wDnmGSXAn3lPzz0GDW0jgcpn7XMDrnxLoO4XQb4Zwss"

const POST_ID = "00000000-0000-4000-8000-0000000004f1"
const AUDIT_TABLE = "durability_gate_writes"

/**
 * How long after `outline` commits the kill lands. Long enough that the write
 * agent call is unambiguously in flight, short enough that Opus cannot have
 * finished a 2000 word draft. The script re-checks that `draft_content` is
 * still null immediately before killing, and aborts if it is not.
 */
const KILL_DELAY_MS = Number(process.env.DURABILITY_KILL_DELAY_MS ?? 30_000)

const POLL_MS = 2_000
const WAIT_FOR_OUTLINE_MS = 15 * 60_000
const WAIT_FOR_RESUME_MS = 20 * 60_000

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

/**
 * `NODE_PATH` is deleted, not inherited: item 4.4a found a bundle that could
 * not boot hiding behind pnpm's flat virtual store leaking into child
 * processes. A deploy has no such path.
 */
function deployEnv(extra = {}) {
  const env = {
    ...process.env,
    REDIS_URL: REDIS_URL,
    WP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
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

function spawnWorker(label) {
  const spawned = watch(
    spawn(process.execPath, ["index.mjs"], {
      cwd: BUNDLE_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: deployEnv(),
    }),
    label,
  )
  log(`${label} spawned (pid ${spawned.child.pid})`)
  return spawned
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

const REDIS_URL = isolatedRedisUrl(requireEnv("REDIS_URL"))

const CONTENT_COLUMNS = ["research_content", "outline_content", "draft_content", "final_md_content"]

async function readPost(client) {
  const { rows } = await client.query(
    `SELECT id, current_stage, stage_status, stage_settings, updated_at,
            ${CONTENT_COLUMNS.map((c) => `md5(coalesce(${c}, '')) AS ${c}_md5`).join(", ")},
            ${CONTENT_COLUMNS.map((c) => `length(${c}) AS ${c}_len`).join(", ")}
       FROM posts WHERE id = $1`,
    [POST_ID],
  )
  return rows[0] ?? null
}

async function readAudit(client) {
  const { rows } = await client.query(
    `SELECT at, research_md5, outline_md5, draft_md5, research_len, outline_len, draft_len, stage_status
       FROM ${AUDIT_TABLE} ORDER BY id`,
  )
  return rows
}

/** Number of times a column changed from one non-empty value to a different one. */
function rewriteCount(audit, column) {
  const seen = []
  for (const row of audit) {
    const md5 = row[`${column}_md5`]
    const len = row[`${column}_len`]
    if (!len) continue
    if (seen.length === 0 || seen[seen.length - 1] !== md5) seen.push(md5)
  }
  return Math.max(0, seen.length - 1)
}

/** Number of distinct non-empty values a column ever held. */
function distinctValues(audit, column) {
  return new Set(
    audit.filter((row) => row[`${column}_len`]).map((row) => row[`${column}_md5`]),
  ).size
}

async function installAudit(client) {
  await client.query(`DROP TRIGGER IF EXISTS durability_gate_trg ON posts`)
  await client.query(`DROP FUNCTION IF EXISTS durability_gate_log()`)
  await client.query(`DROP TABLE IF EXISTS ${AUDIT_TABLE}`)
  await client.query(`
    CREATE TABLE ${AUDIT_TABLE} (
      id bigserial PRIMARY KEY,
      at timestamptz NOT NULL DEFAULT clock_timestamp(),
      op text NOT NULL,
      research_md5 text, outline_md5 text, draft_md5 text,
      research_len int, outline_len int, draft_len int,
      stage_status jsonb
    )`)
  await client.query(`
    CREATE FUNCTION durability_gate_log() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.id = '${POST_ID}'::uuid THEN
        INSERT INTO ${AUDIT_TABLE}
          (op, research_md5, outline_md5, draft_md5, research_len, outline_len, draft_len, stage_status)
        VALUES
          (TG_OP,
           md5(coalesce(NEW.research_content, '')), md5(coalesce(NEW.outline_content, '')),
           md5(coalesce(NEW.draft_content, '')),
           length(NEW.research_content), length(NEW.outline_content), length(NEW.draft_content),
           NEW.stage_status);
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql`)
  await client.query(`
    CREATE TRIGGER durability_gate_trg AFTER INSERT OR UPDATE ON posts
    FOR EACH ROW EXECUTE FUNCTION durability_gate_log()`)
}

async function removeAudit(client) {
  await client.query(`DROP TRIGGER IF EXISTS durability_gate_trg ON posts`)
  await client.query(`DROP FUNCTION IF EXISTS durability_gate_log()`)
  await client.query(`DROP TABLE IF EXISTS ${AUDIT_TABLE}`)
}

async function main() {
  const anthropicKey = requireEnv("ANTHROPIC_API_KEY")
  const perplexityKey = requireEnv("PERPLEXITY_API_KEY")

  // The bundle reads REDIS_URL at import time, and this process is an observer
  // on the same isolated database as the workers it spawns.
  process.env.REDIS_URL = REDIS_URL
  process.env.WP_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY

  await mkdir(OUT_DIR, { recursive: true })

  const pool = new pg.Pool({ connectionString: pgConnectionString() })
  const client = await pool.connect()

  const pubsub = new RedisStreamsPubSub({ url: REDIS_URL })

  let workerA
  let workerB
  let savedSettings
  let auditInstalled = false
  const report = { checks: [], timings: {}, tokens: {} }

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

    log("seeding the post")
    await client.query(`DELETE FROM posts WHERE id = $1`, [POST_ID])
    await client.query(
      `INSERT INTO posts (id, slug, topic, target_audience, niche, intent, word_count,
                          output_format, article_type, current_stage, stage_settings, stage_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10::jsonb, '{}'::jsonb)`,
      [
        POST_ID,
        "durability-gate-write-crash",
        "How small teams keep long-running content pipelines from losing work when a worker dies",
        "Engineering leads at small SaaS teams",
        "developer tooling",
        "informational",
        1200,
        "markdown",
        "how-to guide",
        JSON.stringify({
          research: "auto",
          outline: "auto",
          write: "auto",
          // The run parks here the moment `write` commits, which bounds the
          // spend of the procedure without weakening what it proves.
          edit: "review",
          images: "review",
          ready: "review",
        }),
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
    const encrypted = {
      anthropic: encryptWithKey(anthropicKey, TEST_ENCRYPTION_KEY),
      perplexity: encryptWithKey(perplexityKey, TEST_ENCRYPTION_KEY),
    }
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('api_keys', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(encrypted)],
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

    log("starting the run from a separate `web` process")
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
    log(`run ${runId} published, no worker alive yet`)

    workerA = spawnWorker("worker A")
    report.timings.workerAPid = workerA.child.pid
    const startedAt = Date.now()

    log("waiting for `outline` to commit")
    const outlineRow = await waitFor(
      async () => {
        const row = await readPost(client)
        return row?.stage_status?.outline === "complete" ? row : null
      },
      WAIT_FOR_OUTLINE_MS,
      "`outline` to commit under worker A",
    )
    report.timings.outlineCommittedAfterS = (Date.now() - startedAt) / 1000
    log(`outline committed after ${report.timings.outlineCommittedAfterS}s`)
    if (outlineRow.draft_content_len) {
      throw new Error("`write` had already committed when `outline` was first observed complete")
    }

    log(`holding ${KILL_DELAY_MS / 1000}s so the kill lands inside the write agent call`)
    await sleep(KILL_DELAY_MS)

    const preKill = await readPost(client)
    if (preKill.draft_content_len) {
      throw new Error(
        "`write` finished before the kill: rerun with a larger DURABILITY_KILL_DELAY_MS=0 window",
      )
    }

    const killedAt = Date.now()
    workerA.child.kill("SIGKILL")
    log("worker A SIGKILLed mid-`write`")
    const atKill = {
      row: preKill,
      run: await workflow.getWorkflowRunById(runId),
      audit: await readAudit(client),
    }
    report.atKill = {
      status: atKill.run?.status ?? null,
      steps: Object.keys(atKill.run?.steps ?? {}),
      stageStatus: atKill.row.stage_status,
      researchMd5: atKill.row.research_content_md5,
      outlineMd5: atKill.row.outline_content_md5,
      draftLen: atKill.row.draft_content_len,
      auditRows: atKill.audit.length,
    }

    workerB = spawnWorker("worker B")
    const workerBAt = Date.now()
    report.timings.workerBPid = workerB.child.pid
    report.timings.workerBSpawnedAfterKillS = (workerBAt - killedAt) / 1000

    log("waiting for `write` to commit on worker B")
    await waitFor(
      async () => {
        const row = await readPost(client)
        return row?.draft_content_len ? row : null
      },
      WAIT_FOR_RESUME_MS,
      "`write` to commit under worker B",
    )
    report.timings.writeCommittedAfterKillS = (Date.now() - killedAt) / 1000

    log("waiting for the run to settle")
    const settled = await waitFor(
      async () => {
        const state = await workflow.getWorkflowRunById(runId)
        return state && state.status !== "running" && state.status !== "pending" ? state : null
      },
      WAIT_FOR_RESUME_MS,
      "the run to settle under worker B",
    )
    report.timings.settledAfterKillS = (Date.now() - killedAt) / 1000

    const afterRow = await readPost(client)
    const audit = await readAudit(client)
    report.afterRestart = {
      status: settled.status,
      suspendedPaths: settled.suspendedPaths ?? null,
      steps: Object.keys(settled.steps ?? {}),
      stageStatus: afterRow.stage_status,
      currentStage: afterRow.current_stage,
      researchMd5: afterRow.research_content_md5,
      outlineMd5: afterRow.outline_content_md5,
      draftLen: afterRow.draft_content_len,
    }
    report.audit = audit.map((row) => ({
      at: row.at,
      research: row.research_len ? `${row.research_len} ${row.research_md5.slice(0, 8)}` : null,
      outline: row.outline_len ? `${row.outline_len} ${row.outline_md5.slice(0, 8)}` : null,
      draft: row.draft_len ? `${row.draft_len} ${row.draft_md5.slice(0, 8)}` : null,
      stageStatus: row.stage_status,
    }))

    for (const stage of ["research", "outline"]) {
      const before = atKill.run?.steps?.[stage]
      const after = settled.steps?.[stage]
      report.tokens[stage] = {
        tokensIn: after?.output?.tokensIn ?? null,
        tokensOut: after?.output?.tokensOut ?? null,
        model: after?.output?.model ?? null,
      }
      check(
        `${stage}-step-record-unchanged`,
        before && after && JSON.stringify(before) === JSON.stringify(after),
        `persisted step record for \`${stage}\` is byte-identical across the crash`,
      )
    }
    report.tokens.write = {
      tokensIn: settled.steps?.write?.output?.tokensIn ?? null,
      tokensOut: settled.steps?.write?.output?.tokensOut ?? null,
      model: settled.steps?.write?.output?.model ?? null,
    }

    check(
      "killed-mid-write",
      atKill.row.research_content_len > 0 &&
        atKill.row.outline_content_len > 0 &&
        !atKill.row.draft_content_len,
      `at the kill: research ${atKill.row.research_content_len} chars, outline ` +
        `${atKill.row.outline_content_len} chars, draft null`,
    )
    check(
      "write-completed-after-restart",
      afterRow.draft_content_len > 0,
      `draft_content is ${afterRow.draft_content_len} chars after the restart`,
    )
    check(
      "research-not-rewritten",
      atKill.row.research_content_md5 === afterRow.research_content_md5 &&
        distinctValues(audit, "research") === 1,
      `research_content md5 unchanged across the crash and only 1 distinct value in ` +
        `${audit.length} logged writes (${rewriteCount(audit, "research")} rewrites)`,
    )
    check(
      "outline-not-rewritten",
      atKill.row.outline_content_md5 === afterRow.outline_content_md5 &&
        distinctValues(audit, "outline") === 1,
      `outline_content md5 unchanged across the crash and only 1 distinct value in ` +
        `${audit.length} logged writes (${rewriteCount(audit, "outline")} rewrites)`,
    )
    check(
      "draft-written-once",
      distinctValues(audit, "draft") === 1,
      `draft_content has 1 distinct value in the write log (${rewriteCount(audit, "draft")} rewrites)`,
    )
    check(
      "resumed-through-reclaim",
      report.timings.writeCommittedAfterKillS > 55,
      `write committed ${report.timings.writeCommittedAfterKillS.toFixed(1)}s after the kill, ` +
        `which is past the 60s XAUTOCLAIM idle threshold: the message was pending under worker A, ` +
        `so worker A had genuinely started the step`,
    )
    check(
      "parked-at-edit-gate",
      settled.status === "suspended" && afterRow.stage_status?.edit === "review",
      `run status ${settled.status}, suspendedPaths ` +
        `${JSON.stringify(settled.suspendedPaths ?? null)}, stage_status.edit ` +
        `${afterRow.stage_status?.edit}`,
    )
    check(
      "worker-b-is-a-different-process",
      workerA.child.pid !== workerB.child.pid,
      `worker A pid ${workerA.child.pid}, worker B pid ${workerB.child.pid}`,
    )
  } finally {
    workerA?.child.kill("SIGKILL")
    workerB?.child.kill("SIGKILL")
    if (workerA) await writeFile(path.join(OUT_DIR, "worker-a.log"), workerA.stdout() + workerA.stderr())
    if (workerB) await writeFile(path.join(OUT_DIR, "worker-b.log"), workerB.stdout() + workerB.stderr())
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
