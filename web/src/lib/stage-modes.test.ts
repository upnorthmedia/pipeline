// @vitest-environment node
/**
 * The two vocabularies the dashboard shares with the pipeline: the `StageMode`
 * values that live in `stage_settings`, and the `StageStatus` values that live
 * in `stage_status`.
 *
 * Node environment because the cross-check imports `REVIEW_MODES` from the
 * step module, which pulls the Drizzle schema in with it. `stages.ts` itself
 * has no DOM dependency, so the labels are just as testable here.
 */
import { describe, it, expect } from "vitest"

import { DEFAULT_GATE_MODE, REVIEW_MODES } from "@/mastra/steps/stage-io"

import {
  STAGE_MODE_LABELS,
  STAGE_STATUS_LABELS,
  effectiveStageMode,
  stageModeLabel,
  stageModeStopsRun,
} from "./stages"

describe("STAGE_MODE_LABELS", () => {
  it("names every mode the pipeline acts on", () => {
    // The defect: the client union was `"auto"` alone, so the three-valued
    // column the gate reads had one expressible value in the dashboard.
    expect(Object.keys(STAGE_MODE_LABELS).sort()).toEqual(
      ["auto", ...REVIEW_MODES].sort(),
    )
  })

  it("says what each mode does rather than repeating the stored value", () => {
    expect(STAGE_MODE_LABELS.auto).toBe("Run automatically")
    expect(STAGE_MODE_LABELS.review).toBe("Wait for review")
    expect(STAGE_MODE_LABELS.approve_only).toBe("Wait for approval")
  })

  it("labels an unrecognised mode as it came", () => {
    expect(stageModeLabel("auto")).toBe("Run automatically")
    expect(stageModeLabel("skip")).toBe("skip")
  })
})

describe("STAGE_STATUS_LABELS", () => {
  it("names the suspension, which is the one status no content column implies", () => {
    expect(STAGE_STATUS_LABELS.review).toBe("Awaiting review")
  })

  it("names the other four", () => {
    expect(STAGE_STATUS_LABELS.pending).toBe("Pending")
    expect(STAGE_STATUS_LABELS.running).toBe("Running")
    expect(STAGE_STATUS_LABELS.complete).toBe("Complete")
    expect(STAGE_STATUS_LABELS.failed).toBe("Failed")
  })
})

describe("effectiveStageMode", () => {
  it("reads the mode the settings name", () => {
    expect(effectiveStageMode("outline", { outline: "review" })).toBe("review")
    expect(effectiveStageMode("outline", { outline: "auto" })).toBe("auto")
  })

  // The defect this exists for: a profile row that names five stages parks the
  // run at the sixth, and a dashboard that fell back to "auto" would show a
  // run that never stops and then stop it.
  it("falls back to the pipeline's own default for a stage the settings omit", () => {
    expect(effectiveStageMode("ready", { research: "auto" })).toBe(DEFAULT_GATE_MODE)
  })

  it("reads a whole missing column as unattended, as the pipeline does", () => {
    // `post.stageSettings || defaultStageSettings()` in `post-state.ts`.
    expect(effectiveStageMode("ready", null)).toBe("auto")
    expect(effectiveStageMode("ready", undefined)).toBe("auto")
  })

  it("stops the run for exactly the modes the gate acts on", () => {
    for (const mode of REVIEW_MODES) expect(stageModeStopsRun(mode)).toBe(true)
    expect(stageModeStopsRun("auto")).toBe(false)
  })
})
