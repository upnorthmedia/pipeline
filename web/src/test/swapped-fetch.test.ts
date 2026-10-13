/**
 * @vitest-environment node
 *
 * The contract the eleven fetch-swapping suites rest on: a swap does not
 * outlive the scope that installed it, on any path the scope can end on.
 *
 * The interesting cases are the ones a hand-rolled `afterEach` gets wrong. A
 * test that fails before its restore line, a second swap installed while the
 * first is live, and a swap installed in `beforeAll` and never taken down are
 * all silent: they change what later tests talk to without failing anything.
 * Each one is asserted here against the real global, not against a mock of it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { assertFetchNotLeaked, swapFetch, swapFetchForSuite } from "./swapped-fetch"

/**
 * The transport before anything in this file runs. `setup.ts` has already
 * loaded and installed nothing, so this is the same value the guard treats as
 * pristine.
 */
const pristineFetch = globalThis.fetch

/** A handler that answers everything with 204 and records nothing. */
const answerEmpty = () => new Response(null, { status: 204 })

describe("swapFetch", () => {
  it("installs the handler for the calling test", async () => {
    const seen: string[] = []
    swapFetch((input) => {
      seen.push(String(input))
      return new Response("ok", { status: 200 })
    })

    const response = await fetch("https://example.test/one")

    expect(globalThis.fetch).not.toBe(pristineFetch)
    expect(seen).toEqual(["https://example.test/one"])
    expect(await response.text()).toBe("ok")
  })

  it("has put the transport back by the next test", () => {
    expect(globalThis.fetch).toBe(pristineFetch)
  })

  it("hands the handler the transport it displaced", () => {
    let handed: typeof globalThis.fetch | undefined
    const { realFetch: displaced } = swapFetch((_input, _init, realFetch) => {
      handed = realFetch
      return answerEmpty()
    })

    expect(displaced).toBe(pristineFetch)
    return fetch("https://example.test/two").then(() => {
      expect(handed).toBe(pristineFetch)
    })
  })

  // `it.fails` runs the body and expects it to throw, which is the path a
  // hand-rolled restore placed at the end of a test never reaches.
  it.fails("a failing test still gets its restore", () => {
    swapFetch(answerEmpty)
    expect(globalThis.fetch).not.toBe(pristineFetch)
    throw new Error("this test fails on purpose")
  })

  it("has put the transport back after the failing test", () => {
    expect(globalThis.fetch).toBe(pristineFetch)
  })

  it("nests a second swap and unwinds it in the right order", async () => {
    swapFetch(() => new Response("outer", { status: 200 }))
    const outer = globalThis.fetch
    const { realFetch: displaced } = swapFetch(() => new Response("inner", { status: 200 }))

    // Two swaps in one test are sound because each restores what it displaced
    // and `onTestFinished` unwinds them in reverse order.
    expect(displaced).toBe(outer)
    expect(await (await fetch("https://example.test/nested")).text()).toBe("inner")
  })

  it("has unwound both nested swaps", () => {
    expect(globalThis.fetch).toBe(pristineFetch)
  })

  it("restores early when the test asks, and not twice", async () => {
    const swap = swapFetch(answerEmpty)
    expect(globalThis.fetch).not.toBe(pristineFetch)

    swap.restore()

    expect(globalThis.fetch).toBe(pristineFetch)
    // The end-of-test restore behind this one is a no-op rather than a second
    // assignment of a stale value.
    swap.restore()
    expect(globalThis.fetch).toBe(pristineFetch)
  })

  it("refuses to install over a swap made by hand", () => {
    const handRolled = (async () => answerEmpty()) as typeof globalThis.fetch
    globalThis.fetch = handRolled
    try {
      expect(() => swapFetch(answerEmpty)).toThrow(/already swapped/)
    } finally {
      globalThis.fetch = pristineFetch
    }
  })
})

describe("swapFetchForSuite", () => {
  const seen: string[] = []

  swapFetchForSuite((input) => {
    seen.push(String(input))
    return new Response("suite", { status: 200 })
  })

  it("is installed for the first test", async () => {
    expect(await (await fetch("https://example.test/a")).text()).toBe("suite")
  })

  it("is still installed for the last test", async () => {
    expect(await (await fetch("https://example.test/b")).text()).toBe("suite")
    expect(seen).toEqual(["https://example.test/a", "https://example.test/b"])
  })

  it("nests a per-test swap on top and comes back afterwards", async () => {
    const { realFetch: displaced } = swapFetch(() => new Response("inner", { status: 200 }))

    expect(await (await fetch("https://example.test/c")).text()).toBe("inner")
    // What the inner swap displaced is the suite's transport, not the pristine
    // one, so restoring it hands the suite back rather than skipping a level.
    expect(displaced).not.toBe(pristineFetch)
  })

  it("is the suite transport again once the nested swap is gone", async () => {
    expect(await (await fetch("https://example.test/d")).text()).toBe("suite")
  })
})

describe("after the suite-scoped swap", () => {
  it("the transport is pristine again", () => {
    expect(globalThis.fetch).toBe(pristineFetch)
  })
})

describe("assertFetchNotLeaked", () => {
  // This is the pattern the guard exists for: the swap of an earlier test,
  // still standing when the next one starts. Written by hand because no helper
  // in this repo can produce it any more.
  let leaked: typeof globalThis.fetch

  beforeAll(() => {
    leaked = (async () => answerEmpty()) as typeof globalThis.fetch
  })

  afterAll(() => {
    globalThis.fetch = pristineFetch
  })

  it("names the leak and repairs the transport", () => {
    globalThis.fetch = leaked

    expect(() => assertFetchNotLeaked()).toThrow(/left swapped by an earlier test/)
    expect(globalThis.fetch).toBe(pristineFetch)
  })

  it("passes when nothing is swapped", () => {
    expect(() => assertFetchNotLeaked()).not.toThrow()
  })

  it("passes while a sanctioned swap is live", () => {
    swapFetch(answerEmpty)

    expect(() => assertFetchNotLeaked()).not.toThrow()
  })
})
