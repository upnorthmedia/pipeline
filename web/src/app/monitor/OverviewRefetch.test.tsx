/**
 * What an SSE frame costs the monitor's overview tab.
 *
 * The tab holds a queue-wide feed open, and every frame on that feed used to
 * call `fetchData()`: `queue.status()` plus `analytics.dashboard()`, six
 * aggregate queries over `posts`. The feed carries a `log` per stage message
 * and, since the images fan-out started announcing itself, two frames per
 * generated image, so one running post turned an open monitor page into dozens
 * of aggregates. None of those frames change a number this tab renders.
 *
 * These cases pin both halves of the rule: the frames that do change the
 * numbers still refresh them (coalesced into one request per burst), and the
 * frames that do not are feed entries only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { makeQueueStatus } from "@/test/fixtures";
import { OverviewTab } from "./_components/overview-tab";
import type { SSEEvent } from "@/hooks/use-sse";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    queue: {
      status: vi.fn(),
      pauseAll: vi.fn(),
      resumeAll: vi.fn(),
    },
    analytics: {
      dashboard: vi.fn(),
      costs: vi.fn(),
      models: vi.fn(),
      logs: vi.fn(),
    },
    sseUrl: {
      global: () => "/api/events",
      post: (id: string) => `/api/events/${id}`,
    },
  };
});

vi.mock("@/hooks/use-sse", () => ({
  useSSE: vi.fn(() => ({ connected: false, lastEvent: null })),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container">{children}</div>
    ),
  };
});

const { queue, analytics } = await import("@/lib/api");
const { useSSE } = await import("@/hooks/use-sse");
const mockStatus = vi.mocked(queue.status);
const mockDashboard = vi.mocked(analytics.dashboard);
const mockUseSSE = vi.mocked(useSSE);

const testStats = makeQueueStatus({
  running: 2,
  not_started: 5,
  complete: 42,
  failed: 1,
  total: 50,
});

const testDashboard = {
  by_status: { research: 2, pending: 5, complete: 42, failed: 1 },
  total: 50,
  complete: 42,
  completion_rate: 84.0,
  avg_duration_s: 300,
  by_profile: [{ name: "Test Blog", count: 20 }],
  over_time: [{ date: "2026-03-01", count: 5 }],
  posts_today: 3,
};

/** The callback the tab handed `useSSE`, i.e. the one the feed would call. */
function feed(): (event: SSEEvent) => void {
  const call = mockUseSSE.mock.calls.at(-1);
  if (!call?.[1]) throw new Error("OverviewTab did not subscribe to the feed");
  return call[1];
}

/** Deliver frames the way the feed does, back to back with no gap. */
async function publish(...events: SSEEvent[]) {
  await act(async () => {
    for (const event of events) feed()(event);
  });
}

/**
 * Past the coalescing window and no further: the tab also refetches on a 10s
 * interval, and this must never be long enough to reach it.
 */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
}

async function mountLoaded() {
  renderWithProviders(<OverviewTab />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByText("Total Posts")).toBeInTheDocument();
  mockStatus.mockClear();
  mockDashboard.mockClear();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockStatus.mockResolvedValue(testStats);
  mockDashboard.mockResolvedValue(testDashboard);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("OverviewTab feed refetching", () => {
  it("does not re-query the aggregates for a frame that cannot change them", async () => {
    await mountLoaded();

    // The three `publish_*` frames were here until ledger item P4.9b, when
    // `GET /api/queue` began reporting the publishes that have stopped moving.
    // They now accompany a write to a column that response reads, so they are
    // in the case below instead.
    await publish(
      { event: "log", post_id: "p1", stage: "images", message: "Generating image 2" },
      { event: "image_generated", post_id: "p1", stage: "images", index: 1 },
      { event: "image_failed", post_id: "p1", stage: "images", index: 2 }
    );
    await settle();

    expect(mockDashboard).not.toHaveBeenCalled();
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("still shows those frames in the activity feed", async () => {
    await mountLoaded();

    await publish({ event: "image_generated", post_id: "abcdef1234", stage: "images" });

    expect(screen.getByText("image_generated")).toBeInTheDocument();
    expect(screen.getByText("1 events")).toBeInTheDocument();
  });

  it("re-queries the aggregates when a stage frame changes them", async () => {
    await mountLoaded();

    await publish({ event: "stage_complete", post_id: "p1", stage: "write" });
    await settle();

    expect(mockDashboard).toHaveBeenCalledTimes(1);
    expect(mockStatus).toHaveBeenCalledTimes(1);
  });

  it.each([
    "stage_start",
    "stage_complete",
    "stage_error",
    "pipeline_complete",
    "run_paused",
    // A publish frame cannot make a stall appear, which happens with no event
    // behind it, but it is how one leaves: each of the three writes the status
    // column `publish_stalled` is derived from.
    "publish_start",
    "publish_complete",
    "publish_error",
  ])(
    "treats %s as a frame that changes the numbers",
    async (event) => {
      await mountLoaded();

      await publish({ event, post_id: "p1", stage: "write" });
      await settle();

      expect(mockDashboard).toHaveBeenCalledTimes(1);
    }
  );

  it("collapses a burst of stage frames into one round trip", async () => {
    await mountLoaded();

    await publish(
      { event: "stage_complete", post_id: "p1", stage: "write" },
      { event: "stage_start", post_id: "p1", stage: "edit" },
      { event: "stage_complete", post_id: "p2", stage: "research" },
      { event: "stage_start", post_id: "p2", stage: "outline" }
    );
    await settle();

    expect(mockDashboard).toHaveBeenCalledTimes(1);
  });

  it("collapses frames that arrive a moment apart, not only in one batch", async () => {
    await mountLoaded();

    await publish({ event: "stage_complete", post_id: "p1", stage: "write" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await publish({ event: "stage_start", post_id: "p1", stage: "edit" });
    await settle();

    expect(mockDashboard).toHaveBeenCalledTimes(1);
  });

  it("refetches again for a frame that arrives after the window closed", async () => {
    await mountLoaded();

    await publish({ event: "stage_complete", post_id: "p1", stage: "write" });
    await settle();
    await publish({ event: "stage_complete", post_id: "p1", stage: "edit" });
    await settle();

    expect(mockDashboard).toHaveBeenCalledTimes(2);
  });

  it("does not fire a scheduled refetch after the tab unmounts", async () => {
    const { unmount } = renderWithProviders(<OverviewTab />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const notify = feed();
    mockDashboard.mockClear();

    await act(async () => {
      notify({ event: "stage_complete", post_id: "p1", stage: "write" });
    });
    unmount();
    await settle();

    expect(mockDashboard).not.toHaveBeenCalled();
  });
});
