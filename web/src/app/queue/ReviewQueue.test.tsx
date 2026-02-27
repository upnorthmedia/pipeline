import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import QueuePage from "./page";
import { renderWithProviders } from "@/test/render";
import { makePost } from "@/test/fixtures";
import type { Post } from "@/lib/api";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/queue",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    queue: {
      review: vi.fn(),
    },
    posts: {
      approve: vi.fn(),
      rerun: vi.fn(),
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

const { queue, posts } = await import("@/lib/api");
const mockReview = vi.mocked(queue.review);
const mockApprove = vi.mocked(posts.approve);
const mockRerun = vi.mocked(posts.rerun);

const reviewPosts: Post[] = [
  makePost({
    id: "p1",
    topic: "First Review Post",
    slug: "first-review",
    current_stage: "outline",
    stage_status: { research: "complete", outline: "review" },
    research_content: "Research done",
    outline_content: "Outline content to review here",
  }),
  makePost({
    id: "p2",
    topic: "Second Review Post",
    slug: "second-review",
    current_stage: "edit",
    stage_status: { research: "complete", outline: "complete", write: "complete", edit: "review" },
    research_content: "Research done",
    outline_content: "Outline done",
    draft_content: "Draft done",
    final_md_content: "Final content to review here",
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  mockReview.mockResolvedValue(reviewPosts);
  mockApprove.mockResolvedValue(undefined as never);
  mockRerun.mockResolvedValue(undefined as never);
});

describe("QueuePage", () => {
  it("calls queue.review on mount", async () => {
    renderWithProviders(<QueuePage />);
    await waitFor(() => {
      expect(mockReview).toHaveBeenCalled();
    });
  });

  it("shows loading skeletons initially", () => {
    mockReview.mockReturnValue(new Promise(() => {}));
    const { container } = renderWithProviders(<QueuePage />);
    const skeletons = container.querySelectorAll("[class*='animate-pulse']");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("renders review post topics", async () => {
    renderWithProviders(<QueuePage />);
    await waitFor(() => {
      expect(screen.getByText("First Review Post")).toBeInTheDocument();
      expect(screen.getByText("Second Review Post")).toBeInTheDocument();
    });
  });

  it("shows empty state when no posts", async () => {
    mockReview.mockResolvedValue([]);
    renderWithProviders(<QueuePage />);
    await waitFor(() => {
      expect(screen.getByText("No posts awaiting review")).toBeInTheDocument();
    });
  });

  it("shows awaiting review count", async () => {
    renderWithProviders(<QueuePage />);
    await waitFor(() => {
      expect(screen.getByText("2 posts awaiting review")).toBeInTheDocument();
    });
  });

  it("renders approve button for each post", async () => {
    renderWithProviders(<QueuePage />);
    await waitFor(() => {
      const approveButtons = screen.getAllByRole("button", { name: /approve/i });
      expect(approveButtons).toHaveLength(2);
    });
  });

  it("approve calls posts.approve", async () => {
    const user = userEvent.setup();
    renderWithProviders(<QueuePage />);
    await waitFor(() => {
      expect(screen.getByText("First Review Post")).toBeInTheDocument();
    });
    const approveButtons = screen.getAllByRole("button", { name: /approve/i });
    await user.click(approveButtons[0]);
    expect(mockApprove).toHaveBeenCalledWith("p1");
  });

  it("renders View & Edit link", async () => {
    renderWithProviders(<QueuePage />);
    await waitFor(() => {
      expect(screen.getByText("First Review Post")).toBeInTheDocument();
    });
    const viewLinks = screen.getAllByRole("link", { name: /view & edit/i });
    expect(viewLinks[0]).toHaveAttribute("href", "/posts/p1");
  });

  it("renders Re-run button", async () => {
    renderWithProviders(<QueuePage />);
    await waitFor(() => {
      const rerunButtons = screen.getAllByRole("button", { name: /re-run/i });
      expect(rerunButtons.length).toBeGreaterThan(0);
    });
  });

  it("shows content preview", async () => {
    renderWithProviders(<QueuePage />);
    await waitFor(() => {
      expect(screen.getByText("Outline content to review here")).toBeInTheDocument();
      expect(screen.getByText("Final content to review here")).toBeInTheDocument();
    });
  });
});
