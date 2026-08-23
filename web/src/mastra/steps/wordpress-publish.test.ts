// @vitest-environment node
/**
 * The WordPress publish hook end to end (ledger item 5.3c-iii-b-1-c-iii).
 *
 * Nothing here is mocked except the clock-free parts that have no boundary:
 * the WordPress site is a Node `http.Server` on a loopback port that records
 * every request it receives, the images are real files on disk under a real
 * `MEDIA_DIR`, the row is a real row in the dev database, and the password is a
 * real Fernet token produced by `../../lib/crypto`.
 *
 * The step is called through `execute()` with a stub transport rather than run
 * on the evented engine, for the same reason `images-generate.test.ts` does:
 * the assertions are about which event the hook chose and what it interpolated,
 * while the topic and the envelope are `pipeline-events.ts`'s contract and are
 * asserted there. Registration is asserted in `../index.test.ts`, because
 * importing that module here would rebind the workflow to an instance whose
 * worker is not running.
 *
 * Requires `docker compose up -d db`.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { closeDb, getDb, posts, websiteProfiles } from "../../db"
import { encryptWithKey } from "../../lib/crypto"
import { wordpressPublishStep } from "./wordpress-publish"

import type { WordPressPublishOutput } from "./wordpress-publish"

const db = getDb()

/** A throwaway Fernet key, so no real `WP_ENCRYPTION_KEY` is needed to run this. */
const TEST_KEY = Buffer.alloc(32, 11).toString("base64url")

const PROFILE_ID = "00000000-0000-4000-8000-0000000000aa"
const OTHER_PROFILE_ID = "00000000-0000-4000-8000-0000000000ab"
/** Configured, but with no `wp_default_status`, so `or "publish"` is reachable. */
const PLAIN_PROFILE_ID = "00000000-0000-4000-8000-0000000000ac"
const POST_CREATE = "00000000-0000-4000-8000-0000000000b1"
const POST_UPDATE = "00000000-0000-4000-8000-0000000000b2"
const POST_NO_PROFILE = "00000000-0000-4000-8000-0000000000b3"
const POST_NO_CREDS = "00000000-0000-4000-8000-0000000000b4"
const POST_BAD_KEY = "00000000-0000-4000-8000-0000000000b5"
const POST_WP_ERROR = "00000000-0000-4000-8000-0000000000b6"
const POST_PLAIN = "00000000-0000-4000-8000-0000000000b7"
const POST_ABSENT = "00000000-0000-4000-8000-0000000000bf"

const ALL_POSTS = [
  POST_CREATE,
  POST_UPDATE,
  POST_NO_PROFILE,
  POST_NO_CREDS,
  POST_BAD_KEY,
  POST_WP_ERROR,
  POST_PLAIN,
  POST_ABSENT,
]

const TITLE = "How Bees Navigate"
const DESCRIPTION = "A field guide to waggle dances."

/**
 * The post body, frontmatter included, because `markdown_to_wp_html` is handed
 * the whole `content` rather than the `body` `_extract_frontmatter` returns.
 * The two image references are what makes the local-to-remote rewrite visible
 * in the request the site receives.
 */
function markdown(postId: string): string {
  return [
    "---",
    `title: ${TITLE}`,
    `description: ${DESCRIPTION}`,
    "---",
    "",
    "Bees navigate by polarised light.",
    "",
    `![](/media/${postId}/a.png)`,
    "",
    `![](/media/${postId}/b.jpg)`,
    "",
  ].join("\n")
}

/** `image_manifest`, with `b.jpg` flagged featured and carrying its own alt text. */
function manifest(postId: string): Record<string, unknown> {
  return {
    images: [
      { url: `/media/${postId}/a.png`, placement: "inline" },
      { url: `/media/${postId}/b.jpg`, placement: "featured", alt_text: "A bee" },
    ],
  }
}

interface Recorded {
  method: string
  url: string
  contentType: string | undefined
  disposition: string | undefined
  body: string
}

