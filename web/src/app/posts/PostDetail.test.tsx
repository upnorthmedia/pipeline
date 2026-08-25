import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
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
      approve: vi.fn(),
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
const { useSSE } = await import("@/hooks/use-sse");
const mockUseSSE = vi.mocked(useSSE);

/**
 * Hand one frame to the page's own SSE handler, which is the second argument
 * of the latest `useSSE` call. The hook itself is mocked in this suite, so
 * this is the only way the page's live path is exercised at all.
 */
function emitSSE(event: Record<string, unknown>) {
  const handler = mockUseSSE.mock.calls.at(-1)?.[1];
  if (!handler) throw new Error("the page has not subscribed to the event feed");
  act(() => {
    handler({ post_id: "post-1", ...event } as Parameters<typeof handler>[0]);
  });
}
const { toast } = await import("sonner");
const mockGet = vi.mocked(posts.get);
const mockAnalytics = vi.mocked(posts.analytics);
const mockRun = vi.mocked(posts.run);
const mockRerun = vi.mocked(posts.rerun);
const mockApprove = vi.mocked(posts.approve);

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
    expect(screen.queryByRole("button", { name: /resume from/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Over" })).not.toBeInTheDocument();

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

    await user.click(screen.getByRole("button", { name: /resume from/i }));
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

/**
 * Item P3.2c. `images` is the one stage that reports its progress per item,
 * and the two names it publishes were dropped by `EventSource` before they
 * reached this page. Nothing refetches the row until the stage ends, so
 * without the live frames the count only appears once it is too late to watch.
 */
/**
 * Ledger item P2.109b. A run parked at a gate is the one state on this page
 * that is waiting on the reader, and until this item there was nowhere in the
 * app to release it: the two buttons the header offered both started a *new*
 * run and left the parked one suspended forever.
 */
describe("PostDetailPage review gates", () => {
  const gatedPost = () =>
    makePost({
      current_stage: "outline",
      stage_status: { research: "complete", outline: "review" },
    });

  beforeEach(() => {
    mockGet.mockResolvedValue(gatedPost());
    mockApprove.mockResolvedValue({
      status: "approved",
      stage: "outline",
      mode: "review",
      post_id: "post-1",
    });
  });

  it("names the stage that is waiting and what it is waiting for", async () => {
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Outline is waiting for your approval")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "The run stopped in front of this stage and will not go on until you release it. Everything it has written so far is in the tabs below."
      )
    ).toBeInTheDocument();
  });

  it("releases the run rather than starting a new one", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Approve and continue" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Approve and continue" }));

    expect(mockApprove).toHaveBeenCalledWith("post-1");
    // The distinction the item is about: neither of the header's two forward
    // actions was used, because both create a second run.
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockRerun).not.toHaveBeenCalled();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Outline approved"));
  });

  it("refetches the post so the badge stops saying it is waiting", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Approve and continue" })).toBeInTheDocument();
    });
    const before = mockGet.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Approve and continue" }));

    await waitFor(() => expect(mockGet.mock.calls.length).toBeGreaterThan(before));
  });

  /**
   * A 409 is what a second click looks like, and what an approval made in
   * another tab looks like. The message is the server's, not a stack trace,
   * and the refetch still runs so the page catches up with whatever released
   * the gate.
   */
  it("reports a refused approval in the server's words and still refetches", async () => {
    const user = userEvent.setup();
    // `request()` throws with the response body as its message, which is what
    // `apiErrorMessage` reads the server's `detail` back out of.
    mockApprove.mockRejectedValue(
      new Error(JSON.stringify({ detail: "This post is not waiting for approval." }))
    );
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Approve and continue" })).toBeInTheDocument();
    });
    const before = mockGet.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Approve and continue" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("This post is not waiting for approval.")
    );
    await waitFor(() => expect(mockGet.mock.calls.length).toBeGreaterThan(before));
  });

  /**
   * The frame the gate publishes. Nothing else tells this page a run has
   * parked: it refetches on `stage_complete`, `stage_error` and
   * `pipeline_complete` and has no poll, so before P2.109b a gate appeared
   * only when the reader reloaded by hand.
   */
  it("refetches when a run announces that it has parked", async () => {
    mockGet.mockResolvedValue(
      makePost({ current_stage: "outline", stage_status: { research: "complete" } })
    );
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    const before = mockGet.mock.calls.length;

    mockGet.mockResolvedValue(gatedPost());
    await emitSSE({ event: "stage_review", post_id: "post-1", stage: "outline" });

    await waitFor(() => expect(mockGet.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() =>
      expect(screen.getByText("Outline is waiting for your approval")).toBeInTheDocument()
    );
  });

  it("shows no approval on a post that is not parked", async () => {
    mockGet.mockResolvedValue(makeCompletedPost());
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getAllByText("Complete").length).toBeGreaterThan(0);
    });
    expect(
      screen.queryByRole("button", { name: "Approve and continue" })
    ).not.toBeInTheDocument();
  });
});

