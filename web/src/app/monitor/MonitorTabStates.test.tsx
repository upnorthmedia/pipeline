import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { OverviewTab } from "./_components/overview-tab";
import { CostsTab } from "./_components/costs-tab";
import { ModelsTab } from "./_components/models-tab";
import { LogsTab } from "./_components/logs-tab";
import MonitorLoading from "./loading";

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
      list: vi.fn(),
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

const { queue, analytics, profiles } = await import("@/lib/api");
const mockStatus = vi.mocked(queue.status);
const mockDashboard = vi.mocked(analytics.dashboard);
const mockCosts = vi.mocked(analytics.costs);
const mockModels = vi.mocked(analytics.models);
const mockLogs = vi.mocked(analytics.logs);
const mockProfiles = vi.mocked(profiles.list);

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

const emptyDashboard = {
  by_status: {},
  total: 0,
  complete: 0,
  completion_rate: 0,
  avg_duration_s: null,
  by_profile: [],
  over_time: [],
  posts_today: 0,
};

const testCosts = {
  total_tokens_in: 1000,
  total_tokens_out: 500,
  total_cost: 1.25,
  avg_cost_per_post: 0.25,
  by_model: { "claude-opus-5": { tokens_in: 1000, tokens_out: 500, cost_usd: 1.25, calls: 5 } },
  by_stage: { write: { tokens_in: 1000, tokens_out: 500, cost_usd: 1.25, calls: 5 } },
  by_profile: [{ name: "Test Blog", cost_usd: 1.25 }],
  cost_over_time: [{ date: "2026-03-01", cost_usd: 1.25 }],
  model_costs_reference: {},
};

const emptyCosts = {
  total_tokens_in: 0,
  total_tokens_out: 0,
  total_cost: 0,
  avg_cost_per_post: 0,
  by_model: {},
  by_stage: {},
  by_profile: [],
  cost_over_time: [],
  model_costs_reference: {},
};

const testModels = {
  models: [
    {
      model: "claude-opus-5",
      call_count: 5,
      avg_tokens_in: 1000,
      avg_tokens_out: 500,
      avg_duration_s: 12.5,
      total_cost: 1.25,
    },
  ],
  stage_performance: [{ stage: "write", runs: 5, avg_duration_s: 12.5, total_cost: 1.25 }],
  stage_success_rates: [
    { stage: "write", total: 5, complete: 5, failed: 0, success_rate: 100 },
  ],
};

const emptyModels = { models: [], stage_performance: [], stage_success_rates: [] };

const testLogs = {
  items: [
    {
      post_id: "p1",
      slug: "a-post",
      topic: "A post",
      timestamp: "2026-03-01T10:00:00Z",
      stage: "write",
      level: "info",
      event: "stage_complete",
      message: "wrote 1200 words",
      data: null,
    },
  ],
  total: 1,
  page: 1,
  per_page: 50,
  pages: 1,
};

const emptyLogs = { items: [], total: 0, page: 1, per_page: 50, pages: 0 };

function detail(message: string): Error {
  return new Error(JSON.stringify({ detail: message }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStatus.mockResolvedValue(testStats);
  mockDashboard.mockResolvedValue(testDashboard);
  mockCosts.mockResolvedValue(testCosts);
  mockModels.mockResolvedValue(testModels);
  mockLogs.mockResolvedValue(testLogs);
  mockProfiles.mockResolvedValue([]);
});

describe("OverviewTab async states", () => {
  it("shows the server's reason and a retry when the first load fails", async () => {
    mockStatus.mockRejectedValue(detail("queue backend unreachable"));
    mockDashboard.mockRejectedValue(detail("queue backend unreachable"));

    renderWithProviders(<OverviewTab />);

    expect(await screen.findByText("queue backend unreachable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry overview/i })).toBeInTheDocument();
    expect(screen.queryByText("Total Posts")).not.toBeInTheDocument();
  });

  it("retry refetches and renders the data", async () => {
    const user = userEvent.setup();
    mockStatus.mockRejectedValueOnce(detail("queue backend unreachable"));
    mockDashboard.mockRejectedValueOnce(detail("queue backend unreachable"));

    renderWithProviders(<OverviewTab />);
    await screen.findByRole("button", { name: /retry overview/i });

    await user.click(screen.getByRole("button", { name: /retry overview/i }));

    expect(await screen.findByText("Total Posts")).toBeInTheDocument();
    expect(screen.queryByText("queue backend unreachable")).not.toBeInTheDocument();
  });

  it("keeps the last good render and warns when a later refresh fails", async () => {
    const user = userEvent.setup();
    renderWithProviders(<OverviewTab />);
    await screen.findByText("Total Posts");

    mockDashboard.mockRejectedValue(detail("database is down"));
    await user.click(screen.getByRole("button", { name: /refresh overview/i }));

    expect(await screen.findByText(/database is down/)).toBeInTheDocument();
    expect(screen.getByText("Total Posts")).toBeInTheDocument();
  });

  it("offers the action that fills the page when there are no posts", async () => {
    mockDashboard.mockResolvedValue(emptyDashboard);

    renderWithProviders(<OverviewTab />);

    expect(await screen.findByText(/no posts yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /new post/i })).toHaveAttribute(
      "href",
      "/posts/new"
    );
  });
});

describe("CostsTab async states", () => {
  it("shows the server's reason and a retry when the load fails", async () => {
    mockCosts.mockRejectedValue(detail("analytics query timed out"));

    renderWithProviders(<CostsTab />);

    expect(await screen.findByText("analytics query timed out")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry costs/i })).toBeInTheDocument();
    expect(screen.queryByText("Total Spend")).not.toBeInTheDocument();
  });

  it("retry refetches and renders the data", async () => {
    const user = userEvent.setup();
    mockCosts.mockRejectedValueOnce(detail("analytics query timed out"));

    renderWithProviders(<CostsTab />);
    await user.click(await screen.findByRole("button", { name: /retry costs/i }));

    expect(await screen.findByText("Total Spend")).toBeInTheDocument();
  });

  it("names the pipeline as what fills the tab when nothing has run", async () => {
    mockCosts.mockResolvedValue(emptyCosts);

    renderWithProviders(<CostsTab />);

    expect(await screen.findByText(/no spend recorded yet/i)).toBeInTheDocument();
  });

  it("offers a clear when a model filter is what emptied the tab", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CostsTab />);
    await screen.findByText("Total Spend");

    mockCosts.mockResolvedValue(emptyCosts);
    await user.click(screen.getByRole("button", { name: "Perplexity sonar-pro" }));

    expect(
      await screen.findByRole("button", { name: /clear model filter/i })
    ).toBeInTheDocument();
  });
});

