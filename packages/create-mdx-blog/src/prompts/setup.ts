import prompts from "prompts";
import type { ProjectContext, BlogConfig, FrontmatterMapping, FrontmatterSchema } from "../types.js";
import * as ui from "../ui.js";

/** Prompt: existing blog found — connect or scaffold? */
export async function promptExistingBlogAction(
  blog: NonNullable<ProjectContext["existingBlog"]>,
): Promise<"connect" | "scaffold"> {
  ui.info(
    `Found an existing blog at ${blog.contentDir}/ with ${blog.postCount} post${blog.postCount === 1 ? "" : "s"}.`,
  );
  console.log();

  const { action } = await prompts({
    type: "select",
    name: "action",
    message: "What would you like to do?",
    choices: [
      {
        title: "Connect Jena AI to this blog",
        value: "connect",
        description: "Add webhook integration without changing your blog",
      },
      {
        title: "Scaffold a new blog",
        value: "scaffold",
        description: "Create a fresh blog system alongside your existing one",
      },
    ],
  });

  return action || "connect";
}

/** Prompt: blog configuration for scaffold mode */
export async function promptBlogConfig(): Promise<BlogConfig> {
  const responses = await prompts([
    {
      type: "text",
      name: "siteName",
      message: "Blog name",
      initial: "My Blog",
    },
    {
      type: "text",
      name: "siteDescription",
      message: "Blog description",
      initial: "A blog about things that matter",
    },
    {
      type: "text",
      name: "siteUrl",
      message: "Site URL (for RSS and metadata)",
      initial: "https://example.com",
    },
    {
      type: "number",
      name: "postsPerPage",
      message: "Posts per page",
      initial: 10,
      min: 1,
      max: 100,
    },
    {
      type: "confirm",
      name: "rss",
      message: "Enable RSS feed?",
      initial: true,
    },
    {
      type: "confirm",
      name: "categories",
      message: "Enable category pages?",
      initial: true,
    },
  ]);

  return {
    contentDir: "content/blog",
    postsPerPage: responses.postsPerPage ?? 10,
    rss: responses.rss ?? true,
    categories: responses.categories ?? true,
    siteName: responses.siteName ?? "My Blog",
    siteDescription: responses.siteDescription ?? "",
    siteUrl: responses.siteUrl ?? "https://example.com",
  };
}

/** Prompt: connect to Jena AI? */
export async function promptJenaConnection(): Promise<{
  connect: boolean;
  apiKey?: string;
}> {
  const { connect } = await prompts({
    type: "confirm",
    name: "connect",
    message: "Connect to Jena AI for automated content delivery?",
    initial: false,
  });

  if (!connect) return { connect: false };

  const { apiKey } = await prompts({
    type: "password",
    name: "apiKey",
    message: "Jena AI API key",
  });

  return { connect: true, apiKey };
}

/** Prompt: confirm detected frontmatter schema */
export async function promptFrontmatterConfirmation(
  schema: FrontmatterSchema,
): Promise<boolean> {
  console.log();
  ui.info("Detected frontmatter schema:");
  console.log();
  for (const [key, field] of Object.entries(schema.fields)) {
    const req = field.required ? "" : " (optional)";
    const example =
      typeof field.example === "string"
        ? `"${field.example}"`
        : JSON.stringify(field.example);
    console.log(`    ${key}: ${field.type}${req} — e.g. ${example}`);
  }
  console.log();

  const { confirmed } = await prompts({
    type: "confirm",
    name: "confirmed",
    message: "Does this look right?",
    initial: true,
  });

  return confirmed ?? true;
}

/** Build frontmatter mapping from detected schema */
export function buildFrontmatterMapping(
  schema: FrontmatterSchema,
): FrontmatterMapping {
  const mapping: FrontmatterMapping = {};
  const jenaFields = ["title", "description", "date", "category", "author", "image"];

  for (const jenaField of jenaFields) {
    if (schema.fields[jenaField]) {
      const field = schema.fields[jenaField];
      if (jenaField === "category" && field.type === "string[]") {
        mapping[jenaField] = { key: "category", transform: "array" };
      } else if (jenaField === "image") {
        mapping[jenaField] = { key: "image", transform: "jena-cdn-url" };
      } else {
        mapping[jenaField] = jenaField;
      }
    }
  }

  return mapping;
}
