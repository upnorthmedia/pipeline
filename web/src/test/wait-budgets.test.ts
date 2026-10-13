/**
 * A test cannot be more patient than the harness lets it be.
 *
 * This suite waits on a real Postgres and a real Redis, so its files declare
 * their own budgets: `waitForFrames(..., timeoutMs = 10_000)`,
 * `waitForStart(..., timeoutMs = 15_000)`, `waitForError(..., timeoutMs =
 * 30_000)`. Those numbers are the point at which a wait gives up and says what
 * never arrived. Vitest's default `testTimeout` is 5s, which is below every one
 * of them, so none of those messages could ever print: under load the test died
 * on the harness's clock instead, reporting only `Test timed out in 5000ms`.
 *
 * That is how two of `events.test.ts`'s replay tests failed the first time this
 * repository's gates were run on Linux, and it says nothing about what broke.
 * `vitest.config.ts` now sets a `testTimeout` above the largest declared budget;
 * this file is what keeps the two in step when a new budget is added.
 */
import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const SRC = path.resolve(__dirname, "..")

/** This file's own examples are prose, not budgets, so it is not scanned. */
const SELF = "src/test/wait-budgets.test.ts"

/**
 * The two forms a wait budget takes in this suite: the default value of a
 * `timeoutMs` parameter, and a module constant named `*_TIMEOUT_MS`. Both are
 * passed to a polling loop's deadline, and both are what a test is asking the
 * harness for.
 */
const BUDGET_PATTERNS = [
  /\btimeoutMs\s*(?::\s*number\s*)?=\s*([0-9_]+)/g,
  /\b[A-Z][A-Z0-9_]*_TIMEOUT_MS\s*=\s*([0-9_]+)/g,
]

interface Budget {
  file: string
  line: number
  ms: number
  text: string
}

function testFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...testFiles(full))
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(full)
  }
  return found
}

function declaredBudgets(): Budget[] {
  const budgets: Budget[] = []
  for (const file of testFiles(SRC)) {
    const relative = path.relative(path.resolve(SRC, ".."), file)
    if (relative === SELF) continue
    const lines = fs.readFileSync(file, "utf8").split("\n")
    lines.forEach((text, index) => {
      for (const pattern of BUDGET_PATTERNS) {
        pattern.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = pattern.exec(text)) !== null) {
          budgets.push({
            file: relative,
            line: index + 1,
            ms: Number(match[1].replaceAll("_", "")),
            text: text.trim(),
          })
        }
      }
    })
  }
  return budgets
}

describe("wait budgets and the harness that cuts them short", () => {
  // Without this the first assertion passes on an empty list, which is exactly
  // what a regex that stops matching the codebase would produce.
  it("finds the budgets the suite actually declares", () => {
    const budgets = declaredBudgets()
    const files = new Set(budgets.map((budget) => budget.file))
    expect(budgets.length).toBeGreaterThanOrEqual(10)
    expect(files.size).toBeGreaterThanOrEqual(5)
    expect(files).toContain("src/app/api/events/events.test.ts")
  })

  it("gives every test more time than the slowest budget any test declares", ({ task }) => {
    const budgets = declaredBudgets()
    const slowest = budgets.reduce((worst, budget) => (budget.ms > worst.ms ? budget : worst))
    expect(
      task.timeout,
      `the slowest declared wait is ${slowest.ms}ms at ${slowest.file}:${slowest.line} ` +
        `(${slowest.text}), but vitest cuts a test off at ${task.timeout}ms, so that wait ` +
        `can never report what it was waiting for`,
    ).toBeGreaterThan(slowest.ms)
  })

  // The one above reads the effective timeout, so it would also pass if a
  // single file raised its own. The budget is meant to be the suite's.
  it("sets that budget in vitest.config.ts, for every file at once", () => {
    const config = fs.readFileSync(path.resolve(SRC, "../vitest.config.ts"), "utf8")
    const declared = /^\s*testTimeout:\s*([0-9_]+)\s*,/m.exec(config)
    expect(declared, "vitest.config.ts declares no testTimeout").not.toBeNull()
    expect(Number(declared![1].replaceAll("_", ""))).toBeGreaterThan(
      declaredBudgets().reduce((worst, budget) => Math.max(worst, budget.ms), 0),
    )
  })
})
