// @vitest-environment node
/**
 * Parity tests for the `nextjs` router (ledger item 5.10).
 *
 * The oracle in `../../data/nextjs-router-parity.json` is written by
 * `api/scripts/export_nextjs_router_parity.py`, which drove the real
 * `test_nextjs_connection` coroutine against a local HTTP server and recorded,
 * per scenario, the profile row, the request the webhook stand-in saw (body,
 * content type and signature included) and the value returned or the exception
 * raised. This file stands the same routing table up in Node and runs the
 * ported handler against it over real sockets, with a real BetterAuth session
 * and a real `website_profiles` row, so the `user_id` scoping and the Fernet
 * decrypt are both genuinely exercised.
 *
 * Two scenarios cannot assert byte equality with Python and say so where they
 * are asserted: `connection-refused`, because the message is httpx's wording,
 * and `502-error-key-is-an-integral-float`, because `JSON.parse` erases the
 * int/float distinction Python's `str()` renders.
 *
 * `api/tests/phase_nextjs/` covers `sign_payload` and `verify_signature` but
 * has no coverage of the router itself, so every router case here is new on
 * both sides.
 */
import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"

import { like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { closeDb, getDb, websiteProfiles } from "@/db"
import { signPayload } from "@/lib/hmac-signing"
import { ABSENT_PROFILE_ID } from "@/test/absent-ids"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { POST as postTest } from "./test/route"

interface Route {
  status: number
  body: string
  content_type: string
  location?: string
}

interface SeenRequest {
  method: string
  path: string
  query: string
  content_type: string
  signature: string
  body: string
}

interface Scenario {
  name: string
  profile: {
    user_id: string
    nextjs_webhook_url: string | null
    nextjs_webhook_secret: string | null
  } | null
  unset_key: boolean
  routes: Record<string, Route>
  requests: SeenRequest[]
  expected: {
    returned?: { connected: boolean; error?: string }
    http_status?: number
    detail?: string
  }
}

interface Oracle {
  generated_by: string
  source: string
  encryption_key: string
  webhook_secret: string
  profile_id: string
  user_id: string
  hook_path: string
  scenarios: Scenario[]
}

const oracle: Oracle = JSON.parse(
  readFileSync(path.join(__dirname, "..", "..", "data", "nextjs-router-parity.json"), "utf8"),
)

const PREFIX = "nextjs-router-test-"
const db = getDb()

/** `datetime.now(UTC).isoformat()`: microseconds and an explicit UTC offset. */
const PY_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{6})?\+00:00$/

let user: TestSession
let other: TestSession
let server: Server
let base: string
let savedEncryptionKey: string | undefined
let routes: Record<string, Route> = {}
let seen: SeenRequest[] = []

