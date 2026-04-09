import type { ImageStorageAdapter } from "../types.js";

export const localImageAdapter: ImageStorageAdapter = {
  name: "local",
  resolveUrl(filename: string, slug: string): string {
    return `/blog/images/${slug}/${filename}`;
  },
};