let server: Server
let base = ""
let recorded: Recorded[] = []
/** Set for the run that has to see a WordPress error rather than a media id. */
let mediaFails = false
/**
 * The post whose `wp_publish_status` is read from inside the first upload.
 * `publishing` is a transient value that only exists while the hook is talking
 * to WordPress, so the only place to observe it is from the site's own handler.
 */
let probeStatusFor: string | null = null
let statusDuringUpload: string | null | undefined

let mediaRoot = ""
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

type ExecuteParams = Parameters<typeof wordpressPublishStep.execute>[0]

async function publishPost(postId: string): Promise<WordPressPublishOutput> {
  return (await wordpressPublishStep.execute({
    inputData: { postId },
    mastra: stepMastra,
  } as unknown as ExecuteParams)) as WordPressPublishOutput
}

function payloadsOf(event: string): Record<string, unknown>[] {
  return published.filter((entry) => entry.payload.event === event).map((entry) => entry.payload)
}

async function readPost(postId: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, postId))
  return row
}

async function publishLogEntries(postId: string): Promise<Record<string, unknown>[]> {
  const row = await readPost(postId)
  return (row.executionLogs ?? []).filter((entry) =>
    String(entry.event).startsWith("publish_"),
  ) as Record<string, unknown>[]
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

/** Attachment ids, handed out in upload order so the featured pick is observable. */
let nextMediaId = 0

beforeAll(async () => {
  savedEncryptionKey = process.env.WP_ENCRYPTION_KEY
  process.env.WP_ENCRYPTION_KEY = TEST_KEY
  savedMediaDir = process.env.MEDIA_DIR
  mediaRoot = await mkdtemp(path.join(tmpdir(), "wp-publish-"))
  process.env.MEDIA_DIR = mediaRoot

  server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "/"
      recorded.push({
        method: req.method ?? "",
        url,
        contentType: req.headers["content-type"],
        disposition: req.headers["content-disposition"],
        body: await readBody(req),
      })
      const send = (status: number, payload: unknown) => {
        const text = JSON.stringify(payload)
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(text),
        })
        res.end(text)
      }
      if (url.startsWith("/wp-json/wp/v2/media/")) return send(200, { id: 0 })
      if (url === "/wp-json/wp/v2/media") {
        if (probeStatusFor) {
          statusDuringUpload = (await readPost(probeStatusFor)).wpPublishStatus
          probeStatusFor = null
        }
        if (mediaFails) return send(500, { message: "Sorry, you are not allowed to upload." })
        nextMediaId += 1
        const id = 500 + nextMediaId
        return send(201, { id, source_url: `${base}/wp-content/uploads/${id}.bin` })
      }
      if (url.startsWith("/wp-json/wp/v2/posts")) {
        const existing = /\/posts\/(\d+)$/.exec(url)
        const id = existing ? Number(existing[1]) : 900
        return send(existing ? 200 : 201, { id, link: `${base}/?p=${id}` })
      }
      send(404, { message: "no route" })
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  for (const id of ALL_POSTS) await db.delete(posts).where(eq(posts.id, id))
  for (const id of [PROFILE_ID, OTHER_PROFILE_ID, PLAIN_PROFILE_ID]) {
    await db.delete(websiteProfiles).where(eq(websiteProfiles.id, id))
  }

  await db.insert(websiteProfiles).values([
    {
      id: PROFILE_ID,
      name: "wp publish",
      websiteUrl: "http://127.0.0.1:9/wp",
      wpUrl: base,
      wpUsername: "editor",
      wpAppPassword: encryptWithKey("app pass word", TEST_KEY),
      // Not `publish`, so the value the hook forwards is visibly the profile's.
      wpDefaultStatus: "draft",
    },
    {
      id: OTHER_PROFILE_ID,
      name: "wp publish, unconfigured",
      websiteUrl: "http://127.0.0.1:9/wp2",
    },
    {
      id: PLAIN_PROFILE_ID,
      name: "wp publish, no default status",
      websiteUrl: "http://127.0.0.1:9/wp3",
      wpUrl: base,
      wpUsername: "editor",
      wpAppPassword: encryptWithKey("app pass word", TEST_KEY),
      // The column defaults to `publish`, so the null has to be written.
      wpDefaultStatus: null,
    },
  ])

  for (const [postId, profileId] of [
    [POST_CREATE, PROFILE_ID],
    [POST_UPDATE, PROFILE_ID],
    [POST_NO_PROFILE, null],
    [POST_NO_CREDS, OTHER_PROFILE_ID],
    [POST_BAD_KEY, PROFILE_ID],
    [POST_WP_ERROR, PROFILE_ID],
    [POST_PLAIN, PLAIN_PROFILE_ID],
  ] as const) {
    await db.insert(posts).values({
      id: postId,
      profileId,
      slug: `wp-publish-${postId.slice(-2)}`,
      topic: "Topic from the row",
      // `POST_PLAIN` is the row with no `ready_content` and no manifest, so it
      // is what proves the `or` chain and the featured fallback.
      readyContent: postId === POST_PLAIN ? null : markdown(postId),
      // Always present, so `ready_content or final_md_content` is a real choice
      // rather than a null coalesce with nothing on the other side.
      finalMdContent:
        postId === POST_PLAIN
          ? `Bees navigate by polarised light.\n\n![](/media/${postId}/a.png)\n`
          : "SHOULD-NOT-BE-PUBLISHED",
      imageManifest: postId === POST_PLAIN ? null : manifest(postId),
      wpCategoryId: postId === POST_CREATE ? 7 : null,
      wpAuthorId: postId === POST_CREATE ? 3 : null,
      wpPostId: postId === POST_UPDATE ? 42 : null,
    })
    const dir = path.join(mediaRoot, postId)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "a.png"), "png-bytes")
    await writeFile(path.join(dir, "b.jpg"), "jpg-bytes")
    // Neither of these is uploaded: `.txt` is not an image, and `.webp` is
    // absent from the Python 3.12 `mimetypes` table the port reproduces. The
    // second is the production defect recorded in `todo.md`.
    await writeFile(path.join(dir, "c.webp"), "webp-bytes")
    await writeFile(path.join(dir, "notes.txt"), "not an image")
  }

  // A password that is not a Fernet token at all, for the decrypt branch.
  await db
    .update(websiteProfiles)
    .set({ wpAppPassword: encryptWithKey("app pass word", TEST_KEY) })
    .where(eq(websiteProfiles.id, PROFILE_ID))
}, 60_000)

