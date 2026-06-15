/**
 * CLI adapter -- project-aware tests.
 *
 * Verifies parseArgs for the `project` subcommand + `--project` flag, and
 * runCli for project add/list/analyze and a --project-scoped context call.
 * Uses ANATOMIA_HOME to isolate the registry under a temp dir.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, runCli } from "../cli.js";

let home: string;
let root: string;
const prevHome = process.env.ANATOMIA_HOME;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "anatomia-cli-home-"));
  root = await mkdtemp(join(tmpdir(), "anatomia-cli-root-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "m.cpp"), "void cliOne() { }\nvoid cliTwo() { cliOne(); }\n", "utf8");
  process.env.ANATOMIA_HOME = home;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.ANATOMIA_HOME;
  else process.env.ANATOMIA_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

describe("parseArgs project grammar", () => {
  it("parses `project add <name> <path>`", () => {
    const args = parseArgs(["project", "add", "MyGame", "/games/mine"]);
    expect(args.subcommand).toBe("project");
    expect(args.projectAction).toBe("add");
    expect(args.projectArgs).toEqual(["MyGame", "/games/mine"]);
  });

  it("parses `project list` and `project remove <id>`", () => {
    expect(parseArgs(["project", "list"]).projectAction).toBe("list");
    const rm = parseArgs(["project", "remove", "abc"]);
    expect(rm.projectAction).toBe("remove");
    expect(rm.projectArgs).toEqual(["abc"]);
  });

  it("parses --project on verify/context/where", () => {
    expect(parseArgs(["verify", "--project", "g1"]).project).toBe("g1");
    expect(parseArgs(["context", "-p", "g2", "-t", "task"]).project).toBe("g2");
  });

  it("throws on unknown project action", () => {
    expect(() => parseArgs(["project", "frobnicate"])).toThrow();
  });
});

describe("runCli project lifecycle", () => {
  it("adds, lists, analyzes and removes a project (JSON)", async () => {
    const add = await runCli({
      subcommand: "project",
      repoPath: process.cwd(),
      projectAction: "add",
      projectArgs: ["CliGame", root],
      json: true,
    });
    expect(add.exitCode).toBe(0);
    const added = JSON.parse(add.output);
    expect(added.id).toBe("cligame");

    const list = await runCli({
      subcommand: "project",
      repoPath: process.cwd(),
      projectAction: "list",
      json: true,
    });
    const listed = JSON.parse(list.output);
    expect(listed.projects.map((p: { id: string }) => p.id)).toContain("cligame");

    const ana = await runCli({
      subcommand: "project",
      repoPath: process.cwd(),
      projectAction: "analyze",
      projectArgs: ["cligame"],
      json: true,
    });
    const result = JSON.parse(ana.output);
    expect(result.project).toBe("cligame");
    expect(result.functions).toBeGreaterThan(0);

    const removed = await runCli({
      subcommand: "project",
      repoPath: process.cwd(),
      projectAction: "remove",
      projectArgs: ["cligame"],
      json: true,
    });
    expect(JSON.parse(removed.output).removed).toBe(true);
  });

  it("context --project analyzes the registered project", async () => {
    // Re-register because the previous test removed it.
    await runCli({
      subcommand: "project",
      repoPath: process.cwd(),
      projectAction: "add",
      projectArgs: ["CtxGame", root],
      json: true,
    });
    const { exitCode, output } = await runCli({
      subcommand: "context",
      repoPath: process.cwd(),
      project: "ctxgame",
      task: "add a skill",
    });
    expect(exitCode).toBe(0);
    const bundle = JSON.parse(output);
    expect(bundle).toHaveProperty("exemplars");
  });
});
