import chalk from "chalk";

const BRAND = chalk.hex("#6366f1"); // Indigo to match Jena AI palette

export function banner(): void {
  console.log();
  console.log(BRAND.bold("  create-mdx-blog"));
  console.log(chalk.dim("  Scaffold a production-ready MDX blog for Next.js"));
  console.log();
}

export function step(current: number, total: number, message: string): void {
  const progress = chalk.dim(`[${current}/${total}]`);
  console.log(`  ${progress} ${message}`);
}

export function success(message: string): void {
  console.log(`  ${chalk.green("+")} ${message}`);
}

export function info(message: string): void {
  console.log(`  ${chalk.blue("i")} ${message}`);
}

export function warn(message: string): void {
  console.log(`  ${chalk.yellow("!")} ${message}`);
}

export function error(message: string): void {
  console.log(`  ${chalk.red("x")} ${message}`);
}

export function created(filePath: string): void {
  console.log(`  ${chalk.green("+")} ${chalk.dim("created")} ${filePath}`);
}

export function skipped(filePath: string, reason: string): void {
  console.log(`  ${chalk.yellow("-")} ${chalk.dim("skipped")} ${filePath} ${chalk.dim(`(${reason})`)}`);
}

export function divider(): void {
  console.log();
  console.log(chalk.dim("  " + "─".repeat(50)));
  console.log();
}

export function summary(files: string[], envVars: string[]): void {
  divider();
  console.log(BRAND.bold("  Done!"));
  console.log();

  if (files.length > 0) {
    console.log(chalk.bold("  Files created:"));
    for (const f of files) {
      console.log(`    ${chalk.green("+")} ${f}`);
    }
    console.log();
  }

  if (envVars.length > 0) {
    console.log(chalk.bold("  Environment variables added to .env.local:"));
    for (const v of envVars) {
      console.log(`    ${chalk.blue("+")} ${v}`);
    }
    console.log();
  }

  console.log(chalk.bold("  Next steps:"));
  console.log(`    1. Review the generated files`);
  console.log(`    2. ${chalk.cyan("git add . && git commit -m 'Add blog'")}`);
  console.log(`    3. ${chalk.cyan("git push")} to deploy`);
  console.log();
}
