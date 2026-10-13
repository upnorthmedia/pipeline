// @vitest-environment node
/**
 * `toPydanticIso()` is the one place the port reproduces how FastAPI wrote a
 * `datetime` field, and every ported serializer that returns a timestamp goes
 * through it.
 *
 * The expected strings below are not written by hand. Each one is the value
 * `jsonable_encoder` produced for the same instant under the versions the
 * Python stack ran, re-measured against pydantic 2.12.5 and FastAPI 0.141.1
 * with the transcript in `docs/polish/evidence/p2.md#p230`. Both encoders
 * agree, and both disagree with `Date.toISOString()`.
 */
import { describe, expect, it } from "vitest"

import { toPydanticIso } from "./pydantic"

describe("toPydanticIso", () => {
  it("drops the fractional second entirely when it is zero", () => {
    expect(toPydanticIso(new Date("2026-08-22T12:34:56.000Z"))).toBe("2026-08-22T12:34:56Z")
  })

  it("pads a fractional second to pydantic's six digits", () => {
    // `Date` carries milliseconds, so the last three are always zero, but the
    // width is pydantic's: it never trims and never shortens.
    expect(toPydanticIso(new Date("2026-08-22T12:34:56.789Z"))).toBe("2026-08-22T12:34:56.789000Z")
  })

  it("keeps a trailing zero inside the fraction", () => {
    // The case that separates pydantic from a trim-trailing-zeros rule:
    // `datetime(..., microsecond=700000)` encodes as `.700000`, not `.7`.
    expect(toPydanticIso(new Date("2026-08-22T12:34:56.700Z"))).toBe("2026-08-22T12:34:56.700000Z")
  })

  it("keeps a leading zero inside the fraction", () => {
    expect(toPydanticIso(new Date("2026-08-22T12:34:56.007Z"))).toBe("2026-08-22T12:34:56.007000Z")
  })

  it("carries a null through", () => {
    expect(toPydanticIso(null)).toBeNull()
  })
})
