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
    sseUrl: {
      global: () => "http://localhost:8000/api/events",
      post: (id: string) => `http://localhost:8000/api/events/${id}`,
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

const { queue } = await import("@/lib/api");
const mockStatus = vi.mocked(queue.status);
const mockPauseAll = vi.mocked(queue.pauseAll);
const mockResumeAll = vi.mocked(queue.resumeAll);

const testStats = {
  running: 2,
  pending: 5,
  review: 3,
  complete: 42,
  failed: 1,
  paused: 0,
  total: 53,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockStatus.mockResolvedValue(testStats);
  mockPauseAll.mockResolvedValue({ status: "ok", count: 3 });
  mockResumeAll.mockResolvedValue({ status: "ok", count: 2 });
});

describe("MonitorPage", () => {
  it("renders heading and subtitle", async () => {
    renderWithProviders(<MonitorPage />);

    expect(screen.getByText("Queue Monitor")).toBeInTheDocument();
    expect(
      screen.getByText("Auto-refreshes every 10 seconds")
    ).toBeInTheDocument();
  });

  it("calls queue.status on mount", async () => {
    renderWithProviders(<MonitorPage />);

    await waitFor(() => {
      expect(mockStatus).toHaveBeenCalled();
    });
  });

  it("shows loading skeletons initially", async () => {
    mockStatus.mockImplementation(() => new Promise(() => {}));

    renderWithProviders(<MonitorPage />);

    const skeletons = document
      .querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("renders stat cards with values", async () => {
    renderWithProviders(<MonitorPage />);

    await waitFor(() => {
      expect(screen.getByText("Running")).toBeInTheDocument();
    });

    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Awaiting Review")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();

    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("renders queue controls", async () => {
    renderWithProviders(<MonitorPage />);

    await waitFor(() => {
      expect(screen.getByText("Queue Controls")).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /pause all/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /resume all/i })
    ).toBeInTheDocument();
  });

  it("pause all calls queue.pauseAll", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MonitorPage />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /pause all/i })
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /pause all/i }));

    expect(mockPauseAll).toHaveBeenCalled();
  });

  it("resume all calls queue.resumeAll", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MonitorPage />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /resume all/i })
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /resume all/i }));

    expect(mockResumeAll).toHaveBeenCalled();
  });

  it("shows paused and failed counts", async () => {
    renderWithProviders(<MonitorPage />);

    await waitFor(() => {
      expect(screen.getByText("Queue Controls")).toBeInTheDocument();
    });

    expect(screen.getByText(/paused:/i)).toBeInTheDocument();
    expect(screen.getByText(/failed:/i)).toBeInTheDocument();

    const pausedLabel = screen.getByText(/paused:/i);
    expect(pausedLabel.closest("span")?.textContent).toMatch(/0/);

    const failedLabel = screen.getByText(/failed:/i);
    expect(failedLabel.closest("span")?.textContent).toMatch(/1/);
  });

  it("shows empty activity state", async () => {
    renderWithProviders(<MonitorPage />);

    await waitFor(() => {
      expect(screen.getByText("No recent activity")).toBeInTheDocument();
    });
  });

  it("renders refresh button", async () => {
    renderWithProviders(<MonitorPage />);

    const buttons = screen.getAllByRole("button");
    const iconButton = buttons.find(
      (btn) =>
        btn.querySelector("svg") !== null &&
        !btn.textContent?.trim()
    );

    expect(iconButton).toBeDefined();
  });
});