describe("PostDetailPage live image progress", () => {
  const runningImages = () =>
    makePost({
      current_stage: "images",
      stage_status: {
        research: "complete",
        outline: "complete",
        write: "complete",
        edit: "complete",
        images: "running",
        ready: "pending",
      },
    });

  it("counts the fan-out's frames onto the run trace before any refetch", async () => {
    mockGet.mockResolvedValue(runningImages());
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());

    emitSSE({ event: "stage_start", stage: "images" });
    emitSSE({ event: "image_generated", stage: "images", data: { index: 0, bytes: 91231 } });
    emitSSE({ event: "image_generated", stage: "images", data: { index: 1, bytes: 88110 } });
    emitSSE({
      event: "image_failed",
      stage: "images",
      data: { index: 2, error: "429 RESOURCE_EXHAUSTED" },
    });

    expect(screen.getByText("2 images generated, 1 failed")).toBeInTheDocument();
  });

  it("puts each per-image line in the debug log with what it said", async () => {
    mockGet.mockResolvedValue(runningImages());
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());

    emitSSE({
      event: "image_failed",
      stage: "images",
      level: "error",
      message: "Image 2 failed: 429 RESOURCE_EXHAUSTED",
      data: { index: 2, error: "429 RESOURCE_EXHAUSTED" },
    });

    expect(screen.getByText("Image 2 failed: 429 RESOURCE_EXHAUSTED")).toBeInTheDocument();
  });

  it("starts the count again when the stage does, so a retry does not read as progress", async () => {
    mockGet.mockResolvedValue(runningImages());
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());

    emitSSE({ event: "image_generated", stage: "images", data: { index: 0 } });
    emitSSE({ event: "image_generated", stage: "images", data: { index: 1 } });
    expect(screen.getByText("2 images generated")).toBeInTheDocument();

    emitSSE({ event: "stage_start", stage: "images" });
    emitSSE({ event: "image_failed", stage: "images", data: { index: 0 } });

    expect(screen.getByText("1 image failed")).toBeInTheDocument();
    expect(screen.queryByText("2 images generated")).not.toBeInTheDocument();
  });

  it("counts one image once when the fan-out retries it, which is what the index is for", async () => {
    mockGet.mockResolvedValue(runningImages());
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());

    emitSSE({ event: "image_failed", stage: "images", data: { index: 1, error: "503" } });
    emitSSE({ event: "image_generated", stage: "images", data: { index: 1, bytes: 4211 } });

    expect(screen.getByText("1 image generated")).toBeInTheDocument();
  });

  it("ignores a frame for another post, which the global feed also carries", async () => {
    mockGet.mockResolvedValue(runningImages());
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());

    emitSSE({ event: "image_generated", stage: "images", post_id: "post-2", data: { index: 0 } });

    expect(screen.queryByText(/images? generated/)).not.toBeInTheDocument();
  });
});

/**
 * Item P3.3c-i. `GlobalNotifications` is mounted from the root layout, so it
 * is open on this page too and toasts the same frames off the queue-wide feed.
 * The page raising its own toast for `stage_complete` and `stage_error` meant
 * two notifications per event, worded differently: the global one said
 * "Research complete" and this one said "research complete".
 */
