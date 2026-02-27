import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
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

    it("applies blue color to review stages", () => {
      const stageStatus: StageStatusMap = { outline: "review" };
      const { container } = renderWithProviders(
        <PipelineProgress stageStatus={stageStatus} currentStage="outline" />
      );
      const blueRing = container.querySelector(".ring-blue-500\\/30");
      expect(blueRing).toBeInTheDocument();
    });

    it("applies red color to failed stages", () => {
      const stageStatus: StageStatusMap = { write: "failed" };
      const { container } = renderWithProviders(
        <PipelineProgress stageStatus={stageStatus} currentStage="write" />
      );
      const redRing = container.querySelector(".ring-red-500\\/30");
      expect(redRing).toBeInTheDocument();
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
