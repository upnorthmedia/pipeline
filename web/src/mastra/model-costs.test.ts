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

import { stageCostUsd } from "./execution-log"
import { MODEL_COSTS, type ModelCost } from "./model-costs"
import { MODEL_STAGES, STAGE_MODEL_ALLOWLIST, STAGE_MODEL_PROVIDER } from "./stage-models"

/**
 * Anthropic's per-million-token rates for every Claude model a stage can be
 * configured to run, read from the model pricing table at
 * <https://platform.claude.com/docs/en/about-claude/pricing> on 2026-08-24.
 *
 * Only Anthropic's models are pinned here, and only the selectable ones. The
 * rest of `MODEL_COSTS` cannot be checked this way: `sonar-pro` is on no
 * allowlist and is kept solely to price the runs already recorded against it,
 * and the two Gemini image models are billed per image rather than per token,
 * so the numbers in their rows are the per-million-token rate the provider
 * quotes alongside a bill this table cannot reconstruct.
 */
const ANTHROPIC_PUBLISHED_RATES: Record<string, ModelCost> = {
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-opus-4-6": { input: 5.0, output: 25.0 },
  "claude-fable-5": { input: 10.0, output: 50.0 },
}

function selectableAnthropicModels(): string[] {
  const models = MODEL_STAGES.filter((stage) => STAGE_MODEL_PROVIDER[stage] === "anthropic").flatMap(
    (stage) => STAGE_MODEL_ALLOWLIST[stage],
  )
  return [...new Set(models)].sort()
}

describe("MODEL_COSTS", () => {
  it("prices every model any stage can be configured to run", () => {
    const unpriced = MODEL_STAGES.flatMap((stage) =>
      STAGE_MODEL_ALLOWLIST[stage]
        .filter((model) => !(model in MODEL_COSTS))
        .map((model) => `${stage}: ${model}`),
    )
    expect(unpriced).toEqual([])
  })

  /**
   * A selectable model's row is what prices the *next* run, so it has to be the
   * rate the provider charges today rather than the one it charged when the row
   * was written. Nothing recomputes a historical cost from this table: every
   * `stage_logs` entry carries the `cost_usd` it was written with and
   * `GET /api/analytics/costs` sums those stored numbers, so repricing a row
   * moves future runs only.
   */
  it("prices every selectable Claude model at Anthropic's published rate", () => {
    const wrong = selectableAnthropicModels()
      .map((model) => ({ model, published: ANTHROPIC_PUBLISHED_RATES[model], row: MODEL_COSTS[model] }))
      .filter(({ published, row }) => published === undefined || row?.input !== published.input || row?.output !== published.output)
    expect(wrong).toEqual([])
  })

  it("prices a run on claude-opus-4-6 at what Anthropic bills for it", () => {
    // A million tokens each way at $5 / $25 per MTok.
    expect(stageCostUsd(1_000_000, 1_000_000, "claude-opus-4-6")).toBe(30)
  })

  it("quotes both directions as a positive dollars-per-million-tokens rate", () => {
    for (const [model, cost] of Object.entries(MODEL_COSTS)) {
      expect(cost.input, model).toBeGreaterThan(0)
      expect(cost.output, model).toBeGreaterThan(0)
    }
  })
})
