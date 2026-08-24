/**
 * The three route error boundaries.
 *
 * Every one of them is reached only by a render-time exception: a failed
 * request is caught by the page that made it and rendered through
 * `apiErrorMessage()`, so nothing routes a fetch failure here. What arrives is
 * therefore always a programming error whose message V8 wrote for whoever is
 * reading the stack, which is why these assert that the message is not the
 * body copy and is still reachable.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import AppError from "./error";
import PostError from "./posts/[id]/error";
import ProfileError from "./profiles/[id]/error";

/** The exact text V8 produces for the throw recorded against these boundaries. */
const V8_MESSAGE = "input.entries is not iterable";

function raised(): Error & { digest?: string } {
  return new TypeError(V8_MESSAGE);
}

/**
 * The disclosure's own summary. The body copy names the technical details too,
 * so a bare text match finds both.
 */
function summaryOf(): HTMLElement {
  return screen.getByText(/technical details/i, { selector: "summary" });
}

beforeEach(() => {
  // The boundaries log the error so the stack survives in devtools. Silencing
  // it here keeps the assertion available without printing a stack per case.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const BOUNDARIES = [
  { name: "app", Component: AppError, heading: /this page could not be displayed/i },
  { name: "post", Component: PostError, heading: /this post could not be displayed/i },
  {
    name: "profile",
    Component: ProfileError,
    heading: /this profile could not be displayed/i,
  },
] as const;

describe.each(BOUNDARIES)("$name error boundary", ({ Component, heading }) => {
  it("says what happened in the user's terms", () => {
    renderWithProviders(<Component error={raised()} reset={vi.fn()} />);

    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(
      screen.getByText(/nothing has been changed or lost/i)
    ).toBeVisible();
  });

  it("does not print the raw exception as body copy", () => {
    renderWithProviders(<Component error={raised()} reset={vi.fn()} />);

    // Present, so it can still be reported, but behind the closed disclosure.
    expect(screen.getByText(new RegExp(V8_MESSAGE))).not.toBeVisible();
  });

  it("reveals the exception and its digest under the disclosure", async () => {
    const user = userEvent.setup();
    const error = raised();
    error.digest = "3016267894";
    renderWithProviders(<Component error={error} reset={vi.fn()} />);

    await user.click(summaryOf());

    const details = summaryOf().closest("details");
    expect(details).not.toBeNull();
    expect(
      within(details as HTMLElement).getByText(`TypeError: ${V8_MESSAGE}`)
    ).toBeVisible();
    expect(within(details as HTMLElement).getByText(/3016267894/)).toBeVisible();
  });

  it("names an error that carries no message rather than showing undefined", async () => {
    const user = userEvent.setup();
    const error = new RangeError("");
    renderWithProviders(<Component error={error} reset={vi.fn()} />);

    await user.click(summaryOf());

    const details = summaryOf().closest("details");
    expect(within(details as HTMLElement).getByText("RangeError")).toBeVisible();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it("logs the error so its stack survives in devtools", () => {
    const error = raised();
    renderWithProviders(<Component error={error} reset={vi.fn()} />);

    expect(console.error).toHaveBeenCalledWith(error);
  });

  it("retries through reset", async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    renderWithProviders(<Component error={raised()} reset={reset} />);

    await user.click(screen.getByRole("button", { name: /try again/i }));

    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("route error boundary back links", () => {
  it("sends a post back to the posts list", () => {
    renderWithProviders(<PostError error={raised()} reset={vi.fn()} />);

    expect(screen.getByRole("link", { name: /back to posts/i })).toHaveAttribute(
      "href",
      "/"
    );
  });

  it("sends a profile back to the profiles list", () => {
    renderWithProviders(<ProfileError error={raised()} reset={vi.fn()} />);

    expect(
      screen.getByRole("link", { name: /back to profiles/i })
    ).toHaveAttribute("href", "/profiles");
  });
});
