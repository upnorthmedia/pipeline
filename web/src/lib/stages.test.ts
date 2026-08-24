import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { STAGES } from "./api";
import { STAGE_LABELS, stageLabel } from "./stages";

describe("STAGE_LABELS", () => {
  it("names every stage the pipeline runs", () => {
    expect(Object.keys(STAGE_LABELS).sort()).toEqual([...STAGES].sort());
  });

  it("calls write and edit by the names the progress bar and the run trace use", () => {
    // The defect this module exists for: the tab strip said "Draft" and
    // "Editing" for the two stages every other surface called "Write" and
    // "Edit", so `/posts/[id]` showed two names for one step.
    expect(STAGE_LABELS.write).toBe("Write");
    expect(STAGE_LABELS.edit).toBe("Edit");
  });

  it("gives no two stages the same name", () => {
    const labels = Object.values(STAGE_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("stageLabel", () => {
  it("labels a stage name that is only typed as a string", () => {
    expect(stageLabel("write")).toBe("Write");
  });

  it("returns an unrecognised stage as it came", () => {
    // Analytics rows carry whatever the database holds. A stage this build
    // does not know about is worth seeing, not worth hiding behind a blank.
    expect(stageLabel("proofread")).toBe("proofread");
  });
});

const SRC = join(__dirname, "..");
const OWNER = join(SRC, "lib", "stages.ts");

/**
 * A second copy of the stage names is the defect, not a stale copy: four files
 * held one each and two of them drifted. These two patterns catch the shapes
 * those four used, `stage: "Label"` and `stage: { label: "Label" }`. A map
 * built some third way would slip through, which is why the names themselves
 * are pinned above as well.
 */
const LABEL_MAP_PATTERNS = [
  /^\s*(?:research|outline|write|edit|images|ready)\s*:\s*"[A-Z]/m,
  /^\s*(?:research|outline|write|edit|images|ready)\s*:\s*\{[^}]*label\s*:\s*"/m,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
    return [path];
  });
}

describe("the stage names have one owner", () => {
  it("finds no second stage label map under src/", () => {
    const files = sourceFiles(SRC);
    // A walk that finds nothing would pass this vacuously.
    expect(files.length).toBeGreaterThan(100);

    const offenders = files
      .filter((path) => path !== OWNER)
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return LABEL_MAP_PATTERNS.some((pattern) => pattern.test(source));
      })
      .map((path) => relative(SRC, path));

    expect(offenders).toEqual([]);
  });
});
