/**
 * Container healthcheck for the `worker` service: is this deployment actually
 * consuming Mastra's orchestration topic?
 *
 * The Python `worker` service's healthcheck opened a Redis connection and
 * pinged it, which proved the container could reach Redis and nothing about
 * ARQ. The equivalent question for the Mastra worker has a real answer:
 * `mastra worker start` joins the orchestration consumer group, so
 * `XINFO CONSUMERS` reports it with an `idle` that stays under a second while
 * the read loop polls. That is the same signal `readWorkerHealth()` in
 * `../worker-health.ts` serves to the dashboard, and the constants are pinned
 * against it by `worker-healthcheck.test.ts`.
 *
 * Written as dependency-free ESM speaking RESP over a socket on purpose. The
 * production worker image holds the bundle produced by `mastra worker build`
 * and no application `node_modules`, so a healthcheck that imports `redis`
 * would pass in the dev image and fail in the one that matters.
 *
 * Exit codes: 0 a live consumer exists, 1 none does or Redis is unreachable.
 */
import net from "node:net"
import { pathToFileURL } from "node:url"

export const ORCHESTRATION_TOPIC = "workflows"
export const ORCHESTRATION_GROUP = "mastra-orchestration"
export const STREAM_KEY_PREFIX = "mastra:topic"
export const IDLE_LIMIT_MS = 15_000

/** `redis://[[user]:password@]host[:port][/db]`. */
export function parseRedisUrl(url) {
  const parsed = new URL(url)
  if (parsed.protocol !== "redis:") {
    throw new Error(`unsupported REDIS_URL protocol ${parsed.protocol}, expected redis:`)
  }
  const db = parsed.pathname.replace(/^\//, "")
  return {
    host: parsed.hostname || "localhost",
    port: Number(parsed.port || 6379),
    username: parsed.username ? decodeURIComponent(parsed.username) : "",
    password: parsed.password ? decodeURIComponent(parsed.password) : "",
    db: db === "" ? 0 : Number(db),
  }
}

function encodeCommand(args) {
  let out = `*${args.length}\r\n`
  for (const arg of args) {
    const value = String(arg)
    out += `$${Buffer.byteLength(value)}\r\n${value}\r\n`
  }
  return out
}

/**
 * Enough RESP2 to read `XINFO CONSUMERS`: arrays, bulk strings, integers,
 * errors. Returns `null` while the buffer holds less than one whole reply, so
 * the caller can wait for more bytes rather than guess.
 */
export function parseReply(buffer, start = 0) {
  const end = buffer.indexOf("\r\n", start)
  if (end === -1) return null
  const type = buffer[start]
  const head = buffer.slice(start + 1, end)
  const next = end + 2

  if (type === "+") return { value: head, next }
  if (type === "-") return { value: new Error(head), next }
  if (type === ":") return { value: Number(head), next }
  if (type === "$") {
    const length = Number(head)
    if (length === -1) return { value: null, next }
    if (buffer.length < next + length + 2) return null
    return { value: buffer.slice(next, next + length), next: next + length + 2 }
  }
  if (type === "*") {
    const count = Number(head)
    if (count === -1) return { value: null, next }
    const items = []
    let cursor = next
    for (let i = 0; i < count; i += 1) {
      const item = parseReply(buffer, cursor)
      if (item === null) return null
      items.push(item.value)
      cursor = item.next
    }
    return { value: items, next: cursor }
  }
  throw new Error(`unsupported RESP type ${JSON.stringify(type)}`)
}

/** Sends each command in order and resolves with one reply per command. */
export function sendCommands(target, commands) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: target.host, port: target.port })
    const replies = []
    let buffer = ""
    let settled = false

    const finish = (error, value) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }

    socket.setTimeout(5_000, () => finish(new Error("timed out talking to Redis")))
    socket.on("error", finish)
    socket.on("close", () => finish(new Error("Redis closed the connection early")))
    socket.on("connect", () => {
      socket.write(commands.map(encodeCommand).join(""))
    })
    socket.on("data", (chunk) => {
      buffer += chunk.toString("binary")
      for (;;) {
        let reply
        try {
          reply = parseReply(buffer)
        } catch (error) {
          finish(error)
          return
        }
        if (reply === null) return
        replies.push(reply.value)
        buffer = buffer.slice(reply.next)
        if (replies.length === commands.length) {
          finish(null, replies)
          return
        }
      }
    })
  })
}

export function streamKey(prefix = STREAM_KEY_PREFIX) {
  return `${prefix}:${ORCHESTRATION_TOPIC}`
}

/**
 * A consumer entry per worker process that has ever joined the group, never
 * removed by the transport, so liveness is `idle`, not the entry's existence.
 * `XINFO CONSUMERS` returns flat `[field, value, ...]` arrays under RESP2.
 */
export function liveConsumerCount(consumers, idleLimitMs = IDLE_LIMIT_MS) {
  let live = 0
  for (const entry of consumers) {
    for (let i = 0; i + 1 < entry.length; i += 2) {
      if (entry[i] === "idle" && Number(entry[i + 1]) < idleLimitMs) live += 1
    }
  }
  return live
}

export async function checkWorkerAlive(url, options = {}) {
  const target = parseRedisUrl(url)
  const commands = []
  if (target.password) {
    commands.push(
      target.username ? ["AUTH", target.username, target.password] : ["AUTH", target.password],
    )
  }
  if (target.db) commands.push(["SELECT", target.db])
  commands.push(["XINFO", "CONSUMERS", options.streamKey ?? streamKey(), ORCHESTRATION_GROUP])

  const replies = await sendCommands(target, commands)
  const last = replies[replies.length - 1]
  for (const reply of replies.slice(0, -1)) {
    if (reply instanceof Error) throw reply
  }
  // A stream nothing has published to, or a group no worker has joined, is a
  // worker that has not arrived: not alive, not an error to report as a crash.
  if (last instanceof Error) return 0
  return liveConsumerCount(last, options.idleLimitMs)
}

/** True when this module was started directly rather than imported by a test. */
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntryPoint) {
  const url = process.env.REDIS_URL
  if (!url) {
    console.error("REDIS_URL must be set")
    process.exit(1)
  }
  try {
    const live = await checkWorkerAlive(url)
    if (live > 0) process.exit(0)
    console.error(`no live consumer in ${ORCHESTRATION_GROUP} on ${streamKey()}`)
    process.exit(1)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
