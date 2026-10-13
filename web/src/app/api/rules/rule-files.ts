/**
 * The allowlist and path resolution the two `rules` handlers share, ported from
 * `ALLOWED_FILES` and `_rule_path()` in `api/src/api/rules.py`.
 *
 * Python spelled the six names out as a literal set. This derives them from
 * `STAGE_RULES_MAP`, the same map `web/src/mastra/prompts.ts` reads to build a
 * stage's prompt, so the files the settings page can edit and the files the
 * pipeline actually loads cannot drift apart. The derived list is pinned
 * against Python's literal in `rules.test.ts`.
 *
 * The allowlist is also what keeps `..` and absolute paths out of the resolved
 * filename: a name that is not one of the six never reaches `path.join`.
 */
import path from "node:path"

import { STAGE_RULES_MAP } from "@/mastra/state"
import { rulesDir } from "@/mastra/prompts"

/** The six editable rule names, sorted, matching Python's `sorted(ALLOWED_FILES)`. */
export const RULE_NAMES: readonly string[] = Object.values(STAGE_RULES_MAP)
  .map((filename) => filename.replace(/\.md$/, ""))
  .sort()

export function isRuleName(name: string): boolean {
  return RULE_NAMES.includes(name)
}

/** `RuleFile.filename` in `web/src/lib/api.ts`, and the name on disk. */
export function ruleFilename(name: string): string {
  return `${name}.md`
}

/** Resolved only for a name that passed `isRuleName`. */
export function rulePath(name: string): string {
  return path.join(rulesDir(), ruleFilename(name))
}

/** `HTTPException(404, f"Unknown rule: {name}")` as FastAPI rendered it. */
export function unknownRule(name: string): Response {
  return Response.json({ detail: `Unknown rule: ${name}` }, { status: 404 })
}