describe("PostDetailPage stage notifications", () => {
  it("leaves the stage toast to the one notifier that raises it", async () => {
    mockGet.mockResolvedValue(makePost());
    renderWithProviders(<PostDetailPage />);
    await screen.findByText("Test Post Topic");
    vi.mocked(toast.success).mockClear();

    emitSSE({ event: "stage_complete", stage: "research" });

    expect(toast.success).not.toHaveBeenCalled();
  });

  it("leaves the failure toast to it as well", async () => {
    mockGet.mockResolvedValue(makePost());
    renderWithProviders(<PostDetailPage />);
    await screen.findByText("Test Post Topic");
    vi.mocked(toast.error).mockClear();

    emitSSE({ event: "stage_error", stage: "images", error: "429 RESOURCE_EXHAUSTED" });

    expect(toast.error).not.toHaveBeenCalled();
  });

  it("names the stage a re-run starts from the way the rest of the UI does", async () => {
    mockGet.mockResolvedValue(
      makePost({ stage_status: { research: "complete" }, research_content: "notes" }),
    );
    mockRerun.mockResolvedValue({ status: "queued", mode: "rerun", rerun_from: "write" });
    renderWithProviders(<PostDetailPage />);
    await screen.findByText("Test Post Topic");

    await userEvent.click(screen.getByRole("button", { name: /resume from/i }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Re-running from Write"),
    );
  });

  it("still refetches the post the frame is about", async () => {
    mockGet.mockResolvedValue(makePost());
    renderWithProviders(<PostDetailPage />);
    await screen.findByText("Test Post Topic");
    const before = mockGet.mock.calls.length;

    emitSSE({ event: "stage_complete", stage: "research" });

    await waitFor(() => expect(mockGet.mock.calls.length).toBeGreaterThan(before));
  });
});

/**
 * The two run controls a post grows once it has run. Both were named after the
 * mechanism rather than the outcome: "Rerun Stage" does not re-run a stage (the
 * per-stage retry beside the failure banner does), it resumes the whole
 * pipeline from the first stage `stage_status` does not call complete, and
 * "Force Restart" says nothing about the six columns of output it throws away.
 */
describe("the run controls on a post that has already run", () => {
  const mockRestart = vi.mocked(posts.restart);
  const mockPause = vi.mocked(posts.pause);
  /** The id the route mock answers with, so the handlers' argument is checkable. */
  const completed = () => makeCompletedPost({ id: "post-1", topic: "Test Post Topic" });

  it("names the stage the re-run will start from", async () => {
    mockGet.mockResolvedValue(
      makePost({
        stage_status: { research: "complete", outline: "complete" },
        research_content: "notes",
      }),
    );
    renderWithProviders(<PostDetailPage />);
    await screen.findByText("Test Post Topic");

    expect(screen.getByRole("button", { name: "Resume from Write" })).toBeInTheDocument();
  });

  it("says Resume from Ready on a post whose every stage is complete", async () => {
    mockGet.mockResolvedValue(completed());
    renderWithProviders(<PostDetailPage />);
    await screen.findByText("Test Post Topic");

    expect(screen.getByRole("button", { name: "Resume from Ready" })).toBeInTheDocument();
  });

  it("asks before starting over, and names what is discarded", async () => {
    mockGet.mockResolvedValue(completed());
    mockRestart.mockResolvedValue({ status: "queued", mode: "restart" });
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);
    await screen.findByText("Test Post Topic");

    await user.click(screen.getByRole("button", { name: "Start Over" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/discard/i)).toBeInTheDocument();
    expect(mockRestart).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Start over" }));
    await waitFor(() => expect(mockRestart).toHaveBeenCalledWith("post-1"));
  });

  it("does not start over when the confirmation is cancelled", async () => {
    mockGet.mockResolvedValue(completed());
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);
    await screen.findByText("Test Post Topic");

    await user.click(screen.getByRole("button", { name: "Start Over" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Keep this run" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(mockRestart).not.toHaveBeenCalled();
  });

  it("shows the server's reason when a re-run is refused", async () => {
    mockGet.mockResolvedValue(completed());
    mockRerun.mockRejectedValue(
      new Error(JSON.stringify({ detail: "Another run is already in flight" })),
    );
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);
    await screen.findByText("Test Post Topic");

    await user.click(screen.getByRole("button", { name: /resume from/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Another run is already in flight"),
    );
  });

  it("shows the server's reason when starting over is refused", async () => {
    mockGet.mockResolvedValue(completed());
    mockRestart.mockRejectedValue(
      new Error(JSON.stringify({ detail: "Another run is already in flight" })),
    );
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);
    await screen.findByText("Test Post Topic");

    await user.click(screen.getByRole("button", { name: "Start Over" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Start over" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Another run is already in flight"),
    );
  });

  it("shows the server's reason when a pause is refused", async () => {
    mockGet.mockResolvedValue(
      makePost({ current_stage: "research", stage_status: { research: "running" } }),
    );
    mockPause.mockRejectedValue(
      new Error(JSON.stringify({ detail: "This post is not running" })),
    );
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);
    await screen.findByText("Test Post Topic");

    await user.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("This post is not running"),
    );
  });

  // `withServerError()` keeps the cause out of the body on purpose, so a 500
  // carries Starlette's placeholder and nothing else. Saying which action
  // failed beats repeating that.
  it("falls back to its own wording when the server answers a bare 500", async () => {
    mockGet.mockResolvedValue(completed());
    mockRerun.mockRejectedValue(
      new Error(JSON.stringify({ detail: "Internal Server Error" })),
    );
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);
    await screen.findByText("Test Post Topic");

    await user.click(screen.getByRole("button", { name: /resume from/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("The re-run could not be started."),
    );
  });
});
