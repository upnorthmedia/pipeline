/**
 * One way to swap `globalThis.fetch` in a test, and one guard that proves no
 * swap outlives the scope that installed it.
 *
 * Eleven suites replace the global transport: five agent suites, the API key
 * validator, the api-keys route, the settings-to-provider end-to-end suite, the
 * images-generate step suite, the Gemini client suite and the api client suite.
 * A swap left installed changes what every later test in the file talks to,
 * which is a silent result change rather than a failure, so the discipline has
 * to be mechanical rather than a habit:
 *
 * - `swapFetch` restores through `onTestFinished`, which vitest runs on every
 *   path a test can end on, including a failed assertion and a timeout. A
 *   caller cannot forget an `afterEach`, because there is no `afterEach`.
 * - `swapFetchForSuite` registers its own `beforeAll`/`afterAll` pair, for the
 *   suites whose transport is genuinely suite-wide.
 * - Both refuse to install over a swap they did not make, so the mistake that
 *   turns a restore into a permanent replacement (capturing an existing fake as
 *   "the real fetch" and later restoring *that*) throws instead.
 * - `assertFetchNotLeaked` runs from `setup.ts` before every test in every
 *   file, and fails the run if anything left the global swapped.
 */
import { afterAll, beforeAll, onTestFinished } from "vitest"

/**
 * The transport as it was before any test module loaded. `setup.ts` imports
 * this module, and setup files evaluate before the test file, so nothing has
 * had a chance to swap it yet.
 */
const pristineFetch = globalThis.fetch

/** Swaps currently installed through this module, innermost last. */
const installed: (typeof globalThis.fetch)[] = []

/** What `globalThis.fetch` is supposed to be right now. */
function expectedFetch(): typeof globalThis.fetch {
  return installed[installed.length - 1] ?? pristineFetch
}

/**
 * A stand-in transport. `realFetch` is whatever this swap displaced, for the
 * handlers that answer some hosts and let the rest through.
 */
export type FetchHandler = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  realFetch: typeof globalThis.fetch,
) => Response | Promise<Response>

export interface Swap {
  /** The transport this swap displaced. */
  readonly realFetch: typeof globalThis.fetch
  /** Put the displaced transport back. Calling it twice is a no-op. */
  restore(): void
}

function install(handler: FetchHandler): Swap {
  const realFetch = globalThis.fetch
  if (realFetch !== expectedFetch()) {
    throw new Error(
      "globalThis.fetch was already swapped by something other than swapFetch(). " +
        "Installing over it would capture the existing fake as the real transport " +
        "and make the eventual restore permanent. Restore the first swap first.",
    )
  }

  const swapped = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(input, init, realFetch))) as typeof globalThis.fetch
  installed.push(swapped)
  globalThis.fetch = swapped

  let done = false
  return {
    realFetch,
    restore() {
      if (done) return
      done = true
      if (installed[installed.length - 1] !== swapped) {
        throw new Error("fetch swaps were restored out of order")
      }
      installed.pop()
      globalThis.fetch = realFetch
    },
  }
}

/**
 * Swap `globalThis.fetch` for the rest of the calling test, and put it back
 * however the test ends.
 *
 * `realFetch` is the transport this displaced, for handlers that answer some
 * hosts and let the rest through. `restore` is for the tests that need the
 * transport back mid-test; the end-of-test restore then does nothing.
 */
export function swapFetch(handler: FetchHandler): Swap {
  const swap = install(handler)
  onTestFinished(() => swap.restore())
  return swap
}

/**
 * Swap `globalThis.fetch` for one suite. Call it in the suite body, not in a
 * hook: it registers the `beforeAll` that installs and the `afterAll` that
 * restores, so the swap covers exactly the suite and no test after it. The
 * handler runs during the suite, so it may close over values its own
 * `beforeAll` sets.
 */
export function swapFetchForSuite(handler: FetchHandler): void {
  let swap: Swap | undefined
  beforeAll(() => {
    swap = install(handler)
  })
  afterAll(() => {
    swap?.restore()
    swap = undefined
  })
}

/**
 * Throw if `globalThis.fetch` is not what the currently installed swaps say it
 * should be, after repairing it so the rest of the file still runs against a
 * sound transport. Called from `setup.ts` before every test, which is the one
 * point that is guaranteed to be after every `afterEach` of the previous test
 * and after every `beforeAll` of the enclosing suites.
 */
export function assertFetchNotLeaked(): void {
  const expected = expectedFetch()
  if (globalThis.fetch === expected) return
  const leaked = globalThis.fetch
  globalThis.fetch = expected
  throw new Error(
    "globalThis.fetch was left swapped by an earlier test or hook in this file " +
      `(${(leaked as { name?: string }).name || "anonymous"}). Use swapFetch() from ` +
      "src/test/swapped-fetch.ts, which restores on every path, or restore the swap " +
      "in the same scope that installed it. The transport has been repaired for the " +
      "rest of this file.",
  )
}
