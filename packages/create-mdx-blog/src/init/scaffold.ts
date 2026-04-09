import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JenaConfig, GeneratedFile } from "../types.js";
import { generateWebhookHandler } from "../adapters/delivery/webhook.js";

interface ScaffoldOptions {
  rootDir: string;
  config: Partial<JenaConfig>;
  typescript: boolean;
  tailwind: boolean;
  includeJena: boolean;
}

interface ScaffoldResult {
  files: GeneratedFile[];
  envVars: Record<string, string>;
}

// Resolve template directory — works from both src/ and dist/
function getTemplateDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  // From src/init/, go up one level to src/, then into templates/
  // From dist/init/, go up one level to dist/, then into templates/
  const templatesDir = path.join(currentDir, "..", "templates");
  if (fs.existsSync(templatesDir)) return templatesDir;
  // Fallback: look relative to process.cwd() src/templates
  return path.join(process.cwd(), "src", "templates");
}

function readTemplate(templatePath: string): string {
  const fullPath = path.join(getTemplateDir(), templatePath);
  return fs.readFileSync(fullPath, "utf-8");
}

function applyTokens(template: string, tokens: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(tokens)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

function generateConfigFile(config: Partial<JenaConfig>): string {
  const tmpl = readTemplate("config/jena-config.ts.tmpl");
  const configObj = {
    blog: config.blog,
    ...(config.jena && {
      jena: {
        apiKey: "process.env.JENA_API_KEY",
        webhookSecret: "process.env.JENA_WEBHOOK_SECRET",
      },
    }),
    frontmatter: config.frontmatter ?? {},
    images: config.images ?? { storage: "local" },
  };

  let json = JSON.stringify(configObj, null, 2);
  // Replace quoted env var strings with actual process.env references
  json = json.replace(/"process\.env\.(\w+)"/g, "process.env.$1");

  return tmpl.replace("{{CONFIG_JSON}}", json);
}

export async function scaffoldBlog(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const { config, includeJena } = options;
  const blog = config.blog!;
  const files: GeneratedFile[] = [];

  const libPath = "lib";
  const componentsPath = "components";

  // Content layer
  files.push({
    path: `${libPath}/blog/types.ts`,
    content: readTemplate("content-layer/types.ts.tmpl"),
  });
  files.push({
    path: `${libPath}/blog/content.ts`,
    content: applyTokens(readTemplate("content-layer/content.ts.tmpl"), {
      CONTENT_DIR: blog.contentDir,
      POSTS_PER_PAGE: String(blog.postsPerPage),
    }),
  });
  files.push({
    path: `${libPath}/blog/mdx.ts`,
    content: readTemplate("content-layer/mdx.ts.tmpl"),
  });

  // Components
  const componentTokens = { LIB_PATH: libPath };
  files.push({
    path: `${componentsPath}/blog/post-card.tsx`,
    content: applyTokens(readTemplate("components/post-card.tsx.tmpl"), componentTokens),
  });
  files.push({
    path: `${componentsPath}/blog/post-layout.tsx`,
    content: applyTokens(readTemplate("components/post-layout.tsx.tmpl"), componentTokens),
  });
  files.push({
    path: `${componentsPath}/blog/pagination.tsx`,
    content: readTemplate("components/pagination.tsx.tmpl"),
  });
  files.push({
    path: `${componentsPath}/blog/category-nav.tsx`,
    content: readTemplate("components/category-nav.tsx.tmpl"),
  });

  // Routes
  const routeTokens = {
    LIB_PATH: libPath,
    COMPONENTS_PATH: componentsPath,
    SITE_NAME: blog.siteName,
    SITE_DESCRIPTION: blog.siteDescription,
    SITE_URL: blog.siteUrl,
  };

  files.push({
    path: "app/blog/page.tsx",
    content: applyTokens(readTemplate("routes/blog-page.tsx.tmpl"), routeTokens),
  });
  files.push({
    path: "app/blog/[slug]/page.tsx",
    content: applyTokens(readTemplate("routes/blog-slug-page.tsx.tmpl"), routeTokens),
  });

  if (blog.categories) {
    files.push({
      path: "app/blog/category/[category]/page.tsx",
      content: applyTokens(readTemplate("routes/category-page.tsx.tmpl"), routeTokens),
    });
  }

  if (blog.rss) {
    files.push({
      path: "app/blog/feed.xml/route.ts",
      content: applyTokens(readTemplate("routes/feed-route.ts.tmpl"), routeTokens),
    });
  }

  // Example post
  files.push({
    path: `${blog.contentDir}/welcome.mdx`,
    content: applyTokens(readTemplate("example-post.mdx.tmpl"), {
      TODAY_DATE: new Date().toISOString().split("T")[0],
      SITE_NAME: blog.siteName,
      CONTENT_DIR: blog.contentDir,
    }),
  });

  // Config file
  files.push({ path: "jena.config.ts", content: generateConfigFile(config) });

  // Webhook route (if Jena AI connected)
  if (includeJena) {
    const webhookHandler = generateWebhookHandler({
      typescript: true,
      contentDir: blog.contentDir,
      imageStorage: config.images?.storage ?? "local",
      localImageDir: config.images?.localDir ?? "public/blog/images",
      localImagePublicPath: config.images?.publicPath ?? "/blog/images",
    });
    files.push({ path: "app/api/jena-webhook/route.ts", content: webhookHandler });
  }

  return { files, envVars: {} };
}
