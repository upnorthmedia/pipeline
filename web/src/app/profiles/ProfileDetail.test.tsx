import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProfileDetailPage from "./[id]/page";
import { renderWithProviders } from "@/test/render";
import { makeProfile } from "@/test/fixtures";
import type { InternalLink } from "@/lib/api";

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/profiles/prof-1",
  useParams: () => ({ id: "prof-1" }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    profiles: {
      get: vi.fn(),
      update: vi.fn(),
      crawl: vi.fn(),
      links: vi.fn(),
      createLink: vi.fn(),
      deleteLink: vi.fn(),
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

const { profiles } = await import("@/lib/api");
const { toast } = await import("sonner");
const mockGet = vi.mocked(profiles.get);
const mockUpdate = vi.mocked(profiles.update);
const mockCrawl = vi.mocked(profiles.crawl);
const mockLinks = vi.mocked(profiles.links);
void vi.mocked(profiles.createLink);
const mockDeleteLink = vi.mocked(profiles.deleteLink);

const testLinks: InternalLink[] = [
  {
    id: "link-1",
    profile_id: "prof-1",
    url: "https://example.com/page-1",
    title: "Page One",
    slug: "page-1",
    source: "sitemap",
    post_id: null,
    keywords: [],
    created_at: "2025-01-01T00:00:00Z",
  },
  {
    id: "link-2",
    profile_id: "prof-1",
    url: "https://example.com/page-2",
    title: "Page Two",
    slug: "page-2",
    source: "manual",
    post_id: null,
    keywords: [],
    created_at: "2025-01-02T00:00:00Z",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue(makeProfile());
  mockLinks.mockResolvedValue({ items: testLinks, total: testLinks.length, page: 1, per_page: 20, pages: 1 });
});

describe("ProfileDetailPage", () => {
  it("shows loading skeleton initially", () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    const { container } = renderWithProviders(<ProfileDetailPage />);
    const skeletons = container.querySelectorAll("[class*='animate-pulse']");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("renders profile name after loading", async () => {
    renderWithProviders(<ProfileDetailPage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Test Site" })).toBeInTheDocument();
    });
  });

  it("renders profile website URL", async () => {
    renderWithProviders(<ProfileDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("https://example.com")).toBeInTheDocument();
    });
  });

  it("populates form fields from profile", async () => {
    renderWithProviders(<ProfileDetailPage />);
    await waitFor(() => {
      const nicheInput = screen.getByLabelText("Niche") as HTMLInputElement;
      expect(nicheInput.value).toBe("Technology");
    });
  });

  it("save button calls profiles.update", async () => {
    const profile = makeProfile();
    mockUpdate.mockResolvedValue(profile);
    const user = userEvent.setup();
    renderWithProviders(<ProfileDetailPage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Test Site" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Save Profile/i }));
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        "prof-1",
        expect.objectContaining({
          name: "Test Site",
          website_url: "https://example.com",
        })
      );
      expect(toast.success).toHaveBeenCalledWith("Profile saved");
    });
  });

  it("save validates name and URL required", async () => {
    renderWithProviders(<ProfileDetailPage />);
    await waitFor(() => {
      expect(screen.getByLabelText(/^Name/)).toBeInTheDocument();
    });
    const nameInput = screen.getByLabelText(/^Name/) as HTMLInputElement;
    // Use fireEvent to bypass HTML5 required constraint and directly change value
    fireEvent.change(nameInput, { target: { value: "" } });
    // Submit the form directly to bypass native browser validation in jsdom
    const form = nameInput.closest("form")!;
    fireEvent.submit(form);
    expect(toast.error).toHaveBeenCalledWith("Name and Website URL are required");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("shows crawl status", async () => {
    mockGet.mockResolvedValue(makeProfile({ crawl_status: "crawling" }));
    renderWithProviders(<ProfileDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("crawling")).toBeInTheDocument();
    });
  });

  it("crawl button starts crawl", async () => {
    mockCrawl.mockResolvedValue({ status: "started" });
    const user = userEvent.setup();
    renderWithProviders(<ProfileDetailPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Crawl Sitemap/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Crawl Sitemap/i }));
    await waitFor(() => {
      expect(mockCrawl).toHaveBeenCalledWith("prof-1");
    });
  });

  it("renders internal links", async () => {
    renderWithProviders(<ProfileDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("https://example.com/page-1")).toBeInTheDocument();
      expect(screen.getByText("https://example.com/page-2")).toBeInTheDocument();
    });
  });

  it("shows empty links state", async () => {
    mockLinks.mockResolvedValue({ items: [], total: 0, page: 1, per_page: 20, pages: 0 });
    renderWithProviders(<ProfileDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("No internal links yet")).toBeInTheDocument();
    });
  });

  it("search links input present", async () => {
    renderWithProviders(<ProfileDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Search links by URL or title...")
      ).toBeInTheDocument();
    });
  });

  it("add link button toggles form", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfileDetailPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add Link/i })).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/^URL/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Add Link/i }));
    expect(screen.getByLabelText(/^URL/)).toBeInTheDocument();
  });

  it("delete link removes from list", async () => {
    mockDeleteLink.mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ProfileDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("https://example.com/page-1")).toBeInTheDocument();
    });
    // Find icon-only buttons inside table rows (trash buttons)
    const tableRows = container.querySelectorAll("tbody tr");
    const firstRowDeleteBtn = tableRows[0].querySelector("button");
    expect(firstRowDeleteBtn).toBeTruthy();
    await user.click(firstRowDeleteBtn!);
    await waitFor(() => {
      expect(mockDeleteLink).toHaveBeenCalledWith("prof-1", expect.any(String));
    });
  });

  it("redirects on fetch error", async () => {
    mockGet.mockRejectedValue(new Error("Not found"));
    renderWithProviders(<ProfileDetailPage />);
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/profiles");
    });
  });
});
