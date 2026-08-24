import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProfileDetailPage from "./[id]/page";
import { renderWithProviders } from "@/test/render";
import { makeProfile } from "@/test/fixtures";
import type { InternalLink, Profile } from "@/lib/api";

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
      wpCategories: vi.fn(),
      wpAuthors: vi.fn(),
      wpTest: vi.fn(),
      nextjsTest: vi.fn(),
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
const mockWpCategories = vi.mocked(profiles.wpCategories);
const mockWpAuthors = vi.mocked(profiles.wpAuthors);
const mockWpTest = vi.mocked(profiles.wpTest);
const mockNextjsTest = vi.mocked(profiles.nextjsTest);

/** A profile the page treats as WordPress-connected, so it loads the pickers. */
const wpProfile = () =>
  makeProfile({
    wp_url: "https://wp.example",
    wp_username: "editor",
    wp_app_password_set: true,
  });

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

/**
 * The detail page groups its cards into four tabs, so an assertion about a card
 * has to say which tab owns it. Clicking rather than deep linking with `?tab=`
 * keeps these tests independent of the URL mechanism, which has its own.
 */
async function renderOnTab(tab: "Site" | "Publishing" | "New post defaults" | "Internal links") {
  const result = renderWithProviders(<ProfileDetailPage />);
  await userEvent.setup().click(await screen.findByRole("tab", { name: tab }));
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The page reads its tab off the URL, so one test's deep link must not
  // decide the next test's starting tab.
  window.history.replaceState({}, "", "/profiles/prof-1");
  mockGet.mockResolvedValue(makeProfile());
  mockLinks.mockResolvedValue({ items: testLinks, total: testLinks.length, page: 1, per_page: 20, pages: 1 });
  mockWpCategories.mockResolvedValue([]);
  mockWpAuthors.mockResolvedValue([]);
  mockWpTest.mockResolvedValue({ connected: true, site_name: "Test Site" });
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

  // `/profiles` has named all four `crawl_status` values since it was written;
  // this page printed the stored value, so the two surfaces showed a different
  // word for the same row.
  it.each([
    ["crawling", "Crawling"],
    ["complete", "Complete"],
    ["failed", "Failed"],
    ["pending", "Pending"],
  ])("names crawl status %s as %s", async (stored, shown) => {
    mockGet.mockResolvedValue(makeProfile({ crawl_status: stored }));
    await renderOnTab("Internal links");
    await waitFor(() => {
      expect(screen.getByText(shown)).toBeInTheDocument();
    });
    expect(screen.queryByText(stored)).toBeNull();
  });

  it("crawl button starts crawl", async () => {
    mockCrawl.mockResolvedValue({ status: "started" });
    const user = userEvent.setup();
    await renderOnTab("Internal links");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Crawl Sitemap/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Crawl Sitemap/i }));
    await waitFor(() => {
      expect(mockCrawl).toHaveBeenCalledWith("prof-1");
    });
  });

  it("renders internal links", async () => {
    await renderOnTab("Internal links");
    await waitFor(() => {
      expect(screen.getByText("https://example.com/page-1")).toBeInTheDocument();
      expect(screen.getByText("https://example.com/page-2")).toBeInTheDocument();
    });
  });

  it("shows empty links state", async () => {
    mockLinks.mockResolvedValue({ items: [], total: 0, page: 1, per_page: 20, pages: 0 });
    await renderOnTab("Internal links");
    await waitFor(() => {
      expect(screen.getByText("No internal links yet")).toBeInTheDocument();
    });
  });

  it("search links input present", async () => {
    await renderOnTab("Internal links");
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Search links by URL or title...")
      ).toBeInTheDocument();
    });
  });

  it("sends one links request for a typed word, not one per keystroke", async () => {
    const user = userEvent.setup({ delay: null });
    await renderOnTab("Internal links");
    await waitFor(() =>
      expect(screen.getByText("https://example.com/page-1")).toBeInTheDocument()
    );
    mockLinks.mockClear();

    await user.type(
      screen.getByPlaceholderText("Search links by URL or title..."),
      "pricing"
    );

    await waitFor(() =>
      expect(mockLinks).toHaveBeenLastCalledWith("prof-1", {
        page: 1,
        per_page: 20,
        q: "pricing",
      })
    );
    expect(mockLinks).toHaveBeenCalledTimes(1);
  });

  it("does not let a slow links answer overwrite a newer search", async () => {
    const user = userEvent.setup({ delay: null });
    await renderOnTab("Internal links");
    await waitFor(() =>
      expect(screen.getByText("https://example.com/page-1")).toBeInTheDocument()
    );

    type LinkPage = Awaited<ReturnType<typeof profiles.links>>;
    const page = (url: string): LinkPage => ({
      items: [{ ...testLinks[0], id: url, url }],
      total: 1,
      page: 1,
      per_page: 20,
      pages: 1,
    });
    let resolveSlow!: (value: LinkPage) => void;
    let resolveFast!: (value: LinkPage) => void;
    mockLinks.mockReturnValueOnce(
      new Promise<LinkPage>((r) => {
        resolveSlow = r;
      })
    );
    mockLinks.mockReturnValueOnce(
      new Promise<LinkPage>((r) => {
        resolveFast = r;
      })
    );

    const box = screen.getByPlaceholderText("Search links by URL or title...");
    await user.type(box, "pr");
    await waitFor(() => expect(mockLinks).toHaveBeenCalledTimes(2));
    await user.type(box, "ice");
    await waitFor(() => expect(mockLinks).toHaveBeenCalledTimes(3));

    await act(async () => {
      resolveFast(page("https://example.com/price"));
    });
    await waitFor(() =>
      expect(screen.getByText("https://example.com/price")).toBeInTheDocument()
    );

    await act(async () => {
      resolveSlow(page("https://example.com/stale"));
    });

    expect(screen.queryByText("https://example.com/stale")).not.toBeInTheDocument();
    expect(screen.getByText("https://example.com/price")).toBeInTheDocument();
  });

  it("keeps the links spinner up until the newest request answers", async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = await renderOnTab("Internal links");
    await waitFor(() =>
      expect(screen.getByText("https://example.com/page-1")).toBeInTheDocument()
    );

    type LinkPage = Awaited<ReturnType<typeof profiles.links>>;
    let resolveSlow!: (value: LinkPage) => void;
    mockLinks.mockReturnValueOnce(
      new Promise<LinkPage>((r) => {
        resolveSlow = r;
      })
    );
    mockLinks.mockReturnValueOnce(new Promise(() => {}));

    const box = screen.getByPlaceholderText("Search links by URL or title...");
    await user.type(box, "pr");
    await waitFor(() => expect(mockLinks).toHaveBeenCalledTimes(2));
    await user.type(box, "ice");
    await waitFor(() => expect(mockLinks).toHaveBeenCalledTimes(3));

    await act(async () => {
      resolveSlow({
        items: testLinks,
        total: testLinks.length,
        page: 1,
        per_page: 20,
        pages: 1,
      });
    });

    // The superseded answer neither draws rows nor takes the spinner down.
    expect(container.querySelectorAll(".animate-spin").length).toBeGreaterThan(0);
  });

  it("keeps the searched empty state while a cleared links search is in flight", async () => {
    const user = userEvent.setup({ delay: null });
    await renderOnTab("Internal links");
    await waitFor(() =>
      expect(screen.getByText("https://example.com/page-1")).toBeInTheDocument()
    );

    mockLinks.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      per_page: 20,
      pages: 0,
    });
    const box = screen.getByPlaceholderText("Search links by URL or title...");
    await user.type(box, "zzz");
    await waitFor(() =>
      expect(screen.getByText("No links match your search")).toBeInTheDocument()
    );

    mockLinks.mockReturnValue(new Promise(() => {}));
    await user.clear(box);

    // The empty table on screen is still the search's, so it must not read as
    // a profile that has no links at all.
    expect(screen.getByText("No links match your search")).toBeInTheDocument();
    expect(screen.queryByText("No internal links yet")).not.toBeInTheDocument();
  });

  it("add link button toggles form", async () => {
    const user = userEvent.setup();
    await renderOnTab("Internal links");
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
    const { container } = await renderOnTab("Internal links");
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

  it("shows the server's own message and a working retry when the load fails", async () => {
    const user = userEvent.setup();
    mockGet.mockRejectedValueOnce(
      new Error(JSON.stringify({ detail: "Profile not found" }))
    );
    renderWithProviders(<ProfileDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Could not load this profile")).toBeInTheDocument();
    });
    expect(screen.getByText("Profile not found")).toBeInTheDocument();
    // The URL is where the profile is: a failed load must not throw it away.
    expect(mockPush).not.toHaveBeenCalled();

    mockGet.mockResolvedValue(makeProfile({ name: "Test Profile" }));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(screen.getByText("Test Profile")).toBeInTheDocument();
    });
    expect(
      screen.queryByText("Could not load this profile")
    ).not.toBeInTheDocument();
  });

  it("falls back to its own wording when the load failure carries no message", async () => {
    mockGet.mockRejectedValueOnce(new Error(""));
    renderWithProviders(<ProfileDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByText("The request failed and the server gave no reason.")
      ).toBeInTheDocument();
    });
  });

  it("shows a links error with a retry instead of an empty links table", async () => {
    const user = userEvent.setup();
    mockLinks.mockRejectedValueOnce(
      new Error(JSON.stringify({ detail: "Links unavailable" }))
    );
    await renderOnTab("Internal links");
    await waitFor(() => {
      expect(screen.getByText("Could not load internal links")).toBeInTheDocument();
    });
    expect(screen.getByText("Links unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No internal links yet")).not.toBeInTheDocument();

    mockLinks.mockResolvedValue({
      items: testLinks,
      total: testLinks.length,
      page: 1,
      per_page: 20,
      pages: 1,
    });
    await user.click(screen.getByRole("button", { name: "Retry links" }));
    await waitFor(() => {
      expect(screen.getByText("https://example.com/page-1")).toBeInTheDocument();
    });
  });

  it("renders skeleton rows while the first page of links is in flight", async () => {
    mockLinks.mockReturnValue(new Promise(() => {}));
    const { container } = await renderOnTab("Internal links");
    await waitFor(() => {
      expect(screen.getByText("Internal Links")).toBeInTheDocument();
    });
    expect(screen.queryByText("No internal links yet")).not.toBeInTheDocument();
    const rows = container.querySelectorAll(
      "tbody tr [class*='animate-pulse']"
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("shows why the WordPress pickers are empty instead of swallowing it", async () => {
    mockGet.mockResolvedValue(wpProfile());
    const rejection = new Error(
      JSON.stringify({
        detail: "WordPress API error: Sorry, you are not allowed to list users.",
      })
    );
    mockWpAuthors.mockRejectedValue(rejection);
    await renderOnTab("Publishing");
    await waitFor(() => {
      expect(
        screen.getByText(
          "WordPress API error: Sorry, you are not allowed to list users."
        )
      ).toBeInTheDocument();
    });
  });

  it("keeps the categories it did load when only the authors call fails", async () => {
    // `list_users` needs a capability `list_categories` does not, so one call
    // failing while the other succeeds is the realistic case, not a corner.
    mockGet.mockResolvedValue(
      makeProfile({
        wp_url: "https://wp.example",
        wp_username: "editor",
        wp_default_category_id: 7,
      })
    );
    mockWpCategories.mockResolvedValue([
      { id: 7, name: "Guides", slug: "guides", count: 3 },
    ]);
    mockWpAuthors.mockRejectedValue(new Error(JSON.stringify({ detail: "nope" })));
    await renderOnTab("Publishing");
    await waitFor(() => {
      expect(screen.getByText("nope")).toBeInTheDocument();
    });
    // The category trigger can only read "Guides" if the list survived the
    // sibling rejection: it renders the selected id's name, not the id.
    expect(
      screen.getByRole("combobox", { name: "Default Category" })
    ).toHaveTextContent("Guides");
  });

  it("keeps a rejected save inline above the button", async () => {
    const user = userEvent.setup();
    mockUpdate.mockRejectedValueOnce(
      new Error(JSON.stringify({ detail: "website_url must be absolute" }))
    );
    renderWithProviders(<ProfileDetailPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue("Test Site")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Save Profile/i }));
    await waitFor(() => {
      expect(
        screen.getByText("website_url must be absolute")
      ).toBeInTheDocument();
    });
  });
  /**
   * The profile boundary refuses a `wp_url` the WordPress client cannot build
   * an endpoint from, and FastAPI's 422 carries the reason as a list of field
   * errors rather than as a string. Both places a person can trigger that
   * rejection have to show the reason, or the refusal is worse than the bug it
   * replaced: the URL looks accepted and nothing says why it was not.
   */
  const REJECTED_WP_URL = JSON.stringify({
    detail: [
      {
        type: "value_error",
        loc: ["body", "wp_url"],
        msg: "WordPress URL should start with http:// or https://",
        input: "wp.example",
      },
    ],
  });

  it("shows the field error behind a 422 save, not just that the save failed", async () => {
    const user = userEvent.setup();
    mockUpdate.mockRejectedValueOnce(new Error(REJECTED_WP_URL));
    renderWithProviders(<ProfileDetailPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue("Test Site")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Save Profile/i }));

    await waitFor(() => {
      expect(
        screen.getByText("WordPress URL should start with http:// or https://")
      ).toBeInTheDocument();
    });
  });

  it("shows why Test Connection could not save the URL it was asked to test", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue(wpProfile());
    mockUpdate.mockRejectedValueOnce(new Error(REJECTED_WP_URL));
    await renderOnTab("Publishing");
    await waitFor(() => {
      expect(screen.getByDisplayValue("https://wp.example")).toBeInTheDocument();
    });

    // The page tests the stored credentials on load, so what this asserts is
    // that the button's own click never reached WordPress: the save it depends
    // on was refused first.
    const onLoad = mockWpTest.mock.calls.length;

    await user.click(screen.getByRole("button", { name: /Test connection/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "WordPress URL should start with http:// or https://"
      );
    });
    expect(mockWpTest).toHaveBeenCalledTimes(onLoad);
  });

  /**
   * A connection nobody can find is a connection nobody configures, and a
   * status derived from two non-empty fields says "Connected" beside a picker
   * that just failed to load. Both halves of ledger item P1.3d.
   */
  describe("publishing connections", () => {
    it("offers the WordPress fields on a profile that has never used WordPress", async () => {
      await renderOnTab("Publishing");
      expect(screen.getByLabelText("WordPress URL")).toBeInTheDocument();
      expect(screen.getByLabelText("Application Password")).toBeInTheDocument();
    });

    it("offers the Next.js webhook fields on the same profile", async () => {
      await renderOnTab("Publishing");
      expect(screen.getByLabelText("Webhook URL")).toBeInTheDocument();
    });

    it("says a connection with no credentials is not configured, and tests nothing", async () => {
      await renderOnTab("Publishing");
      expect(screen.getAllByText("Not configured")).toHaveLength(2);
      expect(mockWpTest).not.toHaveBeenCalled();
      expect(mockNextjsTest).not.toHaveBeenCalled();
    });

    it("reports the site a real test reached, not the fields that were filled in", async () => {
      mockGet.mockResolvedValue(wpProfile());
      mockWpTest.mockResolvedValue({ connected: true, site_name: "Editorial" });
      await renderOnTab("Publishing");
      await waitFor(() => {
        expect(screen.getByText("Connected")).toBeInTheDocument();
      });
      expect(screen.getByText("Connected to Editorial")).toBeInTheDocument();
    });

    it("does not call a WordPress connection connected when the test fails", async () => {
      mockGet.mockResolvedValue(wpProfile());
      mockWpTest.mockResolvedValue({
        connected: false,
        error: "Authentication failed. Check the username and application password.",
      });
      await renderOnTab("Publishing");
      await waitFor(() => {
        expect(
          screen.getByText(
            "Authentication failed. Check the username and application password."
          )
        ).toBeInTheDocument();
      });
      expect(screen.queryByText("Connected")).not.toBeInTheDocument();
      expect(screen.getByText("Not connecting")).toBeInTheDocument();
      // The pickers are read from the site, so there is nothing to show.
      expect(
        screen.queryByRole("combobox", { name: "Default Category" })
      ).not.toBeInTheDocument();
    });

    it("shows what WordPress said as a sentence, not as markup", async () => {
      mockGet.mockResolvedValue(wpProfile());
      mockWpTest.mockResolvedValue({
        connected: false,
        error:
          "WordPress API error: <strong>Error:</strong> Unknown username. " +
          "Check again or try your email address.",
      });
      await renderOnTab("Publishing");
      await waitFor(() => {
        expect(
          screen.getByText(
            "WordPress API error: Error: Unknown username. " +
              "Check again or try your email address."
          )
        ).toBeInTheDocument();
      });
    });

    it("strips the same markup out of a failed picker load", async () => {
      mockGet.mockResolvedValue(wpProfile());
      mockWpAuthors.mockRejectedValue(
        new Error(
          JSON.stringify({
            detail: "WordPress API error: <strong>Error:</strong> Not allowed.",
          })
        )
      );
      await renderOnTab("Publishing");
      await waitFor(() => {
        expect(
          screen.getByText("WordPress API error: Error: Not allowed.")
        ).toBeInTheDocument();
      });
    });

    it("does not call a stored webhook URL connected before it has answered", async () => {
      // Testing the webhook POSTs to the customer's site, so the page cannot
      // fire it on load the way it can read `/wp-json`.
      mockGet.mockResolvedValue(
        makeProfile({
          nextjs_webhook_url: "https://blog.example/api/jena-webhook",
          nextjs_webhook_secret_set: true,
        })
      );
      await renderOnTab("Publishing");
      await waitFor(() => {
        expect(
          screen.getByDisplayValue("https://blog.example/api/jena-webhook")
        ).toBeInTheDocument();
      });
      expect(screen.getByText("Not tested")).toBeInTheDocument();
      expect(mockNextjsTest).not.toHaveBeenCalled();
    });

    it("reports a webhook test failure under the webhook fields", async () => {
      const user = userEvent.setup();
      mockGet.mockResolvedValue(
        makeProfile({
          nextjs_webhook_url: "https://blog.example/api/jena-webhook",
          nextjs_webhook_secret_set: true,
        })
      );
      mockUpdate.mockResolvedValue(makeProfile());
      mockNextjsTest.mockResolvedValue({
        connected: false,
        error: "Webhook returned 401",
      });
      await renderOnTab("Publishing");

      await user.click(screen.getByRole("button", { name: /Test webhook/i }));

      await waitFor(() => {
        expect(screen.getByText("Webhook returned 401")).toBeInTheDocument();
      });
    });
  });

  /**
   * The output format names where a finished post goes. Offering a
   * destination the profile has no credentials for buys a run that pays for
   * six stages and then fails in the publish step, so the option is not
   * offered until the credentials exist.
   */
  describe("output format availability", () => {
    it("refuses both publishing formats on a profile with no credentials", async () => {
      const user = userEvent.setup();
      await renderOnTab("Publishing");

      await user.click(screen.getByRole("combobox", { name: "Output Format" }));

      expect(await screen.findByRole("option", { name: /WordPress/ })).toHaveAttribute(
        "aria-disabled",
        "true"
      );
      expect(await screen.findByRole("option", { name: /Next.js/ })).toHaveAttribute(
        "aria-disabled",
        "true"
      );
      expect(await screen.findByRole("option", { name: "Markdown" })).not.toHaveAttribute(
        "aria-disabled",
        "true"
      );
    });

    it("points at the card that fixes it rather than just greying the option", async () => {
      await renderOnTab("Publishing");

      expect(
        screen.getByText(
          "WordPress (Direct Publish): Fill in the WordPress card below to publish there."
        )
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "Next.js (Webhook): Fill in the Next.js card below to publish there."
        )
      ).toBeInTheDocument();
    });

    it("offers WordPress once the profile has all three credentials", async () => {
      const user = userEvent.setup();
      mockGet.mockResolvedValue(wpProfile());
      mockWpTest.mockResolvedValue({ connected: true, site_name: "Editorial" });
      await renderOnTab("Publishing");
      await waitFor(() => {
        expect(screen.getByText("Connected")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("combobox", { name: "Output Format" }));

      expect(await screen.findByRole("option", { name: /WordPress/ })).not.toHaveAttribute(
        "aria-disabled",
        "true"
      );
    });

    /**
     * The credentials and the format live on the same unsaved form, so
     * reading the availability off the loaded profile would make the user
     * save twice to pick the format they just configured.
     */
    it("opens up the format as the credentials are typed, before any save", async () => {
      const user = userEvent.setup();
      await renderOnTab("Publishing");

      await user.type(screen.getByLabelText("WordPress URL"), "https://wp.example");
      await user.type(screen.getByLabelText("Username"), "editor");
      await user.type(screen.getByLabelText("Application Password"), "abcd efgh");

      await waitFor(() =>
        expect(
          screen.queryByText(
            "WordPress (Direct Publish): Fill in the WordPress card below to publish there."
          )
        ).not.toBeInTheDocument()
      );
    });

    it("raises the reason to an alert when the profile already names that format", async () => {
      mockGet.mockResolvedValue(makeProfile({ output_format: "nextjs" }));
      await renderOnTab("Publishing");

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Next.js (Webhook): Fill in the Next.js card below to publish there."
        );
      });
    });
  });

  describe("default stage settings", () => {
    it("names the mode a stage is configured for", async () => {
      await renderOnTab("New post defaults");

      await waitFor(() => {
        expect(screen.getByLabelText("Research stage mode")).toHaveTextContent(
          "Run automatically"
        );
      });
    });

    it("shows a stored review gate instead of an empty picker", async () => {
      // The defect: `StageMode` was `"auto"` alone, so the picker held one
      // option and a profile whose column already said `review` rendered a
      // blank trigger with no way to tell what it was set to or clear it.
      mockGet.mockResolvedValue(
        makeProfile({
          default_stage_settings: {
            research: "review",
            outline: "auto",
            write: "auto",
            edit: "auto",
            images: "auto",
            ready: "auto",
          },
        })
      );
      await renderOnTab("New post defaults");

      await waitFor(() => {
        expect(screen.getByLabelText("Research stage mode")).toHaveTextContent(
          "Wait for review"
        );
      });
      expect(screen.getByLabelText("Outline stage mode")).toHaveTextContent(
        "Run automatically"
      );
    });

    it("renders a column that names fewer than six stages", async () => {
      mockGet.mockResolvedValue(
        makeProfile({
          default_stage_settings: { research: "auto" } as Profile["default_stage_settings"],
        })
      );
      await renderOnTab("New post defaults");

      await waitFor(() =>
        expect(screen.getByLabelText("Outline stage mode")).toBeInTheDocument()
      );
      expect(screen.getByLabelText("Research stage mode")).toHaveTextContent(
        "Run automatically"
      );
    });

    it("offers no way to add a gate the dashboard cannot release", async () => {
      // Nothing in the app resumes a suspended run, so a gate switched on here
      // would park a post with no approve action anywhere to continue it. The
      // picker lets a stored gate be cleared and not set.
      const user = userEvent.setup();
      mockGet.mockResolvedValue(
        makeProfile({
          default_stage_settings: {
            research: "review",
            outline: "auto",
            write: "auto",
            edit: "auto",
            images: "auto",
            ready: "auto",
          },
        })
      );
      await renderOnTab("New post defaults");

      await waitFor(() =>
        expect(screen.getByLabelText("Outline stage mode")).toBeInTheDocument()
      );

      await user.click(screen.getByLabelText("Outline stage mode"));
      await waitFor(() =>
        expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
          "Run automatically",
        ])
      );
    });
  });

  /**
   * The seven cards used to sit in one scroll, so the publishing connection a
   * user came for was below a form about tone of voice. They are grouped by
   * the ownership table in `docs/polish/evidence/p3.md`: what the site is,
   * where its posts go, what a new post starts from, and its link inventory.
   */
  describe("tabs", () => {
    it("groups the cards into four tabs named for what they own", async () => {
      renderWithProviders(<ProfileDetailPage />);
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "Test Site" })).toBeInTheDocument();
      });

      expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
        "Site",
        "Publishing",
        "New post defaults",
        "Internal links",
      ]);
    });

    it("opens on Site, with the other three tabs' contents out of the way", async () => {
      renderWithProviders(<ProfileDetailPage />);
      await waitFor(() => {
        expect(screen.getByLabelText(/^Name/)).toBeInTheDocument();
      });

      expect(screen.getByLabelText("Brand Voice")).toBeInTheDocument();
      expect(screen.queryByLabelText("WordPress URL")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Word Count")).not.toBeInTheDocument();
      expect(screen.queryByText("Internal Links")).not.toBeInTheDocument();
    });

    it("opens on the tab the URL names, so a link can point at the connection", async () => {
      window.history.replaceState({}, "", "/profiles/prof-1?tab=publishing");
      renderWithProviders(<ProfileDetailPage />);

      expect(await screen.findByLabelText("WordPress URL")).toBeInTheDocument();
      expect(screen.queryByLabelText(/^Name/)).not.toBeInTheDocument();
    });

    it("falls back to Site when the URL names a tab that does not exist", async () => {
      window.history.replaceState({}, "", "/profiles/prof-1?tab=nonsense");
      renderWithProviders(<ProfileDetailPage />);

      expect(await screen.findByLabelText(/^Name/)).toBeInTheDocument();
    });

    it("puts the tab it is on into the URL", async () => {
      const user = userEvent.setup();
      renderWithProviders(<ProfileDetailPage />);
      await waitFor(() => {
        expect(screen.getByLabelText(/^Name/)).toBeInTheDocument();
      });

      await user.click(screen.getByRole("tab", { name: "Publishing" }));

      expect(window.location.search).toBe("?tab=publishing");
      expect(await screen.findByLabelText("WordPress URL")).toBeInTheDocument();
    });

    it("keeps Save Profile reachable from a tab that holds no profile form", async () => {
      mockUpdate.mockResolvedValue(makeProfile());
      const user = userEvent.setup();
      renderWithProviders(<ProfileDetailPage />);
      await waitFor(() => {
        expect(screen.getByLabelText(/^Name/)).toBeInTheDocument();
      });

      await user.click(screen.getByRole("tab", { name: "Internal links" }));
      await user.click(screen.getByRole("button", { name: /Save Profile/i }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith(
          "prof-1",
          expect.objectContaining({ name: "Test Site" })
        );
      });
    });

    it("saves an edit made on a tab the user has since left", async () => {
      mockUpdate.mockResolvedValue(makeProfile());
      const user = userEvent.setup();
      renderWithProviders(<ProfileDetailPage />);
      await waitFor(() => {
        expect(screen.getByLabelText("Tone")).toBeInTheDocument();
      });

      await user.clear(screen.getByLabelText("Tone"));
      await user.type(screen.getByLabelText("Tone"), "wry");
      await user.click(screen.getByRole("tab", { name: "Publishing" }));
      await user.click(screen.getByRole("button", { name: /Save Profile/i }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith(
          "prof-1",
          expect.objectContaining({ tone: "wry" })
        );
      });
    });
  });
});

describe("ProfileDetailPage ownership boundary", () => {
  it("names the account-wide settings and links to them", async () => {
    renderWithProviders(<ProfileDetailPage />);
    const link = await screen.findByRole("link", { name: "Account settings" });
    expect(link).toHaveAttribute("href", "/settings");
    expect(
      screen.getByText(/API keys, stage models and rule files are account-wide/)
    ).toBeInTheDocument();
  });

  it("says which surfaces read the default stage settings", async () => {
    await renderOnTab("New post defaults");
    expect(
      await screen.findByText(
        /Copied onto every post created from this profile, in New Post and Batch Create\./
      )
    ).toBeInTheDocument();
  });
});
