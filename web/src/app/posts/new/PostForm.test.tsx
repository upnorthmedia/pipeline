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
      wpCategories: vi.fn(),
      wpAuthors: vi.fn(),
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
const mockWpCategories = vi.mocked(profiles.wpCategories);
const mockWpAuthors = vi.mocked(profiles.wpAuthors);

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
  // Pending by default: most cases here render and assert synchronously, and a
  // profile list that resolves afterwards settles state outside act(...) and
  // fills the run with warnings. Cases that need the list say so.
  mockProfilesList.mockReturnValue(new Promise(() => {}));
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
  });

  it("renders article type and additional fields", () => {
    renderWithProviders(<NewPostPage />);
    expect(screen.getByText("Article Type")).toBeInTheDocument();
    expect(screen.getByLabelText("Required Mentions")).toBeInTheDocument();
    expect(screen.getByLabelText("Additional Information")).toBeInTheDocument();
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

  // A toast would be gone in four seconds and the operator is still looking at
  // a filled-in form, so the reason stays on the page next to the button.
  it("shows the server's own reason inline on submission failure", async () => {
    mockCreate.mockRejectedValue(
      new Error(JSON.stringify({ detail: "Slug already in use" }))
    );
    const user = userEvent.setup();
    renderWithProviders(<NewPostPage />);

    await user.type(screen.getByLabelText(/Topic/), "Test Post");
    await user.click(screen.getByText("Create Post"));

    expect(await screen.findByText("Slug already in use")).toBeInTheDocument();
    expect(screen.getByText("Could not create the post")).toBeInTheDocument();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("falls back to its own wording when the failure carries no message", async () => {
    mockCreate.mockRejectedValue(new Error("Server error"));
    const user = userEvent.setup();
    renderWithProviders(<NewPostPage />);

    await user.type(screen.getByLabelText(/Topic/), "Test Post");
    await user.click(screen.getByText("Create Post"));

    expect(await screen.findByText("Failed to create post")).toBeInTheDocument();
  });

  it("clears a previous failure when the form is submitted again", async () => {
    mockCreate.mockRejectedValueOnce(
      new Error(JSON.stringify({ detail: "Slug already in use" }))
    );
    const user = userEvent.setup();
    renderWithProviders(<NewPostPage />);

    await user.type(screen.getByLabelText(/Topic/), "Test Post");
    await user.click(screen.getByText("Create Post"));
    expect(await screen.findByText("Slug already in use")).toBeInTheDocument();

    await user.click(screen.getByText("Create Post"));
    await waitFor(() =>
      expect(screen.queryByText("Slug already in use")).not.toBeInTheDocument()
    );
  });

  it("prefills the writing config from the chosen profile", async () => {
    mockProfilesList.mockResolvedValue([testProfile]);
    const user = userEvent.setup();
    renderWithProviders(<NewPostPage />);

    await user.click(await screen.findByRole("combobox", { name: "Website profile" }));
    await user.click(await screen.findByRole("option", { name: "Firearms Blog" }));

    expect(screen.getByLabelText("Niche")).toHaveValue("Firearms");
    expect(screen.getByLabelText("Target Audience")).toHaveValue("Gun Enthusiasts");
    expect(screen.getByLabelText("Tone")).toHaveValue("Expert");
    expect(screen.getByLabelText("Word Count")).toHaveValue(3000);
  });

  // Categories and authors come from the profile's own WordPress site, so a
  // wrong password fails here and nowhere else. Silent, it reads as a site
  // with no categories.
  it("surfaces a WordPress lookup failure with a retry", async () => {
    const wpProfile = makeProfile({
      id: "prof-wp",
      name: "WP Site",
      wp_url: "https://wp.example.com",
      wp_username: "editor",
    });
    mockProfilesList.mockResolvedValue([wpProfile]);
    mockWpCategories.mockRejectedValueOnce(
      new Error(JSON.stringify({ detail: "WordPress rejected the credentials" }))
    );
    mockWpAuthors.mockResolvedValue([]);
    const user = userEvent.setup();
    renderWithProviders(<NewPostPage />);

    await user.click(await screen.findByRole("combobox", { name: "Website profile" }));
    await user.click(await screen.findByRole("option", { name: "WP Site" }));

    expect(
      await screen.findByText("WordPress rejected the credentials")
    ).toBeInTheDocument();

    mockWpCategories.mockResolvedValue([{ id: 3, name: "Optics" } as never]);
    await user.click(screen.getByRole("button", { name: /Retry/ }));

    await waitFor(() =>
      expect(
        screen.queryByText("Could not load categories and authors")
      ).not.toBeInTheDocument()
    );
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
