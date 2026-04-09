import type { FrontmatterMapper } from "../types.js";

export const canonicalMapper: FrontmatterMapper = {
  name: "canonical",
  map: (jena) => ({
    title: jena.title,
    description: jena.description,
    date: jena.date,
    category: jena.category,
    author: jena.author,
    image: jena.image,
  }),
};
