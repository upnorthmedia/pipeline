import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PostDetailPage from "./[id]/page";
import { renderWithProviders } from "@/test/render";
import { makePost, makeCompletedPost, makeAnalytics } from "@/test/fixtures";
import { STAGES } from "@/lib/api";
import { STAGE_LABELS } from "@/lib/stages";

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
const { toast } = await import("sonner");
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
      // By role: the run trace names the same stages in its own table. The
      // names come from the shared map because a tab that calls a stage
      // something the progress bar above it does not is the defect here.
      for (const stage of STAGES) {
        expect(
          screen.getByRole("tab", { name: STAGE_LABELS[stage] }),
        ).toBeInTheDocument();
      }
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
      // A real key from `_seo_checklist`. The two integer counts in the same
      // payload are counts, not checks, so they stay out of the fraction.
      expect(screen.getByText("Keyword In Title")).toBeInTheDocument();
      expect(screen.queryByText("Internal Link Count")).toBeNull();
      expect(screen.getByText("Internal Links: 0")).toBeInTheDocument();
      expect(screen.getByText("6/7")).toBeInTheDocument();
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

describe("PostDetailPage publishing", () => {
  const mockPublish = vi.mocked(posts.publish);

  /** `appendExecutionLog`'s stored shape, with the keys it always writes. */
  function logEntry(event: string, message: string) {
    return { ts: "2026-08-24T00:00:00Z", stage: "", level: "error", event, message };
  }

  it("reports the reason the server refused the publish", async () => {
    mockGet.mockResolvedValue(
      makeCompletedPost({ output_format: "wordpress" })
    );
    mockPublish.mockRejectedValue(
      new Error(JSON.stringify({ detail: "No content to publish" }))
    );
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /publish to wordpress/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /publish to wordpress/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("No content to publish");
    });
  });

  it("says the publish is queued rather than already running", async () => {
    mockGet.mockResolvedValue(
      makeCompletedPost({ output_format: "wordpress" })
    );
    mockPublish.mockResolvedValue({ status: "queued" });
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /publish to wordpress/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /publish to wordpress/i }));

    await waitFor(() => {
      expect(screen.getByText("Queued to publish")).toBeInTheDocument();
    });
    expect(toast.info).toHaveBeenCalledWith("Queued to publish to WordPress.");
  });

  it("shows the reason a WordPress publish failed on a page that was reloaded after it", async () => {
    mockGet.mockResolvedValue(
      makeCompletedPost({
        output_format: "wordpress",
        wp_publish_status: "failed",
        execution_logs: [
          logEntry(
            "publish_error",
            "WordPress publish failed: <strong>Error:</strong> Invalid application password."
          ),
        ],
      })
    );
    renderWithProviders(<PostDetailPage />);

    // Scoped to the banner: the run trace's publish row carries the same
    // reason, read out of the same entry, and that duplication is the point.
    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText("Publishing to WordPress failed")).toBeInTheDocument();
    expect(
      within(banner).getByText("Error: Invalid application password.")
    ).toBeInTheDocument();
  });

  it("shows the reason a Next.js publish failed the same way", async () => {
    mockGet.mockResolvedValue(
      makeCompletedPost({
        output_format: "nextjs",
        nextjs_publish_status: "failed",
        execution_logs: [
          logEntry("publish_error", "Next.js publish failed: Webhook returned 401: bad signature"),
        ],
      })
    );
    renderWithProviders(<PostDetailPage />);

    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText("Publishing to Next.js failed")).toBeInTheDocument();
    expect(
      within(banner).getByText("Webhook returned 401: bad signature")
    ).toBeInTheDocument();
  });

  /**
   * The trace is the view built for watching a run, and a publish is the last
   * thing a run does. It ended at `ready` because every publish entry carries
   * `stage: ""` (polish ledger P3.2b-ii).
   */
  it("shows the publish leg on the run trace, with the reason it failed", async () => {
    mockGet.mockResolvedValue(
      makeCompletedPost({
        output_format: "wordpress",
        wp_publish_status: "failed",
        execution_logs: [
          {
            ts: "2026-08-24T00:00:00Z",
            stage: "",
            level: "info",
            event: "publish_start",
            message: "Publishing to WordPress...",
            data: { target: "wordpress" },
          },
          logEntry("publish_error", "WordPress publish failed: 401 Unauthorized"),
        ],
      })
    );
    renderWithProviders(<PostDetailPage />);

    const table = within(await screen.findByRole("table"));
    expect(table.getByText("Publish to WordPress")).toBeInTheDocument();
    expect(table.getByText("401 Unauthorized")).toBeInTheDocument();
  });

  it("shows no publish row for a post exported as markdown", async () => {
    mockGet.mockResolvedValue(makeCompletedPost({ output_format: "markdown" }));
    renderWithProviders(<PostDetailPage />);

    await screen.findByRole("table");
    expect(screen.queryByText(/^Publish to/)).not.toBeInTheDocument();
  });

  it("says so plainly when a failed publish left no reason behind", async () => {
    mockGet.mockResolvedValue(
      makeCompletedPost({ output_format: "wordpress", wp_publish_status: "failed" })
    );
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Publishing to WordPress failed")).toBeInTheDocument();
    });
    expect(
      within(screen.getByRole("alert")).getByText(
        "The run recorded no reason. The worker log has the detail."
      )
    ).toBeInTheDocument();
  });

  it("retries from the failure itself", async () => {
    mockGet.mockResolvedValue(
      makeCompletedPost({
        output_format: "wordpress",
        wp_publish_status: "failed",
        execution_logs: [logEntry("publish_error", "WordPress publish failed: nope")],
      })
    );
    mockPublish.mockResolvedValue({ status: "queued" });
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Publishing to WordPress failed")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /try publishing again/i }));

    await waitFor(() => {
      expect(mockPublish).toHaveBeenCalledWith("post-1");
    });
    expect(screen.queryByText("Publishing to WordPress failed")).not.toBeInTheDocument();
  });

  it("does not claim a failure once the post has published", async () => {
    mockGet.mockResolvedValue(
      makeCompletedPost({
        output_format: "wordpress",
        wp_publish_status: "published",
        wp_post_url: "https://example.test/hello",
        execution_logs: [logEntry("publish_error", "WordPress publish failed: an older attempt")],
      })
    );
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Published")).toBeInTheDocument();
    });
    expect(screen.queryByText("Publishing to WordPress failed")).not.toBeInTheDocument();
  });
});