afterAll(async () => {
  for (const id of ALL_POSTS) await db.delete(posts).where(eq(posts.id, id))
  for (const id of [PROFILE_ID, OTHER_PROFILE_ID, PLAIN_PROFILE_ID]) {
    await db.delete(websiteProfiles).where(eq(websiteProfiles.id, id))
  }
  await closeDb()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  await rm(mediaRoot, { recursive: true, force: true })
  if (savedEncryptionKey === undefined) delete process.env.WP_ENCRYPTION_KEY
  else process.env.WP_ENCRYPTION_KEY = savedEncryptionKey
  if (savedMediaDir === undefined) delete process.env.MEDIA_DIR
  else process.env.MEDIA_DIR = savedMediaDir
})

describe("a post published for the first time", () => {
  let output: WordPressPublishOutput

  beforeAll(async () => {
    recorded = []
    published.length = 0
    logged.length = 0
    probeStatusFor = POST_CREATE
    output = await publishPost(POST_CREATE)
  }, 60_000)

  it("reports the created WordPress post and the uploads it made", () => {
    expect(output).toEqual({
      postId: POST_CREATE,
      status: "published",
      wpPostId: 900,
      wpPostUrl: `${base}/?p=900`,
      uploaded: 2,
      error: null,
    })
  })

  it("uploads the two images in sorted name order and nothing else", () => {
    expect(recorded.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "POST /wp-json/wp/v2/media",
      "POST /wp-json/wp/v2/media/501",
      "POST /wp-json/wp/v2/media",
      "POST /wp-json/wp/v2/media/502",
      "POST /wp-json/wp/v2/posts",
    ])
    expect(recorded[0].disposition).toBe('attachment; filename="a.png"')
    expect(recorded[0].contentType).toBe("image/png")
    expect(recorded[2].disposition).toBe('attachment; filename="b.jpg"')
    expect(recorded[2].contentType).toBe("image/jpeg")
  })

  /**
   * `img_info.get("alt_text", title)`: the entry that carries alt text sends
   * it, and the entry that does not falls back to the frontmatter title rather
   * than to `posts.topic`.
   */
  it("sends the manifest alt text, falling back to the frontmatter title", () => {
    expect(JSON.parse(recorded[1].body)).toEqual({ alt_text: TITLE })
    expect(JSON.parse(recorded[3].body)).toEqual({ alt_text: "A bee" })
  })

  it("creates the post with the frontmatter title, the profile status and the row's ids", () => {
    const body = JSON.parse(recorded[4].body) as Record<string, unknown>
    expect(Object.keys(body)).toEqual([
      "title",
      "content",
      "status",
      "categories",
      "author",
      "featured_media",
      "excerpt",
    ])
    expect(body.title).toBe(TITLE)
    expect(body.status).toBe("draft")
    expect(body.categories).toEqual([7])
    expect(body.author).toBe(3)
    // `b.jpg` is the manifest's featured entry, so the second upload wins even
    // though the first one arrived earlier.
    expect(body.featured_media).toBe(502)
    expect(body.excerpt).toBe(DESCRIPTION)
  })

  it("publishes ready_content, not final_md_content", () => {
    const body = JSON.parse(recorded[4].body) as { content: string }
    expect(body.content).not.toContain("SHOULD-NOT-BE-PUBLISHED")
  })

  it("rewrites every local media URL to the uploaded attachment's URL", () => {
    const body = JSON.parse(recorded[4].body) as { content: string }
    expect(body.content).toContain(`${base}/wp-content/uploads/501.bin`)
    expect(body.content).toContain(`${base}/wp-content/uploads/502.bin`)
    expect(body.content).not.toContain(`/media/${POST_CREATE}/`)
    // The frontmatter is stripped by `markdown_to_wp_html`, not by the hook.
    expect(body.content).not.toContain("description:")
  })

  it("moves the row to publishing before it touches WordPress", () => {
    expect(statusDuringUpload).toBe("publishing")
  })

  it("leaves the row published with the created post's id and link", async () => {
    const row = await readPost(POST_CREATE)
    expect(row.wpPublishStatus).toBe("published")
    expect(row.wpPostId).toBe(900)
    expect(row.wpPostUrl).toBe(`${base}/?p=900`)
  })

  it("writes one publish_complete entry to the row's own trail", async () => {
    const entries = await publishLogEntries(POST_CREATE)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      stage: "",
      level: "info",
      event: "publish_complete",
      message: `Published to WordPress: ${base}/?p=900`,
    })
  })

  it("publishes publish_start before the uploads and publish_complete after", () => {
    expect(published.map((entry) => entry.payload.event)).toEqual([
      "publish_start",
      "publish_complete",
    ])
    expect(payloadsOf("publish_start")[0]).toEqual({
      event: "publish_start",
      post_id: POST_CREATE,
      message: "Publishing to WordPress...",
    })
    expect(payloadsOf("publish_complete")[0]).toEqual({
      event: "publish_complete",
      post_id: POST_CREATE,
      wp_post_url: `${base}/?p=900`,
      wp_post_id: 900,
    })
  })
})

