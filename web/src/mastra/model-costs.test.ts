// @vitest-environment node
/**
 * The price table has to cover every model the app can actually run.
 *
 * `stageCostUsd()` prices an unpriced model at zero, which is Python's rule for
 * `MODEL_COSTS.get(model, ...)` and is the honest answer for a model nobody has
 * published a rate for. It is only honest while no *selectable* model is
 * missing: a model in `STAGE_MODEL_ALLOWLIST` with no row here would put a
 * silent $0.00 on every stage a user ran with it. This is the check that keeps
 * adding a model to the allowlist and forgetting its price from being a quiet
 * accounting hole.
 */
import { describe, expect, it } from "vitest"

import { MODEL_COSTS } from "./model-costs"
import { STAGE_MODEL_ALLOWLIST } from "./stage-models"
import { STAGES } from "./state"

describe("MODEL_COSTS", () => {
  it("prices every model any stage can be configured to run", () => {
    const unpriced = STAGES.flatMap((stage) =>
      STAGE_MODEL_ALLOWLIST[stage]
        .filter((model) => !(model in MODEL_COSTS))
        .map((model) => `${stage}: ${model}`),
    )
    expect(unpriced).toEqual([])
  })

  it("quotes both directions as a positive dollars-per-million-tokens rate", () => {
    for (const [model, cost] of Object.entries(MODEL_COSTS)) {
      expect(cost.input, model).toBeGreaterThan(0)
      expect(cost.output, model).toBeGreaterThan(0)
    }
  })
})
