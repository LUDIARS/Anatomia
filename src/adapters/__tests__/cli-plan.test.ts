/**
 * `plan` argument parsing + the `verify --plan` flag.
 * Argument shaping only — the pipeline has its own tests under src/supply/plan.
 */

import { describe, expect, it } from "vitest";
import { parseArgs } from "../cli.js";

describe("parseArgs: plan", () => {
  it("parses a single-project plan", () => {
    const args = parseArgs(["plan", "--task", "切り絵のデモを実装する", "--project", "pictor"]);
    expect(args.subcommand).toBe("plan");
    expect(args.task).toBe("切り絵のデモを実装する");
    expect(args.projects).toEqual(["pictor"]);
    expect(args.project).toBe("pictor");
    expect(args.planFormat).toBe("markdown");
  });

  it("accepts --project more than once for a cross-repo plan", () => {
    const args = parseArgs([
      "plan",
      "--task",
      "切り絵のデモ",
      "--project",
      "pictor",
      "--project",
      "figmentum",
    ]);
    expect(args.projects).toEqual(["pictor", "figmentum"]);
  });

  it("parses --repo, --json, --no-llm and --format okf", () => {
    const args = parseArgs([
      "plan",
      "--task",
      "t",
      "--repo",
      "/r",
      "--json",
      "--no-llm",
      "--format",
      "okf",
    ]);
    expect(args.repoPath).toBe("/r");
    expect(args.json).toBe(true);
    expect(args.noLlm).toBe(true);
    expect(args.planFormat).toBe("okf");
    expect(args.projects).toBeUndefined();
  });

  it("rejects a plan with no task and an unknown format", () => {
    expect(() => parseArgs(["plan", "--project", "pictor"])).toThrow(/--task/);
    expect(() => parseArgs(["plan", "--task", "t", "--format", "yaml"])).toThrow(/Expected: markdown/);
  });
});

describe("parseArgs: verify --plan", () => {
  it("takes an explicit plan path", () => {
    const args = parseArgs(["verify", "--repo", "/r", "--plan", "/r/.anatomia/plan/abc.json"]);
    expect(args.planPath).toBe("/r/.anatomia/plan/abc.json");
  });

  it("treats a bare --plan as \"the most recent plan\"", () => {
    const args = parseArgs(["verify", "--repo", "/r", "--plan", "--json"]);
    expect(args.planPath).toBe("");
    expect(args.json).toBe(true);
  });

  it("leaves planPath unset when --plan was not given", () => {
    expect(parseArgs(["verify", "--repo", "/r"]).planPath).toBeUndefined();
  });
});