/**
 * The `if post.wp_post_id:` arm. `update_post` forwards its keyword arguments
 * with no filtering at all, so the three values `create_post` would have
 * dropped as falsy are sent as `[]` and two nulls.
 */
describe("a post that already exists on WordPress", () => {
  let output: WordPressPublishOutput

  beforeAll(async () => {
    recorded = []
    published.length = 0
    output = await publishPost(POST_UPDATE)
  }, 60_000)

  it("posts to the existing attachment's id rather than to the collection", () => {
    expect(recorded.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "POST /wp-json/wp/v2/media",
      "POST /wp-json/wp/v2/media/503",
      "POST /wp-json/wp/v2/media",
      "POST /wp-json/wp/v2/media/504",
      "POST /wp-json/wp/v2/posts/42",
    ])
  })

  it("sends the falsy fields rather than dropping them", () => {
    const body = JSON.parse(recorded[4].body) as Record<string, unknown>
    expect(body.categories).toEqual([])
    expect(body.author).toBeNull()
    expect(body.featured_media).toBe(504)
    expect(body.status).toBe("draft")
  })

  it("keeps the id WordPress echoed back", async () => {
    expect(output.wpPostId).toBe(42)
    expect((await readPost(POST_UPDATE)).wpPostId).toBe(42)
  })
})

