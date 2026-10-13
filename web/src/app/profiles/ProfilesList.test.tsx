import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProfilesPage from "./page";
import { renderWithProviders } from "@/test/render";
import { makeProfileListItem } from "@/test/fixtures";
import type { ProfileListItem } from "@/lib/api";

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
const { toast } = await import("sonner");
const mockList = vi.mocked(profiles.list);
// Keep mocked references for mock setup in beforeEach
void vi.mocked(profiles.create);
void vi.mocked(profiles.delete);
void vi.mocked(profiles.crawl);

const testProfiles: ProfileListItem[] = [
  makeProfileListItem({
    id: "prof-1",
    name: "Test Site",
    website_url: "https://example.com",
  }),
  makeProfileListItem({
    id: "prof-2",
    name: "Another Site",
    website_url: "https://another.com",
  }),
];

/** Open the row menu of the first profile and press Delete. */
async function openDeleteConfirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole("button", { name: "Row actions" })[0]);
  await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue(testProfiles);
});

describe("ProfilesPage", () => {
  it("says what a profile owns and what the account owns", async () => {
    renderWithProviders(<ProfilesPage />);
    expect(
      await screen.findByText(
        /A profile owns one site: its voice, publishing connection, internal links and the defaults new posts start from\./
      )
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Account" });
    expect(link).toHaveAttribute("href", "/settings");
    expect(
      screen.getByText(/API keys, stage models and rule files are account-wide/)
    ).toBeInTheDocument();
  });

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
      makeProfileListItem({ id: "prof-1", name: "Test Site", crawl_status: "complete" }),
    ]);
    renderWithProviders(<ProfilesPage />);
    await waitFor(() => {
      expect(screen.getByText("Complete")).toBeInTheDocument();
    });
  });

  it("shows Never for uncrawled profiles", async () => {
    mockList.mockResolvedValue([
      makeProfileListItem({ id: "prof-1", name: "Test Site", last_crawled_at: null }),
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
  it("shows the server's own message and a working retry when the list fails", async () => {
    const user = userEvent.setup();
    mockList.mockRejectedValueOnce(
      new Error(JSON.stringify({ detail: "Profiles unavailable" }))
    );
    renderWithProviders(<ProfilesPage />);
    await waitFor(() => {
      expect(screen.getByText("Could not load profiles")).toBeInTheDocument();
    });
    expect(screen.getByText("Profiles unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No profiles yet")).not.toBeInTheDocument();
    expect(screen.getByText("Profile list unavailable")).toBeInTheDocument();

    mockList.mockResolvedValue(testProfiles);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(screen.getByText("Test Site")).toBeInTheDocument();
    });
    expect(screen.queryByText("Could not load profiles")).not.toBeInTheDocument();
  });

  it("falls back to its own wording when the failure carries no message", async () => {
    mockList.mockRejectedValueOnce(new Error(""));
    renderWithProviders(<ProfilesPage />);
    await waitFor(() => {
      expect(
        screen.getByText("The request failed and the server gave no reason.")
      ).toBeInTheDocument();
    });
  });

  /**
   * The refusal the handler answers with names a count and an action, and it
   * is the only thing that tells the reader why the profile is still there.
   * Swallowing it left a click that appeared to do nothing but print "Failed".
   */
  it("shows the server's reason when a profile cannot be deleted", async () => {
    const user = userEvent.setup();
    vi.mocked(profiles.delete).mockRejectedValueOnce(
      new Error(
        JSON.stringify({
          detail: "This profile still has 3 posts. Delete them before deleting the profile.",
        })
      )
    );
    renderWithProviders(<ProfilesPage />);
    await waitFor(() => {
      expect(screen.getByText("Test Site")).toBeInTheDocument();
    });

    await openDeleteConfirm(user);
    await user.click(await screen.findByRole("button", { name: "Delete profile" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "This profile still has 3 posts. Delete them before deleting the profile."
      );
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("falls back to its own wording when a delete fails with no reason", async () => {
    const user = userEvent.setup();
    vi.mocked(profiles.delete).mockRejectedValueOnce(new Error(""));
    renderWithProviders(<ProfilesPage />);
    await waitFor(() => {
      expect(screen.getByText("Test Site")).toBeInTheDocument();
    });

    await openDeleteConfirm(user);
    await user.click(await screen.findByRole("button", { name: "Delete profile" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("The profile could not be deleted.");
    });
  });

  /**
   * The row menu used to delete on the press itself, with no confirmation and
   * nothing on the row saying what the profile still held. Both halves are
   * here: the count is on the row before the menu is opened, and the press
   * only opens a question.
   */
  it("shows how many posts each profile holds", async () => {
    mockList.mockResolvedValue([
      makeProfileListItem({ id: "prof-1", name: "Busy Site", post_count: 3 }),
      makeProfileListItem({ id: "prof-2", name: "Empty Site", post_count: 0 }),
    ]);
    renderWithProviders(<ProfilesPage />);

    const busy = (await screen.findByText("Busy Site")).closest("tr")!;
    expect(within(busy).getByText("3")).toBeInTheDocument();
    const empty = screen.getByText("Empty Site").closest("tr")!;
    expect(within(empty).getByText("None")).toBeInTheDocument();
  });

  it("asks before deleting and deletes nothing until the question is answered", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfilesPage />);
    await screen.findByText("Test Site");

    await openDeleteConfirm(user);

    expect(
      await screen.findByRole("heading", { name: 'Delete "Test Site"?' })
    ).toBeInTheDocument();
    expect(profiles.delete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: 'Delete "Test Site"?' })
      ).not.toBeInTheDocument();
    });
    expect(profiles.delete).not.toHaveBeenCalled();
  });

  it("deletes a profile with no posts once confirmed", async () => {
    const user = userEvent.setup();
    vi.mocked(profiles.delete).mockResolvedValueOnce(undefined);
    renderWithProviders(<ProfilesPage />);
    await screen.findByText("Test Site");

    await openDeleteConfirm(user);
    expect(
      screen.getByText(/This profile has no posts\./)
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete profile" }));

    await waitFor(() => {
      expect(profiles.delete).toHaveBeenCalledWith("prof-1", { withPosts: false });
    });
    expect(toast.success).toHaveBeenCalledWith("Profile deleted");
  });

  /**
   * The refusal is still the default, so the cascade has to be a separate
   * press with the number in it. Before this the only path was clearing fifty
   * posts from `/` twenty at a time.
   */
  it("offers to take the posts with the profile, naming how many", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue([
      makeProfileListItem({ id: "prof-1", name: "Busy Site", post_count: 3 }),
    ]);
    vi.mocked(profiles.delete).mockResolvedValueOnce(undefined);
    renderWithProviders(<ProfilesPage />);
    await screen.findByText("Busy Site");

    await openDeleteConfirm(user);

    expect(
      await screen.findByRole("heading", { name: 'Delete "Busy Site" and its 3 posts?' })
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Delete profile and 3 posts" })
    );

    await waitFor(() => {
      expect(profiles.delete).toHaveBeenCalledWith("prof-1", { withPosts: true });
    });
    expect(toast.success).toHaveBeenCalledWith("Profile and 3 posts deleted");
  });

  it("says post rather than posts when there is one", async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue([
      makeProfileListItem({ id: "prof-1", name: "One Site", post_count: 1 }),
    ]);
    renderWithProviders(<ProfilesPage />);
    await screen.findByText("One Site");

    await openDeleteConfirm(user);

    expect(
      await screen.findByRole("heading", { name: 'Delete "One Site" and its 1 post?' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete profile and 1 post" })
    ).toBeInTheDocument();
  });

  it("clears the search from the no-match empty state", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfilesPage />);
    await waitFor(() => {
      expect(screen.getByText("Test Site")).toBeInTheDocument();
    });
    await user.type(screen.getByPlaceholderText("Search profiles..."), "nonexistent-xyz");
    expect(screen.getByText("No profiles match your search")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText("Test Site")).toBeInTheDocument();
  });

  it("keeps a rejected create inline in the dialog", async () => {
    const user = userEvent.setup();
    vi.mocked(profiles.create).mockRejectedValueOnce(
      new Error(JSON.stringify({ detail: "A profile with that URL already exists" }))
    );
    renderWithProviders(<ProfilesPage />);
    await waitFor(() => {
      expect(screen.getByText("New Profile")).toBeInTheDocument();
    });
    await user.click(screen.getByText("New Profile"));
    await user.type(screen.getByLabelText("Name"), "My Site");
    await user.type(screen.getByLabelText("Website URL"), "https://example.com");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => {
      expect(
        screen.getByText("A profile with that URL already exists")
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Create Profile")).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });
});

/**
 * A row written before the write endpoints refused userinfo (P2.107) still
 * holds a plain-text password, and this list is the one screen where every
 * profile is visible at once, so it is where such a row has to announce
 * itself. It printed `profile.website_url` verbatim, which put the password on
 * screen and said nothing about it.
 */
describe("ProfilesPage, a stored URL carrying a password", () => {
  const credentialed: ProfileListItem[] = [
    makeProfileListItem({
      id: "prof-1",
      name: "Old Site",
      website_url: "https://admin:hunter2@old.example.com",
    }),
    makeProfileListItem({
      id: "prof-2",
      name: "Clean Site",
      website_url: "https://clean.example.com",
    }),
  ];

  beforeEach(() => {
    mockList.mockResolvedValue(credentialed);
  });

  it("does not print the password anywhere on the list", async () => {
    renderWithProviders(<ProfilesPage />);
    await screen.findByText("Old Site");
    expect(document.body.textContent).not.toContain("hunter2");
    expect(screen.getByText("https://old.example.com")).toBeInTheDocument();
  });

  it("names the problem on the affected row and only that row", async () => {
    renderWithProviders(<ProfilesPage />);
    const flags = await screen.findAllByText("Password in URL");
    expect(flags).toHaveLength(1);
    expect(flags[0].closest("tr")).toHaveTextContent("Old Site");
  });
});