describe("ModelsTab async states", () => {
  it("shows the server's reason and a retry when the load fails", async () => {
    mockModels.mockRejectedValue(detail("execution_logs unavailable"));

    renderWithProviders(<ModelsTab />);

    expect(await screen.findByText("execution_logs unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry models/i })).toBeInTheDocument();
    expect(screen.queryByText(/no model data yet/i)).not.toBeInTheDocument();
  });

  it("retry refetches and renders the data", async () => {
    const user = userEvent.setup();
    mockModels.mockRejectedValueOnce(detail("execution_logs unavailable"));

    renderWithProviders(<ModelsTab />);
    await user.click(await screen.findByRole("button", { name: /retry models/i }));

    expect(await screen.findByText("claude-opus-5")).toBeInTheDocument();
  });

  it("offers a clear when a model filter is what emptied the tab", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ModelsTab />);
    await screen.findByText("claude-opus-5");

    mockModels.mockResolvedValue(emptyModels);
    await user.click(screen.getByRole("button", { name: "Perplexity sonar-pro" }));

    expect(
      await screen.findByRole("button", { name: /clear model filter/i })
    ).toBeInTheDocument();
  });
});

describe("LogsTab async states", () => {
  it("shows the server's reason and a retry when the load fails", async () => {
    mockLogs.mockRejectedValue(detail("log query failed"));

    renderWithProviders(<LogsTab />);

    expect(await screen.findByText("log query failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry logs/i })).toBeInTheDocument();
    expect(screen.queryByText(/no logs match your filters/i)).not.toBeInTheDocument();
  });

  it("retry refetches and renders the rows", async () => {
    const user = userEvent.setup();
    mockLogs.mockRejectedValueOnce(detail("log query failed"));

    renderWithProviders(<LogsTab />);
    await user.click(await screen.findByRole("button", { name: /retry logs/i }));

    expect(await screen.findByText("wrote 1200 words")).toBeInTheDocument();
  });

  it("distinguishes an account with no logs from a filter that matched none", async () => {
    mockLogs.mockResolvedValue(emptyLogs);

    renderWithProviders(<LogsTab />);

    expect(await screen.findByText(/no logs recorded yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/no logs match your filters/i)).not.toBeInTheDocument();
  });

  it("says so when the profile filter could not be loaded", async () => {
    mockProfiles.mockRejectedValue(detail("profiles unavailable"));

    renderWithProviders(<LogsTab />);

    expect(await screen.findByText(/profile filter unavailable/i)).toBeInTheDocument();
  });
});

describe("monitor route skeleton", () => {
  it("mirrors the page's first paint: tab strip, stat cards and charts", () => {
    renderWithProviders(<MonitorLoading />);

    expect(screen.getAllByTestId("monitor-tab-skeleton")).toHaveLength(4);
    expect(screen.getAllByTestId("monitor-stat-skeleton")).toHaveLength(4);
    expect(screen.getAllByTestId("monitor-chart-skeleton")).toHaveLength(2);
  });
});
