// @vitest-environment node
/**
 * Parity tests for the three `wordpress` router handlers (ledger item 5.9b).
 *
 * The oracle in `../../data/wordpress-router-parity.json` is written by
 * `api/scripts/export_wordpress_router_parity.py`, which drove the real
 * `test_connection`, `list_categories` and `list_authors` coroutines against a
 * local HTTP server and recorded, per scenario, the profile row, every request
 * the WordPress stand-in saw, and the value returned or the exception raised.
 * This file stands up a Node server from the same exported routing table and
 * runs the ported handlers against it over real sockets, with a real BetterAuth
 * session and a real `website_profiles` row, so the `user_id` scoping and the
 * Fernet decrypt are both genuinely exercised.
 *
 * `api/tests/phase10/` has no coverage of this router at all, so every case
 * here is new on both sides.
 */
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"

import { like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { closeDb, getDb, websiteProfiles } from "@/db"
import { ABSENT_PROFILE_ID } from "@/test/absent-ids"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET as getAuthors } from "./authors/route"
import { GET as getCategories } from "./categories/route"
import { GET as getTest } from "./test/route"

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
  endpoint: "test" | "categories" | "authors"
  profile: {
    wp_url: string | null
    wp_username: string | null
    wp_app_password: string | null
  } | null
  unset_key: boolean
  routes: Record<string, Route>
  requests: SeenRequest[]
  expected: {
    returned?: unknown
    http_status?: number
    detail?: string
    unhandled?: string
    message?: string
    status_code?: number | null
  }
}

interface Oracle {
  generated_by: string
  source: string
  encryption_key: string
  app_password: string
  profile_id: string
  scenarios: Scenario[]
}

const oracle: Oracle = JSON.parse(
  readFileSync(path.join(__dirname, "..", "..", "data", "wordpress-router-parity.json"), "utf8"),
)

const PREFIX = "wordpress-router-test-"
const db = getDb()

let user: TestSession
let other: TestSession
let server: Server
let base: string
let savedEncryptionKey: string | undefined

/** The route key the export script wrote: method, path, query pairs sorted. */
function routeKey(method: string, target: string): string {
  const [rawPath, rawQuery = ""] = target.split("?")
  const pairs = [...new URLSearchParams(rawQuery).entries()]
  if (pairs.length === 0) return `${method} ${rawPath}`
  pairs.sort(([aKey, aValue], [bKey, bValue]) =>
    aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey),
  )
  return `${method} ${rawPath}?${pairs.map(([k, v]) => `${k}=${v}`).join("&")}`
}

let routes: Record<string, Route> = {}
let seen: SeenRequest[] = []

