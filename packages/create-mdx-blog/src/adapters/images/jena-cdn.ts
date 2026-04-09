import type { ImageStorageAdapter } from "../types.js";

export const jenaCdnImageAdapter: ImageStorageAdapter = {
  name: "jena-cdn",
  resolveUrl(filename: string, slug: string): string {
    // CDN URLs are passed through from the webhook payload as-is.
    // This adapter is a no-op placeholder — the actual URL comes from
    // the Jena AI webhook payload, not from this function.
    return `https://cdn.jena.ai/images/${slug}/${filename}`;
  },
};
