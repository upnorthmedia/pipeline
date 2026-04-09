import fs from "node:fs";
import path from "node:path";
import { glob } from "glob";
import type { ProjectContext, ExistingBlog } from "./types.js";

export async function detectProject(rootDir: string): Promise<ProjectContext> {
  const pkgPath = path.join(rootDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error(
      "No package.json found. Run this command from a Next.js project root.",
    );
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  const nextVersion = allDeps.next?.replace(/[\^~]/, "");
  if (!nextVersion) {
    throw new Error(
      "Next.js not found in dependencies. This tool requires a Next.js 14+ project.",
    );
  }

  const majorVersion = parseInt(nextVersion.split(".")[0], 10);
  if (majorVersion < 14) {
    throw new Error(
      `Next.js ${nextVersion} detected. This tool requires Next.js 14+ with App Router.`,
    );
  }

  const typescript =
    !!allDeps.typescript || fs.existsSync(path.join(rootDir, "tsconfig.json"));

  const packageManager = detectPackageManager(rootDir);

  const tailwind = !!allDeps.tailwindcss || !!allDeps["@tailwindcss/postcss"];

  const shadcn =
    fs.existsSync(path.join(rootDir, "components", "ui")) ||
    fs.existsSync(path.join(rootDir, "src", "components", "ui"));

  const existingBlog = await detectExistingBlog(rootDir);

  return {
    rootDir,
    nextVersion,
    typescript,
    packageManager,
    tailwind,
    shadcn,
    existingBlog,
  };
}

function detectPackageManager(rootDir: string): "npm" | "pnpm" | "yarn" {
  if (fs.existsSync(path.join(rootDir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(rootDir, "yarn.lock"))) return "yarn";
  return "npm";
}

async function detectExistingBlog(rootDir: string): Promise<ExistingBlog | null> {
  const patterns = [
    "app/blog/**/*.{mdx,md}",
    "content/blog/**/*.{mdx,md}",
    "content/posts/**/*.{mdx,md}",
    "posts/**/*.{mdx,md}",
    "src/content/blog/**/*.{mdx,md}",
  ];

  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: rootDir,
      ignore: ["**/node_modules/**"],
    });

    if (matches.length > 0) {
      const firstMatch = matches[0];
      const contentDir = path.dirname(firstMatch).split("/").slice(0, 2).join("/");

      return {
        contentDir,
        postCount: matches.length,
        postPaths: matches,
        frontmatterSchema: null,
      };
    }
  }

  return null;
}
