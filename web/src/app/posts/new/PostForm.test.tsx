import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NewPostPage from "./page";
import { renderWithProviders } from "@/test/render";
import { makeProfile } from "@/test/fixtures";

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/posts/new",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    posts: {
      create: vi.fn(),
    },
    profiles: {
      list: vi.fn(),
    },
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const { posts, profiles } = await import("@/lib/api");
const { toast } = await import("sonner");
const mockCreate = vi.mocked(posts.create);
const mockProfilesList = vi.mocked(profiles.list);

const testProfile = makeProfile({
  id: "prof-1",
  name: "Firearms Blog",
  niche: "Firearms",
  target_audience: "Gun Enthusiasts",
  tone: "Expert",
  word_count: 3000,
  output_format: "wordpress",
  website_url: "https://guns.com",
  brand_voice: "Authoritative",
  avoid: "slang",
  related_keywords: ["ar-15", "optics"],
});

beforeEach(() => {
  vi.clearAllMocks();
  mockProfilesList.mockResolvedValue([testProfile]);
  mockCreate.mockResolvedValue({
    id: "new-post-1",
    slug: "test",
    topic: "Test",
  } as never);
});

describe("NewPostPage", () => {
  it("renders the form title", async () => {
    renderWithProviders(<NewPostPage />);
    expect(screen.getByText("New Post")).toBeInTheDocument();
  });

  it("renders required fields", async () => {
    renderWithProviders(<NewPostPage />);
    expect(screen.getByLabelText(/Topic/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Slug/)).toBeInTheDocument();
  });

  it("auto-generates slug from topic", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewPostPage />);

    const topicInput = screen.getByLabelText(/Topic/);
    await user.type(topicInput, "Best AR-15 Optics");

    const slugInput = screen.getByLabelText(/Slug/) as HTMLInputElement;
    expect(slugInput.value).toBe("best-ar-15-optics");
  });

  it("allows manual slug override", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewPostPage />);

    const slugInput = screen.getByLabelText(/Slug/);
    await user.clear(slugInput);
    await user.type(slugInput, "custom-slug");

    const topicInput = screen.getByLabelText(/Topic/);
    await user.type(topicInput, "Some Topic");

    // Slug should remain custom after topic change
    expect((slugInput as HTMLInputElement).value).toBe("custom-slug");
  });

  it("renders all form sections", () => {
    renderWithProviders(<NewPostPage />);
    expect(screen.getByText("Website Profile")).toBeInTheDocument();
    expect(screen.getByText("Content")).toBeInTheDocument();
    expect(screen.getByText("Writing Config")).toBeInTheDocument();
    expect(screen.getByText("SEO & Research")).toBeInTheDocument();
    expect(screen.getByText("Pipeline Settings")).toBeInTheDocument();
  });

  it("renders all 5 pipeline stage settings", () => {
    renderWithProviders(<NewPostPage />);
    expect(screen.getByText("research")).toBeInTheDocument();
    expect(screen.getByText("outline")).toBeInTheDocument();
    expect(screen.getByText("write")).toBeInTheDocument();
    expect(screen.getByText("edit")).toBeInTheDocument();
    expect(screen.getByText("images")).toBeInTheDocument();
  });

  it("shows validation error when submitting without topic", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewPostPage />);

    const submitBtn = screen.getByText("Create Post");
    await user.click(submitBtn);

    // Browser validation should prevent submission, or toast error shown
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("submits form and redirects on success", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewPostPage />);

    const topicInput = screen.getByLabelText(/Topic/);
    await user.type(topicInput, "My Test Post");

    const submitBtn = screen.getByText("Create Post");
    await user.click(submitBtn);

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: "My Test Post",
          slug: "my-test-post",
        })
      );
    });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/posts/new-post-1");
    });
  });

  it("shows error toast on submission failure", async () => {
    mockCreate.mockRejectedValue(new Error("Server error"));
    const user = userEvent.setup();
    renderWithProviders(<NewPostPage />);

    await user.type(screen.getByLabelText(/Topic/), "Test Post");
    await user.click(screen.getByText("Create Post"));

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Failed to create post");
    });
  });

  it("disables submit button while submitting", async () => {
    mockCreate.mockReturnValue(new Promise(() => {})); // never resolves
    const user = userEvent.setup();
    renderWithProviders(<NewPostPage />);

    await user.type(screen.getByLabelText(/Topic/), "Test Post");
    await user.click(screen.getByText("Create Post"));

    await waitFor(() => {
      expect(screen.getByText("Creating...")).toBeInTheDocument();
    });
  });

  it("renders cancel button", () => {
    renderWithProviders(<NewPostPage />);
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("loads profiles on mount", async () => {
    renderWithProviders(<NewPostPage />);
    await waitFor(() => {
      expect(mockProfilesList).toHaveBeenCalled();
    });
  });
});
