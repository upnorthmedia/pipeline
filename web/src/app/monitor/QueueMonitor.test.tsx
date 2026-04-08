import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MonitorPage from "./page";
import { renderWithProviders } from "@/test/render";

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
      global: () => "http://localhost:8055/api/events",
      post: (id: string) => `http://localhost:8055/api/events/${id}`,
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

const testStats = {
  running: 2,
  pending: 5,
  complete: 42,
  failed: 1,
  paused: 0,
  total: 50,
};

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

  it("shows subtitle text", async () => {
    renderWithProviders(<MonitorPage />);
    expect(
      screen.getByText("Pipeline analytics, costs, model performance, and logs")
    ).toBeInTheDocument();
  });
});
