import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MonitorPage from "./page";
import { renderWithProviders } from "@/test/render";
import { makeQueueStatus } from "@/test/fixtures";

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
    profiles: {
      list: vi.fn().mockResolvedValue([]),
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
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

// Mock recharts ResponsiveContainer (throws in test env without DOM dimensions)
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
const mockStatus = vi.mocked(queue.status);
const mockPauseAll = vi.mocked(queue.pauseAll);
const mockResumeAll = vi.mocked(queue.resumeAll);
const mockDashboard = vi.mocked(analytics.dashboard);

/**
 * One line of the Queue Controls strip, by its whole reading.
 *
 * Each line is a label text node beside a value in its own `<span>`, and
 * `getNodeText` joins only an element's direct text children, so plain
 * `getByText("Running: 2")` never matches. This asks for the innermost element
 * whose `textContent` is the line, which is the line's own wrapper.
 */
function queueLine(text: string): HTMLElement {
  return screen.getByText((_content, element) => {
    if (!element || element.textContent !== text) return false;
    return !Array.from(element.children).some((child) => child.textContent === text);
  });
}

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

beforeEach(() => {
  vi.clearAllMocks();
  mockStatus.mockResolvedValue(testStats);
  mockPauseAll.mockResolvedValue({ status: "ok", count: 3 });
  mockResumeAll.mockResolvedValue({ status: "ok", count: 2 });
  mockDashboard.mockResolvedValue(testDashboard);
});

describe("MonitorPage", () => {
  it("renders page heading", async () => {
    renderWithProviders(<MonitorPage />);
    expect(screen.getByText("Observability")).toBeInTheDocument();
  });

  it("renders all four tabs", async () => {
    renderWithProviders(<MonitorPage />);
    expect(screen.getByRole("tab", { name: /overview/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /costs/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /models/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /logs/i })).toBeInTheDocument();
  });

  it("overview tab is active by default", async () => {
    renderWithProviders(<MonitorPage />);
    const overviewTab = screen.getByRole("tab", { name: /overview/i });
    expect(overviewTab).toHaveAttribute("data-state", "active");
  });

  it("calls queue.status and analytics.dashboard on mount", async () => {
    renderWithProviders(<MonitorPage />);
    await waitFor(() => {
      expect(mockStatus).toHaveBeenCalled();
      expect(mockDashboard).toHaveBeenCalled();
    });
  });

  it("shows stat cards with dashboard values", async () => {
    renderWithProviders(<MonitorPage />);
    await waitFor(() => {
      expect(screen.getByText("Total Posts")).toBeInTheDocument();
    });

    expect(screen.getByText("50")).toBeInTheDocument();
    expect(screen.getByText("84%")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("renders queue controls with pause/resume buttons", async () => {
    renderWithProviders(<MonitorPage />);
    await waitFor(() => {
      expect(screen.getByText("Queue Controls")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /pause all/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resume all/i })).toBeInTheDocument();
  });

  it("pause all calls queue.pauseAll", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MonitorPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /pause all/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /pause all/i }));
    expect(mockPauseAll).toHaveBeenCalled();
  });

  it("resume all calls queue.resumeAll", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MonitorPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /resume all/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /resume all/i }));
    expect(mockResumeAll).toHaveBeenCalled();
  });

  it("shows empty activity state", async () => {
    renderWithProviders(<MonitorPage />);
    await waitFor(() => {
      expect(screen.getByText("No recent activity")).toBeInTheDocument();
    });
  });

  it("names each queue line the way the posts list names one row", async () => {
    renderWithProviders(<MonitorPage />);
    await waitFor(() => {
      expect(screen.getByText("Queue Controls")).toBeInTheDocument();
    });

    // The five standing lines, in the vocabulary `deriveRunState()` puts on a
    // badge. `Pending` was the old name for the fifth and it named the
    // `current_stage` value rather than anything a reader recognises.
    expect(queueLine("Running: 2")).toBeInTheDocument();
    expect(queueLine("Waiting for you: 0")).toBeInTheDocument();
    expect(queueLine("Not started: 5")).toBeInTheDocument();
    expect(queueLine("Paused: 0")).toBeInTheDocument();
    expect(queueLine("Failed: 1")).toBeInTheDocument();
    expect(screen.queryByText(/^Pending:/)).not.toBeInTheDocument();
  });

  it("counts a run caught between two stages as running", async () => {
    mockStatus.mockResolvedValue(makeQueueStatus({ running: 2, in_progress: 3, total: 5 }));
    renderWithProviders(<MonitorPage />);

    await waitFor(() => {
      expect(queueLine("Running: 5")).toBeInTheDocument();
    });
  });

  it("says nothing about finished with errors when no run has any", async () => {
    renderWithProviders(<MonitorPage />);
    await waitFor(() => {
      expect(queueLine("Failed: 1")).toBeInTheDocument();
    });

    expect(screen.queryByText(/Finished with errors/)).not.toBeInTheDocument();
  });

  it("shows finished with errors as its own line once a run has one", async () => {
    mockStatus.mockResolvedValue(makeQueueStatus({ finished_with_errors: 2, complete: 1, total: 3 }));
    renderWithProviders(<MonitorPage />);

    await waitFor(() => {
      expect(queueLine("Finished with errors: 2")).toBeInTheDocument();
    });
    expect(queueLine("Failed: 0")).toBeInTheDocument();
  });

  it("shows subtitle text", async () => {
    renderWithProviders(<MonitorPage />);
    expect(
      screen.getByText("Pipeline analytics, costs, model performance, and logs")
    ).toBeInTheDocument();
  });
});
