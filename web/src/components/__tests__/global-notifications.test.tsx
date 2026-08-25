/**
 * Regression test for the unauthenticated SSE reconnect loop.
 *
 * `GlobalNotifications` is mounted from `providers.tsx`, which wraps every
 * route including `/auth/*`. It opened the queue-wide SSE feed unconditionally,
 * so on the sign-in page `GET /api/events` answered 401, `EventSource.onerror`
 * fired, and the hook reconnected every 3s forever. A 401 does not resolve by
 * retrying, so the feed must not open until there is a session to authenticate
 * it.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GlobalNotifications } from "@/components/global-notifications";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

/** The route the toast is raised on, for the "already looking at it" case. */
const pathname = vi.fn(() => "/");
vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
}));

const useSession = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => useSession(),
  },
}));

/** Instances the component actually constructed this test. */
let opened: string[] = [];
/**
 * The instances themselves, for driving frames through them. `setup.ts`
 * replaces the global with a mock carrying `_emit`, which the DOM lib's
 * `EventSource` type does not know about.
 */
interface EmittingSource {
  _emit(type: string, data: unknown): void;
}
let sources: EmittingSource[] = [];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  opened = [];
  sources = [];
  vi.clearAllMocks();
  pathname.mockReturnValue("/");
  const Real = globalThis.EventSource as unknown as new (u: string) => EventSource;
  vi.stubGlobal(
    "EventSource",
    class extends (Real as new (u: string) => EventSource) {
      constructor(url: string) {
        super(url);
        opened.push(url);
        sources.push(this as unknown as EmittingSource);
      }
    },
  );
});

/** Deliver one named SSE frame the way `useSSE` receives it. */
async function emit(type: string, payload: Record<string, unknown>) {
  await act(async () => {
    sources[sources.length - 1]._emit(type, payload);
    await Promise.resolve();
  });
}

async function renderSignedIn() {
  useSession.mockReturnValue({
    data: { user: { id: "u1", email: "a@b.test" } },
    isPending: false,
  });
  render(<GlobalNotifications />);
  await waitFor(() => expect(sources).toHaveLength(1));
}

