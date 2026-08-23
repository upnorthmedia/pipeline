// @vitest-environment node
/**
 * The Next.js publish hook end to end (ledger item 5.3c-iii-b-2-d).
 *
 * Nothing here is mocked. The receiving blog is a Node `http.Server` on a
 * loopback port that records every request it gets, the images are real files
 * on disk under a real `MEDIA_DIR`, the rows are real rows in the dev database,
 * the secret is a real Fernet token produced by `../../lib/crypto`, and the
 * signature is recomputed from the bytes the server received rather than from
 * the bytes the step thought it sent.
 *
 * The step is called through `execute()` with a stub transport rather than run
 * on the evented engine, for the reason `./wordpress-publish.test.ts` gives:
 * the assertions are about which event the hook chose and what it interpolated,
 * while the topic and the envelope are `pipeline-events.ts`'s contract and are
 * asserted there. Registration is asserted in `../index.test.ts`.
 *
 * Requires `docker compose up -d db`.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, posts, websiteProfiles } from "../../db"
import { encryptWithKey } from "../../lib/crypto"
import { signPayload } from "../../lib/hmac-signing"
import {
  NO_PROFILE_MESSAGE,
  NOT_CONFIGURED_MESSAGE,
  nextjsPublishStep,
  sliceCodePoints,
} from "./nextjs-publish"

import type { NextjsPublishOutput } from "./nextjs-publish"

const db = getDb()

/** A throwaway Fernet key, so no real `WP_ENCRYPTION_KEY` is needed to run this. */
const TEST_KEY = Buffer.alloc(32, 23).toString("base64url")
const SECRET = "webhook-shared-secret"

const PROFILE_ID = "00000000-0000-4000-8000-0000000000ca"
const BARE_PROFILE_ID = "00000000-0000-4000-8000-0000000000cb"
/** Configured, but pointed at a port nothing is listening on. */
const DEAD_PROFILE_ID = "00000000-0000-4000-8000-0000000000cc"
/** Configured, but its secret is not a Fernet token. */
const BAD_SECRET_PROFILE_ID = "00000000-0000-4000-8000-0000000000cd"
/** Configured, and carrying a frontmatter mapping. */
const MAPPED_PROFILE_ID = "00000000-0000-4000-8000-0000000000ce"

const POST_OK = "00000000-0000-4000-8000-0000000000d1"
const POST_MAPPED = "00000000-0000-4000-8000-0000000000d2"
const POST_NO_PROFILE = "00000000-0000-4000-8000-0000000000d3"
const POST_UNCONFIGURED = "00000000-0000-4000-8000-0000000000d4"
const POST_BAD_SECRET = "00000000-0000-4000-8000-0000000000d5"
const POST_REJECTED = "00000000-0000-4000-8000-0000000000d6"
const POST_UNREACHABLE = "00000000-0000-4000-8000-0000000000d7"
const POST_BAD_MANIFEST = "00000000-0000-4000-8000-0000000000d8"
const POST_ABSENT = "00000000-0000-4000-8000-0000000000df"

const ALL_POSTS = [
  POST_OK,
  POST_MAPPED,
  POST_NO_PROFILE,
  POST_UNCONFIGURED,
  POST_BAD_SECRET,
  POST_REJECTED,
  POST_UNREACHABLE,
  POST_BAD_MANIFEST,
  POST_ABSENT,
]

const ALL_PROFILES = [
  PROFILE_ID,
  BARE_PROFILE_ID,
  DEAD_PROFILE_ID,
  BAD_SECRET_PROFILE_ID,
  MAPPED_PROFILE_ID,
]

/** The bytes written into every post's `featured.webp`, so the base64 is checkable. */
const IMAGE_BYTES = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x10])

function markdown(postId: string): string {
  return [
    "---",
    "title: Bees",
    "summary: A field guide.",
    "---",
    "",
    `![](/media/${postId}/featured.webp)`,
    "",
  ].join("\n")
}

function manifest(postId: string): Record<string, unknown> {
  return {
    images: [
      { url: `/media/${postId}/featured.webp`, placement: "featured", alt_text: "A bee" },
      // No file on disk under this name, so the `"data": null` branch is live.
      { url: `/media/${postId}/missing.webp`, placement: "inline" },
      // Falsy url: skipped before any filesystem access.
      { url: "", placement: "inline" },
    ],
  }
}

