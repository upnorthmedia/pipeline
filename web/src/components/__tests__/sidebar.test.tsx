import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Sidebar } from "@/components/sidebar";
import { renderWithProviders } from "@/test/render";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

/**
 * The nav labels are the app's information architecture in four words, so they
 * get an assertion rather than only an e2e click. "Account" in particular is
 * load-bearing: every per-site setting lives under Profiles, and a nav item
 * called Settings reads as the place all of them are.
 */
describe("Sidebar", () => {
  it("names each destination by what it owns", () => {
    renderWithProviders(<Sidebar />);
    const labels = ["Posts", "Profiles", "Observability", "Account"];
    const hrefs = ["/", "/profiles", "/monitor", "/settings"];
    labels.forEach((label, i) => {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute(
        "href",
        hrefs[i]
      );
    });
  });

  it("does not call the account page Settings", () => {
    renderWithProviders(<Sidebar />);
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
  });
});
