import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { AppChrome } from "@/components/app-chrome";
import { renderWithProviders } from "@/test/render";

let pathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

beforeEach(() => {
  pathname = "/";
});

/**
 * `src/middleware.ts` sends every cookieless request to `/auth/sign-in`, so
 * `/auth/*` is the only route a visitor without a session can be on, and every
 * nav link the chrome draws there bounces straight back to it. The chrome is
 * not rendered on those routes rather than painted over: it used to be in the
 * page and in the tab order, hidden only by an opaque overlay the auth layout
 * drew on top of it.
 */
describe("AppChrome", () => {
  it("frames a signed-in route with the navigation and the page", () => {
    pathname = "/posts";
    renderWithProviders(
      <AppChrome>
        <p>the page</p>
      </AppChrome>
    );

    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Profiles" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByText("the page")).toBeInTheDocument();
  });

  it("gives a signed-out route the page and nothing else", () => {
    pathname = "/auth/sign-in";
    renderWithProviders(
      <AppChrome>
        <p>the sign-in form</p>
      </AppChrome>
    );

    expect(screen.getByText("the sign-in form")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("link", { name: "Profiles" })).toBeNull();
    expect(screen.queryByRole("main")).toBeNull();
  });

  // The mobile header carries its own copy of the same four links behind a
  // hamburger, so hiding the sidebar alone would leave them reachable.
  it("leaves no menu button on a signed-out route", () => {
    pathname = "/auth/sign-up";
    renderWithProviders(
      <AppChrome>
        <p>the sign-up form</p>
      </AppChrome>
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Content Crew")).toBeNull();
  });

  // The kill check for a bare `startsWith("/auth")`: a future `/authors` route
  // is an app route, not a sign-in page.
  it("treats a route that merely starts with those letters as an app route", () => {
    pathname = "/authors";
    renderWithProviders(
      <AppChrome>
        <p>the page</p>
      </AppChrome>
    );

    expect(screen.getByRole("navigation")).toBeInTheDocument();
  });
});
