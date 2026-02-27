import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
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
      approve: vi.fn(),
      pause: vi.fn(),
      rerun: vi.fn(),
      analytics: vi.fn(),
      exportMarkdown: (id: string) => `http://localhost:8000/api/posts/${id}/export/markdown`,
      exportHtml: (id: string) => `http://localhost:8000/api/posts/${id}/export/html`,
      exportAll: (id: string) => `http://localhost:8000/api/posts/${id}/export/all`,
    },
    sseUrl: {
      post: (id: string) => `http://localhost:8000/api/events/${id}`,
      global: () => `http://localhost:8000/api/events`,
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
      expect(screen.getByText("Research")).toBeInTheDocument();
      expect(screen.getByText("Outline")).toBeInTheDocument();
      expect(screen.getByText("Draft")).toBeInTheDocument();
      expect(screen.getByText("Final")).toBeInTheDocument();
      expect(screen.getByText("Images")).toBeInTheDocument();
    });
  });

  it("shows Run Next and Run All buttons when not running or complete", async () => {
    const post = makePost({
      current_stage: "research",
      stage_status: {},
    });
    mockGet.mockResolvedValue(post);
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Run Next")).toBeInTheDocument();
      expect(screen.getByText("Run All")).toBeInTheDocument();
    });
  });

  it("shows Approve button when stage is in review", async () => {
    const post = makePost({
      current_stage: "research",
      stage_status: { research: "review" },
    });
    mockGet.mockResolvedValue(post);
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Approve")).toBeInTheDocument();
    });
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
      stage_status: {},
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

  it("renders stage logs when present", async () => {
    const post = makePost({
      stage_logs: {
        research: {
          model: "perplexity",
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
      expect(screen.getByText("Execution Logs")).toBeInTheDocument();
      expect(screen.getByText("perplexity")).toBeInTheDocument();
      expect(screen.getByText("In: 500")).toBeInTheDocument();
      expect(screen.getByText("Out: 1,200")).toBeInTheDocument();
    });
  });

  it("redirects to home on load failure", async () => {
    mockGet.mockRejectedValue(new Error("Not found"));
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/");
    });
  });
});
