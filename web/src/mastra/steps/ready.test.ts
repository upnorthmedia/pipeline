// @vitest-environment node
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, posts } from "../../db"
import { ABSENT_POST_ID } from "../../test/absent-ids"
import { readyStep } from "./ready"

const POST_ID = "00000000-0000-4000-8000-0000000000e6"
const db = getDb()
const calledAgents: string[] = []
const events: Record<string, unknown>[] = []

const mastra = {
  pubsub: {
    publish: async (_topic: string, event: { data: Record<string, unknown> }) => {
      events.push(event.data)
    },
  },
  getAgent: (name: string) => {
    calledAgents.push(name)
    throw new Error(`ready must not call agent ${name}`)
  },
  getLogger: () => undefined,
}

type ExecuteParams = Parameters<typeof readyStep.execute>[0]

async function execute(postId = POST_ID, resumeData?: { approved: true }) {
  return readyStep.execute({
    inputData: { postId },
    mastra,
    resumeData,
  } as unknown as ExecuteParams)
}

beforeAll(async () => {
  await db.delete(posts).where(eq(posts.id, POST_ID))
  await db.insert(posts).values({
    id: POST_ID,
    slug: "deterministic-ready",
    topic: "Deterministic Ready",
    finalMdContent: [
      "---",
      "title: Deterministic Ready",
      "---",
      "",
      "# Deterministic Ready",
      "",
      "## Comparison",
      "",
      "Body.",
      "",
      "<!-- WRITING NOTES: remove me -->",
    ].join("\n"),
    imageManifest: {
      images: [
        {
          id: "inline",
          generated: true,
          url: `/media/${POST_ID}/inline.webp`,
          alt_text: "Comparison image",
          placement: { location: "after_heading", after_section: "Comparison" },
        },
      ],
    },
    stageSettings: { ready: "auto" },
    stageStatus: { images: "complete" },
  })
})

afterAll(async () => {
  await db.delete(posts).where(eq(posts.id, POST_ID))
  await closeDb()
})

describe("deterministic ready step", () => {
  it("assembles and persists the publishable article without a model call", async () => {
    events.length = 0
    calledAgents.length = 0
    const output = await execute()

    expect(output).toMatchObject({
      postId: POST_ID,
      stage: "ready",
      model: "deterministic",
      tokensIn: 0,
      tokensOut: 0,
    })
    expect(calledAgents).toEqual([])

    const [row] = await db.select().from(posts).where(eq(posts.id, POST_ID))
    expect(row.readyContent).toContain(
      `![Comparison image](/media/${POST_ID}/inline.webp)`,
    )
    expect(row.readyContent).not.toContain("WRITING NOTES")
    expect(row.currentStage).toBe("ready")
    expect(row.stageStatus).toMatchObject({ images: "complete", ready: "complete" })
    expect(row.imageManifest).toMatchObject({
      images: [
        expect.objectContaining({
          human_review_required: true,
          human_review_approved: false,
        }),
      ],
    })
  })

  it("announces deterministic completion metadata", () => {
    expect(events.map((event) => event.event)).toEqual([
      "stage_start",
      "log",
      "log",
      "stage_complete",
    ])
    expect(events.at(-1)).toMatchObject({
      stage: "ready",
      model: "deterministic",
    })
  })

  it("fails before doing work when the post does not exist", async () => {
    await expect(execute(ABSENT_POST_ID)).rejects.toThrow("not found")
  })

  it("records image approval when a reviewer releases ready", async () => {
    await db
      .update(posts)
      .set({
        readyContent: null,
        stageSettings: { ready: "review" },
        stageStatus: { images: "complete", ready: "review" },
      })
      .where(eq(posts.id, POST_ID))

    await execute(POST_ID, { approved: true })

    const [row] = await db.select().from(posts).where(eq(posts.id, POST_ID))
    expect(row.imageManifest).toMatchObject({
      images: [
        expect.objectContaining({
          human_review_required: true,
          human_review_approved: true,
        }),
      ],
    })
  })
})
