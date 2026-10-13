// @vitest-environment node
/**
 * The decision table of `_post_completion_hook`'s auto-publish half and of the
 * caller that acts on it (ledger item 5.11), against real rows in the dev
 * database. Nothing is stubbed: the function's only boundary is Postgres.
 *
 * The workflow-level half of this item is `./workflows/auto-publish.test.ts`,
 * which proves a finished run really does reach a receiver. This file is the
 * branch coverage that would be prohibitively slow to get through full pipeline
 * runs: eleven posts across four profiles, one call each.
 *
 * Requires `docker compose up -d db`.
 */
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, posts, websiteProfiles } from "../db"
import { applyAutoPublishHook } from "./auto-publish"

import type { AutoPublishTargets } from "./auto-publish"

const db = getDb()

/** Configured for both destinations, so `both` has somewhere it could have gone. */
const PROFILE_BOTH = "00000000-0000-4000-8000-0000000005a1"
/** WordPress credentials, no Next.js webhook. */
const PROFILE_WP = "00000000-0000-4000-8000-0000000005a2"
/** `wp_app_password` missing, which is one of the three the check reads. */
const PROFILE_WP_PARTIAL = "00000000-0000-4000-8000-0000000005a3"
/** `wp_url` empty rather than null: Python's `and` chain reads truthiness. */
const PROFILE_WP_BLANK = "00000000-0000-4000-8000-0000000005a4"
/** Next.js URL with no secret. */
const PROFILE_NEXTJS_PARTIAL = "00000000-0000-4000-8000-0000000005a5"

const PROFILE_IDS = [
  PROFILE_BOTH,
  PROFILE_WP,
  PROFILE_WP_PARTIAL,
  PROFILE_WP_BLANK,
  PROFILE_NEXTJS_PARTIAL,
]

interface Case {
  /** The post id, and the name the assertions read by. */
  id: string
  name: string
  profileId: string | null
  outputFormat: string | null
  wpPublishStatus?: string | null
  nextjsPublishStatus?: string | null
}

const CASES: Case[] = [
  {
    id: "00000000-0000-4000-8000-0000000005b1",
    name: "wordpress, configured",
    profileId: PROFILE_WP,
    outputFormat: "wordpress",
  },
  {
    id: "00000000-0000-4000-8000-0000000005b2",
    name: "wordpress, no app password",
    profileId: PROFILE_WP_PARTIAL,
    outputFormat: "wordpress",
  },
  {
    id: "00000000-0000-4000-8000-0000000005b3",
    name: "wordpress, blank url",
    profileId: PROFILE_WP_BLANK,
    outputFormat: "wordpress",
  },
  {
    id: "00000000-0000-4000-8000-0000000005b4",
    name: "wordpress, configured, stale nextjs pending",
    profileId: PROFILE_WP,
    outputFormat: "wordpress",
    nextjsPublishStatus: "pending",
  },
  {
    id: "00000000-0000-4000-8000-0000000005b5",
    name: "wordpress, unconfigured, stale wordpress pending",
    profileId: PROFILE_WP_PARTIAL,
    outputFormat: "wordpress",
    wpPublishStatus: "pending",
  },
  {
    id: "00000000-0000-4000-8000-0000000005b6",
    name: "wordpress, configured, previously failed",
    profileId: PROFILE_WP,
    outputFormat: "wordpress",
    wpPublishStatus: "failed",
  },
  {
    id: "00000000-0000-4000-8000-0000000005b7",
    name: "wordpress, configured, already pending",
    profileId: PROFILE_WP,
    outputFormat: "wordpress",
    wpPublishStatus: "pending",
  },
  {
    id: "00000000-0000-4000-8000-0000000005b8",
    name: "nextjs, configured",
    profileId: PROFILE_BOTH,
    outputFormat: "nextjs",
  },
  {
    id: "00000000-0000-4000-8000-0000000005b9",
    name: "nextjs, no secret",
    profileId: PROFILE_NEXTJS_PARTIAL,
    outputFormat: "nextjs",
  },
  {
    id: "00000000-0000-4000-8000-0000000005ba",
    name: "both, configured for both",
    profileId: PROFILE_BOTH,
    outputFormat: "both",
  },
  {
    id: "00000000-0000-4000-8000-0000000005bb",
    name: "wordpress, no profile",
    profileId: null,
    outputFormat: "wordpress",
  },
]

