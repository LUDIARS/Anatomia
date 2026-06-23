import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState, recordPass, shouldHaltForHuman } from "./state.js";
import { emptyTaxonomy, findOrCreateDomain, findOrCreateModule, addDir } from "./taxonomy-ops.js";

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "retune-state-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("retune state", () => {
  it("loads an empty state for a fresh repo", async () => {
    const s = await loadState(repo, "p");
    expect(s.iterations).toBe(0);
    expect(s.history).toEqual([]);
  });

  it("records a pass and persists across load", async () => {
    const t = emptyTaxonomy("p");
    const d = findOrCreateDomain(t, "graph", "g");
    addDir(findOrCreateModule(d, "core", ""), "src/graph");
    let s = await loadState(repo, "p");
    s = recordPass(s, t, "2026-06-22T00:00:00Z");
    await saveState(repo, s);
    const again = await loadState(repo, "p");
    expect(again.iterations).toBe(1);
    expect(again.lastRunAt).toBe("2026-06-22T00:00:00Z");
    expect(again.history[0]).toMatchObject({ iteration: 1, domains: 1, modules: 1 });
  });

  it("halts for human after the configured number of passes", () => {
    expect(shouldHaltForHuman({ version: 1, project: "p", iterations: 1, history: [] })).toBe(false);
    expect(shouldHaltForHuman({ version: 1, project: "p", iterations: 2, history: [] })).toBe(true);
  });

  it("ignores state from a different project", async () => {
    let s = await loadState(repo, "p");
    s = recordPass(s, emptyTaxonomy("p"));
    await saveState(repo, s);
    const other = await loadState(repo, "other");
    expect(other.iterations).toBe(0);
  });
});
