// @vitest-environment node
/**
 * The TypeScript replacement for the `rules` router's pytest coverage. There is
 * none to port: `grep -rn "api/rules" api/tests` finds nothing, so these are
 * the first tests this router has ever had, and the shapes they pin were read
 * off the running FastAPI app rather than off the source (see the ledger entry
 * for item 5.6).
 *
 * `RULES_DIR` is pointed at a scratch directory for the whole file, because
 * `PUT` writes to disk and `rules/*.md` are the product's prompt IP. Nothing
 * here can reach the real files: `rulePath()` is asserted to resolve under the
 * override.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { closeDb } from "@/db"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET as GET_RULE, PUT } from "./[name]/route"
import { GET as GET_LIST } from "./route"
import { RULE_NAMES, rulePath } from "./rule-files"

const PREFIX = "rules-route-test-"
const LIST_URL = "http://test/api/rules"

/** The six names Python spelled out literally in `ALLOWED_FILES`. */
const PYTHON_ALLOWED_FILES = [
  "blog-edit",
  "blog-images",
  "blog-outline",
  "blog-ready",
  "blog-research",
  "blog-write",
]

let user: TestSession
let scratch: string
let previousRulesDir: string | undefined

function ruleRequest(name: string, init: Parameters<typeof apiRequest>[1] = {}) {
  return apiRequest(`http://test/api/rules/${name}`, init)
}

function params(name: string) {
  return { params: Promise.resolve({ name }) }
}

beforeAll(async () => {
  previousRulesDir = process.env.RULES_DIR
  scratch = await mkdtemp(path.join(tmpdir(), "jena-rules-"))
  process.env.RULES_DIR = scratch

  await deleteTestSessions(PREFIX)
  user = await createTestSession(PREFIX)
})

beforeEach(async () => {
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
  if (previousRulesDir === undefined) delete process.env.RULES_DIR
  else process.env.RULES_DIR = previousRulesDir
  await deleteTestSessions(PREFIX)
  await closeDb()
})

describe("the rule allowlist", () => {
  it("is Python's ALLOWED_FILES, sorted", () => {
    expect(RULE_NAMES).toEqual(PYTHON_ALLOWED_FILES)
  })

  it("resolves every name inside the rules directory", () => {
    for (const name of RULE_NAMES) {
      expect(rulePath(name)).toBe(path.join(scratch, `${name}.md`))
    }
  })
})

