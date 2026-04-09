export interface ProjectContext {
  /** Absolute path to project root */
  rootDir: string;
  /** Next.js version string (e.g., "15.5.9") */
  nextVersion: string;
  /** Whether project uses TypeScript */
  typescript: boolean;
  /** Detected package manager */
  packageManager: "npm" | "pnpm" | "yarn";
  /** Whether Tailwind CSS is configured */
  tailwind: boolean;
  /** Whether shadcn/ui components are detected */
  shadcn: boolean;
  /** Existing blog info, null if no blog found */
  existingBlog: ExistingBlog | null;
}

export interface ExistingBlog {
  /** Relative path from project root to blog content directory */
  contentDir: string;
  /** Number of MDX/MD posts found */
  postCount: number;
  /** Paths to discovered post files (relative) */
  postPaths: string[];
  /** Inferred frontmatter schema from existing posts */
  frontmatterSchema: FrontmatterSchema | null;
}

export interface FrontmatterSchema {
  /** Map of field name to inferred type info */
  fields: Record<string, FrontmatterFieldInfo>;
}

export interface FrontmatterFieldInfo {
  type: "string" | "string[]" | "number" | "boolean" | "date";
  /** Example value from an existing post */
  example: unknown;
  /** Whether every post has this field */
  required: boolean;
}

export interface FrontmatterMapping {
  [jenaField: string]: string | FrontmatterTransform;
}

export interface FrontmatterTransform {
  key: string;
  transform?: "array" | "jena-cdn-url";
  default?: string;
}

export interface BlogConfig {
  contentDir: string;
  postsPerPage: number;
  rss: boolean;
  categories: boolean;
  siteName: string;
  siteDescription: string;
  siteUrl: string;
}

export interface JenaConfig {
  blog: BlogConfig;
  jena?: {
    apiKey: string | undefined;
    webhookSecret: string | undefined;
  };
  frontmatter: FrontmatterMapping;
  images: {
    storage: "local" | "jena-cdn";
    localDir?: string;
    publicPath?: string;
  };
}

export interface GeneratedFile {
  /** Relative path from project root */
  path: string;
  /** File content */
  content: string;
}

export type EnvVars = Record<string, string>;
