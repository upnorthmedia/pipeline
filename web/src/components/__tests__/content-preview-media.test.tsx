/**
 * Generated images are referenced from stage content as `/media/<post_id>/<file>`.
 * Those URLs are served by this app's own route handler, so the rendered `src`
 * has to stay origin-relative: an absolute base would point the browser at a
 * separate host for images the dashboard already serves itself.
 *
 * This file deliberately does not mock `react-markdown`, unlike
 * `content-preview.test.tsx`, because the mock replaces the very component
 * mapping that resolves the image source.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { ContentPreview } from "../content-preview";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ContentPreview media sources", () => {
  it("renders a /media image with an origin-relative src", () => {
    renderWithProviders(
      <ContentPreview content="![a hero](/media/post-1/hero.webp)" />
    );
    expect(screen.getByAltText("a hero")).toHaveAttribute(
      "src",
      "/media/post-1/hero.webp"
    );
  });

  it("cannot be pointed at another host by NEXT_PUBLIC_API_URL", () => {
    // The env var was how the dashboard used to reach the Python API's static
    // media mount. It is gone, and re-adding it here would send image requests
    // back off-origin.
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8055");
    renderWithProviders(
      <ContentPreview content="![a hero](/media/post-1/hero.webp)" />
    );
    expect(screen.getByAltText("a hero")).toHaveAttribute(
      "src",
      "/media/post-1/hero.webp"
    );
  });

  it("leaves an absolute image url untouched", () => {
    renderWithProviders(
      <ContentPreview content="![remote](https://cdn.example.com/x.png)" />
    );
    expect(screen.getByAltText("remote")).toHaveAttribute(
      "src",
      "https://cdn.example.com/x.png"
    );
  });
});