interface Recorded {
  method: string
  url: string
  contentType: string | undefined
  signature: string | undefined
  body: string
}

let server: Server
let base = ""
let recorded: Recorded[] = []
/**
 * How the next request is answered. `200` is the success path; anything else
 * is the non-200 branch, answered with `rejectionBody`.
 */
let responseStatus = 200
let rejectionBody = ""
/**
 * The post whose `nextjs_publish_status` is read from inside the handler.
 * `publishing` only exists while the webhook is in flight, so the receiving
 * server is the only place it can be observed.
 */
let probeStatusFor: string | null = null
let statusDuringRequest: string | null | undefined

let mediaRootDir = ""
let savedEncryptionKey: string | undefined
let savedMediaDir: string | undefined

const published: { topic: string; payload: Record<string, unknown> }[] = []
const logged: { level: string; message: string }[] = []

const stepMastra = {
  pubsub: {
    publish: async (topic: string, event: { data: Record<string, unknown> }) => {
      published.push({ topic, payload: event.data })
    },
  },
  getLogger: () => ({
    info: (message: string) => logged.push({ level: "info", message }),
    error: (message: string) => logged.push({ level: "error", message }),
  }),
}

type ExecuteParams = Parameters<typeof nextjsPublishStep.execute>[0]

/**
 * Clear what the last publish recorded. Called explicitly rather than from a
 * `beforeEach`, because the success case runs once in a `beforeAll` and then
 * asserts across several `it`s: a `beforeEach` would wipe the recording between
 * the assertions about it.
 */
function reset(): void {
  recorded = []
  published.length = 0
  logged.length = 0
  responseStatus = 200
  rejectionBody = ""
}

async function publishPost(postId: string): Promise<NextjsPublishOutput> {
  return (await nextjsPublishStep.execute({
    inputData: { postId },
    mastra: stepMastra,
  } as unknown as ExecuteParams)) as NextjsPublishOutput
}

function payloadsOf(event: string): Record<string, unknown>[] {
  return published.filter((entry) => entry.payload.event === event).map((entry) => entry.payload)
}

async function readPost(postId: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, postId))
  return row
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