beforeAll(async () => {
  savedEncryptionKey = process.env.WP_ENCRYPTION_KEY
  process.env.WP_ENCRYPTION_KEY = oracle.encryption_key

  user = await createTestSession(PREFIX)
  other = await createTestSession(PREFIX)

  server = createServer((request, response) => {
    const [rawPath, rawQuery = ""] = (request.url ?? "/").split("?")
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      seen.push({
        method: request.method ?? "",
        path: rawPath,
        query: rawQuery,
        content_type: request.headers["content-type"] ?? "",
        signature: (request.headers["x-jena-signature"] as string) ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      })
      const route = routes[`${request.method} ${rawPath}`]
      if (!route) {
        response.writeHead(404, { "Content-Type": "text/plain" })
        response.end("no route")
        return
      }
      const headers: Record<string, string> = { "Content-Type": route.content_type }
      if (route.location) headers.Location = route.location
      response.writeHead(route.status, headers)
      response.end(route.body)
    })
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

function call(id: string, cookie?: string): Promise<Response> {
  return postTest(
    apiRequest(`http://test/api/profiles/${id}/nextjs/test`, { method: "POST", cookie }),
    { params: Promise.resolve({ id }) },
  )
}

describe("the exported oracle", () => {
  it("carries every scenario the export script ran", () => {
    expect(oracle.generated_by).toBe("api/scripts/export_nextjs_router_parity.py")
    expect(oracle.source).toBe("api/src/api/nextjs.py::test_nextjs_connection")
    expect(oracle.scenarios.length).toBeGreaterThanOrEqual(29)
  })
})

describe.each(oracle.scenarios)("$name", (scenario) => {
  async function run(): Promise<Response> {
    routes = Object.fromEntries(
      Object.entries(scenario.routes).map(([key, route]) => {
        const [method, target] = key.split(" ", 2)
        return [`${method} ${target}`, route]
      }),
    )
    let id: string
    if (scenario.profile === null) {
      id = await insertProfile(other.userId)
    } else if (scenario.profile.user_id !== oracle.user_id) {
      // The export stubbed the lookup, so the row it built still exists; here
      // the row genuinely belongs to the other session, which is the stronger
      // check and the same 404.
      id = await insertProfile(other.userId, {
        nextjsWebhookUrl: scenario.profile.nextjs_webhook_url?.replace("{BASE}", base) ?? null,
        nextjsWebhookSecret: scenario.profile.nextjs_webhook_secret,
      })
    } else {
      id = await insertProfile(user.userId, {
        nextjsWebhookUrl: scenario.profile.nextjs_webhook_url?.replace("{BASE}", base) ?? null,
        nextjsWebhookSecret: scenario.profile.nextjs_webhook_secret,
      })
    }
    if (scenario.unset_key) delete process.env.WP_ENCRYPTION_KEY
    return call(id, user.cookie)
  }

  if (scenario.expected.http_status !== undefined) {
    it(`answers ${scenario.expected.http_status} with Python's detail`, async () => {
      const response = await run()
      expect(response.status).toBe(scenario.expected.http_status)
      expect(await response.json()).toEqual({ detail: scenario.expected.detail })
    })
  } else if (scenario.name === "connection-refused") {
    it("reports the transport failure, with Node's wording rather than httpx's", async () => {
      const response = await run()
      expect(response.status).toBe(200)
      const body = (await response.json()) as { connected: boolean; error: string }
      expect(body.connected).toBe(false)
      expect(body.error.length).toBeGreaterThan(0)
      expect(scenario.expected.returned!.error).toBe("All connection attempts failed")
    })
  } else if (scenario.name === "502-error-key-is-an-integral-float") {
    it("renders the integral float as JSON.parse leaves it, not as Python's str", async () => {
      const response = await run()
      expect(await response.json()).toEqual({
        connected: false,
        error: "Webhook returned 502: 1",
      })
      expect(scenario.expected.returned!.error).toBe("Webhook returned 502: 1.0")
    })
  } else {
    it("answers 200 with the value Python returned", async () => {
      const response = await run()
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(scenario.expected.returned)
    })
  }

  it("issues the same request Python issued", async () => {
    await run()
    expect(seen.map((r) => ({ method: r.method, path: r.path, query: r.query }))).toEqual(
      scenario.requests.map((r) => ({ method: r.method, path: r.path, query: r.query })),
    )
    expect(seen.map((r) => r.content_type)).toEqual(
      scenario.requests.map((r) => r.content_type),
    )
    for (const [index, request] of seen.entries()) {
      const recorded = scenario.requests[index]
      // The timestamp moves, so the body is compared by shape and the
      // signature is recomputed over the body that was actually sent.
      const parsed = JSON.parse(request.body) as { event: string; timestamp: string }
      expect(parsed.event).toBe("test")
      expect(parsed.timestamp).toMatch(PY_TIMESTAMP)
      expect(request.body).toBe(
        `{"event": "test", "timestamp": ${JSON.stringify(parsed.timestamp)}}`,
      )
      expect(JSON.parse(recorded.body).event).toBe("test")
      expect(request.signature).toBe(signPayload(request.body, oracle.webhook_secret))
      expect(recorded.signature).toBe(signPayload(recorded.body, oracle.webhook_secret))
    }
  })
})

describe("cases the oracle cannot reach", () => {
  it("rejects an unauthenticated request before touching the profile", async () => {
    const id = await insertProfile(user.userId)
    const response = await call(id)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
    expect(seen).toEqual([])
  })

  it("answers 422 for a path parameter that is not a uuid", async () => {
    const response = await call("not-a-uuid", user.cookie)
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
  })

  it("answers 404 for a uuid no profile carries", async () => {
    const response = await call(ABSENT_PROFILE_ID, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Profile not found" })
  })

  it("signs with the receiver's own algorithm, not just its own", async () => {
    // `packages/create-mdx-blog` recomputes the digest this way, so the two
    // halves of the contract are checked against each other rather than
    // against one shared helper.
    routes = {
      [`POST ${oracle.hook_path}`]: {
        status: 200,
        body: "{}",
        content_type: "application/json",
      },
    }
    const id = await insertProfile(user.userId, {
      nextjsWebhookUrl: `${base}${oracle.hook_path}`,
      nextjsWebhookSecret: oracle.scenarios.find((s) => s.name === "success-200-json")!.profile!
        .nextjs_webhook_secret,
    })
    const response = await call(id, user.cookie)
    expect(await response.json()).toEqual({ connected: true })
    expect(seen).toHaveLength(1)
    expect(seen[0].signature).toBe(
      createHmac("sha256", oracle.webhook_secret).update(seen[0].body).digest("hex"),
    )
  })
})
