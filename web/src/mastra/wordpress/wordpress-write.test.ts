// @vitest-environment node
/**
 * Parity tests for the write half of the `wordpress` client port (ledger item
 * 5.3c-iii-b-1-a).
 *
 * The oracle in `data/wordpress-write-parity.json` is written by
 * `api/scripts/export_wordpress_write_parity.py`, which ran the real Python
 * client against a local HTTP server and recorded, per scenario: the routing
 * table it served, every request the server saw down to the raw body bytes,
 * and the value the client returned or the `WordPressError` it raised. This
 * file stands up a Node server driven by that same exported table, so the two
 * servers cannot drift, and runs the TypeScript port against it over real
 * sockets.
 *
 * The request assertions are the point of this file. `create_post` decides
 * what to send with truthiness tests, `update_post` forwards nulls, and
 * `upload_media` sends bytes under a `Content-Disposition` header and then
 * conditionally a second JSON request. None of that is observable from the
 * return value, and `api/tests/phase10/test_wordpress_service.py` never sees
 * it either: it replaces the transport with an `AsyncMock`.
 */
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { WordPressClient, WordPressError, basicAuthHeader } from "./index"

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
  content_type: string
  content_disposition: string
  content_length: string
  body_b64: string
}

interface Call {
  fn: string
  image_b64?: string
  filename?: string
  mime_type?: string
  alt_text?: string
  title?: string
  content?: string
  status?: string
  categories?: number[] | null
  author?: number | null
  featured_media?: number | null
  excerpt?: string
  wp_post_id?: number
  /** Pairs, not an object: the oracle is written with sorted keys. */
  kwargs?: [string, unknown][]
}

interface Scenario {
  name: string
  routes: Record<string, Route>
  call: Call
  api_url: string
  requests: SeenRequest[]
  expected: { result?: unknown; error?: string; status_code?: number | null }
}

interface Oracle {
  generated_by: string
  source: string
  httpx_version: string
  scenario_credentials: { username: string; app_password: string }
  scenarios: Scenario[]
}

const oracle: Oracle = JSON.parse(
  readFileSync(path.join(__dirname, "data", "wordpress-write-parity.json"), "utf8"),
)

