/**
 * `web/Dockerfile`, read as data.
 *
 * Two suites assert things about the image that no gate builds: which runtime
 * stage declares which environment variable, and which directory each `COPY`
 * lands. Both need the same walk over the file, so it lives here rather than in
 * whichever test happened to need it first.
 */
import path from "node:path"

export interface Stage {
  name: string
  base: string
  workdir: string
  env: Record<string, string>
  /** Absolute destinations, resolved against the WORKDIR in force. */
  copies: string[]
  cmd: string | null
}

/**
 * The subset of Dockerfile syntax this file uses: `FROM ... AS`, `WORKDIR`,
 * `ENV KEY=value`, `COPY [--flags] src... dest` and `CMD`. Line continuations
 * are joined first so a wrapped instruction is read as one.
 */
export function parseStages(source: string): Map<string, Stage> {
  const stages = new Map<string, Stage>()
  let current: Stage | null = null

  const lines = source
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))

  for (const line of lines) {
    const [instruction, ...rest] = line.split(/\s+/)
    const keyword = instruction.toUpperCase()

    if (keyword === "FROM") {
      const asIndex = rest.findIndex((token) => token.toUpperCase() === "AS")
      const name = asIndex === -1 ? rest[0] : rest[asIndex + 1]
      const base = rest[0]
      const parent = stages.get(base)
      current = {
        name,
        base,
        workdir: parent?.workdir ?? "/",
        env: { ...(parent?.env ?? {}) },
        copies: [...(parent?.copies ?? [])],
        cmd: null,
      }
      stages.set(name, current)
      continue
    }

    if (!current) continue

    if (keyword === "WORKDIR") {
      current.workdir = path.posix.resolve(current.workdir, rest[0])
    } else if (keyword === "ENV") {
      const assignment = rest.join(" ")
      const equals = assignment.indexOf("=")
      if (equals !== -1) {
        const key = assignment.slice(0, equals)
        const value = assignment.slice(equals + 1).replace(/^["']|["']$/g, "")
        current.env[key] = value
      }
    } else if (keyword === "COPY") {
      const operands = rest.filter((token) => !token.startsWith("--"))
      const destination = operands[operands.length - 1]
      if (destination) current.copies.push(path.posix.resolve(current.workdir, destination))
    } else if (keyword === "CMD") {
      current.cmd = rest.join(" ")
    }
  }

  return stages
}
