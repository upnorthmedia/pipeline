import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PostsPage from "./page";
import { renderWithProviders } from "@/test/render";
import { makePost, makeProfile } from "@/test/fixtures";
import type { Post, Profile } from "@/lib/api";

// Mock the api module
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    posts: {
      list: vi.fn(),
      delete: vi.fn(),
      duplicate: vi.fn(),
      run: vi.fn(),
      pause: vi.fn(),
    },
    profiles: {
      list: vi.fn(),
    },
  };
});

// Mock sonner
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

const { posts, profiles } = await import("@/lib/api");
const mockPostsList = vi.mocked(posts.list);
const mockProfilesList = vi.mocked(profiles.list);

const testPosts: Post[] = [
  makePost({ id: "p1", topic: "First Post", slug: "first-post", current_stage: "research" }),
  makePost({
    id: "p2",
    topic: "Second Post",
    slug: "second-post",
    current_stage: "complete",
    stage_status: {
      research: "complete",
      outline: "complete",
      write: "complete",
      edit: "complete",
      images: "complete",
    },
  }),
  makePost({ id: "p3", topic: "Third Post", slug: "third-post", current_stage: "write", stage_status: { research: "complete", outline: "complete", write: "running" } }),
];

const testProfiles: Profile[] = [makeProfile({ id: "prof-1", name: "Test Site" })];

beforeEach(() => {
  vi.clearAllMocks();
  mockPostsList.mockResolvedValue(testPosts);
  mockProfilesList.mockResolvedValue(testProfiles);
});

describe("PostsPage", () => {
  it("renders post topics in the table", async () => {
    renderWithProviders(<PostsPage />);
    await waitFor(() => {
      expect(screen.getByText("First Post")).toBeInTheDocument();
      expect(screen.getByText("Second Post")).toBeInTheDocument();
      expect(screen.getByText("Third Post")).toBeInTheDocument();
    });
  });

  it("renders post slugs", async () => {
    renderWithProviders(<PostsPage />);
    await waitFor(() => {
      expect(screen.getByText("first-post")).toBeInTheDocument();
    });
  });

  it("shows total post count", async () => {
    renderWithProviders(<PostsPage />);
    await waitFor(() => {
      expect(screen.getByText("3 total posts")).toBeInTheDocument();
    });
  });

  it("shows loading skeletons initially", () => {
    mockPostsList.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = renderWithProviders(<PostsPage />);
    const skeletons = container.querySelectorAll("[class*='animate-pulse']");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("shows empty state when no posts", async () => {
    mockPostsList.mockResolvedValue([]);
    renderWithProviders(<PostsPage />);
    await waitFor(() => {
      expect(screen.getByText("No posts found")).toBeInTheDocument();
      expect(screen.getByText("Create your first post")).toBeInTheDocument();
    });
  });

  it("renders New Post button", async () => {
    renderWithProviders(<PostsPage />);
    await waitFor(() => {
      expect(screen.getByText("New Post")).toBeInTheDocument();
    });
  });

  it("renders status filter dropdown", async () => {
    renderWithProviders(<PostsPage />);
    await waitFor(() => {
      expect(screen.getByText("All Posts")).toBeInTheDocument();
    });
  });

  it("renders search input", async () => {
    renderWithProviders(<PostsPage />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Search posts...")).toBeInTheDocument();
    });
  });

  it("renders select-all checkbox", async () => {
    renderWithProviders(<PostsPage />);
    await waitFor(() => {
      const checkboxes = screen.getAllByRole("checkbox");
      expect(checkboxes.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows bulk action bar when items selected", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PostsPage />);

    await waitFor(() => {
      expect(screen.getByText("First Post")).toBeInTheDocument();
    });

    // Select the first checkbox (not the header)
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[1]); // First row checkbox

    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("calls posts.list on mount", async () => {
    renderWithProviders(<PostsPage />);
    await waitFor(() => {
      expect(mockPostsList).toHaveBeenCalled();
    });
  });

  it("renders pipeline progress for each post", async () => {
    renderWithProviders(<PostsPage />);
    await waitFor(() => {
      // Each post row should have completion count text (compact mode)
      const counts = screen.getAllByText(/\d\/6/);
      expect(counts).toHaveLength(3);
    });
  });
});
