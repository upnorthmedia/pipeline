import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BatchCreatePage from "./page";
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
  usePathname: () => "/posts/batch",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    profiles: {
      list: vi.fn(),
    },
    posts: {
      batchCreate: vi.fn(),
    },
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

const { profiles, posts } = await import("@/lib/api");
/* eslint-disable @typescript-eslint/no-unused-vars */
const _toast = await import("sonner");
/* eslint-enable @typescript-eslint/no-unused-vars */
const mockProfilesList = vi.mocked(profiles.list);
const mockBatchCreate = vi.mocked(posts.batchCreate);

describe("BatchCreatePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProfilesList.mockResolvedValue([makeProfile()]);
    mockBatchCreate.mockResolvedValue([{ id: "new-1" }] as unknown as Awaited<ReturnType<typeof posts.batchCreate>>);
  });

  it("renders heading", () => {
    renderWithProviders(<BatchCreatePage />);
    expect(screen.getByText("Batch Create Posts")).toBeInTheDocument();
  });

  it("renders CSV and Manual tabs", () => {
    renderWithProviders(<BatchCreatePage />);
    expect(screen.getByText("CSV Upload")).toBeInTheDocument();
    expect(screen.getByText("Manual Entry")).toBeInTheDocument();
  });

  it("renders profile selector", async () => {
    renderWithProviders(<BatchCreatePage />);
    expect(await screen.findByText("No profile")).toBeInTheDocument();
  });

  it("loads profiles on mount", async () => {
    renderWithProviders(<BatchCreatePage />);
    await waitFor(() => {
      expect(mockProfilesList).toHaveBeenCalled();
    });
  });

  it("manual tab shows one empty row initially", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BatchCreatePage />);

    await user.click(screen.getByText("Manual Entry"));

    const topicInputs = screen.getAllByPlaceholderText("Topic");
    expect(topicInputs).toHaveLength(1);
  });

  it("manual tab auto-generates slug from topic", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BatchCreatePage />);

    await user.click(screen.getByText("Manual Entry"));

    const topicInput = screen.getByPlaceholderText("Topic");
    await user.type(topicInput, "My Awesome Blog Post");

    const slugInput = screen.getByPlaceholderText("slug");
    expect(slugInput).toHaveValue("my-awesome-blog-post");
  });

  it("add row button adds a new row", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BatchCreatePage />);

    await user.click(screen.getByText("Manual Entry"));

    await user.click(screen.getByText("Add Row"));

    const topicInputs = screen.getAllByPlaceholderText("Topic");
    expect(topicInputs).toHaveLength(2);
  });

  it("submit button shows Create 0 Posts and is disabled on CSV tab with no rows", () => {
    renderWithProviders(<BatchCreatePage />);

    const submitButton = screen.getByRole("button", { name: /Create 0 Posts/i });
    expect(submitButton).toBeDisabled();
  });

  it("submit creates posts and redirects", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BatchCreatePage />);

    await user.click(screen.getByText("Manual Entry"));

    const topicInput = screen.getByPlaceholderText("Topic");
    await user.type(topicInput, "Test Blog Post");

    await user.click(screen.getByRole("button", { name: /Create 1 Post$/i }));

    await waitFor(() => {
      expect(mockBatchCreate).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/");
    });
  });

  it("cancel navigates home", () => {
    renderWithProviders(<BatchCreatePage />);

    const cancelLink = screen.getByRole("link", { name: /Cancel/i });
    expect(cancelLink).toHaveAttribute("href", "/");
  });
});
