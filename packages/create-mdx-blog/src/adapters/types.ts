import type {
  ProjectContext,
  FrontmatterSchema,
  GeneratedFile,
  EnvVars,
  JenaConfig,
} from "../types.js";

export interface SetupContext {
  projectContext: ProjectContext;
  config: Partial<JenaConfig>;
}

export interface ScaffoldContext extends SetupContext {
  /** Whether the project uses TypeScript */
  typescript: boolean;
  /** Whether Tailwind is available */
  tailwind: boolean;
}

/** Where images are stored and how URLs are resolved */
export interface ImageStorageAdapter {
  name: string;
  /** Returns the public URL for an image given filename and post slug */
  resolveUrl(filename: string, slug: string): string;
  /** Optional: interactive setup during init, returns env vars to write */
  setup?(ctx: SetupContext): Promise<EnvVars>;
}

/** How content arrives in the user's project */
export interface ContentDeliveryAdapter {
  name: string;
  /** Generate files to add to the project (e.g., webhook route) */
  scaffold(ctx: ScaffoldContext): Promise<GeneratedFile[]>;
  /** Optional: interactive setup during init, returns env vars to write */
  setup?(ctx: SetupContext): Promise<EnvVars>;
}

/** How Jena AI frontmatter maps to the user's schema */
export interface FrontmatterMapper {
  name: string;
  /** Transform Jena AI frontmatter to the target schema */
  map(jenaFrontmatter: Record<string, unknown>): Record<string, unknown>;
  /** Optional: detect schema from existing post content */
  detect?(rawContent: string): FrontmatterSchema;
}
