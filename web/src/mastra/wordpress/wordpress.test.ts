// @vitest-environment node
/**
 * Parity tests for the read half of the `wordpress` client port (ledger item
 * 5.9a).
 *
 * The oracle in `data/wordpress-parity.json` is written by
 * `api/scripts/export_wordpress_parity.py`, which ran the real Python client
 * and recorded what came back. It carries two kinds of case:
 *
 * 1. **Constructor cases**, an input/output table over `api_url`, `site_url`
 *    and the `Authorization` header for 26 spellings of a site URL.
 * 2. **Scenarios**: a routing table Python served from a local HTTP server,
 *    the call it made against it, every request the server saw, and the value
 *    returned or the `WordPressError` raised. This file stands up a Node
 *    server driven by that same exported table, so the two servers cannot
 *    drift, and runs the TypeScript port against it over real sockets.
 *
 * `api/tests/phase10/test_wordpress_service.py` replaces the client's
 * transport with an `AsyncMock`, so nothing there ever exercised the
 * pagination query string, the `>= 400` error grammar or the non-JSON branch
 * against a real response. Nothing is mocked here.
 */
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  WordPressClient,
  WordPressError,
  basicAuthHeader,
  normalizeWordPressUrl,
} from "./index"

interface ConstructorCase {
  name: string
  wp_url: string
  username: string
  app_password: string
  api_url: string
  site_url: string
  authorization: string
}

interface Route {
  status: number
  body: string
  content_type: string
}

interface SeenRequest {
  method: string
  path: string
  query: string
  authorization: string
}

interface Scenario {
  name: string
  url: string
  routes: Record<string, Route>
  call: { fn: string; roles?: string[] }
  api_url: string
  site_url: string
  requests: SeenRequest[]
  expected: { result?: unknown; error?: string; status_code?: number | null }
}

interface Oracle {
  generated_by: string
  source: string
  scenario_credentials: { username: string; app_password: string }
  constructor_cases: ConstructorCase[]
  scenarios: Scenario[]
}

const oracle: Oracle = JSON.parse(
  readFileSync(path.join(__dirname, "data", "wordpress-parity.json"), "utf8"),
)

/** The export script's route key: method, path, and query pairs sorted. */
function routeKey(method: string, target: string): string {
  const [rawPath, rawQuery = ""] = target.split("?")
  const pairs = [...new URLSearchParams(rawQuery).entries()]
  if (pairs.length === 0) {
    return `${method} ${rawPath}`
  }
  pairs.sort(([aKey, aValue], [bKey, bValue]) =>
    aKey === bKey ? (aValue < bValue ? -1 : aValue > bValue ? 1 : 0) : aKey < bKey ? -1 : 1,
  )
  return `${method} ${rawPath}?${pairs.map(([k, v]) => `${k}=${v}`).join("&")}`
}

let server: Server
let base: string
let routes: Record<string, Route> = {}
let seen: SeenRequest[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    const target = req.url ?? "/"
    const [reqPath, query = ""] = target.split("?")
    seen.push({
      method: req.method ?? "",
      path: reqPath,
      query,
      authorization: req.headers.authorization ?? "",
    })
    const route = routes[routeKey(req.method ?? "GET", target)]
    if (!route) {
      res.writeHead(404, { "Content-Type": "text/plain" })
      res.end("no route")
      return
    }
    res.writeHead(route.status, { "Content-Type": route.content_type })
    res.end(route.body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

describe("WordPressClient constructor", () => {
  for (const testCase of oracle.constructor_cases) {
    it(`derives the same urls and credential as Python for ${testCase.name}`, () => {
      const client = new WordPressClient(
        testCase.wp_url,
        testCase.username,
        testCase.app_password,
      )
      expect(client.apiUrl).toBe(testCase.api_url)
      expect(client.siteUrl).toBe(testCase.site_url)
      expect(basicAuthHeader(testCase.username, testCase.app_password)).toBe(
        testCase.authorization,
      )
    })
  }

  it("strips at most one suffix, leaving the one underneath", () => {
    expect(normalizeWordPressUrl("https://example.com/wp-admin/wp-json")).toBe(
      "https://example.com/wp-admin",
    )
  })

  it("requires the suffix to start at a path segment", () => {
    expect(normalizeWordPressUrl("https://example.com/my-wp-admin")).toBe(
      "https://example.com/my-wp-admin",
    )
  })
})

describe("WordPressClient against a live server", () => {
  for (const scenario of oracle.scenarios) {
    it(`matches Python for ${scenario.name}`, async () => {
      routes = scenario.routes
      seen = []
      const client = new WordPressClient(
        scenario.url.replace("{BASE}", base),
        oracle.scenario_credentials.username,
        oracle.scenario_credentials.app_password,
      )
      expect(client.apiUrl).toBe(scenario.api_url.replace("{BASE}", base))
      expect(client.siteUrl).toBe(scenario.site_url.replace("{BASE}", base))

      let outcome: { result?: unknown; error?: string; status_code?: number | null }
      try {
        let value: unknown
        if (scenario.call.fn === "test_connection") {
          value = await client.testConnection()
        } else if (scenario.call.fn === "list_categories") {
          value = await client.listCategories()
        } else if (scenario.call.fn === "list_users") {
          value =
            scenario.call.roles === undefined
              ? await client.listUsers()
              : await client.listUsers(scenario.call.roles)
        } else {
          throw new Error(`unknown call: ${scenario.call.fn}`)
        }
        outcome = { result: value }
      } catch (error) {
        expect(error).toBeInstanceOf(WordPressError)
        const wpError = error as WordPressError
        outcome = { error: wpError.message, status_code: wpError.statusCode }
      }

      expect(outcome).toEqual(scenario.expected)
      expect(seen).toEqual(scenario.requests)
    })
  }
})

describe("behaviour the oracle cannot cover", () => {
  it("lets a transport failure out unwrapped, as Python lets httpx errors out", async () => {
    // Port 1 on the loopback interface refuses, so `fetch` rejects before any
    // status exists. Python raises `httpx.ConnectError` here for the same
    // reason: `_request` only wraps a response it received.
    const client = new WordPressClient("http://127.0.0.1:1", "u", "p")
    await expect(client.testConnection()).rejects.not.toBeInstanceOf(WordPressError)
  })

  it("reports the status the non-JSON body arrived with, not 200 by assumption", async () => {
    routes = {
      "GET /wp-json": { status: 201, body: "created", content_type: "text/plain" },
    }
    seen = []
    const client = new WordPressClient(base, "u", "p")
    await expect(client.testConnection()).rejects.toMatchObject({
      message: "WordPress returned non-JSON response — check that the site URL is correct",
      statusCode: 201,
    })
  })

  it("sends the Basic credential on every page of a paginated call", async () => {
    const full = Array.from({ length: 100 }, (_, index) => ({ id: index }))
    routes = {
      "GET /wp-json/wp/v2/categories?page=1&per_page=100": {
        status: 200,
        body: JSON.stringify(full),
        content_type: "application/json",
      },
      "GET /wp-json/wp/v2/categories?page=2&per_page=100": {
        status: 200,
        body: "[]",
        content_type: "application/json",
      },
    }
    seen = []
    const client = new WordPressClient(base, "someone", "a pass")
    await client.listCategories()
    expect(seen).toHaveLength(2)
    for (const request of seen) {
      expect(request.authorization).toBe(basicAuthHeader("someone", "a pass"))
    }
  })
})
