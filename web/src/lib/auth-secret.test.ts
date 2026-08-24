/**
 * @vitest-environment node
 */
import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { auth } from "@/lib/auth"
import { BETTER_AUTH_DEFAULT_SECRET, resolveAuthSecret } from "@/lib/auth-secret"
import { parseStages } from "@/test/dockerfile-stages"

/**
 * The literal is read out of the installed package rather than trusted from
 * this repo, so an upgrade that changes BetterAuth's fallback fails here
 * instead of silently making the guard match nothing.
 */
const installedDefault = await import("better-auth/plugins").then(async () => {
  const { readFileSync } = await import("node:fs")
  const source = readFileSync(
    new URL("../../node_modules/better-auth/dist/utils/constants.mjs", import.meta.url),
    "utf8",
  )
  return /const DEFAULT_SECRET = "([^"]+)"/.exec(source)?.[1]
})

describe("resolveAuthSecret", () => {
  it("matches the fallback the installed better-auth actually carries", () => {
    expect(installedDefault).toBe(BETTER_AUTH_DEFAULT_SECRET)
  })

  it("returns the configured secret", () => {
    expect(resolveAuthSecret({ BETTER_AUTH_SECRET: "  a-real-secret-value  " })).toBe(
      "a-real-secret-value",
    )
  })

  it("names the variable when it is unset", () => {
    expect(() => resolveAuthSecret({})).toThrow(/BETTER_AUTH_SECRET/)
  })

  it("names the variable when it is blank", () => {
    expect(() => resolveAuthSecret({ BETTER_AUTH_SECRET: "   " })).toThrow(
      /BETTER_AUTH_SECRET/,
    )
  })

  it("refuses better-auth's publicly known fallback", () => {
    expect(() => resolveAuthSecret({ BETTER_AUTH_SECRET: BETTER_AUTH_DEFAULT_SECRET })).toThrow(
      /publicly known/,
    )
  })
})

describe("the running instance", () => {
  it("does not sign cookies with the publicly known fallback", async () => {
    const { secret } = await auth.$context
    expect(secret).not.toBe(BETTER_AUTH_DEFAULT_SECRET)
  })
})

/**
 * `next build` imports every route module, `/api/auth/[...all]` among them, so
 * the builder stage has to carry a secret the way it already carries a database
 * URL. No runtime stage may carry one: a placeholder that reached production
 * would be a known signing key shipped in an image layer.
 */
describe("web/Dockerfile", () => {
  const stages = parseStages(
    fs.readFileSync(path.resolve(__dirname, "../../Dockerfile"), "utf8"),
  )

  it("gives the build a secret of its own", () => {
    const secret = stages.get("builder")?.env.BETTER_AUTH_SECRET
    expect(secret).toBeTruthy()
    expect(secret).not.toBe(BETTER_AUTH_DEFAULT_SECRET)
  })

  it("gives the build a base URL, which BetterAuth warns per route without", () => {
    expect(stages.get("builder")?.env.BETTER_AUTH_URL).toBeTruthy()
  })

  it("leaves every runtime stage to the deployment", () => {
    const runtime = [...stages.values()].filter((stage) => stage.cmd !== null)
    expect(runtime.map((stage) => stage.name).sort()).toEqual(["railway", "runner", "worker"])
    for (const stage of runtime) {
      expect(stage.env.BETTER_AUTH_SECRET).toBeUndefined()
    }
  })
})