beforeAll(async () => {
  savedEncryptionKey = process.env.WP_ENCRYPTION_KEY
  process.env.WP_ENCRYPTION_KEY = TEST_KEY
  savedMediaDir = process.env.MEDIA_DIR
  mediaRootDir = await mkdtemp(path.join(tmpdir(), "nextjs-publish-"))
  process.env.MEDIA_DIR = mediaRootDir

  server = createServer((req, res) => {
    void (async () => {
      recorded.push({
        method: req.method ?? "",
        url: req.url ?? "/",
        contentType: req.headers["content-type"],
        signature: req.headers["x-jena-signature"] as string | undefined,
        body: await readBody(req),
      })
      if (probeStatusFor) {
        statusDuringRequest = (await readPost(probeStatusFor)).nextjsPublishStatus
        probeStatusFor = null
      }
      const body = responseStatus === 200 ? '{"ok":true}' : rejectionBody
      res.writeHead(responseStatus, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      })
      res.end(body)
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  for (const id of ALL_POSTS) await db.delete(posts).where(eq(posts.id, id))
  for (const id of ALL_PROFILES) await db.delete(websiteProfiles).where(eq(websiteProfiles.id, id))

  await db.insert(websiteProfiles).values([
    {
      id: PROFILE_ID,
      name: "nextjs publish",
      websiteUrl: "http://127.0.0.1:9/blog",
      nextjsWebhookUrl: `${base}/api/jena/webhook`,
      nextjsWebhookSecret: encryptWithKey(SECRET, TEST_KEY),
    },
    {
      id: BARE_PROFILE_ID,
      name: "nextjs publish, unconfigured",
      websiteUrl: "http://127.0.0.1:9/blog2",
      // A cleared field in the profile form saves `""`, not null, which is why
      // the guard is truthiness rather than a null check.
      nextjsWebhookUrl: "",
      nextjsWebhookSecret: encryptWithKey(SECRET, TEST_KEY),
    },
    {
      id: DEAD_PROFILE_ID,
      name: "nextjs publish, unreachable",
      websiteUrl: "http://127.0.0.1:9/blog3",
      // Port 9 is `discard`; nothing in this repo listens there.
      nextjsWebhookUrl: "http://127.0.0.1:9/api/jena/webhook",
      nextjsWebhookSecret: encryptWithKey(SECRET, TEST_KEY),
    },
    {
      id: BAD_SECRET_PROFILE_ID,
      name: "nextjs publish, corrupt secret",
      websiteUrl: "http://127.0.0.1:9/blog4",
      nextjsWebhookUrl: `${base}/api/jena/webhook`,
      nextjsWebhookSecret: "not-a-fernet-token",
    },
    {
      id: MAPPED_PROFILE_ID,
      name: "nextjs publish, mapped frontmatter",
      websiteUrl: "http://127.0.0.1:9/blog5",
      nextjsWebhookUrl: `${base}/api/jena/webhook`,
      nextjsWebhookSecret: encryptWithKey(SECRET, TEST_KEY),
      // A plain rename and a dict-shaped target with a default, which is the
      // shape `schema.ts` used to type as `Record<string, string>`.
      nextjsFrontmatterMap: {
        title: "heading",
        summary: { key: "description" },
        author: { key: "author", default: "Staff" },
      },
    },
  ])

  for (const [postId, profileId] of [
    [POST_OK, PROFILE_ID],
    [POST_MAPPED, MAPPED_PROFILE_ID],
    [POST_NO_PROFILE, null],
    [POST_UNCONFIGURED, BARE_PROFILE_ID],
    [POST_BAD_SECRET, BAD_SECRET_PROFILE_ID],
    [POST_REJECTED, PROFILE_ID],
    [POST_UNREACHABLE, DEAD_PROFILE_ID],
    [POST_BAD_MANIFEST, PROFILE_ID],
  ] as const) {
    await db.insert(posts).values({
      id: postId,
      profileId,
      slug: `nextjs-publish-${postId.slice(-2)}`,
      topic: "Topic from the row",
      readyContent: markdown(postId),
      // Always present, so `ready_content or final_md_content` is a real choice.
      finalMdContent: "SHOULD-NOT-BE-PUBLISHED",
      imageManifest:
        postId === POST_BAD_MANIFEST
          ? // `img.get` against an int: `AttributeError` out of the payload
            // build, which Python did not catch.
            { images: [42] }
          : manifest(postId),
    })
    const dir = path.join(mediaRootDir, postId)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "featured.webp"), IMAGE_BYTES)
  }
}, 60_000)

afterAll(async () => {
  for (const id of ALL_POSTS) await db.delete(posts).where(eq(posts.id, id))
  for (const id of ALL_PROFILES) await db.delete(websiteProfiles).where(eq(websiteProfiles.id, id))
  await closeDb()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  await rm(mediaRootDir, { recursive: true, force: true })
  if (savedEncryptionKey === undefined) delete process.env.WP_ENCRYPTION_KEY
  else process.env.WP_ENCRYPTION_KEY = savedEncryptionKey
  if (savedMediaDir === undefined) delete process.env.MEDIA_DIR
  else process.env.MEDIA_DIR = savedMediaDir
})

describe("a post the blog accepts", () => {
  let output: NextjsPublishOutput
  let body: Record<string, unknown>

  beforeAll(async () => {
    reset()
    probeStatusFor = POST_OK
    output = await publishPost(POST_OK)
    body = JSON.parse(recorded[0].body) as Record<string, unknown>
  }, 60_000)

  it("reports the publish and stamps the row", async () => {
    expect(output.postId).toBe(POST_OK)
    expect(output.status).toBe("published")
    expect(output.error).toBeNull()

    const row = await readPost(POST_OK)
    expect(row.nextjsPublishStatus).toBe("published")
    expect(row.nextjsPublishedAt).toEqual(output.publishedAt)
  })

  it("sends one signed POST to the profile's webhook URL", () => {
    expect(recorded).toHaveLength(1)
    expect(recorded[0].method).toBe("POST")
    expect(recorded[0].url).toBe("/api/jena/webhook")
    expect(recorded[0].contentType).toBe("application/json")
    // Recomputed from the bytes the server received, which is exactly what
    // `packages/create-mdx-blog` does with them.
    expect(recorded[0].signature).toBe(signPayload(recorded[0].body, SECRET))
  })

  it("sends the seven-key body in Python's key order", () => {
    expect(Object.keys(body)).toEqual([
      "event",
      "post_id",
      "delivery_id",
      "slug",
      "content",
      "images",
      "timestamp",
    ])
    expect(body.event).toBe("post.published")
    expect(body.post_id).toBe(POST_OK)
    expect(body.slug).toBe(`nextjs-publish-${POST_OK.slice(-2)}`)
    expect(body.delivery_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{6})?\+00:00$/)
  })

  it("publishes ready_content, not final_md_content", () => {
    expect(body.content).toBe(markdown(POST_OK))
  })

  it("base64-encodes the file on disk and records null for the one that is absent", () => {
    expect(body.images).toEqual([
      {
        filename: "featured.webp",
        public_path: `/media/${POST_OK}/featured.webp`,
        alt: "A bee",
        placement: "featured",
        data: IMAGE_BYTES.toString("base64"),
      },
      {
        filename: "missing.webp",
        public_path: `/media/${POST_OK}/missing.webp`,
        alt: "",
        placement: "inline",
        data: null,
      },
    ])
    expect(logged).toContainEqual({
      level: "error",
      message: `Image file not found: ${mediaRootDir}/${POST_OK}/missing.webp`,
    })
  })

  it("moves the row to publishing before it sends the webhook", () => {
    expect(statusDuringRequest).toBe("publishing")
  })

  it("announces the start and the completion with the nextjs target and nothing else", () => {
    expect(payloadsOf("publish_start")).toEqual([
      { event: "publish_start", post_id: POST_OK, target: "nextjs" },
    ])
    expect(payloadsOf("publish_complete")).toEqual([
      { event: "publish_complete", post_id: POST_OK, target: "nextjs" },
    ])
    expect(payloadsOf("publish_error")).toEqual([])
  })

  /**
   * Python's `_fail` and its success branch both write the column and the bus
   * and nothing else. The WordPress hook's write an `execution_logs` entry;
   * this one must not, or `GET /posts/{id}/logs` grows a line Python never had.
   */
  it("writes no execution log entry", async () => {
    const row = await readPost(POST_OK)
    expect(row.executionLogs ?? []).toEqual([])
  })
})

