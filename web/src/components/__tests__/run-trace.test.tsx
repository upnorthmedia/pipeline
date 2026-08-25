import { describe, it, expect, afterEach, vi } from "vitest";
import { screen, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { RunTrace } from "../run-trace";

function complete(stage: string, data: Record<string, unknown> = {}) {
  return {
    ts: "2026-08-23T10:00:00.000Z",
    stage,
    level: "info",
    event: "stage_complete",
    message: `Stage ${stage} complete`,
    data: {
      model: "claude-opus-4-6",
      tokens_in: 12_000,
      tokens_out: 3_400,
      duration_s: 41.2,
      cost_usd: 0.44,
      ...data,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RunTrace", () => {
  it("invites the user to start the pipeline when nothing has run", () => {
    renderWithProviders(<RunTrace executionLogs={[]} stageStatus={{}} />);
    expect(
      screen.getByText(
        "No run yet. Start the pipeline to see per-step status, timing, tokens and cost."
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows a completed stage's model, duration, tokens and cost", () => {
    renderWithProviders(
      <RunTrace executionLogs={[complete("research")]} stageStatus={{ research: "complete" }} />
    );
    // Scoped to the table: the header badges carry the run totals, which for a
    // one-stage run are the same strings.
    const table = within(screen.getByRole("table"));
    expect(table.getByText("claude-opus-4-6")).toBeInTheDocument();
    expect(table.getByText("41.2s")).toBeInTheDocument();
    expect(table.getByText("12,000 / 3,400")).toBeInTheDocument();
    expect(table.getByText("$0.44")).toBeInTheDocument();
  });

  it("totals tokens, cost and time for the run", () => {
    renderWithProviders(
      <RunTrace
        executionLogs={[
          complete("research", { tokens_in: 12_000, tokens_out: 3_400, cost_usd: 0.435, duration_s: 41.2 }),
          complete("outline", { tokens_in: 8_000, tokens_out: 1_600, cost_usd: 0.24, duration_s: 22.8 }),
        ]}
        stageStatus={{ research: "complete", outline: "complete" }}
      />
    );
    expect(screen.getByText("25,000 tokens")).toBeInTheDocument();
    expect(screen.getByText("$0.68")).toBeInTheDocument();
    expect(screen.getByText("1m 4s")).toBeInTheDocument();
  });

  it("counts elapsed time for the stage that is still running", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:10.000Z"));
    renderWithProviders(
      <RunTrace
        executionLogs={[complete("research"), { ts: "2026-08-23T10:00:00.000Z", stage: "outline", event: "stage_start" }]}
        stageStatus={{ research: "complete", outline: "running" }}
      />
    );
    expect(screen.getByText("10.0s")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText("13.0s")).toBeInTheDocument();
  });

  it("starts the clock from the live stage_start frame before any refetch", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:05.000Z"));
    renderWithProviders(
      <RunTrace
        executionLogs={[]}
        stageStatus={{ research: "running" }}
        liveStart={{ stage: "research", at: "2026-08-23T10:00:00.000Z" }}
      />
    );
    expect(screen.getByText("5.0s")).toBeInTheDocument();
  });

  it("names a suspended stage as awaiting review", () => {
    renderWithProviders(
      <RunTrace
        executionLogs={[complete("research")]}
        stageStatus={{ research: "complete", outline: "review" }}
      />
    );
    expect(screen.getByText("Awaiting review")).toBeInTheDocument();
  });

  it("shows retries with the error that caused each one", () => {
    renderWithProviders(
      <RunTrace
        executionLogs={[
          { ts: "2026-08-23T10:00:00.000Z", stage: "write", event: "stage_start" },
          {
            ts: "2026-08-23T10:00:30.000Z",
            stage: "write",
            level: "warning",
            event: "retry",
            message: "Pipeline attempt 1 failed, retrying...",
            data: { attempt: 1, max_attempts: 3, error: "429 rate limited" },
          },
          { ts: "2026-08-23T10:00:31.000Z", stage: "write", event: "stage_start" },
          complete("write"),
        ]}
        stageStatus={{ write: "complete" }}
      />
    );
    expect(screen.getByText("Attempt 1 of 3 failed: 429 rate limited")).toBeInTheDocument();
  });

  it("shows a failed stage with its error text", () => {
    renderWithProviders(
      <RunTrace
        executionLogs={[
          { ts: "2026-08-23T10:00:00.000Z", stage: "images", event: "stage_start" },
          {
            ts: "2026-08-23T10:01:00.000Z",
            stage: "images",
            level: "error",
            event: "stage_error",
            message: "Pipeline failed after 3 attempts: 503 model overloaded",
            data: { error: "503 model overloaded", attempts: 3, moved_to_dlq: true },
          },
        ]}
        stageStatus={{ images: "failed" }}
      />
    );
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("503 model overloaded")).toBeInTheDocument();
  });

  it("shows a failure that named no stage above the table", () => {
    renderWithProviders(
      <RunTrace
        executionLogs={[
          complete("research"),
          {
            ts: "2026-08-23T10:01:00.000Z",
            stage: "",
            level: "error",
            event: "stage_error",
            message: "Pipeline failed after 3 attempts: worker died",
            data: { error: "worker died", attempts: 3, moved_to_dlq: true },
          },
        ]}
        stageStatus={{ research: "complete" }}
      />
    );
    expect(screen.getByText("worker died")).toBeInTheDocument();
  });

  it("prices a sub-cent run at four decimal places rather than rounding it to zero", () => {
    renderWithProviders(
      <RunTrace
        executionLogs={[complete("research", { cost_usd: 0.000105, tokens_in: 5, tokens_out: 1 })]}
        stageStatus={{ research: "complete" }}
      />
    );
    expect(within(screen.getByRole("table")).getByText("$0.0001")).toBeInTheDocument();
  });

  /**
   * The publish leg (ledger P3.2b-ii). Every publish entry carries `stage: ""`,
   * so before this the one view built for watching a run ended at `ready` and
   * said nothing about the step most likely to fail on something outside this
   * app.
   */
  /**
   * A gate is the only status on this table that is waiting on the reader
   * rather than on a machine, so it is the only one that carries a control.
   * Ledger item P2.109b.
   */
  describe("review gate", () => {
    it("offers to release the stage the run is parked at", async () => {
      const user = userEvent.setup();
      const onApprove = vi.fn();
      renderWithProviders(
        <RunTrace
          executionLogs={[complete("research")]}
          stageStatus={{ research: "complete", outline: "review" }}
          onApprove={onApprove}
        />
      );

      const table = within(screen.getByRole("table"));
      expect(table.getByText("Nothing runs until you release this stage.")).toBeInTheDocument();
      await user.click(table.getByRole("button", { name: "Approve Outline" }));

      expect(onApprove).toHaveBeenCalledWith("outline");
    });

    it("shows no control on a trace nothing can act on", () => {
      renderWithProviders(
        <RunTrace
          executionLogs={[complete("research")]}
          stageStatus={{ research: "complete", outline: "review" }}
        />
      );

      expect(screen.queryByRole("button", { name: /^Approve/ })).not.toBeInTheDocument();
      // The status itself is still reported, which is what makes the absence
      // of the button about the handler and not about the row.
      expect(within(screen.getByRole("table")).getAllByText("Awaiting review").length).toBe(1);
    });

    /**
     * Ledger item P4.5. The gate published a frame and stored nothing, so a
     * released stage read exactly like a stage that had never waited: the
     * reader who was not watching at the time had no way to tell a run that
     * went straight through from one that sat in front of a person for four
     * minutes.
     */
    it("says how long a released stage waited, which its numbers do not", () => {
      renderWithProviders(
        <RunTrace
          executionLogs={[
            {
              ts: "2026-08-23T09:00:00.000Z",
              stage: "outline",
              level: "info",
              event: "stage_review",
              message: "Stage outline paused for review",
              data: { mode: "review" },
            },
            {
              ts: "2026-08-23T09:04:12.000Z",
              stage: "outline",
              level: "info",
              event: "stage_start",
              message: "Starting outline...",
            },
            complete("outline"),
          ]}
          stageStatus={{ outline: "complete" }}
        />
      );

      const table = within(screen.getByRole("table"));
      expect(
        table.getByText("Waited 4m 12s for review before this step ran.")
      ).toBeInTheDocument();
      // The stage's own duration is untouched by the wait: a gate costs time
      // the run did not spend working, which is the whole reason the trace
      // reports the two separately.
      expect(table.getByText("41.2s")).toBeInTheDocument();
    });

    it("says nothing about a review on a stage that never waited", () => {
      renderWithProviders(
        <RunTrace executionLogs={[complete("research")]} stageStatus={{ research: "complete" }} />
      );
      expect(screen.queryByText(/for review before this step ran/)).not.toBeInTheDocument();
    });

    it("puts the control on the parked stage and nowhere else", () => {
      const onApprove = vi.fn();
      renderWithProviders(
        <RunTrace
          executionLogs={[complete("research")]}
          stageStatus={{ research: "complete", outline: "review", write: "pending" }}
          onApprove={onApprove}
        />
      );

      const buttons = screen
        .getAllByRole("button")
        .map((b) => b.textContent)
        .filter((text) => text?.startsWith("Approve"));
      expect(buttons).toEqual(["Approve Outline"]);
    });
  });

  describe("publish leg", () => {
    const wpStart = {
      ts: "2026-08-23T11:00:00.000Z",
      stage: "",
      level: "info",
      event: "publish_start",
      message: "Publishing to WordPress...",
      data: { target: "wordpress" },
    };

    it("shows no publish row for a post whose format publishes nowhere", () => {
      renderWithProviders(
        <RunTrace executionLogs={[complete("ready")]} stageStatus={{ ready: "complete" }} />
      );
      expect(screen.queryByText(/^Publish to/)).not.toBeInTheDocument();
    });

    it("names the destination and times the attempt", () => {
      renderWithProviders(
        <RunTrace
          executionLogs={[
            complete("ready"),
            wpStart,
            {
              ts: "2026-08-23T11:00:09.000Z",
              stage: "",
              level: "info",
              event: "publish_complete",
              message: "Published to WordPress: https://example.com/?p=900",
              data: { target: "wordpress" },
            },
          ]}
          stageStatus={{ ready: "complete" }}
          publish={{ target: "wordpress", status: "published" }}
        />
      );
      const table = within(screen.getByRole("table"));
      expect(table.getByText("Publish to WordPress")).toBeInTheDocument();
      expect(table.getByText("9.0s")).toBeInTheDocument();
    });

    it("shows a failed publish with the reason, without its destination prefix", () => {
      renderWithProviders(
        <RunTrace
          executionLogs={[
            complete("ready"),
            wpStart,
            {
              ts: "2026-08-23T11:00:04.000Z",
              stage: "",
              level: "error",
              event: "publish_error",
              message: "WordPress publish failed: 401 Unauthorized",
              data: { target: "wordpress" },
            },
          ]}
          stageStatus={{ ready: "complete" }}
          publish={{ target: "wordpress", status: "failed" }}
        />
      );
      const table = within(screen.getByRole("table"));
      expect(table.getByText("Failed")).toBeInTheDocument();
      expect(table.getByText("401 Unauthorized")).toBeInTheDocument();
    });

    it("counts elapsed time for a publish that is still running", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-23T11:00:06.000Z"));
      renderWithProviders(
        <RunTrace
          executionLogs={[complete("ready"), wpStart]}
          stageStatus={{ ready: "complete" }}
          publish={{ target: "nextjs", status: "publishing" }}
        />
      );
      expect(screen.getByText("Publish to Next.js")).toBeInTheDocument();
      expect(screen.getByText("Running")).toBeInTheDocument();
    });

    it("keeps the publish out of the run totals, which are stage measurements", () => {
      renderWithProviders(
        <RunTrace
          executionLogs={[
            complete("ready", { duration_s: 41.2, cost_usd: 0.44, tokens_in: 12_000, tokens_out: 3_400 }),
            wpStart,
            {
              ts: "2026-08-23T11:00:09.000Z",
              stage: "",
              event: "publish_complete",
              message: "Published to WordPress: https://example.com/?p=900",
              data: { target: "wordpress" },
            },
          ]}
          stageStatus={{ ready: "complete" }}
          publish={{ target: "wordpress", status: "published" }}
        />
      );
      // Scoped to the header badges: the `ready` stage's own 41.2s is the same
      // string in the table, and the point here is which of the two the totals
      // are, not that the string exists.
      const totals = within(screen.getByRole("group", { name: "Run totals" }));
      expect(totals.getByText("41.2s")).toBeInTheDocument();
      expect(totals.getByText("15,400 tokens")).toBeInTheDocument();
      expect(within(screen.getByRole("table")).getByText("9.0s")).toBeInTheDocument();
    });

    it("shows the queued publish of a post whose run has not started", () => {
      renderWithProviders(
        <RunTrace
          executionLogs={[]}
          stageStatus={{}}
          publish={{ target: "wordpress", status: "pending" }}
        />
      );
      expect(
        screen.getByText(
          "No run yet. Start the pipeline to see per-step status, timing, tokens and cost."
        )
      ).toBeInTheDocument();
    });
  });
  /**
   * The fan-out's counts (ledger P3.2c). `images` is the one stage whose
   * "running" hides a count and whose "complete" can hide a failure, and its
   * per-image lines never reached a browser at all before this.
   */
  describe("image progress", () => {
    function imageLine(outcome: "generated" | "failed", index: number) {
      return outcome === "generated"
        ? {
            ts: "2026-08-23T10:00:10.000Z",
            stage: "images",
            level: "info",
            event: "image_generated",
            message: `Image ${index} generated (91231 bytes)`,
            data: { index, bytes: 91231, path: `/media/p1/image-${index}.png` },
          }
        : {
            ts: "2026-08-23T10:00:10.000Z",
            stage: "images",
            level: "error",
            event: "image_failed",
            message: `Image ${index} failed: 429 RESOURCE_EXHAUSTED`,
            data: { index, error: "429 RESOURCE_EXHAUSTED" },
          };
    }

    it("counts the images a running stage has produced so far", () => {
      renderWithProviders(
        <RunTrace
          executionLogs={[
            { ts: "2026-08-23T10:00:00.000Z", stage: "images", event: "stage_start" },
            imageLine("generated", 0),
            imageLine("generated", 1),
          ]}
          stageStatus={{ images: "running" }}
        />
      );
      expect(screen.getByText("2 images generated")).toBeInTheDocument();
    });

    it("says how many failed beside how many were generated", () => {
      renderWithProviders(
        <RunTrace
          executionLogs={[
            { ts: "2026-08-23T10:00:00.000Z", stage: "images", event: "stage_start" },
            imageLine("generated", 0),
            imageLine("failed", 1),
          ]}
          stageStatus={{ images: "complete" }}
        />
      );
      expect(screen.getByText("1 image generated, 1 failed")).toBeInTheDocument();
    });

    it("says so when every image failed, which the stage status does not", () => {
      renderWithProviders(
        <RunTrace
          executionLogs={[
            { ts: "2026-08-23T10:00:00.000Z", stage: "images", event: "stage_start" },
            imageLine("failed", 0),
            imageLine("failed", 1),
          ]}
          stageStatus={{ images: "complete" }}
        />
      );
      expect(screen.getByText("2 images failed")).toBeInTheDocument();
    });

    it("counts the live frames for a stage whose trail has not been refetched", () => {
      renderWithProviders(
        <RunTrace
          executionLogs={[]}
          stageStatus={{ images: "running" }}
          liveStart={{ stage: "images", at: "2026-08-23T10:00:00.000Z" }}
          liveImages={[
            { index: 0, outcome: "generated" },
            { index: 1, outcome: "generated" },
            { index: 2, outcome: "failed" },
          ]}
        />
      );
      expect(screen.getByText("2 images generated, 1 failed")).toBeInTheDocument();
    });

    it("shows no count for a stage that has produced no image line", () => {
      renderWithProviders(
        <RunTrace executionLogs={[complete("research")]} stageStatus={{ research: "complete" }} />
      );
      expect(screen.queryByText(/images generated/)).not.toBeInTheDocument();
    });
  });
});
