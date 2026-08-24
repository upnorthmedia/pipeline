import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
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
    // Both requests stay pending: a profile list resolving after the test body
    // has finished updates state outside act() and prints a warning.
    mockPostsList.mockReturnValue(new Promise(() => {})); // never resolves
    mockProfilesList.mockReturnValue(new Promise(() => {}));
    const { container } = renderWithProviders(<PostsPage />);
    const skeletons = container.querySelectorAll("[class*='animate-pulse']");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("shows empty state when no posts", async () => {
    mockPostsList.mockResolvedValue([]);
    renderWithProviders(<PostsPage />);
    await waitFor(() => {
      expect(screen.getByText("No posts yet")).toBeInTheDocument();
      expect(screen.getByText("Create your first post")).toBeInTheDocument();
    });
  });

  it("tells a filtered empty result apart from an empty account", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PostsPage />);
    await waitFor(() => expect(screen.getByText("First Post")).toBeInTheDocument());

    mockPostsList.mockResolvedValue([]);
    await user.type(screen.getByPlaceholderText("Search posts..."), "zzz");

    await waitFor(() => {
      expect(screen.getByText("No posts match these filters")).toBeInTheDocument();
    });
    expect(screen.queryByText("Create your first post")).not.toBeInTheDocument();

    mockPostsList.mockResolvedValue(testPosts);
    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => expect(screen.getByText("First Post")).toBeInTheDocument());
    expect(screen.getByPlaceholderText("Search posts...")).toHaveValue("");
  });

  it("shows the server's own message and a retry when the list fails", async () => {
    const user = userEvent.setup();
    mockPostsList.mockRejectedValueOnce(
      new Error(JSON.stringify({ detail: "profile 9 does not belong to you" }))
    );
    renderWithProviders(<PostsPage />);

    await waitFor(() => {
      expect(screen.getByText("Could not load posts")).toBeInTheDocument();
    });
    expect(
      screen.getByText("profile 9 does not belong to you")
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getByText("First Post")).toBeInTheDocument());
    expect(screen.queryByText("Could not load posts")).not.toBeInTheDocument();
  });

  it("falls back to its own wording when the failure carries no message", async () => {
    mockPostsList.mockRejectedValue(new Error("Failed to fetch"));
    renderWithProviders(<PostsPage />);

    await waitFor(() => {
      expect(
        screen.getByText("The request failed and the server gave no reason.")
      ).toBeInTheDocument();
    });
  });

  it("counts one post without a plural", async () => {
    mockPostsList.mockResolvedValue([testPosts[0]]);
    renderWithProviders(<PostsPage />);
    await waitFor(() => {
      expect(screen.getByText("1 total post")).toBeInTheDocument();
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

  /**
   * The gate queue. `current_stage` stays on the stage the worker suspended
   * in, so the `status` parameter every other option uses cannot ask for the
   * posts holding in front of a person: this one option has to reach the
   * server's `awaiting_review` filter instead.
   */
  describe("waiting for review filter", () => {
    async function openStateFilter() {
      const user = userEvent.setup();
      renderWithProviders(<PostsPage />);
      await waitFor(() => expect(screen.getByText("First Post")).toBeInTheDocument());
      await user.click(screen.getByRole("combobox", { name: "Filter posts by state" }));
      return user;
    }

    it("offers Waiting for review among the states", async () => {
      await openStateFilter();
      expect(
        await screen.findByRole("option", { name: "Waiting for review" })
      ).toBeInTheDocument();
    });

    it("asks the server for the gate queue rather than for a stage", async () => {
      const user = await openStateFilter();
      await user.click(await screen.findByRole("option", { name: "Waiting for review" }));

      await waitFor(() =>
        expect(mockPostsList).toHaveBeenLastCalledWith({ awaiting_review: "true" })
      );
    });

    it("counts the queue rather than calling it a total", async () => {
      mockPostsList.mockResolvedValue([testPosts[0]]);
      const user = await openStateFilter();
      await user.click(await screen.findByRole("option", { name: "Waiting for review" }));

      expect(await screen.findByText("1 post waiting for your review")).toBeInTheDocument();
      expect(screen.queryByText("1 total post")).not.toBeInTheDocument();
    });

    it("says nothing is waiting rather than blaming the filters", async () => {
      const user = await openStateFilter();
      mockPostsList.mockResolvedValue([]);
      await user.click(await screen.findByRole("option", { name: "Waiting for review" }));

      expect(await screen.findByText("Nothing is waiting for your review")).toBeInTheDocument();
      expect(screen.queryByText("No posts match these filters")).not.toBeInTheDocument();
    });

    /**
     * The count and the empty state describe the rows on screen, and a filter
     * change does not clear them: `fetchPosts` only swaps in skeletons for the
     * first load and an explicit refresh. So the wording has to follow the
     * request that produced the list rather than the control the user has just
     * moved, or the unfiltered count reads as a queue depth for one round trip.
     */
    it("does not count the old list under the new heading", async () => {
      const user = await openStateFilter();
      let release: (value: Post[]) => void = () => {};
      mockPostsList.mockImplementation(
        () =>
          new Promise<Post[]>((resolve) => {
            release = resolve;
          })
      );

      await user.click(await screen.findByRole("option", { name: "Waiting for review" }));
      expect(screen.getByText("3 total posts")).toBeInTheDocument();

      await act(async () => {
        release([testPosts[0]]);
      });
      expect(screen.getByText("1 post waiting for your review")).toBeInTheDocument();
    });

    it("still filters current_stage for every other state", async () => {
      const user = await openStateFilter();
      await user.click(await screen.findByRole("option", { name: "Queued" }));

      await waitFor(() => expect(mockPostsList).toHaveBeenLastCalledWith({ status: "pending" }));
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

  it("names the run's state in the list rather than echoing the stage column", async () => {
    renderWithProviders(<PostsPage />);
    await waitFor(() => {
      expect(screen.getByText("Complete")).toBeInTheDocument();
    });
    expect(screen.getByText("Running Write")).toBeInTheDocument();
    // `p1` sits on `research` with an untouched `stage_status`, which is a post
    // nothing has executed against, not a post in the research stage.
    expect(screen.getByText("Not started")).toBeInTheDocument();
  });

  it("does not call a run with a failed stage complete", async () => {
    mockPostsList.mockResolvedValue([
      makePost({
        id: "p4",
        topic: "Broken Post",
        slug: "broken-post",
        current_stage: "complete",
        stage_status: {
          research: "complete",
          outline: "complete",
          write: "complete",
          edit: "complete",
          images: "failed",
          ready: "complete",
        },
      }),
    ]);
    renderWithProviders(<PostsPage />);
    await waitFor(() => {
      expect(screen.getByText("Broken Post")).toBeInTheDocument();
    });
    expect(screen.getByText("Finished with errors")).toBeInTheDocument();
    expect(screen.queryByText("Complete")).not.toBeInTheDocument();
  });
});

describe("PostsPage search", () => {
  /**
   * A promise plus the handle that settles it, so a test can hold one list
   * request open while a second one answers.
   */
  function deferredList(): {
    promise: Promise<Post[]>;
    resolve: (value: Post[]) => void;
  } {
    let resolve!: (value: Post[]) => void;
    const promise = new Promise<Post[]>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  async function typeSearch(user: ReturnType<typeof userEvent.setup>, text: string) {
    await user.type(screen.getByPlaceholderText("Search posts..."), text);
  }

  it("sends one request for a typed word, not one per keystroke", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<PostsPage />);
    await waitFor(() => expect(screen.getByText("First Post")).toBeInTheDocument());
    expect(mockPostsList).toHaveBeenCalledTimes(1);

    await typeSearch(user, "bread");

    await waitFor(() =>
      expect(mockPostsList).toHaveBeenLastCalledWith({ q: "bread" })
    );
    expect(mockPostsList).toHaveBeenCalledTimes(2);
  });

  it("does not refetch the profile filter's options with every list request", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<PostsPage />);
    await waitFor(() => expect(screen.getByText("First Post")).toBeInTheDocument());
    expect(mockProfilesList).toHaveBeenCalledTimes(1);

    await typeSearch(user, "bread");
    await waitFor(() => expect(mockPostsList).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Refresh posts" }));
    await waitFor(() => expect(mockPostsList).toHaveBeenCalledTimes(3));

    // The options in the profile filter do not change because the rows under
    // it did, so they are read once for the page rather than once per list.
    expect(mockProfilesList).toHaveBeenCalledTimes(1);
  });

  it("does not let a slow answer overwrite the rows a newer search returned", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<PostsPage />);
    await waitFor(() => expect(screen.getByText("First Post")).toBeInTheDocument());

    const slow = deferredList();
    const fast = deferredList();
    mockPostsList.mockReturnValueOnce(slow.promise);
    mockPostsList.mockReturnValueOnce(fast.promise);

    await typeSearch(user, "so");
    await waitFor(() => expect(mockPostsList).toHaveBeenCalledTimes(2));
    await typeSearch(user, "up");
    await waitFor(() => expect(mockPostsList).toHaveBeenCalledTimes(3));

    await act(async () => {
      fast.resolve([makePost({ id: "soup", topic: "Soup Post" })]);
    });
    await waitFor(() => expect(screen.getByText("Soup Post")).toBeInTheDocument());

    await act(async () => {
      slow.resolve([makePost({ id: "so", topic: "Stale Post" })]);
    });

    expect(screen.queryByText("Stale Post")).not.toBeInTheDocument();
    expect(screen.getByText("Soup Post")).toBeInTheDocument();
    expect(screen.getByText("1 total post")).toBeInTheDocument();
  });

  it("does not let a slow failure replace the rows a newer search returned", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<PostsPage />);
    await waitFor(() => expect(screen.getByText("First Post")).toBeInTheDocument());

    let rejectSlow!: (reason: Error) => void;
    const slow = new Promise<Post[]>((_, reject) => {
      rejectSlow = reject;
    });
    const fast = deferredList();
    mockPostsList.mockReturnValueOnce(slow);
    mockPostsList.mockReturnValueOnce(fast.promise);

    await typeSearch(user, "so");
    await waitFor(() => expect(mockPostsList).toHaveBeenCalledTimes(2));
    await typeSearch(user, "up");
    await waitFor(() => expect(mockPostsList).toHaveBeenCalledTimes(3));

    await act(async () => {
      fast.resolve([makePost({ id: "soup", topic: "Soup Post" })]);
    });
    await waitFor(() => expect(screen.getByText("Soup Post")).toBeInTheDocument());

    await act(async () => {
      rejectSlow(new Error(JSON.stringify({ detail: "gone" })));
      await slow.catch(() => {});
    });

    expect(screen.queryByText("Could not load posts")).not.toBeInTheDocument();
    expect(screen.getByText("Soup Post")).toBeInTheDocument();
  });

  it("keeps the skeletons up until the newest request answers", async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = renderWithProviders(<PostsPage />);
    await waitFor(() => expect(screen.getByText("First Post")).toBeInTheDocument());

    const slow = deferredList();
    const fast = deferredList();
    mockPostsList.mockReturnValueOnce(slow.promise);
    mockPostsList.mockReturnValueOnce(fast.promise);

    await user.click(screen.getByRole("button", { name: "Refresh posts" }));
    await waitFor(() => expect(mockPostsList).toHaveBeenCalledTimes(2));
    const skeletons = () =>
      container.querySelectorAll("[class*='animate-pulse']").length;
    const rowSkeletons = skeletons();
    expect(rowSkeletons).toBeGreaterThan(1);

    await typeSearch(user, "soup");
    await waitFor(() => expect(mockPostsList).toHaveBeenCalledTimes(3));

    // The refresh is the superseded request now, so its answer neither draws
    // rows nor takes the skeletons down.
    await act(async () => {
      slow.resolve(testPosts);
    });
    expect(skeletons()).toBe(rowSkeletons);

    await act(async () => {
      fast.resolve([makePost({ id: "soup", topic: "Soup Post" })]);
    });
    expect(screen.getByText("Soup Post")).toBeInTheDocument();
    expect(skeletons()).toBeLessThan(rowSkeletons);
  });

  it("keeps the filtered empty state while a cleared search is still in flight", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<PostsPage />);
    await waitFor(() => expect(screen.getByText("First Post")).toBeInTheDocument());

    mockPostsList.mockResolvedValue([]);
    await typeSearch(user, "zzz");
    await waitFor(() =>
      expect(screen.getByText("No posts match these filters")).toBeInTheDocument()
    );

    const slow = deferredList();
    mockPostsList.mockReturnValueOnce(slow.promise);
    await user.clear(screen.getByPlaceholderText("Search posts..."));

    // The rows on screen are still the ones the search returned, so the empty
    // state has to keep describing that search until its replacement lands.
    expect(screen.queryByText("Create your first post")).not.toBeInTheDocument();
    expect(screen.getByText("No posts match these filters")).toBeInTheDocument();

    await act(async () => {
      slow.resolve(testPosts);
    });
    await waitFor(() => expect(screen.getByText("First Post")).toBeInTheDocument());
  });
});
