/**
 * T31 — CLI adapter tests.
 *
 * Tests parseArgs and the pure runCli logic.
 * Uses a temp directory with one .cpp file for integration-style verify tests.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, runCli } from "../cli.js";
import type { CliArgs } from "../cli.js";

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses verify subcommand with --repo and --diff", () => {
    const args = parseArgs(["verify", "--repo", "/my/repo", "--diff", "patch.diff"]);
    expect(args.subcommand).toBe("verify");
    expect(args.repoPath).toBe("/my/repo");
    expect(args.diff).toBe("patch.diff");
  });

  it("parses context subcommand with --task", () => {
    const args = parseArgs(["context", "--repo", "/r", "--task", "add skill"]);
    expect(args.subcommand).toBe("context");
    expect(args.task).toBe("add skill");
  });

  it("parses where subcommand with --json flag", () => {
    const args = parseArgs(["where", "--repo", "/r", "--task", "dodge", "--json"]);
    expect(args.subcommand).toBe("where");
    expect(args.json).toBe(true);
  });

  it("parses short flags -r -d -t -j", () => {
    const args = parseArgs(["verify", "-r", "/x", "-d", "-", "-j"]);
    expect(args.repoPath).toBe("/x");
    expect(args.diff).toBe("-");
    expect(args.json).toBe(true);
  });

  it("throws on unknown subcommand", () => {
    expect(() => parseArgs(["unknown", "--repo", "/r"])).toThrow();
  });

  it("defaults repoPath to cwd when --repo is absent", () => {
    const args = parseArgs(["context"]);
    expect(args.repoPath).toBe(process.cwd());
  });
});

// ---------------------------------------------------------------------------
// runCli — integration tests with a real temp dir
// ---------------------------------------------------------------------------

let tmpDir: string;
const SIMPLE_CPP = "void hello() { }\nvoid world() { hello(); }\n";

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "anatomia-cli-test-"));
  await writeFile(join(tmpDir, "main.cpp"), SIMPLE_CPP, "utf8");
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("runCli verify", () => {
  it("exits 0 and returns JSON for clean diff", async () => {
    const args: CliArgs = {
      subcommand: "verify",
      repoPath: tmpDir,
      diff: join(tmpDir, "main.cpp"),
      json: true,
    };
    const { exitCode, output } = await runCli(args);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("pass", true);
    expect(Array.isArray(parsed.gates)).toBe(true);
  });

  it("outputs human summary when --json is not set", async () => {
    const args: CliArgs = {
      subcommand: "verify",
      repoPath: tmpDir,
      diff: join(tmpDir, "main.cpp"),
      json: false,
    };
    const { exitCode, output } = await runCli(args);
    expect(exitCode).toBe(0);
    expect(output).toMatch(/PASS/);
  });

  it("accepts a unified diff and verifies the post-image hunk", async () => {
    const diffPath = join(tmpDir, "change.diff");
    await writeFile(
      diffPath,
      [
        "diff --git a/main.cpp b/main.cpp",
        "index 1111111..2222222 100644",
        "--- a/main.cpp",
        "+++ b/main.cpp",
        "@@ -1,2 +1,6 @@",
        " void hello() { }",
        " void world() { hello(); }",
        "+void addedFromDiff() {",
        "+  hello();",
        "+}",
        "",
      ].join("\n"),
      "utf8",
    );

    const args: CliArgs = {
      subcommand: "verify",
      repoPath: tmpDir,
      diff: diffPath,
      json: true,
    };
    const { output } = await runCli(args);
    const parsed = JSON.parse(output);
    const specGate = parsed.gates.find((g: { gate: string }) => g.gate === "spec_linkage");

    expect(specGate.pass).toBe(false);
    expect(specGate.suggestion).toContain("addedFromDiff");
  });
});

describe("runCli context", () => {
  it("returns JSON ContextBundle and exits 0", async () => {
    const args: CliArgs = {
      subcommand: "context",
      repoPath: tmpDir,
      task: "add a skill domain",
    };
    const { exitCode, output } = await runCli(args);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("applicableRules");
    expect(parsed).toHaveProperty("exemplars");
  });
});

describe("runCli where", () => {
  it("returns landings JSON and exits 0", async () => {
    const args: CliArgs = {
      subcommand: "where",
      repoPath: tmpDir,
      task: "add movement",
    };
    const { exitCode, output } = await runCli(args);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("landings");
    expect(Array.isArray(parsed.landings)).toBe(true);
  });
});
