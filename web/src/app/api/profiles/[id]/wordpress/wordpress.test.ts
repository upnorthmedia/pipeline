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
import { WP_URL_HAS_CREDENTIALS } from "@/mastra/wordpress"
import { ABSENT_PROFILE_ID } from "@/test/absent-ids"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET as getAuthors } from "./authors/route"
import { GET as getCategories } from "./categories/route"
import { PY_WP_DECRYPT_FAILED, WP_DECRYPT_FAILED } from "./client"
import { GET as getTest, WP_ROOT_NOT_WORDPRESS } from "./test/route"

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

/**
 * The seven scenarios where the port deliberately stops reproducing Python
 * (polish ledger item P1.3a).
 *
 * Every one of them is an exception nothing caught, so FastAPI answered a 500
 * with an empty body and the dashboard had nothing to show. The oracle keeps
 * recording the exception, because it is the record of what the deployed stack
 * did; this function is the one place that says what the port answers instead,
 * and it is derived from the oracle rather than written out, so a scenario
 * added to the export cannot quietly skip the new behaviour.
 *
 * `null` means "still uncaught", which is what the escaping branch below
 * asserts. Nothing reaches it today, and the guard under "the exported oracle"
 * is what keeps that fact visible.
 */
/**
 * The one detail the port deliberately rewords (polish ledger item P3.3c-ii).
 *
 * The oracle keeps recording what Python answered, because it is the record of
 * what the deployed stack did. This maps that string onto what the port says
 * instead, and it is applied to every place a scenario's expectation carries a
 * message: the `detail` of a 400 and the `error` inside a 200 body. Anything it
 * does not recognise is returned untouched, so a scenario added to the export
 * is still compared byte for byte.
 */
function reworded<T>(value: T): T {
  if (value === PY_WP_DECRYPT_FAILED) return WP_DECRYPT_FAILED as unknown as T
  if (value && typeof value === "object" && "error" in value) {
    const body = value as { error?: unknown }
    if (body.error === PY_WP_DECRYPT_FAILED) return { ...body, error: WP_DECRYPT_FAILED } as T
  }
  return value
}

function divergentAnswer(scenario: Scenario): { status: number; body: unknown } | null {
  const { unhandled, message } = scenario.expected
  switch (unhandled) {
    case "AttributeError":
      // `info.get(...)` on a `/wp-json` root that is not a JSON object.
      return { status: 200, body: { connected: false, error: WP_ROOT_NOT_WORDPRESS } }
    case "WordPressError":
      return { status: 502, body: { detail: message } }
    case "KeyError": {
      // Python's `str(KeyError("id"))` is the repr of the key, quotes included.
      const key = message!.slice(1, -1)
      const noun = scenario.endpoint === "categories" ? "category" : "author"
      return { status: 502, body: { detail: `WordPress returned a ${noun} with no "${key}"` } }
    }
    default:
      return null
  }
}

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

  it("still records the seven 500s the port diverges from", () => {
    const uncaught = oracle.scenarios.filter((scenario) => scenario.expected.unhandled)
    expect(uncaught.map((scenario) => scenario.name)).toEqual([
      "test-root-returns-json-array",
      "test-root-returns-json-null",
      "test-root-returns-json-string",
      "categories-missing-id-raises",
      "categories-401-escapes",
      "authors-missing-slug-raises",
      "authors-403-escapes",
    ])
    // Every one of them has a replacement, so the escaping branch is unreached.
    // A scenario exported later with a different exception fails here first.
    expect(uncaught.filter((scenario) => divergentAnswer(scenario) === null)).toEqual([])
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
      expect(await response!.json()).toEqual(reworded(scenario.expected.returned))
    })
  } else if (scenario.expected.http_status !== undefined) {
    it(`answers ${scenario.expected.http_status} with Python's detail`, async () => {
      const { response } = await run()
      expect(response!.status).toBe(scenario.expected.http_status)
      expect(await response!.json()).toEqual({ detail: reworded(scenario.expected.detail) })
    })
  } else if (divergentAnswer(scenario)) {
    const answer = divergentAnswer(scenario)!
    it(`answers ${answer.status} where Python raised ${scenario.expected.unhandled}`, async () => {
      const { thrown, response } = await run()
      expect(thrown, "the handler raised instead of answering").toBeUndefined()
      expect(response!.status).toBe(answer.status)
      expect(await response!.json()).toEqual(answer.body)
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

  /**
   * Polish ledger item P3.3c-ii. Python's wording for a Fernet token this
   * server cannot open is `PY_WP_DECRYPT_FAILED`, and all three endpoints hand
   * it straight to the dashboard, where it renders on the profile's WordPress
   * tab. It names an environment variable the reader can neither see nor
   * change. The oracle still records what Python said; `reworded()` above is
   * where the port's answer is written down.
   */
  it.each(["test", "categories", "authors"] as const)(
    "%s tells the reader what to do about a password it cannot decrypt",
    async (endpoint) => {
      const id = await insertProfile(user.userId, {
        wpUrl: base,
        wpUsername: "wp-user",
        // A syntactically valid Fernet token written under a different key.
        wpAppPassword: "gAAAAABmZm90YWtleXRoYXRkb2Vzbm90b3Blbg==",
      })
      const response = await call(endpoint, id, user.cookie)
      const body = await response.json()
      const shown = endpoint === "test" ? body.error : body.detail

      expect(shown).toBe(
        "The saved WordPress application password could not be read. Enter it again on this profile and save.",
      )
      expect(shown).not.toContain("WP_ENCRYPTION_KEY")
      expect(shown).not.toContain("\u2014")
      expect(seen, "nothing should be contacted with a credential we could not open").toEqual([])
    },
  )

  /**
   * Polish ledger item P2.107. `POST`/`PATCH /api/profiles` now refuse a
   * `wp_url` carrying userinfo, but a row written before that check still
   * holds one, and `fetch` refuses a credentialed URL with a `TypeError`
   * (`Request cannot be constructed from a URL that includes credentials`)
   * rather than with a `WordPressError`. Nothing here caught it, so all three
   * endpoints answered 500 with an empty body and the reader was told nothing
   * about the one field they can fix.
   */
  it.each(["test", "categories", "authors"] as const)(
    "%s reports a stored wp_url carrying credentials instead of failing with a 500",
    async (endpoint) => {
      const id = await insertProfile(user.userId, {
        wpUrl: base.replace("http://", "http://leaked-user:leaked-pass@"),
        wpUsername: "wp-user",
        wpAppPassword: scenarioPassword(),
      })

      const response = await call(endpoint, id, user.cookie)
      const body = await response.json()
      const shown = endpoint === "test" ? body.error : body.detail

      expect(response.status).toBe(endpoint === "test" ? 200 : 400)
      expect(shown).toBe(WP_URL_HAS_CREDENTIALS)
      expect(shown).not.toContain("leaked-pass")
      expect(seen, "nothing should be contacted with a URL no request can carry").toEqual([])
    },
  )

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
