/**
 * Port of `GET /api/rules` in `api/src/api/rules.py`, the list the settings
 * page's rule editor builds its tabs from.
 *
 * The response is the `RuleFile[]` in `web/src/lib/api.ts`: one entry per
 * allowlisted name in sorted order, whether the file is on disk, and its size
 * in bytes (`0` when it is missing, as Python's conditional gave).
 *
 * Deviation, deliberate: Python's whole `rules` router carried no session
 * dependency, so any caller could read and, through `PUT`, overwrite the
 * product's prompt IP for every tenant at once. That is the same gap item
 * 5.5d-i found in the events router, and it is closed the same way: every
 * handler here requires a session. There is no ownership scoping to add on top,
 * because `rules/*.md` are installation-wide files, not rows with an owner.
 *
 * Python called `Path.exists()` and then `Path.stat()`, two syscalls with a
 * window between them. This reads one `stat` and treats `ENOENT` as "missing",
 * which answers the same two questions without the window.
 */
import { stat } from "node:fs/promises"

import { getRequestUser, unauthorized } from "@/lib/request-auth"

import { RULE_NAMES, ruleFilename, rulePath } from "./rule-files"

interface RuleFileResponse {
  name: string
  filename: string
  exists: boolean
  size: number
}

async function describeRule(name: string): Promise<RuleFileResponse> {
  const entry = { name, filename: ruleFilename(name) }
  try {
    const stats = await stat(rulePath(name))
    return { ...entry, exists: true, size: stats.size }
  } catch {
    return { ...entry, exists: false, size: 0 }
  }
}

export async function GET(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  return Response.json(await Promise.all(RULE_NAMES.map(describeRule)))
}
