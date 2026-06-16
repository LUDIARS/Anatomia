/**
 * cache-stats CLI subcommand — parseArgs + runCli over a JSONL transcript.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, runCli } from "../cli.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anatomia-cli-cs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env["ANATOMIA_CACHE_LOG"];
});

const LINES = [
  '{"kind":"get","ts":1,"session":"s1","ns":"card","hit":false,"key":"a"}',
  '{"kind":"get","ts":2,"session":"s1","ns":"card","hit":true,"key":"a"}',
  '{"kind":"llm","ts":3,"session":"s1","model":"m","usage":{"inputTokens":50,"outputTokens":10,"cacheReadTokens":0,"cacheCreationTokens":0}}',
].join("\n");

describe("cache-stats CLI", () => {
  it("parses --log and --json", () => {
    const args = parseArgs(["cache-stats", "--log", "/tmp/x.jsonl", "--json"]);
    expect(args.subcommand).toBe("cache-stats");
    expect(args.logPath).toBe("/tmp/x.jsonl");
    expect(args.json).toBe(true);
  });

  it("reports a hit rate from --log (JSON)", async () => {
    const path = join(dir, "c.jsonl");
    await writeFile(path, LINES, "utf8");
    const { exitCode, output } = await runCli(parseArgs(["cache-stats", "--log", path, "--json"]));
    expect(exitCode).toBe(0);
    const report = JSON.parse(output);
    expect(report.global).toMatchObject({ gets: 2, hits: 1, misses: 1, hitRate: 0.5 });
    expect(report.llmCalls).toBe(1);
    expect(report.estimatedCallsSaved).toBe(1);
  });

  it("falls back to ANATOMIA_CACHE_LOG and prints a human report", async () => {
    const path = join(dir, "env.jsonl");
    await writeFile(path, LINES, "utf8");
    process.env["ANATOMIA_CACHE_LOG"] = path;
    const { exitCode, output } = await runCli(parseArgs(["cache-stats"]));
    expect(exitCode).toBe(0);
    expect(output).toContain("GLOBAL");
    expect(output).toContain("50.0%");
  });

  it("errors clearly when no transcript is configured", async () => {
    const { exitCode, output } = await runCli(parseArgs(["cache-stats"]));
    expect(exitCode).toBe(1);
    expect(output).toContain("ANATOMIA_CACHE_LOG");
  });
});
