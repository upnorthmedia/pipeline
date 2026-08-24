import { describe, expect, it } from "vitest";

import type { PostStage, StageStatusMap } from "./api";
import { deriveRunState } from "./run-state";

const state = (currentStage: PostStage, stageStatus: StageStatusMap = {}) =>
  deriveRunState({ currentStage, stageStatus });

describe("deriveRunState", () => {
  it("calls a post nothing has run yet not started", () => {
    expect(state("pending")).toMatchObject({ kind: "not_started", label: "Not started" });
  });

  it("names the stage that is running", () => {
    const s = state("write", { research: "complete", write: "running" });
    expect(s).toMatchObject({ kind: "running", label: "Running Write", runningStage: "write" });
  });

  it("names the stage a review gate is holding, and says it waits on a person", () => {
    const s = state("outline", { research: "complete", outline: "review" });
    expect(s.kind).toBe("review");
    expect(s.label).toBe("Waiting for you");
    expect(s.detail).toBe("Outline is holding for your review before the run continues.");
    expect(s.reviewStages).toEqual(["outline"]);
  });

  it("reports a finished run with a failed stage as finished with errors, not complete", () => {
    const s = state("complete", {
      research: "complete",
      outline: "complete",
      write: "complete",
      edit: "complete",
      images: "failed",
      ready: "complete",
    });
    expect(s.kind).toBe("finished_with_errors");
    expect(s.label).toBe("Finished with errors");
    expect(s.detail).toBe("The run reached the end, but Images failed.");
    expect(s.failedStages).toEqual(["images"]);
  });

  it("counts every failed stage in the sentence when more than one failed", () => {
    const s = state("complete", { research: "failed", images: "failed", ready: "complete" });
    expect(s.detail).toBe("The run reached the end, but Research and Images failed.");
    expect(s.failedStages).toEqual(["research", "images"]);
  });

  it("calls a run that stopped on a failure failed, and names where", () => {
    const s = state("images", { research: "complete", images: "failed" });
    expect(s).toMatchObject({ kind: "failed", label: "Failed at Images" });
  });

  it("reports a run given up on with no stage marked failed", () => {
    const s = state("failed", { research: "complete" });
    expect(s).toMatchObject({ kind: "failed", label: "Failed" });
  });

  it("calls a clean finished run complete", () => {
    const s = state("complete", {
      research: "complete",
      outline: "complete",
      write: "complete",
      edit: "complete",
      images: "complete",
      ready: "complete",
    });
    expect(s).toMatchObject({ kind: "complete", label: "Complete", detail: null });
    expect(s.failedStages).toEqual([]);
  });

  it("lets the worker's terminal failure stamp outrank a stage left stuck on running", () => {
    // `markPipelineFailed()` writes `current_stage = "failed"` without touching
    // `stage_status`, so the stage that threw is still recorded as running. The
    // run is over; the map is stale.
    expect(state("failed", { research: "running" })).toMatchObject({
      kind: "failed",
      label: "Failed",
    });
  });

  it("names the stage that failed on a run the worker gave up on", () => {
    expect(state("failed", { research: "complete", write: "failed" })).toMatchObject({
      kind: "failed",
      label: "Failed at Write",
    });
  });

  it("reports paused", () => {
    expect(state("paused", { research: "complete" })).toMatchObject({
      kind: "paused",
      label: "Paused",
    });
  });

  it("reports paused over the stage the pause left running", () => {
    // Pausing overwrites `current_stage` and nothing else, so the stage the
    // post was on stays `running` in the map. The label the operator set is
    // what the row says about itself.
    expect(state("paused", { write: "running" })).toMatchObject({
      kind: "paused",
      label: "Paused",
    });
  });

  it("lets a live stage outrank a failure earlier in the same run", () => {
    const s = state("ready", { images: "failed", ready: "running" });
    expect(s.kind).toBe("running");
    expect(s.failedStages).toEqual(["images"]);
  });

  it("falls back to the stage the row names when nothing else applies", () => {
    expect(state("edit", { research: "complete" })).toMatchObject({
      kind: "in_progress",
      label: "Edit",
    });
  });
});
