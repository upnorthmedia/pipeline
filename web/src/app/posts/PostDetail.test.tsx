import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PostDetailPage from "./[id]/page";
import { renderWithProviders } from "@/test/render";
import { makePost, makeCompletedPost, makeAnalytics } from "@/test/fixtures";

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/posts/post-1",
  useParams: () => ({ id: "post-1" }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    posts: {
      get: vi.fn(),
      update: vi.fn(),
      run: vi.fn(),
      runAll: vi.fn(),
      pause: vi.fn(),
      rerun: vi.fn(),
      restart: vi.fn(),
      analytics: vi.fn(),
      publish: vi.fn(),
      exportMarkdown: (id: string) => `/api/posts/${id}/export/markdown`,
      exportHtml: (id: string) => `/api/posts/${id}/export/html`,
      exportAll: (id: string) => `/api/posts/${id}/export/all`,
    },
    sseUrl: {
      post: (id: string) => `/api/events/${id}`,
      global: () => `/api/events`,
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

vi.mock("@uiw/react-codemirror", () => ({
  __esModule: true,
  default: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
    <textarea
      data-testid="codemirror-mock"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

vi.mock("react-markdown", () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div data-testid="markdown-preview">{children}</div>,
}));

vi.mock("remark-gfm", () => ({
  __esModule: true,
  default: () => {},
}));

const { posts } = await import("@/lib/api");
const mockGet = vi.mocked(posts.get);
const mockAnalytics = vi.mocked(posts.analytics);
const mockRun = vi.mocked(posts.run);
const mockRerun = vi.mocked(posts.rerun);

beforeEach(() => {
  vi.clearAllMocks();
  mockAnalytics.mockRejectedValue(new Error("no analytics"));
});

describe("PostDetailPage", () => {
  it("shows loading skeleton initially", () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    mockAnalytics.mockReturnValue(new Promise(() => {}));
    const { container } = renderWithProviders(<PostDetailPage />);
    const skeletons = container.querySelectorAll("[class*='animate-pulse']");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("renders post topic after loading", async () => {
    const post = makePost({ topic: "My Great Post" });
    mockGet.mockResolvedValue(post);
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("My Great Post")).toBeInTheDocument();
    });
  });

  it("renders post slug", async () => {
    const post = makePost({ slug: "my-great-post" });
    mockGet.mockResolvedValue(post);
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("my-great-post")).toBeInTheDocument();
    });
  });

  it("renders pipeline progress component", async () => {
    const post = makePost({
      stage_status: { research: "complete", outline: "running" },
      current_stage: "outline",
    });
    mockGet.mockResolvedValue(post);
    const { container } = renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      // Full mode pipeline progress has 9x9 circles
      const circles = container.querySelectorAll(".h-9.w-9");
      expect(circles).toHaveLength(6);
    });
  });

  it("renders stage tabs", async () => {
    const post = makeCompletedPost();
    mockGet.mockResolvedValue(post);
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      // By role: the run trace names the same stages in its own table.
      expect(screen.getByRole("tab", { name: "Research" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Outline" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Draft" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Editing" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Images" })).toBeInTheDocument();
    });
  });

  it("offers Run Pipeline on a post that has never run", async () => {
    const post = makePost({ current_stage: "research", stage_status: {} });
    mockGet.mockResolvedValue(post);
    mockRun.mockResolvedValue({ status: "queued", stage: "research" });
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("This post has not run yet")).toBeInTheDocument();
    });
    // The two re-run controls are meaningless before a first run.
    expect(screen.queryByText("Rerun Stage")).not.toBeInTheDocument();
    expect(screen.queryByText("Force Restart")).not.toBeInTheDocument();

    await user.click(screen.getAllByText("Run Pipeline")[0]);
    expect(mockRun).toHaveBeenCalledWith("post-1");
  });

  it("shows Pause button when a stage is running", async () => {
    const post = makePost({
      current_stage: "research",
      stage_status: { research: "running" },
    });
    mockGet.mockResolvedValue(post);
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Pause")).toBeInTheDocument();
    });
  });

  it("shows Export dropdown when content is available", async () => {
    const post = makeCompletedPost();
    mockGet.mockResolvedValue(post);
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Export")).toBeInTheDocument();
    });
  });

  it("shows stage content in tab", async () => {
    const post = makePost({
      research_content: "Research findings go here",
      stage_status: { research: "complete" },
      current_stage: "outline",
    });
    mockGet.mockResolvedValue(post);
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      // With CodeMirror editor, content is in the editor component
      expect(screen.getByTestId("markdown-editor")).toBeInTheDocument();
      expect(screen.getByText("Research Output")).toBeInTheDocument();
    });
  });

  it("shows empty state for stages without content", async () => {
    const post = makePost({
      current_stage: "research",
      stage_status: { research: "failed" },
    });
    mockGet.mockResolvedValue(post);
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText("No research content yet")
      ).toBeInTheDocument();
    });
  });

  it("renders analytics card when available", async () => {
    const post = makeCompletedPost();
    const analytics = makeAnalytics();
    mockGet.mockResolvedValue(post);
    mockAnalytics.mockResolvedValue(analytics);
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Analytics")).toBeInTheDocument();
      expect(screen.getByText("2,150")).toBeInTheDocument(); // word_count
      expect(screen.getByText("64.2")).toBeInTheDocument(); // flesch
    });
  });

  it("renders SEO checklist items", async () => {
    const post = makeCompletedPost();
    const analytics = makeAnalytics();
    mockGet.mockResolvedValue(post);
    mockAnalytics.mockResolvedValue(analytics);
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("SEO Checklist")).toBeInTheDocument();
      expect(screen.getByText("Title Contains Keyword")).toBeInTheDocument();
    });
  });

  it("renders keyword density badges", async () => {
    const post = makeCompletedPost();
    const analytics = makeAnalytics();
    mockGet.mockResolvedValue(post);
    mockAnalytics.mockResolvedValue(analytics);
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Keyword Density")).toBeInTheDocument();
      expect(screen.getByText("primary keyword: 1.5%")).toBeInTheDocument();
    });
  });

  it("reports per-stage cost through the run trace", async () => {
    const post = makePost({
      execution_logs: [
        {
          ts: "2026-01-01T00:00:00.000Z",
          stage: "research",
          level: "info",
          event: "stage_complete",
          message: "Stage research complete",
          data: {
            model: "sonar-pro",
            tokens_in: 500,
            tokens_out: 1200,
            duration_s: 4.5,
            cost_usd: 0.012,
          },
        },
      ],
      stage_logs: {
        research: {
          model: "sonar-pro",
          tokens_in: 500,
          tokens_out: 1200,
          duration_s: 4.5,
          cost_usd: 0.012,
        },
      },
      stage_status: { research: "complete" },
      research_content: "Content here",
    });
    mockGet.mockResolvedValue(post);
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Run Trace")).toBeInTheDocument();
    });
    expect(screen.getByText("sonar-pro")).toBeInTheDocument();
    expect(screen.getByText("500 / 1,200")).toBeInTheDocument();
    expect(screen.getAllByText("$0.01").length).toBeGreaterThan(0);
    // The separate "Cost Tracking" card said the same thing from a column the
    // trace cross-checks against `stage_status`; only the trace is left.
    expect(screen.queryByText("Cost Tracking")).not.toBeInTheDocument();
  });

  it("shows the server's message and a working retry when the load fails", async () => {
    // Previously this redirected to `/` with a toast, which took the operator
    // off the post with nothing to read and nothing to retry.
    mockGet.mockRejectedValueOnce(new Error(JSON.stringify({ detail: "Post not found" })));
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Could not load this post")).toBeInTheDocument();
    });
    expect(screen.getByText("Post not found")).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();

    mockGet.mockResolvedValue(makePost({ topic: "Back again" }));
    await user.click(screen.getByText("Retry"));
    await waitFor(() => {
      expect(screen.getByText("Back again")).toBeInTheDocument();
    });
  });

  it("falls back to its own wording when the failure carries no message", async () => {
    mockGet.mockRejectedValue(new Error(""));
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText("The request failed and the server gave no reason.")
      ).toBeInTheDocument();
    });
  });

  it("keeps the post on screen when a refetch fails and offers a retry", async () => {
    const post = makePost({
      topic: "Still here",
      stage_status: { research: "complete" },
      research_content: "Content here",
    });
    mockGet.mockResolvedValueOnce(post);
    mockRerun.mockResolvedValue({ status: "queued", mode: "rerun", rerun_from: "research" });
    mockGet.mockRejectedValueOnce(new Error(JSON.stringify({ detail: "Database is down" })));
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Still here")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Rerun Stage"));
    await waitFor(() => {
      expect(screen.getByText("This post is out of date")).toBeInTheDocument();
    });
    expect(screen.getByText("Database is down")).toBeInTheDocument();
    // The last good render is still there behind the banner.
    expect(screen.getByText("Still here")).toBeInTheDocument();
  });

  it("shows an analytics error with a retry when analytics fails", async () => {
    mockGet.mockResolvedValue(makePost());
    mockAnalytics.mockRejectedValueOnce(
      new Error(JSON.stringify({ detail: "Analytics is unavailable" }))
    );
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Analytics unavailable")).toBeInTheDocument();
    });
    expect(screen.getByText("Analytics is unavailable")).toBeInTheDocument();

    mockAnalytics.mockResolvedValue(makeAnalytics());
    await user.click(screen.getByText("Retry"));
    await waitFor(() => {
      expect(screen.getByText("SEO Checklist")).toBeInTheDocument();
    });
  });
});
