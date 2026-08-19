/**
 * src/adapters/__tests__/cli-domains-program.test.ts — `anatomia domains program`.
 *
 * The command is the operator's pre-flight for the two-layer program gate: it
 * must show exactly which modules `.anatomia/layers.json` leaves unclassified
 * and report 0 once the declaration covers the repo. It is a lens, not a gate
 * (exit 0 either way).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, runCli } from "../cli.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "anatomia-domains-program-cli-"));
  await mkdir(join(root, "src", "ui"), { recursive: true });
  await mkdir(join(root, "src", "misc"), { recursive: true });
  await writeFile(join(root, "src", "ui", "button.ts"), "export function render() { return 1; }\n", "utf8");
  await writeFile(join(root, "src", "misc", "util.ts"), "export function helper() { return 2; }\n", "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("parseArgs: domains program", () => {
  it("parses the program action with --unclassified and --json", () => {
    const args = parseArgs(["domains", "program", "--project", "p", "--unclassified", "--json"]);
    expect(args.subcommand).toBe("domains");
    expect(args.domainsAction).toBe("program");
    expect(args.project).toBe("p");
    expect(args.unclassifiedOnly).toBe(true);
    expect(args.json).toBe(true);
  });

  it("lists program among the accepted actions", () => {
    expect(() => parseArgs(["domains", "nope"])).toThrow(/program/);
  });

  it("rejects --project and --repo together", () => {
    expect(() => parseArgs(["domains", "program", "--project", "p", "--repo", "./repo"])).toThrow(/either --project.*or --repo/i);
  });
});

describe("runCli: domains program", () => {
  it("reports every module unclassified when layers.json is absent", async () => {
    const result = await runCli(parseArgs(["domains", "program", "--repo", root]));
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("layers.json: absent");
    expect(result.output).toContain("unclassified: 2 module(s)");
    expect(result.output).toContain("src/misc");
    expect(result.output).toContain("src/ui");
  });

  it("drops to zero once the declaration covers the repo, and --json is machine-readable", async () => {
    await mkdir(join(root, ".anatomia"), { recursive: true });
    await writeFile(
      join(root, ".anatomia", "layers.json"),
      JSON.stringify({ layers: [{ glob: "src/ui/**", layer: "presentation" }, { glob: "src/misc/**", layer: "shared" }], mergeCouplingThreshold: 1 }),
      "utf8",
    );
    const text = await runCli(parseArgs(["domains", "program", "--repo", root]));
    expect(text.exitCode).toBe(0);
    expect(text.output).toContain("unclassified: 0 module(s)");
    expect(text.output).toContain("presentation");

    const json = await runCli(parseArgs(["domains", "program", "--repo", root, "--json", "--unclassified"]));
    const payload = JSON.parse(json.output);
    expect(payload.configPresent).toBe(true);
    expect(payload.totals.unclassifiedModules).toBe(0);
    expect(payload.unclassified).toEqual([]);
    expect(payload.layers).toBeUndefined();
  });

  it("reports a present but empty declaration as zero rules", async () => {
    await writeFile(join(root, ".anatomia", "layers.json"), JSON.stringify({ layers: [], mergeCouplingThreshold: 1 }), "utf8");
    const result = await runCli(parseArgs(["domains", "program", "--repo", root]));
    expect(result.output).toContain("layers.json: 0 rule(s)");
  });
});
