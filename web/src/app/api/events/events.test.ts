// @vitest-environment node
/**
 * The two SSE streams the dashboard's `useSSE()` hook opens: `/api/events/{post_id}`
 * for one post, and `/api/events` for the queue-wide feed.
 *
 * The tests run against the real database, real BetterAuth sessions and the
 * real Redis Streams topic. Every event they assert on is published by a
 * separate `RedisStreamsPubSub` client, so a frame that reaches the response
 * body provably travelled through Redis rather than through an in-process
 * emitter: that is the property the `web` / `worker` split depends on, since
 * the process serving the stream is not the one executing the run.
 *
 * The assertions are on the raw `text/event-stream` bytes rather than on a
 * parsed object, because the framing is what `EventSource` parses and this port
 * writes those bytes itself where `sse_starlette` used to.
 *
 * Requires `docker compose up -d db redis`.
 */
import { randomUUID } from "node:crypto"

import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { eq, like } from "drizzle-orm"
import { createClient } from "redis"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, posts, websiteProfiles } from "@/db"
import { TOPIC_PIPELINE_EVENTS, publishPipelineEvent } from "@/mastra/pipeline-events"
import { ABSENT_POST_ID } from "@/test/absent-ids"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET as postEvents } from "./[post_id]/route"
import { GET as globalEvents } from "./route"
import { anchorPosition, eventAnchor, parseAnchor, requestAnchor } from "./anchor"
import { SSE_SEPARATOR, encodeSseEvent, encodeSsePing } from "./sse"

const PREFIX = "events-sse-test-"
const URL_BASE = "http://test/api/events"
const MISSING_ID = ABSENT_POST_ID

/**
 * How long a replaying connection is given to produce its first frame.
 *
 * A replay reads the retained stream from the beginning, because the transport
 * exposes no seekable position, so the wait is proportional to how many entries
 * the shared topic is holding rather than to how far back the anchor is. This
 * is the same 10s every other wait uses, restated where the reason differs.
 */
const REPLAY_TIMEOUT_MS = 10_000

/** Discard port on loopback: nothing here should ever reach a real site. */
const SITE = "http://127.0.0.1:9/site"

/** The stream the app's own transport writes to, at its default key prefix. */
const STREAM_KEY = `mastra:topic:${TOPIC_PIPELINE_EVENTS}`

const db = getDb()

/** A second client, so a delivered frame crossed a real Redis connection. */
const publisher = new RedisStreamsPubSub({ url: process.env.REDIS_URL! })

/** Raw Redis, for the consumer-group bookkeeping the transport does per subscription. */
const raw = createClient({ url: process.env.REDIS_URL! })

let user: TestSession
let other: TestSession

/** Every connection opened by a test, torn down after it. */
const open: { abort: AbortController; drained: Promise<void> }[] = []

async function insertProfile(userId: string) {
  const [row] = await db
    .insert(websiteProfiles)
    .values({ userId, name: "Test Blog", websiteUrl: SITE })
    .returning()
  return row
}

async function insertPost(
  userId: string,
  values: Partial<typeof posts.$inferInsert> = {},
): Promise<typeof posts.$inferSelect> {
  const profile = await insertProfile(userId)
  const [row] = await db
    .insert(posts)
    .values({
      slug: `${PREFIX}${randomUUID()}`,
      topic: "A topic",
      profileId: profile.id,
      ...values,
    })
    .returning()
  return row
}

/**
 * Where a reconnecting client puts the anchor it is resuming from.
 *
 * Both are real paths: `header` is what a browser sends when it reconnects an
 * `EventSource` object itself, `param` is what `useSSE()` will send, because it
 * builds a new `EventSource` on every retry and a fresh one has no
 * `Last-Event-ID` to send.
 */
interface Anchored {
  header?: string
  param?: string
}

/** The request one connection is opened with, anchor included. */
function anchoredRequest(
  url: string,
  init: { cookie?: string; signal?: AbortSignal } & Anchored,
): Request {
  const target = new URL(url)
  if (init.param !== undefined) target.searchParams.set("last_event_id", init.param)
  return apiRequest(target.toString(), {
    cookie: init.cookie,
    signal: init.signal,
    headers: init.header === undefined ? undefined : { "last-event-id": init.header },
  })
}

/** The per-post handler, called the way Next.js calls it. */
function events(
  postId: string,
  init: { cookie?: string; signal?: AbortSignal } & Anchored = {},
) {
  return postEvents(anchoredRequest(`${URL_BASE}/${postId}`, init), {
    params: Promise.resolve({ post_id: postId }),
  })
}

/** The global handler, which takes no path parameter at all. */
function feed(init: { cookie?: string; signal?: AbortSignal } & Anchored = {}) {
  return globalEvents(anchoredRequest(URL_BASE, init))
}

interface Connection {
  response: Response
  abort: AbortController
  /** Resolves once the body has ended, which is what an abort makes happen. */
  drained: Promise<void>
  /** Everything received so far, undecoded. */
  raw: () => string
  /** Complete frames only; a partially received frame is not reported. */
  frames: () => string[]
}

/**
 * Opens the stream and starts draining it in the background.
 *
 * The drain runs detached because the body never ends on its own: the endpoint
 * streams until the client goes away, which is what `afterEach` does.
 */
