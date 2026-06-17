/**
 * cost feed store — memory + JSONL append/read, bad-line skip, env resolution.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryCostFeed,
  createJsonlCostFeed,
  readCostEntries,
  getCostFeed,
  _resetCostFeed,
  type CostFeedEntry,
} from "../feed.js";

function entry(p: Partial<CostFeedEntry> = {}): CostFeedEntry {
  return {
    ts: 1,
    service: "discutere",
    sessionId: "S1",
    calls: 1,
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 100,
    cacheCreationTokens: 20,
    costUsd: 0.01,
    ...p,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anatomia-cost-"));
  _resetCostFeed();
  delete process.env["ANATOMIA_COST_LOG"];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  _resetCostFeed();
  delete process.env["ANATOMIA_COST_LOG"];
});

describe("cost feed", () => {
  it("memory feed records and reads", async () => {
    const feed = createMemoryCostFeed();
    feed.record(entry({ sessionId: "A" }));
    feed.record(entry({ sessionId: "B" }));
    const all = await feed.read();
    expect(all.map((e) => e.sessionId)).toEqual(["A", "B"]);
  });

  it("jsonl feed appends and reads back", async () => {
    const path = join(dir, "cost.jsonl");
    const feed = createJsonlCostFeed(path);
    feed.record(entry({ sessionId: "A", costUsd: 0.02 }));
    feed.record(entry({ sessionId: "B", costUsd: 0.03 }));
    await feed.flush();
    const all = await feed.read();
    expect(all).toHaveLength(2);
    expect(all[1].costUsd).toBe(0.03);
  });

  it("readCostEntries skips blank/unparseable lines and rows missing keys", async () => {
    const path = join(dir, "mixed.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify(entry({ sessionId: "ok" })),
        "",
        "{ not json",
        JSON.stringify({ service: "x" }), // missing sessionId → skipped
        JSON.stringify(entry({ sessionId: "ok2" })),
      ].join("\n"),
      "utf8",
    );
    const all = await readCostEntries(path);
    expect(all.map((e) => e.sessionId)).toEqual(["ok", "ok2"]);
  });

  it("readCostEntries returns [] for a missing file", async () => {
    expect(await readCostEntries(join(dir, "nope.jsonl"))).toEqual([]);
  });

  it("getCostFeed uses JSONL when ANATOMIA_COST_LOG is set, memory otherwise", async () => {
    const memFeed = getCostFeed();
    memFeed.record(entry({ sessionId: "mem" }));
    expect((await memFeed.read()).length).toBe(1);

    _resetCostFeed();
    const path = join(dir, "env.jsonl");
    process.env["ANATOMIA_COST_LOG"] = path;
    const fileFeed = getCostFeed();
    fileFeed.record(entry({ sessionId: "file" }));
    await fileFeed.flush();
    const persisted = await readCostEntries(path);
    expect(persisted.map((e) => e.sessionId)).toEqual(["file"]);
  });
});
