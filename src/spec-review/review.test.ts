import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewSpec } from "./review.js";
import { formatSpecReview } from "./format.js";

const dirs: string[] = [];

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "anatomia-spec-review-"));
  dirs.push(dir);
  return dir;
}

async function writeHealthySpec(repo: string): Promise<void> {
  await mkdir(join(repo, "spec"), { recursive: true });
  await writeFile(join(repo, "spec", "README.md"), "# spec\n", "utf8");
  for (const category of ["data", "feature", "interface", "setup", "test"]) {
    await mkdir(join(repo, "spec", category), { recursive: true });
    await writeFile(join(repo, "spec", category, `${category}-main.md`), `# ${category}\n\nBody.\n`, "utf8");
  }
}

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("reviewSpec", () => {
  it("passes a complete AIFormat-style spec tree", async () => {
    const repo = await tempRepo();
    await writeHealthySpec(repo);

    const report = await reviewSpec(repo);

    expect(report.grade).toBe("A");
    expect(report.findings).toEqual([]);
    expect(report.criteria.name).toBe("AIFormat");
    expect(report.criteria.files).toContain("FORMAT_SPEC.md");
  });

  it("reports deterministic structure violations", async () => {
    const repo = await tempRepo();
    await writeHealthySpec(repo);
    await mkdir(join(repo, "spec", "usage"), { recursive: true });
    await writeFile(join(repo, "spec", "loose.md"), "# loose\n", "utf8");
    await writeFile(join(repo, ".gitignore"), "data/\n", "utf8");

    const report = await reviewSpec(repo);
    const kinds = report.findings.map((f) => f.kind);

    expect(report.grade).toBe("C");
    expect(kinds).toContain("NONCANONICAL_DIR");
    expect(kinds).toContain("STRAY_FILE");
    expect(kinds).toContain("GITIGNORE_DATA");
  });

  it("treats missing spec as a high-severity review finding", async () => {
    const repo = await tempRepo();

    const report = await reviewSpec(repo);

    expect(report.spec).toBe(false);
    expect(report.grade).toBe("C");
    expect(report.findings[0]?.kind).toBe("MISSING_SPEC");
  });

  it("formats a human-readable report", async () => {
    const repo = await tempRepo();

    const text = formatSpecReview(await reviewSpec(repo));

    expect(text).toContain("Spec review");
    expect(text).toContain("MISSING_SPEC");
    expect(text).toContain("AIFormat");
  });
});