beforeAll(async () => {
  savedEncryptionKey = process.env.WP_ENCRYPTION_KEY
  process.env.WP_ENCRYPTION_KEY = oracle.encryption_key

  user = await createTestSession(PREFIX)
  other = await createTestSession(PREFIX)

  server = createServer((request, response) => {
    const target = request.url ?? "/"
    const [rawPath, rawQuery = ""] = target.split("?")
    seen.push({
      method: request.method ?? "",
      path: rawPath,
      query: rawQuery,
      authorization: request.headers.authorization ?? "",
    })
    const route = routes[routeKey(request.method ?? "", target)]
    if (!route) {
      response.writeHead(404, { "Content-Type": "text/plain" })
      response.end("no route")
      return
    }
    response.writeHead(route.status, { "Content-Type": route.content_type })
    response.end(route.body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  await clearProfiles()
  await deleteTestSessions(PREFIX)
  if (savedEncryptionKey === undefined) delete process.env.WP_ENCRYPTION_KEY
  else process.env.WP_ENCRYPTION_KEY = savedEncryptionKey
  await closeDb()
})

async function clearProfiles() {
  await db.delete(websiteProfiles).where(like(websiteProfiles.userId, `${PREFIX}%`))
}

beforeEach(() => {
  routes = {}
  seen = []
  process.env.WP_ENCRYPTION_KEY = oracle.encryption_key
})

afterEach(clearProfiles)

async function insertProfile(
  ownerId: string,
  values: Partial<typeof websiteProfiles.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(websiteProfiles)
    .values({
      userId: ownerId,
      name: "Fixture Blog",
      websiteUrl: "http://127.0.0.1:9/fixture",
      ...values,
    })
    .returning({ id: websiteProfiles.id })
  return row.id
}

const HANDLERS = {
  test: getTest,
  categories: getCategories,
  authors: getAuthors,
} as const

function call(endpoint: keyof typeof HANDLERS, id: string, cookie?: string) {
  return HANDLERS[endpoint](
    apiRequest(`http://test/api/profiles/${id}/wordpress/${endpoint}`, { cookie }),
    { params: Promise.resolve({ id }) },
  )
}

describe("the exported oracle", () => {
  it("carries every scenario the export script ran", () => {
    expect(oracle.generated_by).toBe("api/scripts/export_wordpress_router_parity.py")
    expect(oracle.scenarios.length).toBeGreaterThanOrEqual(36)
  })
})

describe.each(oracle.scenarios)("$endpoint: $name", (scenario) => {
  async function run(): Promise<{ response?: Response; thrown?: unknown; id: string }> {
    routes = Object.fromEntries(
      Object.entries(scenario.routes).map(([key, route]) => {
        const [method, target] = key.split(" ", 2)
        return [routeKey(method, target), route]
      }),
    )
    let id: string
    if (scenario.profile === null) {
      // The row belongs to somebody else, which is the same 404 as a row that
      // was never written, and the stronger of the two checks.
      id = await insertProfile(other.userId)
    } else {
      id = await insertProfile(user.userId, {
        wpUrl: scenario.profile.wp_url?.replace("{BASE}", base) ?? null,
        wpUsername: scenario.profile.wp_username,
        wpAppPassword: scenario.profile.wp_app_password,
      })
    }
    if (scenario.unset_key) delete process.env.WP_ENCRYPTION_KEY
    try {
      return { response: await call(scenario.endpoint, id, user.cookie), id }
    } catch (thrown) {
      return { thrown, id }
    }
  }

  if (scenario.expected.returned !== undefined) {
    it("answers 200 with the value Python returned", async () => {
      const { response } = await run()
      expect(response!.status).toBe(200)
      expect(await response!.json()).toEqual(scenario.expected.returned)
    })
  } else if (scenario.expected.http_status !== undefined) {
    it(`answers ${scenario.expected.http_status} with Python's detail`, async () => {
      const { response } = await run()
      expect(response!.status).toBe(scenario.expected.http_status)
      expect(await response!.json()).toEqual({ detail: scenario.expected.detail })
    })
  } else {
    it(`lets the ${scenario.expected.unhandled} out, as Python did`, async () => {
      const { thrown, response } = await run()
      expect(response, "the handler answered instead of raising").toBeUndefined()
      expect(thrown).toBeInstanceOf(Error)
    })
  }

  it("issues the same requests Python's client issued", async () => {
    await run()
    expect(seen.map((request) => ({ method: request.method, path: request.path }))).toEqual(
      scenario.requests.map((request) => ({ method: request.method, path: request.path })),
    )
    expect(seen.map((request) => request.query)).toEqual(
      scenario.requests.map((request) => request.query),
    )
    expect(seen.map((request) => request.authorization)).toEqual(
      scenario.requests.map((request) => request.authorization),
    )
  })
})

describe("cases the oracle cannot reach", () => {
  it.each(["test", "categories", "authors"] as const)(
    "%s rejects an unauthenticated request",
    async (endpoint) => {
      const id = await insertProfile(user.userId)
      const response = await call(endpoint, id)
      expect(response.status).toBe(401)
    },
  )

  it.each(["test", "categories", "authors"] as const)(
    "%s answers a malformed path uuid with FastAPI's 422",
    async (endpoint) => {
      const response = await call(endpoint, "not-a-uuid", user.cookie)
      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({
        detail: [
          {
            type: "uuid_parsing",
            loc: ["path", "profile_id"],
            msg: "Input should be a valid UUID",
            input: "not-a-uuid",
          },
        ],
      })
    },
  )

  it.each(["test", "categories", "authors"] as const)(
    "%s answers a profile that does not exist with a 404",
    async (endpoint) => {
      const response = await call(endpoint, ABSENT_PROFILE_ID, user.cookie)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ detail: "Profile not found" })
    },
  )

  it("test answers another user's fully configured profile with a 404, contacting nothing", async () => {
    routes = { [routeKey("GET", "/wp-json")]: { status: 200, body: '{"name":"x"}', content_type: "application/json" } }
    const id = await insertProfile(other.userId, {
      wpUrl: base,
      wpUsername: "wp-user",
      wpAppPassword: scenarioPassword(),
    })
    const response = await call("test", id, user.cookie)
    expect(response.status).toBe(404)
    expect(seen).toEqual([])
  })

  it("categories answers another user's profile with the same 404 as a missing one", async () => {
    const id = await insertProfile(other.userId, {
      wpUrl: base,
      wpUsername: "wp-user",
      wpAppPassword: scenarioPassword(),
    })
    const response = await call("categories", id, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Profile not found" })
  })

  it("sends the Basic credential built from the decrypted app password", async () => {
    routes = { [routeKey("GET", "/wp-json")]: { status: 200, body: '{"name":"x"}', content_type: "application/json" } }
    const id = await insertProfile(user.userId, {
      wpUrl: base,
      wpUsername: "wp-user",
      wpAppPassword: scenarioPassword(),
    })
    await call("test", id, user.cookie)
    const expected = `Basic ${Buffer.from(`wp-user:${oracle.app_password}`, "utf8").toString("base64")}`
    expect(seen).toHaveLength(1)
    expect(seen[0].authorization).toBe(expected)
  })
})

/** The Fernet token the export script stored, lifted off any `ok` scenario. */
function scenarioPassword(): string {
  const ok = oracle.scenarios.find((scenario) => scenario.name === "test-success")
  return ok!.profile!.wp_app_password!
}
