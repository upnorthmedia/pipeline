#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import ora from "ora";
import * as ui from "./ui.js";
import { detectProject } from "./detect.js";
import { detectFrontmatter } from "./adapters/frontmatter/detect.js";
import {
  promptExistingBlogAction,
  promptBlogConfig,
  promptJenaConnection,
  promptFrontmatterConfirmation,
  buildFrontmatterMapping,
} from "./prompts/setup.js";
import { scaffoldBlog } from "./init/scaffold.js";
import { connectToExistingBlog } from "./init/connect.js";
import type { JenaConfig } from "./types.js";

async function main() {
  ui.banner();

  const rootDir = process.cwd();

  // Step 1: Detect project
  const spinner = ora("Detecting project...").start();
  let context;
  try {
    context = await detectProject(rootDir);
    spinner.succeed(
      `Next.js ${context.nextVersion} · ${context.typescript ? "TypeScript" : "JavaScript"} · ${context.tailwind ? "Tailwind" : "CSS"} · ${context.packageManager}`,
    );
  } catch (err) {
    spinner.fail((err as Error).message);
    process.exit(1);
  }

  // Step 2: Determine mode
  let mode: "scaffold" | "connect" = "scaffold";
  if (context.existingBlog) {
    mode = await promptExistingBlogAction(context.existingBlog);
  }

  if (mode === "connect") {
    await runConnectMode(rootDir, context);
  } else {
    await runScaffoldMode(rootDir, context);
  }
}

async function runScaffoldMode(
  rootDir: string,
  context: Awaited<ReturnType<typeof detectProject>>,
) {
  // Prompt for blog config
  const blogConfig = await promptBlogConfig();

  // Prompt for Jena AI connection
  const jena = await promptJenaConnection();

  const config: Partial<JenaConfig> = {
    blog: blogConfig,
    frontmatter: {
      title: "title",
      description: "description",
      date: "date",
      category: "category",
      image: "image",
      author: "author",
    },
    images: {
      storage: jena.connect ? "jena-cdn" : "local",
      localDir: "public/blog/images",
      publicPath: "/blog/images",
    },
  };

  if (jena.connect) {
    config.jena = {
      apiKey: undefined,
      webhookSecret: undefined,
    };
  }

  // Scaffold
  const spinner = ora("Scaffolding blog...").start();
  const result = await scaffoldBlog({
    rootDir,
    config,
    typescript: context.typescript,
    tailwind: context.tailwind,
    includeJena: jena.connect,
  });
  spinner.stop();

  // Write files
  const writtenFiles: string[] = [];
  for (const file of result.files) {
    const fullPath = path.join(rootDir, file.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content);
    ui.created(file.path);
    writtenFiles.push(file.path);
  }

  // Write env vars
  const envEntries: string[] = [];
  if (jena.connect) {
    const webhookSecret = randomBytes(32).toString("base64");
    const envLines = [
      `JENA_API_KEY=${jena.apiKey ?? ""}`,
      `JENA_WEBHOOK_SECRET=${webhookSecret}`,
    ];

    appendEnvLocal(rootDir, envLines);
    envEntries.push("JENA_API_KEY", "JENA_WEBHOOK_SECRET");
    verifyGitignore(rootDir);
  }

  // Install dependencies if needed
  await installDepsIfNeeded(rootDir, context.packageManager);

  ui.summary(writtenFiles, envEntries);
}

async function runConnectMode(
  rootDir: string,
  context: Awaited<ReturnType<typeof detectProject>>,
) {
  const blog = context.existingBlog!;

  // Read existing posts and detect frontmatter
  const postContents = blog.postPaths.map((p) =>
    fs.readFileSync(path.join(rootDir, p), "utf-8"),
  );
  const schema = detectFrontmatter(postContents);
  blog.frontmatterSchema = schema;

  // Confirm frontmatter
  const confirmed = await promptFrontmatterConfirmation(schema);
  if (!confirmed) {
    ui.warn("Frontmatter mapping not confirmed. Please edit jena.config.ts manually after setup.");
  }

  const mapping = buildFrontmatterMapping(schema);

  // Connect
  const spinner = ora("Setting up Jena AI connection...").start();
  const result = await connectToExistingBlog({
    rootDir,
    contentDir: blog.contentDir,
    frontmatterMapping: mapping,
    imageStorage: "jena-cdn",
  });
  spinner.stop();

  // Write files
  const writtenFiles: string[] = [];
  for (const file of result.files) {
    const fullPath = path.join(rootDir, file.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content);
    ui.created(file.path);
    writtenFiles.push(file.path);
  }

  // Write env vars
  const webhookSecret = randomBytes(32).toString("base64");
  appendEnvLocal(rootDir, [
    "JENA_API_KEY=",
    `JENA_WEBHOOK_SECRET=${webhookSecret}`,
  ]);
  verifyGitignore(rootDir);

  ui.summary(writtenFiles, ["JENA_API_KEY", "JENA_WEBHOOK_SECRET"]);
}

function appendEnvLocal(rootDir: string, lines: string[]): void {
  const envPath = path.join(rootDir, ".env.local");
  const existing = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf-8")
    : "";

  const newLines = lines.filter((line) => {
    const key = line.split("=")[0];
    return !existing.includes(`${key}=`);
  });

  if (newLines.length > 0) {
    const separator = existing.endsWith("\n") || existing === "" ? "" : "\n";
    const content = `${separator}# Jena AI Blog Integration\n${newLines.join("\n")}\n`;
    fs.appendFileSync(envPath, content);
  }
}

function verifyGitignore(rootDir: string): void {
  const gitignorePath = path.join(rootDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return;

  const content = fs.readFileSync(gitignorePath, "utf-8");
  if (!content.includes(".env.local")) {
    ui.warn(
      ".env.local is not in .gitignore. Next.js ignores it by default, but double-check your .gitignore.",
    );
  }
}

async function installDepsIfNeeded(
  rootDir: string,
  packageManager: "npm" | "pnpm" | "yarn",
): Promise<void> {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"),
  );
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  const needed: string[] = [];
  if (!allDeps["gray-matter"]) needed.push("gray-matter");
  if (!allDeps["next-mdx-remote"]) needed.push("next-mdx-remote");

  if (needed.length === 0) return;

  ui.info(`Installing: ${needed.join(", ")}`);
  const { execSync } = await import("node:child_process");
  const cmd =
    packageManager === "pnpm"
      ? `pnpm add ${needed.join(" ")}`
      : packageManager === "yarn"
        ? `yarn add ${needed.join(" ")}`
        : `npm install ${needed.join(" ")}`;

  execSync(cmd, { cwd: rootDir, stdio: "pipe" });
}

main().catch((err) => {
  ui.error(err.message);
  process.exit(1);
});
