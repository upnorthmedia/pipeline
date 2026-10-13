import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PipelineProgress } from "./pipeline-progress";
import { renderWithProviders } from "@/test/render";
import type { StageStatusMap } from "@/lib/api";

describe("PipelineProgress", () => {
  describe("compact mode", () => {
    it("renders 6 stage dots", () => {
      const { container } = renderWithProviders(
        <PipelineProgress stageStatus={{}} currentStage="research" compact />
      );
      const dots = container.querySelectorAll(".rounded-full.h-2.w-2");
      expect(dots).toHaveLength(6);
    });

    it("shows completion count", () => {
      const stageStatus: StageStatusMap = {
        research: "complete",
        outline: "complete",
        write: "running",
      };
      renderWithProviders(
        <PipelineProgress
          stageStatus={stageStatus}
          currentStage="write"
          compact
        />
      );
      expect(screen.getByText("2/6")).toBeInTheDocument();
    });

    it("shows 0/6 when no stages complete", () => {
      renderWithProviders(
        <PipelineProgress stageStatus={{}} currentStage="pending" compact />
      );
      expect(screen.getByText("0/6")).toBeInTheDocument();
    });

    it("shows 6/6 when all stages complete", () => {
      const all: StageStatusMap = {
        research: "complete",
        outline: "complete",
        write: "complete",
        edit: "complete",
        images: "complete",
        ready: "complete",
      };
      renderWithProviders(
        <PipelineProgress stageStatus={all} currentStage="complete" compact />
      );
      expect(screen.getByText("6/6")).toBeInTheDocument();
    });

    it("applies pulse animation to running stages", () => {
      const stageStatus: StageStatusMap = { research: "running" };
      const { container } = renderWithProviders(
        <PipelineProgress
          stageStatus={stageStatus}
          currentStage="research"
          compact
        />
      );
      const pulsingDot = container.querySelector(".animate-pulse");
      expect(pulsingDot).toBeInTheDocument();
    });
  });

  describe("full mode", () => {
    it("renders 6 stage circles", () => {
      const { container } = renderWithProviders(
        <PipelineProgress stageStatus={{}} currentStage="research" />
      );
      // Full mode uses h-9 w-9 circles
      const circles = container.querySelectorAll(".h-9.w-9");
      expect(circles).toHaveLength(6);
    });

    it("renders connector lines between stages", () => {
      const { container } = renderWithProviders(
        <PipelineProgress stageStatus={{}} currentStage="research" />
      );
      // 5 connectors between 6 stages
      const connectors = container.querySelectorAll(".h-px.w-8");
      expect(connectors).toHaveLength(5);
    });

    it("applies emerald color to completed stages", () => {
      const stageStatus: StageStatusMap = { research: "complete" };
      const { container } = renderWithProviders(
        <PipelineProgress stageStatus={stageStatus} currentStage="outline" />
      );
      const emeraldRing = container.querySelector(".ring-emerald-500\\/30");
      expect(emeraldRing).toBeInTheDocument();
    });

    it("applies amber color to running stages", () => {
      const stageStatus: StageStatusMap = { research: "running" };
      const { container } = renderWithProviders(
        <PipelineProgress stageStatus={stageStatus} currentStage="research" />
      );
      const amberRing = container.querySelector(".ring-amber-500\\/30");
      expect(amberRing).toBeInTheDocument();
    });

    it("applies red color to failed stages", () => {
      const stageStatus: StageStatusMap = { write: "failed" };
      const { container } = renderWithProviders(
        <PipelineProgress stageStatus={stageStatus} currentStage="write" />
      );
      const redRing = container.querySelector(".ring-red-500\\/30");
      expect(redRing).toBeInTheDocument();
    });

    it("stops spinning a stage the run died in, and names it failed", () => {
      // Polish ledger P5.1. `markPipelineFailed()` stamps the stage it can
      // name, but rows written before it did, and failures whose step the
      // engine could not identify, still record the stage as running under
      // `current_stage = "failed"`. Painting an amber spinner on a dead run is
      // the same lie the run trace's elapsed clock was telling.
      const stageStatus: StageStatusMap = { research: "complete", write: "running" };
      const { container } = renderWithProviders(
        <PipelineProgress stageStatus={stageStatus} currentStage="failed" />
      );
      expect(container.querySelector(".ring-amber-500\\/30")).not.toBeInTheDocument();
      expect(container.querySelector(".ring-red-500\\/30")).toBeInTheDocument();
      expect(screen.getByLabelText("Write: Failed")).toBeInTheDocument();
    });

    it("highlights active stage with ring-offset", () => {
      const stageStatus: StageStatusMap = { research: "running" };
      const { container } = renderWithProviders(
        <PipelineProgress stageStatus={stageStatus} currentStage="research" />
      );
      const activeRing = container.querySelector(".ring-offset-2");
      expect(activeRing).toBeInTheDocument();
    });

    it("shows emerald connector after completed stage", () => {
      const stageStatus: StageStatusMap = {
        research: "complete",
        outline: "running",
      };
      const { container } = renderWithProviders(
        <PipelineProgress stageStatus={stageStatus} currentStage="outline" />
      );
      const emeraldConnector = container.querySelector(
        ".h-px.w-8.bg-emerald-500\\/50"
      );
      expect(emeraldConnector).toBeInTheDocument();
    });

    it("tells a stage awaiting review apart from one that has not started", () => {
      // The defect: `STATUS_STYLES` had no `review` entry, so a stage parked
      // in front of a reviewer fell through to the `pending` style and painted
      // the same grey circle as a stage nothing had reached yet.
      const parked = renderWithProviders(
        <PipelineProgress stageStatus={{ research: "review" }} currentStage="research" />
      );
      const skyRing = parked.container.querySelector(".ring-sky-500\\/30");
      expect(skyRing).toBeInTheDocument();

      const untouched = renderWithProviders(
        <PipelineProgress stageStatus={{}} currentStage="research" />
      );
      expect(untouched.container.querySelector(".ring-sky-500\\/30")).toBeNull();
    });

    it("names a status in the user's terms rather than by its stored value", () => {
      renderWithProviders(
        <PipelineProgress stageStatus={{ research: "review" }} currentStage="research" />
      );
      expect(screen.getByLabelText("Research: Awaiting review")).toBeInTheDocument();
      expect(screen.queryByLabelText("Research: review")).toBeNull();
    });

    // The aria-label above went through `stageStatusLabel`; the tooltip body a
    // sighted mouse user actually reads printed the stored value with a
    // `capitalize` class over it, so a parked stage read "Review" there and
    // "Awaiting review" one line up in the same component.
    it("names the status in the tooltip body too", async () => {
      const user = userEvent.setup();
      renderWithProviders(
        <PipelineProgress stageStatus={{ research: "review" }} currentStage="research" />
      );

      await user.hover(screen.getByLabelText("Research: Awaiting review"));

      // Radix renders the content twice: once on screen and once in the
      // visually-hidden live region it announces through.
      expect(await screen.findAllByText("Awaiting review")).not.toHaveLength(0);
      expect(screen.queryAllByText("review")).toHaveLength(0);
    });

    it("applies spin animation to running icon", () => {
      const stageStatus: StageStatusMap = { research: "running" };
      const { container } = renderWithProviders(
        <PipelineProgress stageStatus={stageStatus} currentStage="research" />
      );
      const spinningIcon = container.querySelector(".animate-spin");
      expect(spinningIcon).toBeInTheDocument();
    });
  });
});
