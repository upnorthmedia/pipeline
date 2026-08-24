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
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GlobalNotifications } from "@/components/global-notifications";

const useSession = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => useSession(),
  },
}));

/** Instances the component actually constructed this test. */
let opened: string[] = [];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  opened = [];
  const Real = globalThis.EventSource as unknown as new (u: string) => EventSource;
  vi.stubGlobal(
    "EventSource",
    class extends (Real as new (u: string) => EventSource) {
      constructor(url: string) {
        super(url);
        opened.push(url);
      }
    },
  );
});

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