describe("GlobalNotifications", () => {
  it("opens no SSE connection when there is no session", async () => {
    useSession.mockReturnValue({ data: null, isPending: false });

    render(<GlobalNotifications />);

    await new Promise((r) => setTimeout(r, 50));
    expect(opened).toEqual([]);
  });

  it("opens no SSE connection while the session is still loading", async () => {
    useSession.mockReturnValue({ data: null, isPending: true });

    render(<GlobalNotifications />);

    await new Promise((r) => setTimeout(r, 50));
    expect(opened).toEqual([]);
  });

  // The toasts named the stage by its stored value, so a run announced itself
  // as "research complete" and, on a frame carrying no stage, as
  // "unknown complete".
  describe("toast copy", () => {
    it("names the stage the way every other surface does", async () => {
      await renderSignedIn();

      await emit("stage_complete", { post_id: "abcdef1234", stage: "research" });

      expect(toast.success).toHaveBeenCalledWith(
        "Research complete",
        expect.anything(),
      );
    });

    it("names the stage on a failure too", async () => {
      await renderSignedIn();

      await emit("stage_error", {
        post_id: "abcdef1234",
        stage: "images",
        error: "429 RESOURCE_EXHAUSTED",
      });

      expect(toast.error).toHaveBeenCalledWith("Images failed", expect.anything());
    });

    /**
     * Ledger item P2.109b. A run that parks at a gate is waiting on the
     * reader, and until that item it announced nothing at all: no frame, no
     * toast, and no refetch on the post page either.
     */
    it("says which stage is waiting when a run parks at a gate", async () => {
      await renderSignedIn();

      await emit("stage_review", {
        post_id: "abcdef1234",
        stage: "outline",
        mode: "review",
      });

      expect(toast.info).toHaveBeenCalledWith(
        "Outline is waiting for your approval",
        expect.anything(),
      );
    });

    it("says nothing about an unknown stage when the frame carries none", async () => {
      await renderSignedIn();

      await emit("stage_complete", { post_id: "abcdef1234" });

      expect(toast.success).toHaveBeenCalledWith("Stage complete", expect.anything());
    });
  });

  /**
   * Item P3.3c-i. The description named the post by the first eight characters
   * of its uuid, which is a value no reader has ever seen, and read
   * "Post undefined..." for a frame carrying no post id at all.
   */
  describe("which post the toast is about", () => {
    it("names the post by its topic", async () => {
      await renderSignedIn();

      await emit("stage_complete", {
        post_id: "3f2a1b0c-0000-4000-8000-000000000000",
        topic: "Best espresso machines under $500",
        stage: "research",
      });

      expect(toast.success).toHaveBeenCalledWith(
        "Research complete",
        expect.objectContaining({ description: "Best espresso machines under $500" }),
      );
    });

    it("shows no id fragment for a frame carrying no topic", async () => {
      await renderSignedIn();

      await emit("stage_complete", {
        post_id: "3f2a1b0c-0000-4000-8000-000000000000",
        stage: "research",
      });

      const options = vi.mocked(toast.success).mock.calls[0][1] as {
        description?: string;
      };
      expect(options.description).toBeUndefined();
    });

    it("says which post failed as well as why", async () => {
      await renderSignedIn();

      await emit("stage_error", {
        post_id: "3f2a1b0c-0000-4000-8000-000000000000",
        topic: "Espresso machines",
        stage: "images",
        error: "429 RESOURCE_EXHAUSTED",
      });

      expect(toast.error).toHaveBeenCalledWith(
        "Images failed",
        expect.objectContaining({
          description: "Espresso machines: 429 RESOURCE_EXHAUSTED",
        }),
      );
    });

    it("still reports why a post it cannot name failed", async () => {
      await renderSignedIn();

      await emit("stage_error", {
        post_id: "3f2a1b0c-0000-4000-8000-000000000000",
        stage: "images",
        error: "429 RESOURCE_EXHAUSTED",
      });

      expect(toast.error).toHaveBeenCalledWith(
        "Images failed",
        expect.objectContaining({ description: "429 RESOURCE_EXHAUSTED" }),
      );
    });

    it("names the finished post in the export prompt", async () => {
      await renderSignedIn();

      await emit("pipeline_complete", {
        post_id: "3f2a1b0c-0000-4000-8000-000000000000",
        topic: "Espresso machines",
      });

      expect(toast.success).toHaveBeenCalledWith(
        "Pipeline complete",
        expect.objectContaining({
          description: "Espresso machines is ready for export",
        }),
      );
    });

    it("still says what happened when the finished post has no topic", async () => {
      await renderSignedIn();

      await emit("pipeline_complete", { post_id: "3f2a1b0c-0000-4000-8000-000000000000" });

      expect(toast.success).toHaveBeenCalledWith(
        "Pipeline complete",
        expect.objectContaining({ description: "Ready for export" }),
      );
    });

    it("treats an empty topic as no topic rather than an empty line", async () => {
      await renderSignedIn();

      await emit("stage_complete", {
        post_id: "3f2a1b0c-0000-4000-8000-000000000000",
        topic: "",
        stage: "research",
      });

      const options = vi.mocked(toast.success).mock.calls[0][1] as {
        description?: string;
      };
      expect(options.description).toBeUndefined();
    });

    it("never prints the word undefined, whatever the frame is missing", async () => {
      await renderSignedIn();

      await emit("stage_complete", { post_id: "" });
      await emit("stage_error", { post_id: "" });
      await emit("pipeline_complete", { post_id: "" });

      const descriptions = [
        ...vi.mocked(toast.success).mock.calls,
        ...vi.mocked(toast.error).mock.calls,
      ].map(([, options]) => (options as { description?: string } | undefined)?.description);
      for (const description of descriptions) {
        expect(description ?? "").not.toContain("undefined");
      }
    });
  });

  describe("the View action", () => {
    it("offers a way to the post from anywhere else", async () => {
      pathname.mockReturnValue("/");
      await renderSignedIn();

      await emit("stage_complete", { post_id: "post-1", stage: "research" });

      const options = vi.mocked(toast.success).mock.calls[0][1] as {
        action?: { label: string };
      };
      expect(options.action?.label).toBe("View");
    });

    it("offers nothing for a frame that names no post", async () => {
      await renderSignedIn();

      await emit("stage_complete", { stage: "research" });

      const options = vi.mocked(toast.success).mock.calls[0][1] as {
        action?: { label: string };
      };
      expect(options.action).toBeUndefined();
    });

    it("keeps up with the route the reader moved to", async () => {
      pathname.mockReturnValue("/posts/post-1");
      useSession.mockReturnValue({
        data: { user: { id: "u1", email: "a@b.test" } },
        isPending: false,
      });
      const { rerender } = render(<GlobalNotifications />);
      await waitFor(() => expect(sources).toHaveLength(1));

      await emit("stage_complete", { post_id: "post-1", stage: "research" });
      pathname.mockReturnValue("/");
      rerender(<GlobalNotifications />);
      await emit("stage_complete", { post_id: "post-1", stage: "outline" });

      const [first, second] = vi.mocked(toast.success).mock.calls.map(
        ([, options]) => options as { action?: { label: string } },
      );
      expect(first.action).toBeUndefined();
      expect(second.action?.label).toBe("View");
    });

    it("offers nothing on the page the toast is about", async () => {
      pathname.mockReturnValue("/posts/post-1");
      await renderSignedIn();

      await emit("stage_complete", { post_id: "post-1", stage: "research" });

      const options = vi.mocked(toast.success).mock.calls[0][1] as {
        action?: { label: string };
      };
      expect(options.action).toBeUndefined();
    });
  });

  it("opens the queue-wide feed once a session exists", async () => {
    useSession.mockReturnValue({
      data: { user: { id: "u1", email: "a@b.test" } },
      isPending: false,
    });

    render(<GlobalNotifications />);

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toContain("/api/events");
  });
});