describe("a profile with a frontmatter mapping", () => {
  it("rewrites the frontmatter block before signing", async () => {
    reset()
    await publishPost(POST_MAPPED)
    const body = JSON.parse(recorded[0].body) as { content: string }
    // `yaml.dump(..., default_flow_style=False)` with `sort_keys=True`, which
    // is why `author` comes first and `heading` last.
    expect(body.content).toBe(
      [
        "---",
        "author: Staff",
        "description: A field guide.",
        "heading: Bees",
        "---",
        "",
        `![](/media/${POST_MAPPED}/featured.webp)`,
        "",
      ].join("\n"),
    )
  })
})

describe("the guards", () => {
  it("returns missing and touches nothing when the post is gone", async () => {
    reset()
    const output = await publishPost(POST_ABSENT)
    expect(output).toEqual({
      postId: POST_ABSENT,
      status: "missing",
      publishedAt: null,
      error: null,
    })
    expect(published).toEqual([])
    expect(recorded).toEqual([])
    expect(logged).toEqual([
      { level: "error", message: `Post ${POST_ABSENT} not found for Next.js publish` },
    ])
  })

  /**
   * The two guard messages are asserted as literals as well as through the
   * exported constants: the constants are what the route handler and the
   * dashboard read, so an assertion against them alone moves with any edit to
   * the copy, and this copy is Python's, verbatim.
   */
  it("fails with the assign-a-profile copy when no profile is linked", async () => {
    reset()
    const output = await publishPost(POST_NO_PROFILE)
    expect(output.status).toBe("failed")
    expect(output.error).toBe(NO_PROFILE_MESSAGE)
    expect(output.error).toBe("No profile linked to this post. Assign a profile first.")
    expect((await readPost(POST_NO_PROFILE)).nextjsPublishStatus).toBe("failed")
    // The failure precedes the `publishing` write, so no start was announced.
    expect(payloadsOf("publish_start")).toEqual([])
    expect(payloadsOf("publish_error")).toEqual([
      {
        event: "publish_error",
        post_id: POST_NO_PROFILE,
        error: NO_PROFILE_MESSAGE,
        target: "nextjs",
      },
    ])
    expect(recorded).toEqual([])
  })

  it("fails with the configuration copy when the webhook URL is blank", async () => {
    reset()
    const output = await publishPost(POST_UNCONFIGURED)
    expect(output.status).toBe("failed")
    expect(output.error).toBe(NOT_CONFIGURED_MESSAGE)
    expect(output.error).toBe(
      "Next.js webhook not configured. Go to Profiles, select this post's profile, " +
        "and add a Webhook URL and Secret in the Next.js Integration section.",
    )
    expect((await readPost(POST_UNCONFIGURED)).nextjsPublishStatus).toBe("failed")
    expect(recorded).toEqual([])
  })

  it("fails when the stored secret is not a Fernet token", async () => {
    reset()
    const output = await publishPost(POST_BAD_SECRET)
    expect(output.status).toBe("failed")
    expect(output.error).toBe("Failed to decrypt webhook secret")
    expect((await readPost(POST_BAD_SECRET)).nextjsPublishStatus).toBe("failed")
    expect(recorded).toEqual([])
  })

  /**
   * `_fail` in `nextjs_publish.py` logs, writes the column and publishes the
   * event. Its WordPress namesake also appends to `execution_logs`; copying
   * that here would put an entry in `GET /posts/{id}/logs` Python never wrote.
   */
  it("writes no execution log entry on the failure path either", async () => {
    for (const postId of [POST_NO_PROFILE, POST_UNCONFIGURED, POST_BAD_SECRET]) {
      expect((await readPost(postId)).executionLogs ?? []).toEqual([])
    }
  })
})

