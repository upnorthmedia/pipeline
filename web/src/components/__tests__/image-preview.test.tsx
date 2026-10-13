import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  // `placement` is written by the images model against `rules/blog-images.md`,
  // which documents exactly two `location` values. Both reached the screen
  // unmapped: the featured entry read `featured_image`, and a content entry
  // read the bare heading text with nothing saying what its relationship to
  // that heading was.
  describe("placement copy", () => {
    // `placement` is typed on the component as the object the rule file
    // documents, but the manifest is model-written JSON: the bare-string form
    // and an undocumented location both arrive in practice, so the fixtures
    // are cast rather than narrowed.
    function placementOf(placement: unknown) {
      const images = [{ id: "content-1", prompt: "A photo", placement }];
      renderWithProviders(
        <ImagePreview manifest={{ images } as Record<string, unknown>} />,
      );
    }

    it("names the heading an image follows", () => {
      placementOf({ location: "after_heading", after_section: "Choosing A Router" });
      expect(screen.getByText('After "Choosing A Router"')).toBeInTheDocument();
    });

    it("calls the featured entry a featured image, not `featured_image`", () => {
      placementOf({ location: "featured_image", after_section: null });
      expect(screen.getByText("Featured image")).toBeInTheDocument();
      expect(screen.queryByText("featured_image")).not.toBeInTheDocument();
    });

    it("names a heading placement that carries no heading", () => {
      placementOf({ location: "after_heading", after_section: null });
      expect(screen.getByText("After a heading")).toBeInTheDocument();
    });

    it("humanises a location the rule file does not document", () => {
      placementOf({ location: "inline_sidebar" });
      expect(screen.getByText("Inline sidebar")).toBeInTheDocument();
    });

    // `generateOneImage`'s featured check tolerates a bare-string placement, so
    // the preview has to render one rather than print `[object Object]`-grade
    // nonsense or the raw token.
    it("humanises a bare-string placement", () => {
      placementOf("featured");
      expect(screen.getByText("Featured")).toBeInTheDocument();
    });

    it("shows no placement line when the entry has none", () => {
      placementOf(undefined);
      expect(screen.queryByText(/^After/)).not.toBeInTheDocument();
      expect(screen.queryByText("Featured image")).not.toBeInTheDocument();
    });

    it("shows no placement line for an empty location", () => {
      placementOf({ location: "   ", after_section: "  " });
      expect(screen.queryByText("Featured image")).not.toBeInTheDocument();
      expect(screen.queryByText(/^After/)).not.toBeInTheDocument();
    });
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

/**
 * Item P1.2b. A manifest entry the images stage could not produce carries the
 * reason on `error` (`generateOneImage` writes `generated: false` with the
 * message on both of its failure exits), and an entry it did produce carries a
 * `/media/<post_id>/<file>` url whose file can be gone: the two golden runs in
 * this repo were captured with no Gemini quota, and `todo.md` records a run
 * whose images went to the compose volume while the dashboard read the repo
 * directory. Neither may reach the user as a broken image.
 */
describe("ImagePreview failures", () => {
  const FAILED_MANIFEST = {
    total_generated: 0,
    total_failed: 1,
    images: [
      {
        id: "featured",
        prompt: "A photo",
        generated: false,
        error: "429 RESOURCE_EXHAUSTED: quota exceeded",
      },
    ],
  };

  it("shows the reason a failed image gives instead of a bare badge", () => {
    renderWithProviders(<ImagePreview manifest={FAILED_MANIFEST} />);
    expect(
      screen.getByText(/429 RESOURCE_EXHAUSTED: quota exceeded/)
    ).toBeInTheDocument();
  });

  it("renders no img element for a failed entry", () => {
    const { container } = renderWithProviders(
      <ImagePreview
        manifest={{
          images: [
            {
              id: "featured",
              generated: false,
              error: "boom",
              // A failed entry can still carry the url the stage would have
              // written, and that file does not exist.
              url: "/media/post-1/featured.webp",
              alt_text: "Featured image alt",
            },
          ],
        }}
      />
    );
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("translates the no-prompt token into a sentence", () => {
    renderWithProviders(
      <ImagePreview
        manifest={{
          images: [{ id: "content-1", generated: false, error: "no prompt" }],
        }}
      />
    );
    expect(screen.queryByText("no prompt")).not.toBeInTheDocument();
    expect(screen.getByText(/no prompt was written for it/i)).toBeInTheDocument();
  });

  it("offers a retry that re-runs the images stage", async () => {
    const onRetry = vi.fn();
    renderWithProviders(
      <ImagePreview manifest={FAILED_MANIFEST} onRetry={onRetry} />
    );
    await userEvent.click(screen.getByRole("button", { name: /retry images/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("offers no retry when every image generated", () => {
    renderWithProviders(
      <ImagePreview
        manifest={{
          total_generated: 1,
          total_failed: 0,
          images: [
            { id: "featured", generated: true, url: "/media/post-1/featured.webp" },
          ],
        }}
        onRetry={vi.fn()}
      />
    );
    expect(
      screen.queryByRole("button", { name: /retry images/i })
    ).not.toBeInTheDocument();
  });

  it("counts how many of the set failed", () => {
    renderWithProviders(
      <ImagePreview
        manifest={{
          images: [
            { id: "featured", generated: true, url: "/media/post-1/featured.webp" },
            { id: "content-1", generated: false, error: "boom" },
            { id: "content-2", generated: false, error: "boom" },
          ],
        }}
      />
    );
    expect(screen.getByText(/2 of 3 images could not be generated/i)).toBeInTheDocument();
  });

  it("replaces an image whose file is gone with a failure and a retry", async () => {
    const onRetry = vi.fn();
    renderWithProviders(
      <ImagePreview
        manifest={{
          total_generated: 1,
          total_failed: 0,
          images: [
            {
              id: "featured",
              generated: true,
              url: "/media/post-1/featured.webp",
              alt_text: "Featured image alt",
            },
          ],
        }}
        onRetry={onRetry}
      />
    );
    // jsdom never loads an image, so the browser's own `error` event is what
    // this stands in for: the file 404s and the element paints the broken-image
    // glyph unless something replaces it.
    fireEvent.error(screen.getByAltText("Featured image alt"));

    expect(screen.queryByAltText("Featured image alt")).not.toBeInTheDocument();
    expect(screen.getByText(/file is missing/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry images/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