/** Never inserted, so the hook's "post is gone" branch has a subject. */
const ABSENT_POST = "00000000-0000-4000-8000-0000000005bf"

/** Well before any row this test writes, so a bumped `updated_at` is unmistakable. */
const SEEDED_AT = new Date("2020-01-01T00:00:00.000Z")

const targets: Record<string, AutoPublishTargets> = {}

function caseFor(name: string): Case {
  const found = CASES.find((entry) => entry.name === name)
  if (!found) throw new Error(`no case named ${name}`)
  return found
}

async function readPost(postId: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, postId))
  return row
}

/** `{wordpress, nextjs}` for a case, plus the row it left behind. */
async function outcome(name: string) {
  const entry = caseFor(name)
  return { ...targets[entry.name], row: await readPost(entry.id) }
}

beforeAll(async () => {
  for (const entry of CASES) await db.delete(posts).where(eq(posts.id, entry.id))
  await db.delete(posts).where(eq(posts.id, ABSENT_POST))
  for (const id of PROFILE_IDS) await db.delete(websiteProfiles).where(eq(websiteProfiles.id, id))

  await db.insert(websiteProfiles).values([
    {
      id: PROFILE_BOTH,
      name: "auto-publish both",
      websiteUrl: "http://127.0.0.1:9/both",
      wpUrl: "http://127.0.0.1:9/wp",
      wpUsername: "editor",
      wpAppPassword: "encrypted-app-password",
      nextjsWebhookUrl: "http://127.0.0.1:9/hook",
      nextjsWebhookSecret: "encrypted-secret",
    },
    {
      id: PROFILE_WP,
      name: "auto-publish wordpress",
      websiteUrl: "http://127.0.0.1:9/wp-only",
      wpUrl: "http://127.0.0.1:9/wp",
      wpUsername: "editor",
      wpAppPassword: "encrypted-app-password",
    },
    {
      id: PROFILE_WP_PARTIAL,
      name: "auto-publish wordpress, partial",
      websiteUrl: "http://127.0.0.1:9/wp-partial",
      wpUrl: "http://127.0.0.1:9/wp",
      wpUsername: "editor",
      wpAppPassword: null,
    },
    {
      id: PROFILE_WP_BLANK,
      name: "auto-publish wordpress, blank",
      websiteUrl: "http://127.0.0.1:9/wp-blank",
      wpUrl: "",
      wpUsername: "editor",
      wpAppPassword: "encrypted-app-password",
    },
    {
      id: PROFILE_NEXTJS_PARTIAL,
      name: "auto-publish nextjs, partial",
      websiteUrl: "http://127.0.0.1:9/nextjs-partial",
      nextjsWebhookUrl: "http://127.0.0.1:9/hook",
      nextjsWebhookSecret: null,
    },
  ])

  for (const entry of CASES) {
    await db.insert(posts).values({
      id: entry.id,
      profileId: entry.profileId,
      slug: `auto-publish-${entry.id.slice(-3)}`,
      topic: entry.name,
      outputFormat: entry.outputFormat,
      wpPublishStatus: entry.wpPublishStatus ?? null,
      nextjsPublishStatus: entry.nextjsPublishStatus ?? null,
      updatedAt: SEEDED_AT,
    })
  }

  for (const entry of CASES) {
    targets[entry.name] = await applyAutoPublishHook(entry.id)
  }
  targets.absent = await applyAutoPublishHook(ABSENT_POST)
}, 60_000)

afterAll(async () => {
  for (const entry of CASES) await db.delete(posts).where(eq(posts.id, entry.id))
  for (const id of PROFILE_IDS) await db.delete(websiteProfiles).where(eq(websiteProfiles.id, id))
  await closeDb()
})