describe("GET /api/rules", () => {
  it("401s without a session", async () => {
    const response = await GET_LIST(apiRequest(LIST_URL))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("lists the six rules in sorted order with their filenames", async () => {
    const body = await (await GET_LIST(apiRequest(LIST_URL, { cookie: user.cookie }))).json()

    expect(body.map((entry: { name: string }) => entry.name)).toEqual(PYTHON_ALLOWED_FILES)
    expect(body.map((entry: { filename: string }) => entry.filename)).toEqual(
      PYTHON_ALLOWED_FILES.map((name) => `${name}.md`),
    )
  })

  it("reports a missing file as exists false with size 0", async () => {
    const body = await (await GET_LIST(apiRequest(LIST_URL, { cookie: user.cookie }))).json()

    expect(body).toEqual(
      PYTHON_ALLOWED_FILES.map((name) => ({
        name,
        filename: `${name}.md`,
        exists: false,
        size: 0,
      })),
    )
  })

  it("reports size in bytes, not characters", async () => {
    const content = "# ruleséé"
    await writeFile(path.join(scratch, "blog-edit.md"), content, "utf8")

    const body = await (await GET_LIST(apiRequest(LIST_URL, { cookie: user.cookie }))).json()
    const edit = body.find((entry: { name: string }) => entry.name === "blog-edit")

    expect(edit).toEqual({
      name: "blog-edit",
      filename: "blog-edit.md",
      exists: true,
      size: Buffer.byteLength(content, "utf8"),
    })
    expect(edit.size).toBeGreaterThan(content.length)
  })

  it("ignores files in the directory that are not on the allowlist", async () => {
    await writeFile(path.join(scratch, "blog-secret.md"), "not a rule", "utf8")

    const body = await (await GET_LIST(apiRequest(LIST_URL, { cookie: user.cookie }))).json()

    expect(body.map((entry: { name: string }) => entry.name)).toEqual(PYTHON_ALLOWED_FILES)
  })
})

describe("GET /api/rules/{name}", () => {
  it("401s without a session", async () => {
    const response = await GET_RULE(ruleRequest("blog-edit"), params("blog-edit"))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("404s an unknown rule with the name echoed back", async () => {
    const response = await GET_RULE(ruleRequest("bogus", { cookie: user.cookie }), params("bogus"))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Unknown rule: bogus" })
  })

  it("404s a traversing name before touching the filesystem", async () => {
    const name = "../../package"
    const response = await GET_RULE(ruleRequest(name, { cookie: user.cookie }), params(name))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: `Unknown rule: ${name}` })
  })

  it("404s an allowlisted rule whose file is missing, with the other message", async () => {
    const response = await GET_RULE(
      ruleRequest("blog-ready", { cookie: user.cookie }),
      params("blog-ready"),
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Rule file not found" })
  })

  it("returns the file content verbatim, decoded as utf-8", async () => {
    const content = "# Ready\n\nUse “curly” quotes and café.\n"
    await writeFile(path.join(scratch, "blog-ready.md"), content, "utf8")

    const response = await GET_RULE(
      ruleRequest("blog-ready", { cookie: user.cookie }),
      params("blog-ready"),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: "blog-ready", content })
  })
})

describe("PUT /api/rules/{name}", () => {
  const body = (content: unknown) => ({ body: JSON.stringify({ content }) })

  it("401s without a session", async () => {
    const response = await PUT(
      ruleRequest("blog-edit", { method: "PUT", ...body("x") }),
      params("blog-edit"),
    )

    expect(response.status).toBe(401)
    expect(await readdir(scratch)).toEqual([])
  })

  it("overwrites an existing file and echoes the content back", async () => {
    await writeFile(path.join(scratch, "blog-write.md"), "old", "utf8")

    const response = await PUT(
      ruleRequest("blog-write", { method: "PUT", cookie: user.cookie, ...body("new content") }),
      params("blog-write"),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: "blog-write", content: "new content" })
    expect(await readFile(path.join(scratch, "blog-write.md"), "utf8")).toBe("new content")
  })

  it("creates a file that was not there, so the next GET stops 404ing", async () => {
    await PUT(
      ruleRequest("blog-images", { method: "PUT", cookie: user.cookie, ...body("fresh") }),
      params("blog-images"),
    )

    const response = await GET_RULE(
      ruleRequest("blog-images", { cookie: user.cookie }),
      params("blog-images"),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: "blog-images", content: "fresh" })
  })

  it("writes utf-8 bytes, matching Python's write_text(encoding='utf-8')", async () => {
    const content = "café 中文\n"

    await PUT(
      ruleRequest("blog-outline", { method: "PUT", cookie: user.cookie, ...body(content) }),
      params("blog-outline"),
    )

    const bytes = await readFile(path.join(scratch, "blog-outline.md"))
    expect(bytes).toEqual(Buffer.from(content, "utf8"))
  })

  it("accepts an empty string, truncating the file", async () => {
    await writeFile(path.join(scratch, "blog-research.md"), "something", "utf8")

    const response = await PUT(
      ruleRequest("blog-research", { method: "PUT", cookie: user.cookie, ...body("") }),
      params("blog-research"),
    )

    expect(response.status).toBe(200)
    expect(await readFile(path.join(scratch, "blog-research.md"), "utf8")).toBe("")
  })

  it("404s an unknown rule and writes nothing", async () => {
    const response = await PUT(
      ruleRequest("bogus", { method: "PUT", cookie: user.cookie, ...body("payload") }),
      params("bogus"),
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Unknown rule: bogus" })
    expect(await readdir(scratch)).toEqual([])
  })

  it("422s a missing content field with pydantic's shape", async () => {
    const response = await PUT(
      ruleRequest("blog-edit", { method: "PUT", cookie: user.cookie, body: "{}" }),
      params("blog-edit"),
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      detail: [{ type: "missing", loc: ["body", "content"], msg: "Field required", input: {} }],
    })
  })

  it("422s a non-string content with pydantic's string_type", async () => {
    const response = await PUT(
      ruleRequest("blog-edit", { method: "PUT", cookie: user.cookie, ...body(5) }),
      params("blog-edit"),
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      detail: [
        {
          type: "string_type",
          loc: ["body", "content"],
          msg: "Input should be a valid string",
          input: 5,
        },
      ],
    })
  })

  it("422s a body that is not JSON at all", async () => {
    const response = await PUT(
      ruleRequest("blog-edit", { method: "PUT", cookie: user.cookie, body: "{oops" }),
      params("blog-edit"),
    )

    expect(response.status).toBe(422)
    expect((await response.json()).detail[0].type).toBe("json_invalid")
  })

  it("validates the body before the path, as FastAPI did", async () => {
    const response = await PUT(
      ruleRequest("bogus", { method: "PUT", cookie: user.cookie, body: "{}" }),
      params("bogus"),
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      detail: [{ type: "missing", loc: ["body", "content"], msg: "Field required", input: {} }],
    })
  })
})
