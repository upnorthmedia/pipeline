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

    it("says nothing about an unknown stage when the frame carries none", async () => {
      await renderSignedIn();

      await emit("stage_complete", { post_id: "abcdef1234" });

      expect(toast.success).toHaveBeenCalledWith("Stage complete", expect.anything());
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
