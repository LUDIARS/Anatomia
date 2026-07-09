/**
 * Deterministic spec review using AIFormat's spec documentation criteria.
 *
 * The review is intentionally standalone: it reads only the target repository's
 * spec/ tree and .gitignore, plus the bundled AIFormat submodule for provenance.
 * No code analysis, LLM, network, or git command is required.
 */

import { access, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SpecSeverity = "Critical" | "High" | "Medium" | "Low";
export type SpecGrade = "A" | "B" | "C" | "D";

export interface SpecReviewFinding {
  severity: SpecSeverity;
  kind:
    | "MISSING_SPEC"
    | "NONCANONICAL_DIR"
    | "STRAY_FILE"
    | "GITIGNORE_DATA"
    | "MISSING_CATEGORY"
    | "EMPTY_CATEGORY"
    | "MISSING_INDEX";
  path: string;
  message: string;
  suggestion: string;
  criterion: string;
}

export interface SpecReviewReport {
  project: string;
  spec: boolean;
  grade: SpecGrade;
  criteria: {
    name: "AIFormat";
    root: string;
    files: string[];
  };
  summary: {
    findings: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    presentCategories: string[];
    missingCategories: string[];
    emptyCategories: string[];
  };
  findings: SpecReviewFinding[];
}

export interface SpecReviewOptions {
  /** Override the AIFormat submodule root. Default: <repo>/lib/aiformat. */
  aiformatRoot?: string;
}

const CANONICAL = new Set(["data", "faq", "feature", "interface", "plan", "setup", "test"]);
const EVALUATED = ["data", "feature", "interface", "setup", "test"];
const ALLOWED_ROOT_FILES = new Set(["readme.md", "index.md"]);
const INDEX_FILES = new Set(["readme.md", "index.md"]);

const DEFAULT_AIFORMAT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../lib/aiformat",
);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function rel(repoPath: string, path: string): string {
  const r = relative(repoPath, path).replace(/\\/g, "/");
  return r || ".";
}

function gradeFor(findings: SpecReviewFinding[]): SpecGrade {
  if (findings.some((f) => f.severity === "Critical")) return "D";
  if (findings.some((f) => f.severity === "High")) return "C";
  if (findings.length > 0) return "B";
  return "A";
}

async function countContentDocs(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch {
    return 0;
  }
  return entries
    .map((e) => e.replace(/\\/g, "/"))
    .filter((e) => e.toLowerCase().endsWith(".md"))
    .filter((e) => !INDEX_FILES.has(e.split("/").pop()!.toLowerCase()))
    .length;
}

async function criteriaFiles(aiformatRoot: string): Promise<string[]> {
  const files = ["FORMAT_SPEC.md", "common/REVIEW_QUALITY.md", "REVIEW.md"];
  const present: string[] = [];
  for (const file of files) {
    if (await exists(join(aiformatRoot, file))) present.push(file);
  }
  return present;
}

