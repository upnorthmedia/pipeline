import { describe, it, expect, vi, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { ImagePreview } from "../image-preview";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ImagePreview", () => {
  it("shows empty state when manifest is null", () => {
    renderWithProviders(<ImagePreview manifest={null} />);
    expect(screen.getByText("No images generated yet")).toBeInTheDocument();
  });

  it("shows empty state when manifest is empty", () => {
    renderWithProviders(<ImagePreview manifest={{}} />);
    expect(screen.getByText("No images generated yet")).toBeInTheDocument();
  });

  it("renders image cards from manifest", () => {
    const manifest = {
      featured: {
        prompt: "A landscape photo",
        alt_text: "Beautiful landscape",
        placement: "Featured image",
      },
      content_1: {
        prompt: "A diagram",
        alt_text: "Process diagram",
        placement: "After section 2",
      },
    };
    renderWithProviders(<ImagePreview manifest={manifest} />);
    expect(screen.getByTestId("image-preview")).toBeInTheDocument();
    expect(screen.getByText("featured")).toBeInTheDocument();
    expect(screen.getByText("content 1")).toBeInTheDocument();
  });

  it("displays alt text", () => {
    const manifest = {
      featured: {
        alt_text: "Beautiful landscape",
        prompt: "A photo",
      },
    };
    renderWithProviders(<ImagePreview manifest={manifest} />);
    expect(screen.getByText(/Beautiful landscape/)).toBeInTheDocument();
  });

  it("displays placement info", () => {
    const manifest = {
      featured: {
        placement: "Featured image",
        prompt: "A photo",
      },
    };
    renderWithProviders(<ImagePreview manifest={manifest} />);
    expect(screen.getByText("Featured image")).toBeInTheDocument();
  });

  it("displays prompt text", () => {
    const manifest = {
      featured: {
        prompt: "A beautiful mountain landscape at sunset",
      },
    };
    renderWithProviders(<ImagePreview manifest={manifest} />);
    expect(
      screen.getByText(/A beautiful mountain landscape at sunset/)
    ).toBeInTheDocument();
  });

  it("displays style metadata", () => {
    const manifest = {
      featured: {
        prompt: "A photo",
        style: "photorealistic",
      },
    };
    renderWithProviders(<ImagePreview manifest={manifest} />);
    expect(screen.getByText(/photorealistic/)).toBeInTheDocument();
  });

  it("displays image with filename", () => {
    const manifest = {
      featured: {
        prompt: "A photo",
        filename: "/images/featured.png",
        alt_text: "Featured image alt",
      },
    };
    renderWithProviders(<ImagePreview manifest={manifest} />);
    const img = screen.getByAltText("Featured image alt");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "/images/featured.png");
  });

  it("renders a generated image with an origin-relative src", () => {
    // The manifest shape the images stage actually writes: `images` is a list
    // and each entry carries the `/media/<post_id>/<file>` url the app serves
    // itself, so the rendered `src` must stay origin-relative.
    const manifest = {
      images: [
        {
          id: "featured",
          prompt: "A photo",
          url: "/media/post-1/featured.webp",
          alt_text: "Featured image alt",
        },
      ],
    };
    renderWithProviders(<ImagePreview manifest={manifest} />);
    expect(screen.getByAltText("Featured image alt")).toHaveAttribute(
      "src",
      "/media/post-1/featured.webp"
    );
  });

  it("cannot be pointed at another host by NEXT_PUBLIC_API_URL", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8055");
    const manifest = {
      images: [
        {
          id: "featured",
          url: "/media/post-1/featured.webp",
          alt_text: "Featured image alt",
        },
      ],
    };
    renderWithProviders(<ImagePreview manifest={manifest} />);
    expect(screen.getByAltText("Featured image alt")).toHaveAttribute(
      "src",
      "/media/post-1/featured.webp"
    );
  });

  it("shows placeholder when no filename", () => {
    const manifest = {
      featured: {
        prompt: "A photo",
      },
    };
    const { container } = renderWithProviders(
      <ImagePreview manifest={manifest} />
    );
    // Should show the placeholder icon instead of an img
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(0);
  });
});