/**
 * Ledger item P3.2a. `markPipelineComplete()` is unconditional, so a run whose
 * `images` stage wrote `images: failed` and returned still ends up stamped
 * `current_stage = "complete"`. The header used to print that column and say
 * COMPLETE; the page has to say what failed, why, and offer the one retry the
 * API has for it.
 */
describe("PostDetailPage stage failures", () => {
  const failedPost = (error: string | null) =>
    makePost({
      current_stage: "complete",
      completed_at: "2026-08-24T10:00:00Z",
      stage_status: {
        research: "complete",
        outline: "complete",
        write: "complete",
        edit: "complete",
        images: "failed",
        ready: "complete",
      },
      execution_logs:
        error === null
          ? []
          : [
              {
                ts: "2026-08-24T09:59:00Z",
                stage: "images",
                level: "error",
                event: "stage_error",
                message: "Images failed",
                data: { error },
              },
            ],
    });

  beforeEach(() => {
    mockGet.mockResolvedValue(failedPost("Gemini returned 429: quota exhausted"));
  });

  it("does not call a run with a failed stage complete", async () => {
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Finished with errors")).toBeInTheDocument();
    });
  });

  it("names the failed stage and what it reported", async () => {
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Images failed")).toBeInTheDocument();
    });
    // Scoped to the banner: the run trace below it renders the same reason,
    // which is the point of reading both out of `execution_logs`.
    const banner = screen.getByRole("alert");
    expect(
      within(banner).getByText("Gemini returned 429: quota exhausted")
    ).toBeInTheDocument();
  });

  it("says so plainly when the run recorded no reason", async () => {
    mockGet.mockResolvedValue(failedPost(null));
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Images failed")).toBeInTheDocument();
    });
    expect(
      screen.getByText("The run recorded no reason. The worker log has the detail.")
    ).toBeInTheDocument();
  });

  it("retries exactly the stage that failed", async () => {
    const user = userEvent.setup();
    mockRun.mockResolvedValue({ status: "queued", stage: "images" });
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Images failed")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Re-run Images" }));
    expect(mockRun).toHaveBeenCalledWith("post-1", "images");
  });

  it("gives each failed stage its own reason and its own retry", async () => {
    mockGet.mockResolvedValue(
      makePost({
        current_stage: "complete",
        stage_status: { research: "failed", images: "failed", ready: "complete" },
      })
    );
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Research failed")).toBeInTheDocument();
    });
    expect(screen.getByText("Images failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-run Research" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-run Images" })).toBeInTheDocument();
  });

  it("shows no failure banner on a clean run", async () => {
    mockGet.mockResolvedValue(makeCompletedPost());
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => {
      // The run trace names every stage `Complete` too, so the badge is the
      // first of them rather than the only one.
      expect(screen.getAllByText("Complete").length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Re-run / })).not.toBeInTheDocument();
  });
});
