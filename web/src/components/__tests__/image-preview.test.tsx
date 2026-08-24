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

  // Every fixture below uses the manifest shape the pipeline actually stores:
  // `rules/blog-images.md` asks the model for `{ style_brief, images: [...] }`
  // and `generateOneImage` writes each entry back with `generated`, `index`,
  // and either a served `url` or an `error`. The flat `{ featured: {...} }` map
  // these tests used to carry has never been produced by any stage in this
  // repo, which is why six of them could not find a rendered card.
  it("renders image cards from manifest", () => {
    const manifest = {
      images: [
        {
          id: "featured",
          type: "featured",
          prompt: "A landscape photo",
          alt_text: "Beautiful landscape",
          placement: { location: "featured_image", after_section: null },
        },
        {
          id: "content-1",
          type: "content",
          prompt: "A diagram",
          alt_text: "Process diagram",
          placement: { location: "after_heading", after_section: "After section 2" },
        },
      ],
    };
    renderWithProviders(<ImagePreview manifest={manifest} />);
    expect(screen.getByTestId("image-preview")).toBeInTheDocument();
    expect(screen.getByText("featured")).toBeInTheDocument();
    expect(screen.getByText("content 1")).toBeInTheDocument();
  });

  it("displays alt text", () => {
    const manifest = {
      images: [
        {
          id: "featured",
          alt_text: "Beautiful landscape",
          prompt: "A photo",
        },
      ],
    };
    renderWithProviders(<ImagePreview manifest={manifest} />);
    expect(screen.getByText(/Beautiful landscape/)).toBeInTheDocument();
  });

  it("displays placement info", () => {
    // `placement` is an object in every real manifest, and the heading an image
    // follows is the part of it worth showing.
    const manifest = {
      images: [
        {
          id: "content-1",
          placement: { location: "after_heading", after_section: "Choosing A Router" },
          prompt: "A photo",
        },
      ],
    };
    renderWithProviders(<ImagePreview manifest={manifest} />);
    expect(screen.getByText("Choosing A Router")).toBeInTheDocument();
  });

  it("displays prompt text", () => {
    const manifest = {
      images: [
        {
          id: "featured",
          prompt: "A beautiful mountain landscape at sunset",
        },
      ],
    };
    renderWithProviders(<ImagePreview manifest={manifest} />);
    expect(
      screen.getByText(/A beautiful mountain landscape at sunset/)
    ).toBeInTheDocument();
  });

  it("displays style metadata", () => {
    // The style lives on the manifest's `style_brief`, not on an entry: it is
    // one visual identity shared by every image in the set.
    const manifest = {
      images: [{ id: "featured", prompt: "A photo" }],
      style_brief: { overall_style: "photorealistic" },
    };
    renderWithProviders(<ImagePreview manifest={manifest} />);
    expect(screen.getByText(/photorealistic/)).toBeInTheDocument();
  });

  it("does not render the model's declared filename as an image src", () => {
    // `filename` is the name the model asked for, and the stage rewrites it for
    // featured images before writing the file, so it is not a path this app
    // serves. Only `url`, which the stage sets after the write, is.
    const manifest = {
      images: [
        {
          id: "featured",
          prompt: "A photo",
          filename: "featured-022726-47.png",
          alt_text: "Featured image alt",
        },
      ],
    };
    const { container } = renderWithProviders(
      <ImagePreview manifest={manifest} />
    );
    expect(screen.queryByAltText("Featured image alt")).not.toBeInTheDocument();
    expect(container.querySelectorAll("img")).toHaveLength(0);
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

  it("shows placeholder when an entry has no url", () => {
    const manifest = {
      images: [{ id: "featured", prompt: "A photo" }],
    };
    const { container } = renderWithProviders(
      <ImagePreview manifest={manifest} />
    );
    // Should show the placeholder icon instead of an img
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(0);
  });
});