describe("a blog that refuses the delivery", () => {
  it("records the status code and the first 200 code points of the body", async () => {
    // 260 characters, so the slice is visible, and led by an astral character
    // so a UTF-16 slice would keep one fewer of them.
    reset()
    rejectionBody = `\u{1f41d}${"e".repeat(259)}`
    responseStatus = 500
    const output = await publishPost(POST_REJECTED)

    expect(output.status).toBe("failed")
    expect(output.error).toBe(`Webhook returned 500: \u{1f41d}${"e".repeat(199)}`)
    // The naive slice keeps 199 characters plus half a surrogate pair.
    expect(output.error).not.toBe(`Webhook returned 500: ${rejectionBody.slice(0, 200)}`)
    expect((await readPost(POST_REJECTED)).nextjsPublishStatus).toBe("failed")
    // The start was announced before the request went out, so both events fire.
    expect(payloadsOf("publish_start")).toHaveLength(1)
    expect(payloadsOf("publish_error")).toEqual([
      {
        event: "publish_error",
        post_id: POST_REJECTED,
        error: output.error,
        target: "nextjs",
      },
    ])
  })

  /**
   * `if response.status_code == 200`, not `< 300`: a receiver that answers
   * `201 Created` or `204 No Content` fails the publish. The check is exact
   * because Python's was, and a receiver that started answering 201 would
   * otherwise silently change from failing to succeeding.
   */
  it("treats a 201 as a refusal", async () => {
    reset()
    responseStatus = 201
    rejectionBody = '{"ok":true}'
    const output = await publishPost(POST_REJECTED)
    expect(output.status).toBe("failed")
    expect(output.error).toBe('Webhook returned 201: {"ok":true}')
    expect((await readPost(POST_REJECTED)).nextjsPublishStatus).toBe("failed")
  })

  it("leaves a body shorter than the limit whole", () => {
    expect(sliceCodePoints("short", 200)).toBe("short")
    expect(sliceCodePoints("", 200)).toBe("")
  })
})

describe("a blog that is not listening", () => {
  it("records a request failure without a status code", async () => {
    reset()
    const output = await publishPost(POST_UNREACHABLE)
    expect(output.status).toBe("failed")
    // The tail is Node's, not `httpx`'s; the prefix is the contract.
    expect(output.error).toMatch(/^Webhook request failed: /)
    expect((await readPost(POST_UNREACHABLE)).nextjsPublishStatus).toBe("failed")
    expect(payloadsOf("publish_error")).toHaveLength(1)
  })
})

describe("a manifest the payload build cannot walk", () => {
  /**
   * Python left the payload build outside its `try`, so this propagated out of
   * the job: ARQ retried and the row stayed on `publishing`. Reproduced by
   * letting the exception leave the step.
   */
  it("throws, leaving the row publishing and no failure announced", async () => {
    reset()
    await expect(publishPost(POST_BAD_MANIFEST)).rejects.toThrow(
      "'int' object has no attribute 'get'",
    )
    expect((await readPost(POST_BAD_MANIFEST)).nextjsPublishStatus).toBe("publishing")
    expect(payloadsOf("publish_start")).toHaveLength(1)
    expect(payloadsOf("publish_error")).toEqual([])
    expect(recorded).toEqual([])
  })
})
