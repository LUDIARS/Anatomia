/**
 * src/adapters/__tests__/cli-entrypoints.test.ts — `anatomia entrypoints`.
 *
 * The command is a lens, not a gate, so the contract under test is: it always
 * exits 0, and each flag selects one honest view of the graph (entries, one
 * entry's tree, the unrooted set, the frontier).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, runCli } from "../cli.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "anatomia-entrypoints-cli-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "routes.ts"),
    [
      "export function handleUsers() { helper(); }",
      "export function helper() { }",
      "export function stray() { }",
      'app.get("/users", handleUsers);',
      "",
    ].join("\n"),
    "utf8",
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("parseArgs: entrypoints", () => {
  it("parses the entry-selection flags", () => {
    const args = parseArgs(["entrypoints", "--project", "p", "--entry", "handleUsers", "--json"]);
    expect(args.subcommand).toBe("entrypoints");
    expect(args.project).toBe("p");
    expect(args.entryRef).toBe("handleUsers");
    expect(args.json).toBe(true);
  });

  it("parses --unrooted and --frontier", () => {
    const args = parseArgs(["entrypoints", "--unrooted", "--frontier"]);
    expect(args.unrooted).toBe(true);
    expect(args.frontier).toBe(true);
  });

  it("parses export-graph --mode entrypoints without colliding with find --mode", () => {
    expect(parseArgs(["export-graph", "--mode", "entrypoints"]).exportMode).toBe("entrypoints");
    expect(parseArgs(["find", "x", "--mode", "prefix"]).mode).toBe("prefix");
    expect(() => parseArgs(["export-graph", "--mode", "nope"])).toThrow(/graph \| entrypoints/);
  });
});

describe("runCli: entrypoints", () => {
  it("lists detected entries and exits 0", async () => {
    const result = await runCli(parseArgs(["entrypoints", "--repo", root]));
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("handleUsers");
    expect(result.output).toContain("http-route");
  });

  it("emits the whole graph as JSON", async () => {
    const result = await runCli(parseArgs(["entrypoints", "--repo", root, "--json"]));
    const graph = JSON.parse(result.output);
    expect(graph.stale).toBe(false);
    expect(graph.staleReasons).toEqual([]);
    expect(graph.entries.map((entry: { symbol: { name: string } }) => entry.symbol.name)).toContain("handleUsers");
    expect(graph.unrooted.map((symbol: { name: string }) => symbol.name)).toContain("stray");
  });

  it("shows one entry's reach tree by symbol name", async () => {
    const result = await runCli(parseArgs(["entrypoints", "--repo", root, "--entry", "handleUsers"]));
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("helper");
  });

  it("lists the unrooted symbols", async () => {
    const result = await runCli(parseArgs(["entrypoints", "--repo", root, "--unrooted"]));
    expect(result.output).toContain("stray");
  });

  it("exits 0 and says so when the entry reference matches nothing", async () => {
    const result = await runCli(parseArgs(["entrypoints", "--repo", root, "--entry", "missing"]));
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("no entry matches");
  });
});
