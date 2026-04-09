import matter from "gray-matter";
import type { FrontmatterSchema, FrontmatterFieldInfo } from "../../types.js";
import type { FrontmatterMapper } from "../types.js";

function inferType(value: unknown): FrontmatterFieldInfo["type"] {
  if (Array.isArray(value)) {
    return "string[]";
  }
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

export function detectFrontmatter(postContents: string[]): FrontmatterSchema {
  if (postContents.length === 0) {
    return { fields: {} };
  }

  const allFields = new Map<string, { types: Set<string>; examples: unknown[]; count: number }>();

  for (const content of postContents) {
    const { data } = matter(content);
    for (const [key, value] of Object.entries(data)) {
      if (!allFields.has(key)) {
        allFields.set(key, { types: new Set(), examples: [], count: 0 });
      }
      const field = allFields.get(key)!;
      field.types.add(inferType(value));
      if (field.examples.length < 2) {
        field.examples.push(value);
      }
      field.count++;
    }
  }

  const fields: Record<string, FrontmatterFieldInfo> = {};
  for (const [key, info] of allFields) {
    let type: FrontmatterFieldInfo["type"] = "string";
    if (info.types.has("string[]")) {
      type = "string[]";
    } else if (info.types.has("number")) {
      type = "number";
    } else if (info.types.has("boolean")) {
      type = "boolean";
    }

    fields[key] = {
      type,
      example: info.examples[0],
      required: info.count === postContents.length,
    };
  }

  return { fields };
}

export const detectedMapper: FrontmatterMapper = {
  name: "detected",
  map: (jena) => jena,
  detect: (rawContent: string) => detectFrontmatter([rawContent]),
};