export async function reviewSpec(
  repoPath: string,
  opts: SpecReviewOptions = {},
): Promise<SpecReviewReport> {
  const root = resolve(repoPath);
  const aiformatRoot = opts.aiformatRoot ?? DEFAULT_AIFORMAT_ROOT;
  const specDir = join(root, "spec");
  const findings: SpecReviewFinding[] = [];

  if (!(await isDir(specDir))) {
    findings.push({
      severity: "High",
      kind: "MISSING_SPEC",
      path: "spec/",
      message: "spec/ directory is missing.",
      suggestion: "Create spec/ and organize durable design docs under data, feature, interface, setup, and test.",
      criterion: "AIFormat FORMAT_SPEC.md §1 and common/REVIEW_QUALITY.md §3",
    });
    return summarize(root, false, aiformatRoot, [], [], [], findings);
  }

  const entries = await readdir(specDir);
  const presentCategories: string[] = [];

  for (const name of entries.sort()) {
    const full = join(specDir, name);
    if (await isDir(full)) {
      if (CANONICAL.has(name)) {
        presentCategories.push(name);
      } else {
        findings.push({
          severity: "High",
          kind: "NONCANONICAL_DIR",
          path: rel(root, full),
          message: `spec/ contains noncanonical category "${name}".`,
          suggestion: "Move the document under one of data, faq, feature, interface, plan, setup, or test.",
          criterion: "AIFormat FORMAT_SPEC.md §1; scripts/check-spec-structure.mjs NONCANONICAL_DIR",
        });
      }
    } else if (!ALLOWED_ROOT_FILES.has(name.toLowerCase())) {
      findings.push({
        severity: "Medium",
        kind: "STRAY_FILE",
        path: rel(root, full),
        message: `spec/ root contains a file outside category folders: ${name}.`,
        suggestion: "Keep only README.md or index.md at spec/ root; move durable docs into a category folder.",
        criterion: "AIFormat FORMAT_SPEC.md §1; scripts/check-spec-structure.mjs STRAY_FILE",
      });
    }
  }

  if (!entries.some((e) => ALLOWED_ROOT_FILES.has(e.toLowerCase()))) {
    findings.push({
      severity: "Low",
      kind: "MISSING_INDEX",
      path: "spec/",
      message: "spec/ has no README.md or index.md navigation file.",
      suggestion: "Add spec/README.md or spec/index.md as a short index for the categorized specs.",
      criterion: "AIFormat FORMAT_SPEC.md §1 root index allowance",
    });
  }

  const missingCategories = EVALUATED.filter((c) => !presentCategories.includes(c));
  for (const category of missingCategories) {
    findings.push({
      severity: "Low",
      kind: "MISSING_CATEGORY",
      path: `spec/${category}/`,
      message: `Evaluated spec category "${category}" is not present.`,
      suggestion: "Add the category when it applies; otherwise treat this as a reviewer note rather than a structural failure.",
      criterion: "AIFormat FORMAT_SPEC.md §9 and common/REVIEW_QUALITY.md §3",
    });
  }

  const emptyCategories: string[] = [];
  for (const category of EVALUATED.filter((c) => presentCategories.includes(c))) {
    const docCount = await countContentDocs(join(specDir, category));
    if (docCount === 0) {
      emptyCategories.push(category);
      findings.push({
        severity: "Low",
        kind: "EMPTY_CATEGORY",
        path: `spec/${category}/`,
        message: `Evaluated spec category "${category}" has no content markdown beyond an index file.`,
        suggestion: "Add at least one durable spec document for this category, or remove the placeholder until it is meaningful.",
        criterion: "AIFormat FORMAT_SPEC.md §9 and common/REVIEW_QUALITY.md §3",
      });
    }
  }

  if (presentCategories.includes("data")) {
    const gitignore = await safeRead(join(root, ".gitignore"));
    const trapsSpecData = gitignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => /^data\/?$/.test(line));
    if (trapsSpecData) {
      findings.push({
        severity: "High",
        kind: "GITIGNORE_DATA",
        path: ".gitignore",
        message: "Unanchored data/ ignore rule also ignores spec/data/.",
        suggestion: "Change the ignore rule to /data/ so spec/data/ remains tracked.",
        criterion: "AIFormat scripts/check-spec-structure.mjs GITIGNORE_DATA",
      });
    }
  }

  return summarize(root, true, aiformatRoot, presentCategories, missingCategories, emptyCategories, findings);
}

async function summarize(
  project: string,
  spec: boolean,
  aiformatRoot: string,
  presentCategories: string[],
  missingCategories: string[],
  emptyCategories: string[],
  findings: SpecReviewFinding[],
): Promise<SpecReviewReport> {
  const count = (severity: SpecSeverity): number =>
    findings.filter((f) => f.severity === severity).length;
  return {
    project,
    spec,
    grade: gradeFor(findings),
    criteria: {
      name: "AIFormat",
      root: aiformatRoot,
      files: await criteriaFiles(aiformatRoot),
    },
    summary: {
      findings: findings.length,
      critical: count("Critical"),
      high: count("High"),
      medium: count("Medium"),
      low: count("Low"),
      presentCategories: [...presentCategories].sort(),
      missingCategories: [...missingCategories].sort(),
      emptyCategories: [...emptyCategories].sort(),
    },
    findings: findings.sort((a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.path.localeCompare(b.path) ||
      a.kind.localeCompare(b.kind),
    ),
  };
}

function severityRank(severity: SpecSeverity): number {
  switch (severity) {
    case "Critical": return 0;
    case "High": return 1;
    case "Medium": return 2;
    case "Low": return 3;
  }
}
