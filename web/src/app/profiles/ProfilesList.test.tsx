import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProfilesPage from "./page";
import { renderWithProviders } from "@/test/render";
import { makeProfile } from "@/test/fixtures";
import type { Profile } from "@/lib/api";

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/profiles",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    profiles: {
      list: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      crawl: vi.fn(),
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
const mockList = vi.mocked(profiles.list);
// Keep mocked references for mock setup in beforeEach
void vi.mocked(profiles.create);
void vi.mocked(profiles.delete);
void vi.mocked(profiles.crawl);

const testProfiles: Profile[] = [
  makeProfile({ id: "prof-1", name: "Test Site", website_url: "https://example.com" }),
  makeProfile({ id: "prof-2", name: "Another Site", website_url: "https://another.com" }),
];

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue(testProfiles);
});

describe("ProfilesPage", () => {
  it("renders profiles in table", async () => {
    renderWithProviders(<ProfilesPage />);
    await waitFor(() => {
      expect(screen.getByText("Test Site")).toBeInTheDocument();
      expect(screen.getByText("Another Site")).toBeInTheDocument();
    });
  });

  it("renders website URLs", async () => {
    renderWithProviders(<ProfilesPage />);
    await waitFor(() => {
      expect(screen.getByText("https://example.com")).toBeInTheDocument();
      expect(screen.getByText("https://another.com")).toBeInTheDocument();
    });
  });

  it("shows total profile count", async () => {
    renderWithProviders(<ProfilesPage />);
    await waitFor(() => {
      expect(screen.getByText("2 total profiles")).toBeInTheDocument();
    });
  });

  it("shows loading skeletons initially", () => {
    mockList.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = renderWithProviders(<ProfilesPage />);
    const skeletons = container.querySelectorAll("[class*='animate-pulse']");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("shows empty state when no profiles", async () => {
    mockList.mockResolvedValue([]);
    renderWithProviders(<ProfilesPage />);
    await waitFor(() => {
      expect(screen.getByText("No profiles yet")).toBeInTheDocument();
      expect(screen.getByText("Create your first profile")).toBeInTheDocument();
    });
  });

  it("shows search empty state", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfilesPage />);
    await waitFor(() => {
      expect(screen.getByText("Test Site")).toBeInTheDocument();
    });
    const searchInput = screen.getByPlaceholderText("Search profiles...");
    await user.type(searchInput, "nonexistent-xyz");
    expect(screen.getByText("No profiles match your search")).toBeInTheDocument();
  });

  it("filters profiles by search", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfilesPage />);
    await waitFor(() => {
      expect(screen.getByText("Test Site")).toBeInTheDocument();
      expect(screen.getByText("Another Site")).toBeInTheDocument();
    });
    const searchInput = screen.getByPlaceholderText("Search profiles...");
    await user.type(searchInput, "Another");
    expect(screen.queryByText("Test Site")).not.toBeInTheDocument();
    expect(screen.getByText("Another Site")).toBeInTheDocument();
  });

  it("calls profiles.list on mount", async () => {
    renderWithProviders(<ProfilesPage />);
    await waitFor(() => {
      expect(mockList).toHaveBeenCalled();
    });
  });

  it("renders New Profile button", async () => {
    renderWithProviders(<ProfilesPage />);
    await waitFor(() => {
      expect(screen.getByText("New Profile")).toBeInTheDocument();
    });
  });

  it("shows crawl status badges", async () => {
    mockList.mockResolvedValue([
      makeProfile({ id: "prof-1", name: "Test Site", crawl_status: "complete" }),
    ]);
    renderWithProviders(<ProfilesPage />);
    await waitFor(() => {
      expect(screen.getByText("Complete")).toBeInTheDocument();
    });
  });

  it("shows Never for uncrawled profiles", async () => {
    mockList.mockResolvedValue([
      makeProfile({ id: "prof-1", name: "Test Site", last_crawled_at: null }),
    ]);
    renderWithProviders(<ProfilesPage />);
    await waitFor(() => {
      expect(screen.getByText("Never")).toBeInTheDocument();
    });
  });

  it("create dialog validates required fields", async () => {
    const { toast } = await import("sonner");
    const user = userEvent.setup();
    renderWithProviders(<ProfilesPage />);
    await waitFor(() => {
      expect(screen.getByText("New Profile")).toBeInTheDocument();
    });
    await user.click(screen.getByText("New Profile"));
    await waitFor(() => {
      expect(screen.getByText("Create Profile")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(toast.error).toHaveBeenCalledWith("Name and website URL are required");
  });
});
