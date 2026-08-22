// @vitest-environment node
/**
 * Parity tests for the `validate_links` port (ledger item 3.4c).
 *
 * `link_validator` is the only pipeline service that reaches the network, so
 * its parity oracle is split in two, both written by
 * `api/scripts/export_link_validator_parity.py`:
 *
 * 1. **Network cases.** Python ran the real `validate_links` against a local
 *    HTTP server whose routes return the exact status codes the stripper cares
 *    about, plus redirects, a refused connection and a route that never
 *    answers, and recorded what came back with the base URL templated to
 *    `{BASE}`. This file stands up the equivalent server in Node, on its own
 *    port, and runs the TypeScript port against it. No HTTP is mocked: the
 *    requests go over real sockets to a real server.
 * 2. **Extraction and strip cases.** The regex half of the module is pure, so
 *    it is pinned as an input/output table. The golden cases resolve their text
 *    out of `docs/mastra-port/golden/` rather than carrying a copy, so the
 *    oracle is over content this repo did not produce for the test's benefit.
 */
import { readFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  CONCURRENCY_LIMIT,
  REQUEST_TIMEOUT_MS,
  findMarkdownLinks,
  stripDeadLinks,
  validateLinks,
  type RemovedLink,
} from "./index"

interface NetworkCase {
  name: string
  template: string
  expected_template: string
  expected_removed: RemovedLink[]
  max_in_flight: number
  elapsed_s: number
}

interface ExtractionCase {
  name: string
  text?: string
  golden?: { slug: string; stage: string; key: string }
  matches: { text: string; url: string }[]
}

interface StripCase {
  name: string
  content: string
  dead_urls: string[]
  expected: string
}

interface Parity {
  generated_by: string
  source: string
  hang_seconds: number
  slow_seconds: number
  closed_port: number
  network_cases: NetworkCase[]
  extraction_cases: ExtractionCase[]
  strip_cases: StripCase[]
}

const PARITY: Parity = JSON.parse(
  readFileSync(path.join(__dirname, "data", "link-validator-parity.json"), "utf8"),
)

const GOLDEN_DIR = path.resolve(__dirname, "../../../../docs/mastra-port/golden")

function goldenText(slug: string, stage: string, key: string): string {
  const payload = JSON.parse(
    readFileSync(path.join(GOLDEN_DIR, slug, `${stage}.json`), "utf8"),
  ) as { stage_output: Record<string, unknown> }
  const content = payload.stage_output[key]
  if (typeof content !== "string" || content.length === 0) {
    throw new Error(`golden ${slug}/${stage}.json has no string at ${key}`)
  }
  return content
}

/**
 * The route table from the export script, reproduced in Node. `/slow` counts
 * itself in and out around its sleep only, never across the response write,
 * for the reason spelled out in the Python original: counting the write window
 * reports one more than the semaphore actually admits.
 */
let server: Server
let base: string
let inFlight = 0
let maxInFlight = 0

function respond(res: ServerResponse, status: number, location?: string): void {
  const headers: Record<string, string> = { "Content-Length": "0" }
  if (location !== undefined) headers.Location = location
  res.writeHead(status, headers)
  res.end()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = new URL(req.url ?? "/", base).pathname
  if (pathname === "/hang") {
    await sleep(PARITY.hang_seconds * 1000)
  } else if (pathname === "/slow") {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      await sleep(PARITY.slow_seconds * 1000)
    } finally {
      inFlight -= 1
    }
  }
  switch (pathname) {
    case "/hang":
    case "/slow":
    case "/ok":
      return respond(res, 200)
    case "/moved":
      return respond(res, 301, "/gone")
    case "/found":
      return respond(res, 302, "/ok")
    case "/gone":
      return respond(res, 410)
    case "/unavailable":
      return respond(res, 451)
    case "/error":
      return respond(res, 500)
    case "/teapot":
      return respond(res, 418)
    default:
      return respond(res, 404)
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void handle(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
})

function expand(template: string): string {
  return template.replaceAll("{BASE}", base).replaceAll("{BASE_UPPER}", base.toUpperCase())
}

function contract(value: string): string {
  return value.replaceAll(base, "{BASE}").replaceAll(base.toUpperCase(), "{BASE_UPPER}")
}

describe("validateLinks against a live HTTP server", () => {
  it("the parity oracle was generated from the Python implementation", () => {
    expect(PARITY.generated_by).toBe("api/scripts/export_link_validator_parity.py")
    expect(PARITY.source).toBe("api/src/services/link_validator.py")
    expect(PARITY.network_cases.length).toBeGreaterThanOrEqual(22)
  })

  // The timeout case waits out the real `REQUEST_TIMEOUT_MS`, so it gets its
  // own budget rather than slowing every other case down.
  for (const parityCase of PARITY.network_cases) {
    const isTimeout = parityCase.name === "timeout"
    it(
      `matches Python for ${parityCase.name}`,
      async () => {
        maxInFlight = 0
        const started = Date.now()
        const result = await validateLinks(expand(parityCase.template))
        const elapsed = Date.now() - started

        expect(contract(result.content)).toBe(parityCase.expected_template)
        expect(result.removed.map((r) => ({ ...r, url: contract(r.url) }))).toEqual(
          parityCase.expected_removed,
        )
        expect(maxInFlight).toBe(parityCase.max_in_flight)
        if (isTimeout) {
          // Python recorded 10.0s: the request is abandoned at the deadline
          // rather than waiting out the server's 12s sleep.
          expect(elapsed).toBeGreaterThanOrEqual(REQUEST_TIMEOUT_MS - 500)
          expect(elapsed).toBeLessThan(PARITY.hang_seconds * 1000)
        }
      },
      isTimeout ? PARITY.hang_seconds * 1000 + 10_000 : 10_000,
    )
  }

  it("admits exactly CONCURRENCY_LIMIT requests at a time", () => {
    const probe = PARITY.network_cases.find((c) => c.name === "semaphore-probe")
    expect(probe?.max_in_flight).toBe(CONCURRENCY_LIMIT)
  })
})

describe("findMarkdownLinks", () => {
  for (const parityCase of PARITY.extraction_cases) {
    it(`matches re.findall for ${parityCase.name}`, () => {
      const text =
        parityCase.golden !== undefined
          ? goldenText(
              parityCase.golden.slug,
              parityCase.golden.stage,
              parityCase.golden.key,
            )
          : (parityCase.text ?? "")
      expect(findMarkdownLinks(text)).toEqual(parityCase.matches)
    })
  }

  it("covers the golden fixtures' real link inventory", () => {
    const golden = PARITY.extraction_cases.filter((c) => c.golden !== undefined)
    expect(golden.length).toBe(8)
    const urls = golden.flatMap((c) => c.matches.map((m) => m.url))
    expect(urls.filter((u) => u.startsWith("https://")).length).toBeGreaterThan(0)
  })
})

describe("stripDeadLinks", () => {
  for (const parityCase of PARITY.strip_cases) {
    it(`matches re.sub for ${parityCase.name}`, () => {
      expect(stripDeadLinks(parityCase.content, parityCase.dead_urls)).toBe(
        parityCase.expected,
      )
    })
  }

  it("inserts the captured text verbatim, not as a replacement pattern", () => {
    // `$&`, `$1` and `` $` `` are replacement specials in JavaScript and mean
    // nothing to Python's `\1`. They come out of the link text unchanged.
    expect(stripDeadLinks("[$& $1 $` $'](https://d.com/a)", ["https://d.com/a"])).toBe(
      "$& $1 $` $'",
    )
  })
})