/**
 * The row that takes the other side of every `or` in the hook: no
 * `ready_content`, so the body comes from `final_md_content`; no frontmatter,
 * so the title falls back to `posts.topic` and the excerpt to `""`; no
 * manifest, so the featured image falls back to the first upload; and a profile
 * with no `wp_default_status`, so the status falls back to `publish`.
 */
describe("a post with nothing configured", () => {
  let output: WordPressPublishOutput

  beforeAll(async () => {
    recorded = []
    published.length = 0
    output = await publishPost(POST_PLAIN)
  }, 60_000)

  it("publishes final_md_content when there is no ready_content", () => {
    expect(output.status).toBe("published")
    const body = JSON.parse(recorded[4].body) as { content: string }
    expect(body.content).toContain("Bees navigate by polarised light.")
  })

  it("titles the post from posts.topic and sends no excerpt", () => {
    const body = JSON.parse(recorded[4].body) as Record<string, unknown>
    expect(body.title).toBe("Topic from the row")
    // `create_post` drops the four falsy fields, so an empty description, a
    // null category list and a null author never reach the wire.
    expect(Object.keys(body)).toEqual(["title", "content", "status", "featured_media"])
  })

  it("falls back to publish when the profile names no default status", () => {
    expect((JSON.parse(recorded[4].body) as { status: string }).status).toBe("publish")
  })

  it("makes the first upload featured when the manifest names none", () => {
    const uploads = recorded.filter((entry) => entry.url === "/wp-json/wp/v2/media")
    expect(uploads).toHaveLength(2)
    const body = JSON.parse(recorded[4].body) as { featured_media: number }
    // Two files are uploaded and the earlier one wins, which is the only thing
    // separating the fallback from "the last upload" or "the featured entry".
    expect(body.featured_media).toBe(505)
  })

  it("uses posts.topic as the alt text of every upload", () => {
    expect(JSON.parse(recorded[1].body)).toEqual({ alt_text: "Topic from the row" })
  })
})