describe("output_format wordpress", () => {
  it("marks a configured post pending and asks the caller to publish it", async () => {
    const { wordpress, nextjs, row } = await outcome("wordpress, configured")

    expect(row.wpPublishStatus).toBe("pending")
    expect(wordpress).toBe(true)
    expect(nextjs).toBe(false)
  })

  it("leaves the other destination's column alone", async () => {
    const { row } = await outcome("wordpress, configured")

    expect(row.nextjsPublishStatus).toBeNull()
  })

  /**
   * Python read `profile.wp_url and profile.wp_username and
   * profile.wp_app_password`, so any one of the three missing declines the
   * whole publish rather than starting one that would fail at the first
   * request.
   */
  it("declines when the profile is missing its app password", async () => {
    const { wordpress, row } = await outcome("wordpress, no app password")

    expect(row.wpPublishStatus).toBeNull()
    expect(wordpress).toBe(false)
  })

  it("declines on an empty string, as Python truthiness did", async () => {
    const { wordpress, row } = await outcome("wordpress, blank url")

    expect(row.wpPublishStatus).toBeNull()
    expect(wordpress).toBe(false)
  })

  it("declines when the post has no profile at all", async () => {
    const { wordpress, row } = await outcome("wordpress, no profile")

    expect(row.wpPublishStatus).toBeNull()
    expect(wordpress).toBe(false)
  })

  it("overwrites a previous failure", async () => {
    const { wordpress, row } = await outcome("wordpress, configured, previously failed")

    expect(row.wpPublishStatus).toBe("pending")
    expect(wordpress).toBe(true)
  })
})

describe("output_format nextjs", () => {
  it("marks a configured post pending and asks the caller to publish it", async () => {
    const { wordpress, nextjs, row } = await outcome("nextjs, configured")

    expect(row.nextjsPublishStatus).toBe("pending")
    expect(nextjs).toBe(true)
    expect(wordpress).toBe(false)
  })

  it("leaves the WordPress column alone even on a profile carrying WordPress credentials", async () => {
    const { row } = await outcome("nextjs, configured")

    expect(row.wpPublishStatus).toBeNull()
  })

  it("declines when the profile has a webhook URL but no secret", async () => {
    const { nextjs, row } = await outcome("nextjs, no secret")

    expect(row.nextjsPublishStatus).toBeNull()
    expect(nextjs).toBe(false)
  })
})

/**
 * `both` is the column's default, and Python compared `post.output_format ==
 * "wordpress"` and `== "nextjs"` rather than testing membership, so it matches
 * neither branch however well configured the profile is. `POST
 * /{post_id}/publish` refuses it for the same reason, so the two paths agree:
 * a `both` post is published by choosing a format first.
 */
describe("output_format both", () => {
  it("publishes nowhere despite a profile configured for both", async () => {
    const { wordpress, nextjs, row } = await outcome("both, configured for both")

    expect(row.wpPublishStatus).toBeNull()
    expect(row.nextjsPublishStatus).toBeNull()
    expect(wordpress).toBe(false)
    expect(nextjs).toBe(false)
  })
})

/**
 * The consequence of Python writing the column in the hook and reading it back
 * in the caller. The caller's `should_publish_*` is the state of the row, not
 * the answer the check above gave, so a post left `pending` by a publish that
 * died is retried by the next full run of the pipeline.
 */
describe("a stale pending marker", () => {
  it("re-publishes even though the configuration check declined", async () => {
    const { wordpress, row } = await outcome("wordpress, unconfigured, stale wordpress pending")

    expect(row.wpPublishStatus).toBe("pending")
    expect(wordpress).toBe(true)
  })

  it("starts the other destination too, whatever output_format says", async () => {
    const { wordpress, nextjs } = await outcome("wordpress, configured, stale nextjs pending")

    expect(wordpress).toBe(true)
    expect(nextjs).toBe(true)
  })
})

/**
 * SQLAlchemy emitted no `UPDATE` for an assignment that did not change the
 * loaded value, so `updated_at` stayed where it was. The three rows here are
 * the two sides of that: a marker that did not move leaves the timestamp alone,
 * one that did move bumps it.
 */
describe("updated_at", () => {
  it("is left alone when the column already read pending", async () => {
    const { wordpress, row } = await outcome("wordpress, configured, already pending")

    expect(wordpress).toBe(true)
    expect(row.updatedAt).toEqual(SEEDED_AT)
  })

  it("is left alone when the check declined", async () => {
    const { row } = await outcome("wordpress, no app password")

    expect(row.updatedAt).toEqual(SEEDED_AT)
  })

  it("moves when the marker is written", async () => {
    const { row } = await outcome("wordpress, configured")

    expect(row.updatedAt!.getTime()).toBeGreaterThan(SEEDED_AT.getTime())
  })
})

describe("a post that no longer exists", () => {
  it("publishes nothing rather than raising", () => {
    expect(targets.absent).toEqual({ wordpress: false, nextjs: false })
  })
})
