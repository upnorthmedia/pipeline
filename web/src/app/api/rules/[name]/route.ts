/**
 * Port of `GET /api/rules/{name}` and `PUT /api/rules/{name}` in
 * `api/src/api/rules.py`, the read and save behind the settings page's rule
 * editor.
 *
 * Both answer `{name, content}`, the `RuleContent` interface in
 * `web/src/lib/api.ts`. Python separated its two 404s and this keeps them
 * apart: an unallowlisted name is `Unknown rule: <name>` from `_rule_path()`,
 * while an allowlisted name with no file on disk is `Rule file not found`. Only
 * `GET` can reach the second one, because `PUT` creates the file.
 *
 * Authentication is the deviation recorded on the collection handler: the
 * Python router had none, which left an unauthenticated `PUT` able to rewrite
 * the prompts every tenant's pipeline runs on.
 *
 * `rules/*.md` are the product's prompt IP and this port does not rewrite them.
 * `PUT` writing whatever the editor sends is the endpoint's purpose, unchanged
 * from Python, and the tests here run against a temporary `RULES_DIR` so the
 * real files are never touched.
 */
import { readFile, writeFile } from "node:fs/promises"

import { z } from "zod"

import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { invalidJsonBody, unprocessableBody } from "../../pydantic"

import { isRuleName, rulePath, unknownRule } from "../rule-files"

/** `RuleUpdate` in `api/src/api/rules.py`: one required `str` field. */
const ruleUpdateSchema = z.object({ content: z.string() })

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { name } = await params
  if (!isRuleName(name)) return unknownRule(name)

  let content: string
  try {
    content = await readFile(rulePath(name), "utf8")
  } catch {
    return Response.json({ detail: "Rule file not found" }, { status: 404 })
  }

  return Response.json({ name, content })
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  // Body before path, matching FastAPI: request validation runs after the
  // dependencies and before the endpoint function, so a bad body on an
  // unallowlisted name answered 422 rather than the handler's 404.
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return invalidJsonBody()
  }

  const parsed = ruleUpdateSchema.safeParse(body)
  if (!parsed.success) return unprocessableBody(parsed.error.issues, body)

  const { name } = await params
  if (!isRuleName(name)) return unknownRule(name)

  await writeFile(rulePath(name), parsed.data.content, "utf8")

  return Response.json({ name, content: parsed.data.content })
}