async function connect(
  postId: string,
  cookie: string | undefined = user.cookie,
  anchor: Anchored = {},
): Promise<Connection> {
  return drain((signal) => events(postId, { cookie, signal, ...anchor }))
}

/** The same, for the global feed, which selects on the session and nothing else. */
async function connectFeed(
  cookie: string | undefined = user.cookie,
  anchor: Anchored = {},
): Promise<Connection> {
  return drain((signal) => feed({ cookie, signal, ...anchor }))
}

async function drain(
  openStream: (signal: AbortSignal) => Promise<Response>,
): Promise<Connection> {
  const abort = new AbortController()
  const response = await openStream(abort.signal)
  let text = ""
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const drained = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        text += decoder.decode(value, { stream: true })
      }
    } catch {
      // The abort below closes the stream under the reader.
    }
  })()
  open.push({ abort, drained })
  return {
    response,
    abort,
    drained,
    raw: () => text,
    frames: () => {
      const parts = text.split(SSE_SEPARATOR + SSE_SEPARATOR)
      parts.pop()
      return parts.map((part) => part + SSE_SEPARATOR + SSE_SEPARATOR)
    },
  }
}

/**
 * Closes one connection mid-test, the way a browser navigating away does.
 *
 * `afterEach` tears the rest down; a test that reconnects has to do it early,
 * and has to wait for the same settling `afterEach` waits for, because the
 * abort does not await the `unsubscribe()` it starts.
 */
async function disconnect(connection: Connection): Promise<void> {
  connection.abort.abort()
  await connection.drained
  const index = open.findIndex((entry) => entry.abort === connection.abort)
  if (index >= 0) open.splice(index, 1)
  await new Promise((resolve) => setTimeout(resolve, 250))
}

/** The `event:` name and the parsed `data:` payload of one frame. */
function parseFrame(frame: string): { event: string; data: Record<string, unknown> } {
  const lines = frame.split(SSE_SEPARATOR).filter((line) => line.length > 0)
  const name = lines.find((line) => line.startsWith("event: "))
  const data = lines
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .join("\n")
  return { event: name!.slice("event: ".length), data: JSON.parse(data) }
}

/** The `id:` field of one frame, or `undefined` when the frame carries none. */
function frameId(frame: string): string | undefined {
  const line = frame.split(SSE_SEPARATOR).find((part) => part.startsWith("id: "))
  return line?.slice("id: ".length)
}

/**
 * The envelope `RedisStreamsPubSub.publish()` wrote for one published payload,
 * read back off the stream itself.
 *
 * This is the only way to see the `id` and `createdAt` the transport stamps:
 * the subscriber callback receives them, but a test asserting the frame's id is
 * correct needs an independent source for the expected value, and the stream
 * entry is it.
 */
async function envelopeFor(match: (data: Record<string, unknown>) => boolean) {
  const entries = (await raw.xRange(STREAM_KEY, "-", "+")) as {
    id: string
    message: Record<string, string>
  }[]
  for (const entry of entries.reverse()) {
    const envelope = JSON.parse(entry.message.event) as {
      id: string
      createdAt: string
      data: Record<string, unknown>
    }
    if (match(envelope.data)) return envelope
  }
  throw new Error("no matching entry on the stream")
}

