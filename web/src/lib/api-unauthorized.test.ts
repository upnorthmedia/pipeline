/**
 * Regression test for the stale-session trap.
 *
 * `src/proxy.ts` gates pages on the presence of `better-auth.session_token`,
 * not its validity, on purpose: full validation is server-side. The cost is
 * that a stale or expired cookie renders the whole authenticated shell while
 * every route handler answers 401 `{"detail":"Not authenticated"}`. With no
 * client-side handling of 401 the user is stranded: the dashboard paints, the
 * data never loads, Retry can never succeed, and nothing ever sends them to
 * the sign-in page. Observed as "I can't login and it still shows dashboard
 * while showing not authenticated".
 *
 * A 401 from any API call means this session is over, so the client must send
 * the user to sign in rather than render an error card about it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { posts } from "./api";

const replace = vi.fn();

beforeEach(() => {
  replace.mockClear();
  vi.stubGlobal("location", {
    replace,
    pathname: "/",
    href: "http://localhost:3000/",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function respond(status: number, body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status })),
  );
}

describe("401 handling", () => {
  it("sends the user to sign-in when a request is unauthorized", async () => {
    respond(401, JSON.stringify({ detail: "Not authenticated" }));

    await expect(posts.list()).rejects.toThrow();

    expect(replace).toHaveBeenCalledWith("/auth/sign-in");
  });

  it("does not redirect on other failures", async () => {
    respond(500, JSON.stringify({ detail: "Internal Server Error" }));

    await expect(posts.list()).rejects.toThrow();

    expect(replace).not.toHaveBeenCalled();
  });

  it("does not redirect when already on an auth page", async () => {
    vi.stubGlobal("location", {
      replace,
      pathname: "/auth/sign-in",
      href: "http://localhost:3000/auth/sign-in",
    });
    respond(401, JSON.stringify({ detail: "Not authenticated" }));

    await expect(posts.list()).rejects.toThrow();

    expect(replace).not.toHaveBeenCalled();
  });
});
