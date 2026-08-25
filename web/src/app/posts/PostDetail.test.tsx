import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PostDetailPage from "./[id]/page";
import { renderWithProviders } from "@/test/render";
import {
  defaultStageSettings,
  makePost,
  makeCompletedPost,
  makeAnalytics,
} from "@/test/fixtures";
import { STAGES, type Post } from "@/lib/api";
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

  /**
   * Ledger item P2.115. The pause stops the run at its next stage boundary, so
   * the stage in flight is still `running` while it takes effect: the badge has
   * to say that rather than "Paused", and the button that asks for a pause has
   * nothing left to ask for.
   */
  it("reads Pausing, and drops the Pause button, while the interrupted stage finishes", async () => {
    const post = makePost({
      current_stage: "paused",
      stage_status: { research: "complete", outline: "running" },
    });
    mockGet.mockResolvedValue(post);
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Pausing")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
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
 * Ledger item P5.1, the stage-level twin of P4.9a. A run the worker gave up on
 * leaves the stage it died in recorded as `running`: `markStageRunning()` wrote
 * it on the way into the step and, before P5.1, nothing moved it, because
 * `markPipelineFailed()` only stamped `current_stage`. Three readers on this
 * one page took that literally, so a dead run had a spinning progress dot, a
 * tab reading `Running Write...` and a run-trace row counting an elapsed clock
 * up, four inches under a header badge that said the run had failed.
 */
describe("PostDetailPage a run the worker gave up on", () => {
  const deadRun = () =>
    makePost({
      current_stage: "failed",
      stage_status: {
        research: "complete",
        outline: "complete",
        write: "running",
      },
      research_content: "notes",
      execution_logs: [
        {
          ts: "2026-08-24T09:50:00Z",
          stage: "write",
          level: "info",
          event: "stage_start",
          message: "Running write",
          data: {},
        },
        {
          ts: "2026-08-24T09:59:00Z",
          stage: "write",
          level: "error",
          event: "stage_error",
          message: "Pipeline failed after 3 attempts: Anthropic returned 529",
          data: { error: "Anthropic returned 529", attempts: 3, moved_to_dlq: true },
        },
      ],
    });

  beforeEach(() => {
    mockGet.mockResolvedValue(deadRun());
  });

  it("does not leave the run trace calling the stage it died in running", async () => {
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Run Trace")).toBeInTheDocument();
    });

    const trace = within(screen.getByRole("table"));
    expect(trace.queryByText("Running")).not.toBeInTheDocument();
    // Two of the six rows: `write` died and nothing after it started.
    expect(trace.getAllByText("Failed")).toHaveLength(1);
    expect(screen.queryByLabelText("Run in progress")).not.toBeInTheDocument();
  });

  it("names the stage the run died in on the badge, and offers its re-run", async () => {
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Failed at Write")).toBeInTheDocument();
    });
    const banner = screen.getByRole("alert");
    expect(within(banner).getByText("Anthropic returned 529")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-run Write" })).toBeInTheDocument();
  });

  it("stops the progress dot spinning on the stage the run died in", async () => {
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Run Trace")).toBeInTheDocument();
    });

    expect(screen.getByLabelText("Write: Failed")).toBeInTheDocument();
    expect(screen.queryByLabelText("Write: Running")).not.toBeInTheDocument();
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

  /**
   * The frame the two pause endpoints publish. A pause is the one pipeline
   * control that starts nothing, so before ledger item P4.4a it announced
   * itself to nobody: the tab that pressed the button refetched by hand and
   * every other reader kept the run on screen as running until it reloaded.
   */
  it("refetches when a run announces that it has been paused", async () => {
    mockGet.mockResolvedValue(
      makePost({
        current_stage: "outline",
        stage_status: { research: "complete", outline: "running" },
      })
    );
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => expect(screen.getByText("Running Outline")).toBeInTheDocument());
    const before = mockGet.mock.calls.length;

    mockGet.mockResolvedValue(
      makePost({
        current_stage: "paused",
        stage_status: { research: "complete", outline: "running" },
      })
    );
    await emitSSE({ event: "run_paused", post_id: "post-1" });

    await waitFor(() => expect(mockGet.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByText("Pausing")).toBeInTheDocument());
  });

  it("ignores a pause announced for a different post", async () => {
    mockGet.mockResolvedValue(
      makePost({
        current_stage: "outline",
        stage_status: { research: "complete", outline: "running" },
      })
    );
    renderWithProviders(<PostDetailPage />);
    await waitFor(() => expect(screen.getByText("Running Outline")).toBeInTheDocument());
    const before = mockGet.mock.calls.length;

    await emitSSE({ event: "run_paused", post_id: "another-post" });

    expect(mockGet.mock.calls.length).toBe(before);
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

  /**
   * Ledger item P4.4b. A pause that lands during `ready` leaves all six stages
   * complete and `current_stage = "paused"`, because `pipeline-complete` reads
   * the pause and skips the stamp, the auto-publish and the frame. The header
   * offered "Resume from Ready" on that row, which is `POST /rerun`: it clears
   * `ready_content` and pays for the stage again to reach a step that needs no
   * stage run at all.
   */
  describe("a pause that landed after the last stage", () => {
    const mockRunAll = vi.mocked(posts.runAll);
    const pausedAtFinish = () =>
      makeCompletedPost({ id: "post-1", topic: "Test Post Topic", current_stage: "paused", completed_at: null });

    it("offers the finish instead of a re-run of the last stage", async () => {
      mockGet.mockResolvedValue(pausedAtFinish());
      renderWithProviders(<PostDetailPage />);
      await screen.findByText("Test Post Topic");

      expect(screen.getByRole("button", { name: "Finish this run" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /resume from/i })).not.toBeInTheDocument();
    });

    it("finishes the run without re-running a stage", async () => {
      mockGet.mockResolvedValue(pausedAtFinish());
      mockRunAll.mockResolvedValue({ status: "queued", mode: "run-all" });
      renderWithProviders(<PostDetailPage />);
      await screen.findByText("Test Post Topic");

      await userEvent.click(screen.getByRole("button", { name: "Finish this run" }));

      await waitFor(() => expect(mockRunAll).toHaveBeenCalledWith("post-1"));
      expect(mockRerun).not.toHaveBeenCalled();
    });

    it("says what the pause cost the post rather than naming a stage to carry on from", async () => {
      mockGet.mockResolvedValue(pausedAtFinish());
      renderWithProviders(<PostDetailPage />);
      await screen.findByText("Test Post Topic");

      expect(screen.getByText("Paused before finishing")).toBeInTheDocument();
      expect(screen.queryByText(/carry on from this stage/i)).not.toBeInTheDocument();
    });

    it("still resumes a pause that has a stage left to run", async () => {
      mockGet.mockResolvedValue(
        makePost({
          current_stage: "paused",
          stage_status: { research: "complete", outline: "complete" },
          research_content: "notes",
        }),
      );
      renderWithProviders(<PostDetailPage />);
      await screen.findByText("Test Post Topic");

      expect(screen.getByRole("button", { name: "Resume from Write" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Finish this run" })).not.toBeInTheDocument();
    });
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

/**
 * Ledger item P4.3: a publish whose worker died reported `Publishing...`
 * forever.
 *
 * The status column moves to `publishing` before the step touches the
 * destination and only the step writes it again, so a worker that dies between
 * those two points leaves the row on that value with nothing left in the
 * process that owns it. `RedisStreamsPubSub`'s reclaim loop is the one thing
 * that can re-deliver the step, and it needs a live worker and
 * `RECLAIM_IDLE_MS` of idle time to do it, so the page has to be able to say
 * that the attempt has gone past that window and give the reader the retry it
 * was not offering: the Publish button is gated on `null` or `pending`, so a
 * row stuck on `publishing` had no control on the page at all.
 */
describe("PostDetailPage stalled publishing", () => {
  const mockPublish = vi.mocked(posts.publish);

  /** `appendExecutionLog`'s stored shape for the entry a worker writes on pickup. */
  function startEntry(ts: string) {
    return {
      ts,
      stage: "",
      level: "info",
      event: "publish_start",
      message: "Publishing to WordPress...",
    };
  }

  function minutesAgo(minutes: number): string {
    return new Date(Date.now() - minutes * 60_000).toISOString();
  }

  it("calls a publish whose worker went quiet stalled rather than running", async () => {
    mockGet.mockResolvedValue(
      makeCompletedPost({
        output_format: "wordpress",
        wp_publish_status: "publishing",
        updated_at: minutesAgo(40),
        execution_logs: [startEntry(minutesAgo(38))],
      })
    );
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Publish stalled")).toBeInTheDocument();
    });
    expect(screen.queryByText("Publishing...")).not.toBeInTheDocument();

    const banner = screen.getByRole("alert");
    expect(
      within(banner).getByText("Publishing to WordPress stopped responding")
    ).toBeInTheDocument();
    expect(within(banner).getByText(/the worker died partway through/i)).toBeInTheDocument();
  });

  /**
   * Ledger item P4.9a. The banner and the run trace read the same row, so
   * before this they contradicted each other on one screen: the banner said
   * the publish had stopped responding while the table beside it said
   * `Running` with a clock counting up and the card's `Run in progress` pulse
   * lit. Both now come from the one `rowPublishStall()` call this page makes.
   */
  it("does not leave the run trace calling the same publish running", async () => {
    mockGet.mockResolvedValue(
      makeCompletedPost({
        output_format: "wordpress",
        wp_publish_status: "publishing",
        updated_at: minutesAgo(40),
        execution_logs: [startEntry(minutesAgo(38))],
      })
    );
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Publish stalled")).toBeInTheDocument();
    });
    const trace = within(screen.getByRole("table"));
    expect(trace.getByText("Publish to WordPress")).toBeInTheDocument();
    expect(trace.getByText("Stalled")).toBeInTheDocument();
    expect(trace.queryByText("Running")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Run in progress")).not.toBeInTheDocument();
  });

  it("offers the retry the Publish button was not giving a stuck row", async () => {
    mockGet.mockResolvedValue(
      makeCompletedPost({
        output_format: "wordpress",
        wp_publish_status: "publishing",
        updated_at: minutesAgo(40),
        execution_logs: [startEntry(minutesAgo(38))],
      })
    );
    mockPublish.mockResolvedValue({ status: "queued" });
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Publish stalled")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /try publishing again/i }));

    await waitFor(() => {
      expect(mockPublish).toHaveBeenCalledWith("post-1");
    });
    // The optimistic write puts the row back on `pending` *and* restamps the
    // clock, so the banner it just retried from cannot survive the press.
    expect(screen.queryByText("Publish stalled")).not.toBeInTheDocument();
    expect(screen.getByText("Queued to publish")).toBeInTheDocument();
  });

  it("says a queued publish was never picked up, which is a different fault", async () => {
    mockGet.mockResolvedValue(
      makeCompletedPost({
        output_format: "nextjs",
        nextjs_publish_status: "pending",
        updated_at: minutesAgo(40),
      })
    );
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Publish stalled")).toBeInTheDocument();
    });
    const banner = screen.getByRole("alert");
    expect(
      within(banner).getByText("Publishing to Next.js stopped responding")
    ).toBeInTheDocument();
    expect(within(banner).getByText(/no worker is running/i)).toBeInTheDocument();
  });

  it("leaves a publish that is still inside the window alone", async () => {
    mockGet.mockResolvedValue(
      makeCompletedPost({
        output_format: "wordpress",
        wp_publish_status: "publishing",
        updated_at: minutesAgo(3),
        execution_logs: [startEntry(minutesAgo(2))],
      })
    );
    renderWithProviders(<PostDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Publishing...")).toBeInTheDocument();
    });
    expect(screen.queryByText("Publish stalled")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  /**
   * The case the item is actually about: nobody reloads. A publish that dies
   * publishes no further event, this page has no poll, and the render that
   * would have to notice is the one that never happens again.
   */
  it("flips to stalled on a page nothing else touches", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockGet.mockResolvedValue(
        makeCompletedPost({
          output_format: "wordpress",
          wp_publish_status: "publishing",
          updated_at: minutesAgo(14),
          execution_logs: [startEntry(minutesAgo(14))],
        })
      );
      renderWithProviders(<PostDetailPage />);

      await waitFor(() => {
        expect(screen.getByText("Publishing...")).toBeInTheDocument();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60_000);
      });

      expect(screen.getByText("Publish stalled")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Ledger item P4.6. `PATCH /api/posts/{id}` has taken `stage_settings` and
 * kept it as sent since P2.114, but the picker that writes it was on
 * `/posts/new` only, so a post created with a gate it should not have had
 * could be fixed only by creating it again.
 *
 * The worker reads the gates off the row at the top of every step
 * (`loadPipelineState` in each of the six), not off the run's snapshot, so an
 * edit made here reaches the stages this run has not started yet.
 */
describe("PostDetailPage gate settings", () => {
  const mockUpdate = vi.mocked(posts.update);
  const gatedPost = () =>
    makePost({ stage_settings: { ...defaultStageSettings, outline: "review" } });

  beforeEach(() => {
    mockGet.mockResolvedValue(gatedPost());
    mockUpdate.mockImplementation(async (_id, data) =>
      makePost({ ...gatedPost(), ...(data as Partial<Post>) })
    );
  });

  it("says where the post will stop", async () => {
    renderWithProviders(<PostDetailPage />);

    expect(await screen.findByTestId("gate-summary")).toHaveTextContent(
      "This post will stop at Outline and wait for you."
    );
    expect(
      within(screen.getByTestId("gate-outline")).getByRole("combobox")
    ).toHaveTextContent("Wait for review");
  });

  it("saves a gate the post should never have had", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);

    await user.click(await screen.findByRole("combobox", { name: "Outline" }));
    await user.click(await screen.findByRole("option", { name: "Run automatically" }));

    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith("post-1", {
        stage_settings: defaultStageSettings,
      })
    );
    expect(screen.getByTestId("gate-summary")).toHaveTextContent(
      "This post will go from Research to Ready without stopping."
    );
    expect(toast.success).toHaveBeenCalledWith("Outline will run automatically.");
  });

  // All six stages every time: a `stage_settings` with a hole in it parks the
  // run at the stages it leaves out (`DEFAULT_GATE_MODE` is `review`), so a
  // patch carrying only the stage that changed would gate the other five.
  it("writes every stage rather than the one that changed", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);

    await user.click(await screen.findByRole("combobox", { name: "Write" }));
    await user.click(await screen.findByRole("option", { name: "Wait for approval" }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][1].stage_settings).toEqual({
      ...defaultStageSettings,
      outline: "review",
      write: "approve_only",
    });
  });

  it("puts the gate back when the save fails", async () => {
    mockUpdate.mockRejectedValue(new Error("nope"));
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);

    await user.click(await screen.findByRole("combobox", { name: "Outline" }));
    await user.click(await screen.findByRole("option", { name: "Run automatically" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("The review gates could not be saved.")
    );
    expect(screen.getByTestId("gate-summary")).toHaveTextContent(
      "This post will stop at Outline and wait for you."
    );
  });
});

/**
 * Ledger item P5.3. The gate that stopped a run is read at the top of the
 * step, so a run that has already parked read its gate before it stopped:
 * nothing in `PATCH /api/posts/{id}` reaches the suspended run, and clearing
 * the gate of the stage it is parked at left the row saying "no stops" over an
 * approval banner that was still on screen.
 *
 * Two things close it. The card says where the run is stopped *now* rather
 * than only where it will stop next, and clearing the gate that is holding it
 * releases the run through the same route the approval banner uses.
 */
describe("PostDetailPage clearing the gate a run is parked at", () => {
  const mockUpdate = vi.mocked(posts.update);

  const parkedPost = (overrides: Partial<Post> = {}) =>
    makePost({
      current_stage: "outline",
      stage_status: { research: "complete", outline: "review" },
      stage_settings: { ...defaultStageSettings, outline: "review" },
      ...overrides,
    });

  /** The row after the release: the worker has picked the stage back up. */
  const releasedPost = () =>
    makePost({
      current_stage: "outline",
      stage_status: { research: "complete", outline: "running" },
      stage_settings: defaultStageSettings,
    });

  beforeEach(() => {
    mockGet.mockResolvedValue(parkedPost());
    mockUpdate.mockImplementation(async (_id, data) =>
      parkedPost(data as Partial<Post>)
    );
    mockApprove.mockResolvedValue({
      status: "approved",
      stage: "outline",
      mode: "review",
      post_id: "post-1",
    });
  });

  it("says where the run is stopped now, not only where it will stop next", async () => {
    renderWithProviders(<PostDetailPage />);

    expect(await screen.findByTestId("gate-summary")).toHaveTextContent(
      "This post is waiting for you at Outline. After that it will run to Ready without stopping."
    );
  });

  it("releases the run when the gate holding it is cleared", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);
    await screen.findByText("Outline is waiting for your approval");

    mockGet.mockResolvedValue(releasedPost());
    await user.click(await screen.findByRole("combobox", { name: "Outline" }));
    await user.click(await screen.findByRole("option", { name: "Run automatically" }));

    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith("post-1", {
        stage_settings: defaultStageSettings,
      })
    );
    await waitFor(() => expect(mockApprove).toHaveBeenCalledWith("post-1"));
    // The release is the run continuing, not a second run: the two forward
    // actions in the header both start one.
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockRerun).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.queryByText("Outline is waiting for your approval")
      ).not.toBeInTheDocument()
    );
    expect(screen.getByTestId("gate-summary")).toHaveTextContent(
      "This post will go from Research to Ready without stopping."
    );
    expect(toast.success).toHaveBeenCalledWith(
      "Outline will run automatically. The run is continuing."
    );
  });

  it("leaves the run alone when the gate cleared is not the one holding it", async () => {
    mockGet.mockResolvedValue(
      parkedPost({
        stage_settings: { ...defaultStageSettings, outline: "review", write: "review" },
      })
    );
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);
    await screen.findByText("Outline is waiting for your approval");

    await user.click(await screen.findByRole("combobox", { name: "Write" }));
    await user.click(await screen.findByRole("option", { name: "Run automatically" }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockApprove).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Write will run automatically.");
  });

  /**
   * A gate that cannot be turned into a gate to switch off: no snapshot, or a
   * run released from another tab. The setting is saved either way, so the
   * message says that and points at the control that is still on screen.
   */
  it("says the gate is saved but the run is still waiting when the release is refused", async () => {
    mockApprove.mockRejectedValue(
      new Error(JSON.stringify({ detail: "This post is not waiting for approval." }))
    );
    const user = userEvent.setup();
    renderWithProviders(<PostDetailPage />);
    await screen.findByText("Outline is waiting for your approval");

    await user.click(await screen.findByRole("combobox", { name: "Outline" }));
    await user.click(await screen.findByRole("option", { name: "Run automatically" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("This post is not waiting for approval.")
    );
    expect(screen.getByText("Outline is waiting for your approval")).toBeInTheDocument();
    expect(screen.getByTestId("gate-summary")).toHaveTextContent(
      "This post is waiting for you at Outline."
    );
  });
});