async function waitForFrames(connection: Connection, count: number, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const frames = connection.frames()
    if (frames.length >= count) return frames
    if (Date.now() > deadline) {
      throw new Error(`only ${frames.length} of ${count} frames arrived: ${JSON.stringify(connection.raw())}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** The fan-out consumer groups currently registered on the shared stream. */
async function groupNames(): Promise<string[]> {
  try {
    const groups = (await raw.xInfoGroups(STREAM_KEY)) as { name: string }[]
    return groups.map((group) => group.name)
  } catch {
    // The stream does not exist until something publishes to it.
    return []
  }
}

/** Resolves once `predicate` accepts the live group list, or gives up. */
async function waitForGroups(
  predicate: (names: string[]) => boolean,
  timeoutMs = 10_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const names = await groupNames()
    if (predicate(names)) return names
    if (Date.now() > deadline) throw new Error(`consumer groups never settled: ${names.join(", ")}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

beforeAll(async () => {
  await raw.connect()
  user = await createTestSession(PREFIX)
  other = await createTestSession(`${PREFIX}other-`)
})

afterEach(async () => {
  while (open.length > 0) {
    const connection = open.pop()!
    connection.abort.abort()
    await connection.drained
  }
  // The teardown the abort triggers is not awaited by the abort itself, so give
  // the unsubscribe a moment to destroy its group before the next test counts.
  await new Promise((resolve) => setTimeout(resolve, 250))
})

afterAll(async () => {
  await db.delete(posts).where(like(posts.slug, `${PREFIX}%`))
  await db.delete(websiteProfiles).where(like(websiteProfiles.userId, `${PREFIX}%`))
  await deleteTestSessions(PREFIX)
  await publisher.close()
  await raw.quit()
  await closeDb()
})

describe("GET /api/events/{post_id}", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await events(MISSING_ID)
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ detail: "Not authenticated" })
  })

  it("answers a malformed path uuid with FastAPI's 422", async () => {
    const response = await events("not-a-uuid", { cookie: user.cookie })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { detail: { type: string; loc: string[] }[] }
    expect(body.detail[0].type).toBe("uuid_parsing")
    expect(body.detail[0].loc).toEqual(["path", "post_id"])
  })

  it("answers a post that does not exist with a 404", async () => {
    const response = await events(MISSING_ID, { cookie: user.cookie })
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ detail: "Post not found" })
  })

  it("answers another user's post with the same 404, opening no stream", async () => {
    const post = await insertPost(other.userId)
    const before = await groupNames()
    const response = await events(post.id, { cookie: user.cookie })
    expect(response.status).toBe(404)
    expect(await groupNames()).toEqual(before)
  })

  it("answers a post whose profile_id is null with a 404", async () => {
    const [orphan] = await db
      .insert(posts)
      .values({ slug: `${PREFIX}${randomUUID()}`, topic: "Orphan", profileId: null })
      .returning()
    const response = await events(orphan.id, { cookie: user.cookie })
    expect(response.status).toBe(404)
  })

  it("answers an owned post with sse_starlette's four response headers", async () => {
    const post = await insertPost(user.userId)
    const connection = await connect(post.id)
    expect(connection.response.status).toBe(200)
    expect(connection.response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
    expect(connection.response.headers.get("cache-control")).toBe("no-store")
    expect(connection.response.headers.get("connection")).toBe("keep-alive")
    expect(connection.response.headers.get("x-accel-buffering")).toBe("no")
  })

  it("delivers a published event as one CRLF-framed named frame", async () => {
    const post = await insertPost(user.userId)
    const connection = await connect(post.id)

    await publishPipelineEvent(publisher, post.id, "stage_start", {
      stage: "research",
      message: "Starting research",
    })

    const [frame] = await waitForFrames(connection, 1)
    expect(frame).toBe(
      `id: ${frameId(frame)}\r\nevent: stage_start\r\ndata: ${JSON.stringify({
        event: "stage_start",
        post_id: post.id,
        stage: "research",
        message: "Starting research",
      })}\r\n\r\n`,
    )
  })

  it("carries the whole published payload in data, event name and post_id included", async () => {
    const post = await insertPost(user.userId)
    const connection = await connect(post.id)

    await publishPipelineEvent(publisher, post.id, "stage_complete", {
      stage: "write",
      model: "test-model",
      duration_s: 1.25,
    })

    const [frame] = await waitForFrames(connection, 1)
    expect(parseFrame(frame)).toEqual({
      event: "stage_complete",
      data: {
        event: "stage_complete",
        post_id: post.id,
        stage: "write",
        model: "test-model",
        duration_s: 1.25,
      },
    })
  })

  it("delivers every event name useSSE() listens for, in publication order", async () => {
    const post = await insertPost(user.userId)
    const connection = await connect(post.id)

    const names = ["stage_start", "log", "stage_complete", "pipeline_complete", "stage_error"]
    for (const name of names) await publishPipelineEvent(publisher, post.id, name, {})

    const frames = await waitForFrames(connection, names.length)
    expect(frames.map((frame) => parseFrame(frame).event)).toEqual(names)
  })

  it("ignores events for other posts", async () => {
    const mine = await insertPost(user.userId)
    const theirs = await insertPost(user.userId)
    const connection = await connect(mine.id)

    await publishPipelineEvent(publisher, theirs.id, "stage_start", { stage: "research" })
    await publishPipelineEvent(publisher, mine.id, "stage_start", { stage: "outline" })

    const [frame] = await waitForFrames(connection, 1)
    expect(parseFrame(frame).data.post_id).toBe(mine.id)
    expect(connection.frames()).toHaveLength(1)
  })

  it("names an event with no `event` key `update`, as parsed.get('event', 'update') did", async () => {
    const post = await insertPost(user.userId)
    const connection = await connect(post.id)

    // Straight onto the topic, because `publishPipelineEvent()` always names
    // the event; this is the malformed-publisher case Python defaulted for.
    await publisher.publish(TOPIC_PIPELINE_EVENTS, {
      type: "anonymous",
      runId: post.id,
      data: { post_id: post.id, stage: "research" },
    })

    const [frame] = await waitForFrames(connection, 1)
    expect(parseFrame(frame).event).toBe("update")
  })

  it("drops an event carrying no post_id rather than broadcasting it", async () => {
    const post = await insertPost(user.userId)
    const connection = await connect(post.id)

    await publisher.publish(TOPIC_PIPELINE_EVENTS, {
      type: "stage_start",
      runId: post.id,
      data: { stage: "research" },
    })
    await publishPipelineEvent(publisher, post.id, "stage_start", { stage: "research" })

    const frames = await waitForFrames(connection, 1)
    expect(frames).toHaveLength(1)
    expect(parseFrame(frames[0]).data.post_id).toBe(post.id)
  })

  it("does not replay events published before the connection opened", async () => {
    const post = await insertPost(user.userId)
    await publishPipelineEvent(publisher, post.id, "stage_start", { stage: "research" })

    const connection = await connect(post.id)
    await publishPipelineEvent(publisher, post.id, "stage_complete", { stage: "research" })

    const frames = await waitForFrames(connection, 1)
    expect(frames).toHaveLength(1)
    expect(parseFrame(frames[0]).event).toBe("stage_complete")
  })

  it("fans out to two concurrent readers of the same post instead of round-robining", async () => {
    const post = await insertPost(user.userId)
    const first = await connect(post.id)
    const second = await connect(post.id)

    await publishPipelineEvent(publisher, post.id, "stage_start", { stage: "research" })

    for (const connection of [first, second]) {
      const [frame] = await waitForFrames(connection, 1)
      expect(parseFrame(frame).data.stage).toBe("research")
    }
  })

  it("destroys its consumer group and stops delivering once the client disconnects", async () => {
    const post = await insertPost(user.userId)
    const before = await groupNames()
    const connection = await connect(post.id)

    const during = await waitForGroups((names) => names.length === before.length + 1)
    const mine = during.filter((name) => !before.includes(name))
    expect(mine).toHaveLength(1)

    await publishPipelineEvent(publisher, post.id, "stage_start", { stage: "research" })
    await waitForFrames(connection, 1)

    connection.abort.abort()
    await connection.drained
    await waitForGroups((names) => !names.includes(mine[0]))

    await publishPipelineEvent(publisher, post.id, "stage_complete", { stage: "research" })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(connection.frames()).toHaveLength(1)
  })

  it("acknowledges every delivery, so a long-lived reader accumulates no pending entries", async () => {
    const post = await insertPost(user.userId)
    const elsewhere = await insertPost(user.userId)
    const before = await groupNames()
    const connection = await connect(post.id)
    const during = await waitForGroups((names) => names.length === before.length + 1)
    const group = during.filter((name) => !before.includes(name))[0]

    // One matching event and one filtered out: the filtered one is the case
    // that leaks, because nothing sends it to the client and so nothing would
    // ack it as a side effect of writing the frame.
    await publishPipelineEvent(publisher, elsewhere.id, "stage_start", { stage: "research" })
    await publishPipelineEvent(publisher, post.id, "stage_start", { stage: "research" })
    await waitForFrames(connection, 1)

    const deadline = Date.now() + 10_000
    for (;;) {
      const groups = (await raw.xInfoGroups(STREAM_KEY)) as { name: string; pending: number }[]
      const found = groups.find((entry) => entry.name === group)
      if (found && found.pending === 0) break
      if (Date.now() > deadline) throw new Error(`group ${group} still has ${found?.pending} pending`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })
})

describe("GET /api/events", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await feed()
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ detail: "Not authenticated" })
  })

  it("opens with the same four response headers as the per-post stream", async () => {
    const connection = await connectFeed()
    expect(connection.response.status).toBe(200)
    expect(connection.response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
    expect(connection.response.headers.get("cache-control")).toBe("no-store")
    expect(connection.response.headers.get("connection")).toBe("keep-alive")
    expect(connection.response.headers.get("x-accel-buffering")).toBe("no")
  })

  it("delivers events for every post the caller owns, not just one", async () => {
    const first = await insertPost(user.userId)
    const second = await insertPost(user.userId)
    const connection = await connectFeed()

    await publishPipelineEvent(publisher, first.id, "stage_start", { stage: "research" })
    await publishPipelineEvent(publisher, second.id, "stage_complete", { stage: "outline" })

    const frames = await waitForFrames(connection, 2)
    expect(frames.map((frame) => parseFrame(frame).data.post_id)).toEqual([first.id, second.id])
  })

  it("drops another user's events, which global_events() broadcast to everyone", async () => {
    const theirs = await insertPost(other.userId)
    const mine = await insertPost(user.userId)
    const connection = await connectFeed()

    await publishPipelineEvent(publisher, theirs.id, "stage_start", { stage: "research" })
    await publishPipelineEvent(publisher, mine.id, "stage_start", { stage: "research" })

    const frames = await waitForFrames(connection, 1)
    expect(frames).toHaveLength(1)
    expect(parseFrame(frames[0]).data.post_id).toBe(mine.id)
  })

  it("drops an event for a post that no longer exists", async () => {
    const mine = await insertPost(user.userId)
    const connection = await connectFeed()

    await publishPipelineEvent(publisher, MISSING_ID, "stage_start", { stage: "research" })
    await publishPipelineEvent(publisher, mine.id, "stage_start", { stage: "research" })

    const frames = await waitForFrames(connection, 1)
    expect(frames).toHaveLength(1)
    expect(parseFrame(frames[0]).data.post_id).toBe(mine.id)
  })

  it("drops an event for a post whose profile_id is null, as the inner join did", async () => {
    const [orphan] = await db
      .insert(posts)
      .values({ slug: `${PREFIX}${randomUUID()}`, topic: "Orphan", profileId: null })
      .returning()
    const mine = await insertPost(user.userId)
    const connection = await connectFeed()

    await publishPipelineEvent(publisher, orphan.id, "stage_start", { stage: "research" })
    await publishPipelineEvent(publisher, mine.id, "stage_start", { stage: "research" })

    const frames = await waitForFrames(connection, 1)
    expect(frames).toHaveLength(1)
    expect(parseFrame(frames[0]).data.post_id).toBe(mine.id)
  })

  it("delivers events for a post created after the connection opened", async () => {
    const connection = await connectFeed()

    // The property a connect-time snapshot of owned ids would lose: the
    // dashboard opens this feed on mount and the post it is waiting to hear
    // about is created afterwards.
    const later = await insertPost(user.userId)
    await publishPipelineEvent(publisher, later.id, "stage_start", { stage: "research" })

    const [frame] = await waitForFrames(connection, 1)
    expect(parseFrame(frame).data.post_id).toBe(later.id)
  })

  it("preserves publication order across posts whose ownership is not yet resolved", async () => {
    const owned = [
      await insertPost(user.userId),
      await insertPost(user.userId),
      await insertPost(user.userId),
    ]
    const connection = await connectFeed()

    // The first event for each post pays for a database lookup and the second
    // reads the memo, so without the delivery chain in `pipelineEventStream()`
    // the three cached events would overtake the three uncached ones.
    const published: string[] = []
    for (const round of [0, 1]) {
      for (const post of owned) {
        const seq = `${round}-${post.id}`
        published.push(seq)
        await publishPipelineEvent(publisher, post.id, "log", { seq })
      }
    }

    const frames = await waitForFrames(connection, published.length)
    expect(frames.map((frame) => parseFrame(frame).data.seq)).toEqual(published)
  })

  it("remembers an ownership answer instead of re-querying per event", async () => {
    const mine = await insertPost(user.userId)
    const connection = await connectFeed()

    await publishPipelineEvent(publisher, mine.id, "stage_start", { stage: "research" })
    await waitForFrames(connection, 1)

    // Deleting the row is the observable difference between a memo and a
    // lookup per event: a per-event lookup would now start dropping the feed.
    await db.delete(posts).where(eq(posts.id, mine.id))
    await publishPipelineEvent(publisher, mine.id, "stage_complete", { stage: "research" })

    const frames = await waitForFrames(connection, 2)
    expect(parseFrame(frames[1]).event).toBe("stage_complete")
  })

  it("remembers a negative answer too, so a mid-connection reassignment needs a reconnect", async () => {
    const theirs = await insertPost(other.userId)
    const mine = await insertPost(user.userId)
    const connection = await connectFeed()

    await publishPipelineEvent(publisher, theirs.id, "stage_start", { stage: "research" })
    await publishPipelineEvent(publisher, mine.id, "stage_start", { stage: "research" })
    await waitForFrames(connection, 1)

    // The documented staleness cost of caching the negative answer.
    await db
      .update(websiteProfiles)
      .set({ userId: user.userId })
      .where(eq(websiteProfiles.id, theirs.profileId!))
    await publishPipelineEvent(publisher, theirs.id, "stage_complete", { stage: "research" })
    await publishPipelineEvent(publisher, mine.id, "stage_complete", { stage: "research" })

    const frames = await waitForFrames(connection, 2)
    expect(frames).toHaveLength(2)
    expect(frames.map((frame) => parseFrame(frame).data.post_id)).toEqual([mine.id, mine.id])

    // A reconnect is what picks the reassignment up.
    const reconnected = await connectFeed()
    await publishPipelineEvent(publisher, theirs.id, "pipeline_complete", {})
    const [frame] = await waitForFrames(reconnected, 1)
    expect(parseFrame(frame).data.post_id).toBe(theirs.id)
  })

  it("acknowledges deliveries it drops, so an unowned run leaks no pending entries", async () => {
    const theirs = await insertPost(other.userId)
    const mine = await insertPost(user.userId)
    const before = await groupNames()
    const connection = await connectFeed()
    const during = await waitForGroups((names) => names.length === before.length + 1)
    const group = during.filter((name) => !before.includes(name))[0]

    await publishPipelineEvent(publisher, theirs.id, "stage_start", { stage: "research" })
    await publishPipelineEvent(publisher, mine.id, "stage_start", { stage: "research" })
    await waitForFrames(connection, 1)

    const deadline = Date.now() + 10_000
    for (;;) {
      const groups = (await raw.xInfoGroups(STREAM_KEY)) as { name: string; pending: number }[]
      const found = groups.find((entry) => entry.name === group)
      if (found && found.pending === 0) break
      if (Date.now() > deadline) throw new Error(`group ${group} still has ${found?.pending} pending`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })

  it("stamps the same event with the same id on the feed as on the per-post stream", async () => {
    const post = await insertPost(user.userId)
    const perPost = await connect(post.id)

    // The feed joins one event late, so the two connections have delivered
    // different numbers of frames by the time they share one. The anchor names
    // a position in the shared stream, so it has to agree anyway: an id
    // counted per connection would not.
    await publishPipelineEvent(publisher, post.id, "log", { n: 1 })
    await waitForFrames(perPost, 1)
    const global = await connectFeed()
    await publishPipelineEvent(publisher, post.id, "log", { n: 2 })

    const mine = await waitForFrames(perPost, 2)
    const [theirs] = await waitForFrames(global, 1)
    expect(frameId(theirs)).toBeDefined()
    expect(frameId(mine[1])).toBe(frameId(theirs))
  })

  it("scopes two concurrent callers to their own posts on the same topic", async () => {
    const mine = await insertPost(user.userId)
    const theirs = await insertPost(other.userId)
    const ours = await connectFeed()
    const yours = await connectFeed(other.cookie)

    await publishPipelineEvent(publisher, mine.id, "stage_start", { stage: "research" })
    await publishPipelineEvent(publisher, theirs.id, "stage_start", { stage: "research" })

    for (const [connection, expected] of [
      [ours, mine.id],
      [yours, theirs.id],
    ] as const) {
      const frames = await waitForFrames(connection, 1)
      expect(frames).toHaveLength(1)
      expect(parseFrame(frames[0]).data.post_id).toBe(expected)
    }
  })
})

/**
 * The `id:` field, which is the replay anchor ledger item 5.5e-ii resumes from.
 *
 * Python's `_subscribe_and_stream()` yielded `{"event": ..., "data": ...}` and
 * `ServerSentEvent.encode()` skipped `id:` entirely because `self.id` was
 * `None`, so this is a deliberate addition rather than a port. The frames it
 * changes are the ones `useSSE()` already parses, and an id it ignores costs it
 * nothing: `EventSource` strips the field before dispatching the event.
 */
describe("SSE frame ids", () => {
  it("puts id: before event: on every frame, as ServerSentEvent.encode() ordered them", async () => {
    const post = await insertPost(user.userId)
    const connection = await connect(post.id)

    const names = ["stage_start", "log", "stage_complete"]
    for (const name of names) await publishPipelineEvent(publisher, post.id, name, {})

    const frames = await waitForFrames(connection, names.length)
    for (const frame of frames) {
      const lines = frame.split(SSE_SEPARATOR)
      expect(lines[0].startsWith("id: ")).toBe(true)
      expect(lines[1].startsWith("event: ")).toBe(true)
    }
  })

  it("names the transport's own event id and publish timestamp", async () => {
    const post = await insertPost(user.userId)
    const connection = await connect(post.id)

    await publishPipelineEvent(publisher, post.id, "stage_start", { stage: "research" })

    const [frame] = await waitForFrames(connection, 1)
    const envelope = await envelopeFor((data) => data.post_id === post.id)
    expect(frameId(frame)).toBe(`${new Date(envelope.createdAt).getTime()}-${envelope.id}`)
  })

  it("keeps the whole uuid, which contains the separator four times over", async () => {
    const post = await insertPost(user.userId)
    const connection = await connect(post.id)

    await publishPipelineEvent(publisher, post.id, "stage_start", { stage: "research" })

    const [frame] = await waitForFrames(connection, 1)
    const id = frameId(frame)!
    const envelope = await envelopeFor((data) => data.post_id === post.id)
    // Splitting on the first `-` is the parse a replay has to do; splitting on
    // the last would cut the uuid apart.
    expect(id.slice(id.indexOf("-") + 1)).toBe(envelope.id)
    expect(Number(id.slice(0, id.indexOf("-")))).toBe(new Date(envelope.createdAt).getTime())
  })

  it("issues a distinct, non-decreasing id per event across one run", async () => {
    const post = await insertPost(user.userId)
    const connection = await connect(post.id)

    const start = Date.now()
    for (let i = 0; i < 5; i += 1) await publishPipelineEvent(publisher, post.id, "log", { i })

    const frames = await waitForFrames(connection, 5)
    const ids = frames.map((frame) => frameId(frame)!)
    expect(new Set(ids).size).toBe(5)

    const millis = ids.map((id) => Number(id.slice(0, id.indexOf("-"))))
    for (const value of millis) {
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(start)
      expect(value).toBeLessThanOrEqual(Date.now())
    }
    expect([...millis].sort((a, b) => a - b)).toEqual(millis)
  })
})

/**
 * Replay: what a client gets back when it reconnects carrying the id of the
 * last frame it received.
 *
 * Python had no equivalent. `PUBLISH` retains nothing, so every event published
 * while `api/src/api/events.py` had no subscriber was gone, and a browser that
 * refreshed mid-run saw the pipeline resume from wherever it happened to be.
 * The retained Redis stream can answer for that window, and these tests are the
 * ledger's requirement that it does: disconnect mid-run, reconnect, and find no
 * gap in the sequence.
 *
 * The payload's `i` is the sequence: an assertion on the exact list of `i`
 * values catches a gap and a duplicate with the same expression.
 */
describe("replay from an anchor", () => {
  it("resumes where the client stopped, with no gap across the disconnect", async () => {
    const post = await insertPost(user.userId)
    const first = await connect(post.id)

    for (const i of [1, 2, 3]) await publishPipelineEvent(publisher, post.id, "log", { i })
    const received = await waitForFrames(first, 3)
    const anchor = frameId(received[2])!
    await disconnect(first)

    // The window the client is not there for. Python lost these outright.
    for (const i of [4, 5, 6]) await publishPipelineEvent(publisher, post.id, "log", { i })

    const second = await connect(post.id, user.cookie, { param: anchor })
    await publishPipelineEvent(publisher, post.id, "log", { i: 7 })

    const frames = await waitForFrames(second, 4, REPLAY_TIMEOUT_MS)
    expect(frames.map((frame) => parseFrame(frame).data.i)).toEqual([4, 5, 6, 7])
  })

  it("resumes on the uuid when what follows the anchor shares its millisecond", async () => {
    const post = await insertPost(user.userId)
    const first = await connect(post.id)

    // Published in one turn, so the transport stamps these microseconds apart.
    // At most one millisecond boundary can fall inside that span, so at least
    // four of the five adjacent pairs share a `createdAt`.
    await Promise.all(
      [1, 2, 3, 4, 5, 6].map((i) => publishPipelineEvent(publisher, post.id, "log", { i })),
    )
    const received = await waitForFrames(first, 6)
    const millis = received.map((frame) => {
      const id = frameId(frame)!
      return Number(id.slice(0, id.indexOf("-")))
    })

    // Anchor on a frame whose successor carries the same timestamp: the
    // fallback ordering places that successor "before" the anchor, so only the
    // uuid half can tell the replay where the client actually stopped.
    const at = millis.findIndex(
      (value, index) => index < millis.length - 1 && value === millis[index + 1],
    )
    expect(at).toBeGreaterThanOrEqual(0)

    const anchor = frameId(received[at])!
    const expected = received.slice(at + 1).map((frame) => parseFrame(frame).data.i)
    await disconnect(first)

    const second = await connect(post.id, user.cookie, { param: anchor })
    const frames = await waitForFrames(second, expected.length, REPLAY_TIMEOUT_MS)
    expect(frames.map((frame) => parseFrame(frame).data.i)).toEqual(expected)
  })

  it("accepts the anchor as the Last-Event-ID header a browser's own reconnect sends", async () => {
    const post = await insertPost(user.userId)
    const first = await connect(post.id)

    await publishPipelineEvent(publisher, post.id, "log", { i: 1 })
    const [frame] = await waitForFrames(first, 1)
    await disconnect(first)

    await publishPipelineEvent(publisher, post.id, "log", { i: 2 })

    const second = await connect(post.id, user.cookie, { header: frameId(frame)! })
    const frames = await waitForFrames(second, 1, REPLAY_TIMEOUT_MS)
    expect(frames.map((f) => parseFrame(f).data.i)).toEqual([2])
  })

  it("prefers the header over a query parameter, because the two age differently", async () => {
    const post = await insertPost(user.userId)
    const first = await connect(post.id)

    for (const i of [1, 2, 3]) await publishPipelineEvent(publisher, post.id, "log", { i })
    const received = await waitForFrames(first, 3)
    await disconnect(first)

    await publishPipelineEvent(publisher, post.id, "log", { i: 4 })

    // The URL was built when the connection first opened and still names the
    // first frame; the header is what the last frame carried.
    const second = await connect(post.id, user.cookie, {
      param: frameId(received[0])!,
      header: frameId(received[2])!,
    })
    const frames = await waitForFrames(second, 1, REPLAY_TIMEOUT_MS)
    expect(frames.map((f) => parseFrame(f).data.i)).toEqual([4])
  })

  it("resumes from the anchor's timestamp when the anchored event is gone from the stream", async () => {
    const post = await insertPost(user.userId)
    const first = await connect(post.id)

    for (const i of [1, 2]) await publishPipelineEvent(publisher, post.id, "log", { i })
    const received = await waitForFrames(first, 2)
    const id = frameId(received[1])!
    const millis = id.slice(0, id.indexOf("-"))
    await disconnect(first)

    // A millisecond of clearance: "published later" has to be expressible in
    // the anchor's own resolution for the fallback to place these after it.
    await new Promise((resolve) => setTimeout(resolve, 10))
    for (const i of [3, 4]) await publishPipelineEvent(publisher, post.id, "log", { i })

    // The anchor's timestamp with a uuid that names no entry: what a client
    // holds once its own anchor event has been trimmed off the stream.
    const second = await connect(post.id, user.cookie, { param: `${millis}-${randomUUID()}` })
    const frames = await waitForFrames(second, 2, REPLAY_TIMEOUT_MS)
    expect(frames.map((f) => parseFrame(f).data.i)).toEqual([3, 4])
  })

  it("ignores an anchor it did not write rather than replaying the whole stream", async () => {
    const post = await insertPost(user.userId)
    const first = await connect(post.id)

    await publishPipelineEvent(publisher, post.id, "log", { i: 1 })
    await waitForFrames(first, 1)
    await disconnect(first)

    await publishPipelineEvent(publisher, post.id, "log", { i: 2 })

    const second = await connect(post.id, user.cookie, { param: "garbage" })
    await publishPipelineEvent(publisher, post.id, "log", { i: 3 })

    const frames = await waitForFrames(second, 1)
    expect(frames.map((f) => parseFrame(f).data.i)).toEqual([3])
  })

  it("replays the queue-wide feed from an anchor, still scoped to the caller", async () => {
    const mine = await insertPost(user.userId)
    const theirs = await insertPost(other.userId)
    const first = await connectFeed()

    await publishPipelineEvent(publisher, mine.id, "log", { i: 1 })
    const [frame] = await waitForFrames(first, 1)
    await disconnect(first)

    await publishPipelineEvent(publisher, theirs.id, "log", { i: 2 })
    await publishPipelineEvent(publisher, mine.id, "log", { i: 3 })

    const second = await connectFeed(user.cookie, { param: frameId(frame)! })
    const frames = await waitForFrames(second, 1, REPLAY_TIMEOUT_MS)
    expect(frames.map((f) => parseFrame(f).data.i)).toEqual([3])
  })
})

describe("parseAnchor()", () => {
  it("splits on the first separator, which keeps the uuid whole", () => {
    const id = "3f1a2b3c-4d5e-4f60-8a71-9b2c3d4e5f60"
    expect(parseAnchor(`1755859200123-${id}`)).toEqual({ millis: 1_755_859_200_123, id })
  })

  it("reads back exactly what eventAnchor() wrote", () => {
    const event = {
      type: "stage_start",
      data: {},
      runId: "run",
      id: randomUUID(),
      createdAt: new Date(1_755_859_200_123),
    }
    expect(parseAnchor(eventAnchor(event)!)).toEqual({ millis: 1_755_859_200_123, id: event.id })
  })

  it("names no position for a value this server did not write", () => {
    expect(parseAnchor("garbage")).toBeUndefined()
    expect(parseAnchor("abc-def")).toBeUndefined()
    expect(parseAnchor("1.5-abc")).toBeUndefined()
    expect(parseAnchor("-abc")).toBeUndefined()
    expect(parseAnchor("1755859200123-")).toBeUndefined()
    expect(parseAnchor(null)).toBeUndefined()
    expect(parseAnchor(undefined)).toBeUndefined()
  })
})

describe("requestAnchor()", () => {
  const id = "3f1a2b3c-4d5e-4f60-8a71-9b2c3d4e5f60"

  function request(init: { header?: string; param?: string }): Request {
    const url = new URL(URL_BASE)
    if (init.param !== undefined) url.searchParams.set("last_event_id", init.param)
    return new Request(
      url,
      init.header === undefined ? {} : { headers: { "last-event-id": init.header } },
    )
  }

  it("takes the Last-Event-ID header when there is one", () => {
    expect(requestAnchor(request({ header: `1-${id}` }))).toEqual({ millis: 1, id })
  })

  it("takes the query parameter, which is the path useSSE() will use", () => {
    expect(requestAnchor(request({ param: `2-${id}` }))).toEqual({ millis: 2, id })
  })

  it("prefers the header, which is the fresher of the two", () => {
    expect(requestAnchor(request({ header: `2-${id}`, param: `1-${id}` }))).toEqual({
      millis: 2,
      id,
    })
  })

  it("falls through to the parameter when the header does not parse", () => {
    expect(requestAnchor(request({ header: "garbage", param: `1-${id}` }))).toEqual({
      millis: 1,
      id,
    })
  })

  it("reports no anchor for a request that carries neither", () => {
    expect(requestAnchor(request({}))).toBeUndefined()
  })
})

describe("anchorPosition()", () => {
  const anchor = { millis: 1_000, id: "anchor-uuid" }
  const base = { type: "log", data: {}, runId: "run" }

  it("recognises the anchor itself by uuid, whatever its timestamp says", () => {
    expect(anchorPosition(anchor, { ...base, id: anchor.id, createdAt: new Date(9_999) })).toBe(
      "at",
    )
  })

  it("places an earlier event before the anchor", () => {
    expect(anchorPosition(anchor, { ...base, id: "other", createdAt: new Date(999) })).toBe(
      "before",
    )
  })

  it("places a later event after it", () => {
    expect(anchorPosition(anchor, { ...base, id: "other", createdAt: new Date(1_001) })).toBe(
      "after",
    )
  })

  it("treats the anchor's own millisecond as before, so an exact match still settles it", () => {
    expect(anchorPosition(anchor, { ...base, id: "other", createdAt: new Date(1_000) })).toBe(
      "before",
    )
  })

  it("reports an unplaceable event as after, so a replay cannot stall on one", () => {
    expect(
      anchorPosition(anchor, { ...base, id: "other", createdAt: new Date("not a date") }),
    ).toBe("after")
  })
})

describe("eventAnchor()", () => {
  const base = { type: "stage_start", data: {}, runId: "run" }

  it("joins the publish timestamp to the transport uuid", () => {
    const id = "3f1a2b3c-4d5e-4f60-8a71-9b2c3d4e5f60"
    expect(eventAnchor({ ...base, id, createdAt: new Date(1_755_859_200_123) })).toBe(
      `1755859200123-${id}`,
    )
  })

  it("accepts the string createdAt a payload carries before the transport revives it", () => {
    // `#deliverMessage()` only revives `createdAt` when it is a string; a
    // locally delivered event arrives as a Date. Both shapes reach here.
    const id = "3f1a2b3c-4d5e-4f60-8a71-9b2c3d4e5f60"
    const createdAt = "2026-08-22T12:00:00.123Z" as unknown as Date
    expect(eventAnchor({ ...base, id, createdAt })).toBe(`1787400000123-${id}`)
  })

  it("omits the anchor for an event the transport did not stamp", () => {
    expect(eventAnchor({ ...base, id: "", createdAt: new Date(0) })).toBeUndefined()
    expect(
      eventAnchor({ ...base, id: "x", createdAt: new Date("not a date") }),
    ).toBeUndefined()
  })
})

describe("encodeSseEvent()", () => {
  it("writes no id: line when there is no anchor, as Python's `if self.id is not None` did", () => {
    expect(encodeSseEvent("log", { a: 1 })).toBe(
      `event: log${SSE_SEPARATOR}data: {"a":1}${SSE_SEPARATOR}${SSE_SEPARATOR}`,
    )
  })

  it("strips line breaks out of the id, so an id cannot forge a second field", () => {
    const frame = encodeSseEvent("log", {}, "1-a\r\ndata: injected")
    expect(frame.startsWith(`id: 1-adata: injected${SSE_SEPARATOR}`)).toBe(true)
    expect(frame.split(SSE_SEPARATOR).filter((line) => line.startsWith("data: "))).toEqual([
      "data: {}",
    ])
  })
})

describe("encodeSsePing()", () => {
  it("stays a bare comment, so a keepalive cannot move the client's Last-Event-ID", () => {
    expect(encodeSsePing(new Date(1_755_859_200_123))).toBe(
      `: ping - 2025-08-22T10:40:00.123Z${SSE_SEPARATOR}${SSE_SEPARATOR}`,
    )
  })
})
