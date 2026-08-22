// @vitest-environment node
/**
 * Parity tests for the `sitemap` port (ledger item 5.2c-i).
 *
 * The oracle in `data/sitemap-parity.json` is written by
 * `api/scripts/export_sitemap_parity.py`, which ran the real Python service
 * and recorded what came back. It carries three kinds of case:
 *
 * 1. **Parse cases** over the XML fixtures (copied into `data/fixtures/` so
 *    they outlive `api/`) and a set of literals covering gzip, a missing
 *    `<loc>`, broken XML, an unknown root element and three namespace shapes.
 * 2. **Robots cases**, an input/output table for `parse_robots_txt`.
 * 3. **Scenarios**: a routing table Python served from a local HTTP server,
 *    the call it made against it, and the result. This file stands up a Node
 *    server driven by that same exported table, so the two servers cannot
 *    drift, and runs the TypeScript port against it over real sockets. No HTTP
 *    is mocked, unlike the pytest suite, which mocked `httpx.AsyncClient`.
 */
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { gzipSync } from "node:zlib"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  SitemapParseError,
  crawlSitemap,
  discoverSitemaps,
  fetchAndParseSitemap,
  parseRobotsTxt,
  parseSitemapXml,
  type SitemapEntry,
} from "./index"

interface ParseCase {
  name: string
  fixture?: string
  xml?: string
  gzipped?: boolean
  error?: string
  sub_sitemaps?: string[]
  entries?: SitemapEntry[]
}

interface Route {
  status: number
  body: string | null
  fixture: string | null
  content_type: string
  template_base: boolean
  gzipped: boolean
  reset: boolean
}

interface Scenario {
  name: string
  routes: Record<string, Route>
  call: { fn: string; url: string; max_depth?: number }
  expected: string[] | SitemapEntry[]
}

interface Parity {
  fixture_host: string
  parse_cases: ParseCase[]
  robots_cases: { name: string; content: string; expected: string[] }[]
  scenarios: Scenario[]
}

const DATA = path.join(__dirname, "data")
const parity = JSON.parse(
  readFileSync(path.join(DATA, "sitemap-parity.json"), "utf-8"),
) as Parity

function fixtureBytes(name: string): Buffer {
  return readFileSync(path.join(DATA, "fixtures", name))
}

let server: Server
let base = ""
let routes: Record<string, Route> = {}

beforeAll(async () => {
  server = createServer((req, res) => {
    const requestPath = new URL(req.url ?? "/", base).pathname
    const route = routes[requestPath]
    if (!route) {
      res.writeHead(404, { "Content-Length": "0" })
      res.end()
      return
    }
    if (route.reset) {
      // Hang up without answering, the way the export's server did, so the
      // client raises a transport error rather than seeing a status code.
      res.socket?.destroy()
      return
    }
    let body = route.fixture
      ? fixtureBytes(route.fixture)
      : Buffer.from(route.body ?? "")
    body = Buffer.from(
      route.template_base
        ? body.toString("utf-8").replaceAll(parity.fixture_host, base)
        : body.toString("utf-8").replaceAll("{BASE}", base),
    )
    if (route.gzipped) {
      body = gzipSync(body)
    }
    res.writeHead(route.status, {
      "Content-Type": route.content_type,
      "Content-Length": String(body.length),
    })
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

describe("parseSitemapXml", () => {
  for (const testCase of parity.parse_cases) {
    it(`matches Python on ${testCase.name}`, () => {
      let content = testCase.fixture
        ? fixtureBytes(testCase.fixture)
        : Buffer.from(testCase.xml ?? "")
      if (testCase.gzipped) {
        content = gzipSync(content)
      }

      if (testCase.error) {
        // The message text after the prefix is the XML library's, and lxml's
        // wording is not fast-xml-parser's, so only the prefix is parity.
        const prefix = testCase.error.split(":")[0]
        expect(() => parseSitemapXml(content)).toThrow(SitemapParseError)
        expect(() => parseSitemapXml(content)).toThrow(
          testCase.error.startsWith("Malformed XML") ? `${prefix}:` : testCase.error,
        )
        return
      }

      const parsed = parseSitemapXml(content)
      expect(parsed.subSitemaps).toEqual(testCase.sub_sitemaps)
      expect(parsed.entries).toEqual(testCase.entries)
    })
  }
})

describe("parseRobotsTxt", () => {
  for (const testCase of parity.robots_cases) {
    it(`matches Python on ${testCase.name}`, () => {
      expect(parseRobotsTxt(testCase.content)).toEqual(testCase.expected)
    })
  }
})

describe("against a live server", () => {
  for (const scenario of parity.scenarios) {
    it(`matches Python on ${scenario.name}`, async () => {
      routes = scenario.routes
      const url = scenario.call.url.replaceAll("{BASE}", base)

      if (scenario.call.fn === "discover_sitemaps") {
        const found = await discoverSitemaps(url)
        expect(found.map((item) => item.replaceAll(base, "{BASE}"))).toEqual(
          scenario.expected,
        )
        return
      }

      const found =
        scenario.call.fn === "crawl_sitemap"
          ? await crawlSitemap(url)
          : await fetchAndParseSitemap(url, scenario.call.max_depth)
      expect(found).toEqual(scenario.expected)
    })
  }
})