let server: Server
let base: string
let routes: Record<string, Route> = {}
let seen: SeenRequest[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    const target = req.url ?? "/"
    const [reqPath, query = ""] = target.split("?")
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        path: reqPath,
        query,
        authorization: req.headers.authorization ?? "",
        content_type: req.headers["content-type"] ?? "",
        content_disposition: (req.headers["content-disposition"] as string) ?? "",
        content_length: req.headers["content-length"] ?? "",
        body_b64: Buffer.concat(chunks).toString("base64"),
      })
      const route = routes[`${req.method ?? "GET"} ${reqPath}`]
      if (!route) {
        res.writeHead(404, { "Content-Type": "text/plain" })
        res.end("no route")
        return
      }
      res.writeHead(route.status, { "Content-Type": route.content_type })
      res.end(route.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

/** The mirror of the export script's `_invoke`, argument defaults included. */
function invoke(client: WordPressClient, call: Call): Promise<unknown> {
  if (call.fn === "upload_media") {
    const bytes = new Uint8Array(Buffer.from(call.image_b64 ?? "", "base64"))
    // `mime_type` and `alt_text` are omitted from the call rather than passed
    // as undefined, so the port's own defaults are the ones under test.
    if (call.mime_type === undefined) {
      return client.uploadMedia(bytes, call.filename as string)
    }
    if (call.alt_text === undefined) {
      return client.uploadMedia(bytes, call.filename as string, call.mime_type)
    }
    return client.uploadMedia(
      bytes,
      call.filename as string,
      call.mime_type,
      call.alt_text,
    )
  }
  if (call.fn === "create_post") {
    return client.createPost({
      title: call.title as string,
      content: call.content as string,
      ...(call.status === undefined ? {} : { status: call.status }),
      ...(call.categories === undefined ? {} : { categories: call.categories }),
      ...(call.author === undefined ? {} : { author: call.author }),
      ...(call.featured_media === undefined
        ? {}
        : { featuredMedia: call.featured_media }),
      ...(call.excerpt === undefined ? {} : { excerpt: call.excerpt }),
    })
  }
  if (call.fn === "update_post") {
    return client.updatePost(
      call.wp_post_id as number,
      Object.fromEntries(call.kwargs as [string, unknown][]),
    )
  }
  throw new Error(`unknown call: ${call.fn}`)
}

describe("WordPressClient write half against a live server", () => {
  for (const scenario of oracle.scenarios) {
    it(`matches Python for ${scenario.name}`, async () => {
      routes = scenario.routes
      seen = []
      const client = new WordPressClient(
        base,
        oracle.scenario_credentials.username,
        oracle.scenario_credentials.app_password,
      )
      expect(client.apiUrl).toBe(scenario.api_url.replace("{BASE}", base))

      let outcome: { result?: unknown; error?: string; status_code?: number | null }
      try {
        outcome = { result: await invoke(client, scenario.call) }
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
  it("sends the Basic credential on the alt-text patch, not only the upload", async () => {
    routes = {
      "POST /wp-json/wp/v2/media": {
        status: 201,
        body: JSON.stringify({ id: 3 }),
        content_type: "application/json",
      },
      "POST /wp-json/wp/v2/media/3": {
        status: 200,
        body: JSON.stringify({ id: 3 }),
        content_type: "application/json",
      },
    }
    seen = []
    const client = new WordPressClient(base, "someone", "a pass")
    await client.uploadMedia(new Uint8Array([1, 2, 3]), "x.png", "image/png", "alt")
    expect(seen).toHaveLength(2)
    for (const request of seen) {
      expect(request.authorization).toBe(basicAuthHeader("someone", "a pass"))
    }
  })

  it("lets a transport failure out unwrapped, as Python lets httpx errors out", async () => {
    // Port 1 on the loopback interface refuses, so `fetch` rejects before any
    // status exists. Python raises `httpx.ConnectError` here for the same
    // reason: `_request` only wraps a response it received.
    const client = new WordPressClient("http://127.0.0.1:1", "u", "p")
    await expect(
      client.createPost({ title: "t", content: "c" }),
    ).rejects.not.toBeInstanceOf(WordPressError)
  })

  it("treats a null upload response as having no id rather than throwing", async () => {
    // `media.get("id")` on `None` raises `AttributeError` in Python, which
    // `upload_media` does not catch, so the call fails with a non-WordPressError.
    // Reading `.id` off `null` throws in TypeScript too, which is why the port
    // guards the lookup; the guard must not turn the patch back on.
    routes = {
      "POST /wp-json/wp/v2/media": {
        status: 201,
        body: "null",
        content_type: "application/json",
      },
    }
    seen = []
    const client = new WordPressClient(base, "u", "p")
    await expect(
      client.uploadMedia(new Uint8Array([1]), "x.png", "image/png", "alt"),
    ).resolves.toBeNull()
    expect(seen).toHaveLength(1)
  })

  it("keeps a null in an updatePost field where createPost would drop it", async () => {
    routes = {
      "POST /wp-json/wp/v2/posts": {
        status: 201,
        body: JSON.stringify({ id: 1 }),
        content_type: "application/json",
      },
      "POST /wp-json/wp/v2/posts/1": {
        status: 200,
        body: JSON.stringify({ id: 1 }),
        content_type: "application/json",
      },
    }
    seen = []
    const client = new WordPressClient(base, "u", "p")
    await client.createPost({ title: "t", content: "c", featuredMedia: null })
    await client.updatePost(1, { featured_media: null })
    expect(Buffer.from(seen[0].body_b64, "base64").toString()).toBe(
      '{"title":"t","content":"c","status":"publish"}',
    )
    expect(Buffer.from(seen[1].body_b64, "base64").toString()).toBe(
      '{"featured_media":null}',
    )
  })
})