describe("the guards, none of which reaches WordPress", () => {
  // Each of these is a whole run of its own, so the recordings are cleared per
  // test rather than per describe.
  beforeEach(() => {
    recorded = []
    published.length = 0
    logged.length = 0
  })

  it("does nothing at all for a post that does not exist", async () => {
    const output = await publishPost(POST_ABSENT)
    expect(output).toEqual({
      postId: POST_ABSENT,
      status: "missing",
      wpPostId: null,
      wpPostUrl: null,
      uploaded: 0,
      error: null,
    })
    expect(published).toEqual([])
    expect(recorded).toEqual([])
    expect(logged).toEqual([
      { level: "error", message: `Post ${POST_ABSENT} not found for WP publish` },
    ])
  })

  it.each([
    [POST_NO_PROFILE, "No profile linked to post"],
    [POST_NO_CREDS, "WordPress credentials not configured"],
  ])("fails %s with %s", async (postId, error) => {
    const output = await publishPost(postId)
    expect(output).toEqual({
      postId,
      status: "failed",
      wpPostId: null,
      wpPostUrl: null,
      uploaded: 0,
      error,
    })
    expect(recorded).toEqual([])
    expect((await readPost(postId)).wpPublishStatus).toBe("failed")
    expect(await publishLogEntries(postId)).toEqual([
      expect.objectContaining({
        stage: "",
        level: "error",
        event: "publish_error",
        message: `WordPress publish failed: ${error}`,
      }),
    ])
    // No `publish_start`: the guards run before the row is moved to
    // `publishing`, so the dashboard never sees a publish begin.
    expect(published.map((entry) => entry.payload.event)).toEqual(["publish_error"])
    expect(payloadsOf("publish_error")[0]).toEqual({
      event: "publish_error",
      post_id: postId,
      error,
      message: `Publish failed: ${error}`,
    })
  })

  /**
   * `if not profile.wp_url or not profile.wp_username or not
   * profile.wp_app_password`. `POST_NO_CREDS` above has none of the three, so
   * each column is knocked out on its own here.
   */
  it.each([
    ["wp_username", { wpUsername: null }, { wpUsername: "editor" }],
    ["wp_app_password", { wpAppPassword: null }, { wpAppPassword: "restore" }],
  ] as const)("treats a profile missing %s as unconfigured", async (_column, cleared, restored) => {
    await db.update(websiteProfiles).set(cleared).where(eq(websiteProfiles.id, PROFILE_ID))
    try {
      const output = await publishPost(POST_BAD_KEY)
      expect(output.error).toBe("WordPress credentials not configured")
      expect(recorded).toEqual([])
    } finally {
      await db
        .update(websiteProfiles)
        .set(
          "wpAppPassword" in restored
            ? { wpAppPassword: encryptWithKey("app pass word", TEST_KEY) }
            : restored,
        )
        .where(eq(websiteProfiles.id, PROFILE_ID))
    }
  })

  it("fails a password that is not a Fernet token", async () => {
    await db
      .update(websiteProfiles)
      .set({ wpAppPassword: "not-a-token" })
      .where(eq(websiteProfiles.id, PROFILE_ID))
    try {
      const output = await publishPost(POST_BAD_KEY)
      expect(output.error).toBe("Failed to decrypt WP app password")
      expect(recorded).toEqual([])
      expect((await readPost(POST_BAD_KEY)).wpPublishStatus).toBe("failed")
    } finally {
      await db
        .update(websiteProfiles)
        .set({ wpAppPassword: encryptWithKey("app pass word", TEST_KEY) })
        .where(eq(websiteProfiles.id, PROFILE_ID))
    }
  })
})

/**
 * `except WordPressError as e: await _fail(..., str(e))`. The failure happens
 * after the row has already moved to `publishing` and after `publish_start`
 * went out, which is the sequence the dashboard has to cope with.
 */
describe("a WordPress that refuses the upload", () => {
  let output: WordPressPublishOutput

  beforeAll(async () => {
    recorded = []
    published.length = 0
    mediaFails = true
    try {
      output = await publishPost(POST_WP_ERROR)
    } finally {
      mediaFails = false
    }
  }, 60_000)

  it("records the site's own message", () => {
    expect(output.status).toBe("failed")
    expect(output.error).toBe("WordPress API error: Sorry, you are not allowed to upload.")
  })

  it("stops at the first refused upload and never creates the post", () => {
    expect(recorded.map((entry) => entry.url)).toEqual(["/wp-json/wp/v2/media"])
  })

  it("moves the row to publishing and then to failed", async () => {
    expect((await readPost(POST_WP_ERROR)).wpPublishStatus).toBe("failed")
  })

  it("publishes publish_start and then publish_error", () => {
    expect(published.map((entry) => entry.payload.event)).toEqual([
      "publish_start",
      "publish_error",
    ])
  })
})
