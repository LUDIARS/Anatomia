/**
 * Ratified-link persistence (spec/persist.ts) + the analyze() merge path:
 * roundtrip (ratified-only, deterministic order, missing file = initial
 * state), fail-fast on a malformed committed artifact, and merge priority —
 * a persisted ratified link must win the (from,to) dedup against the
 * heuristic linkers' proposal in analyze() Phase 5.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { AnchorId, Link } from "../types.js";
import { loadRatifiedLinks, saveRatifiedLinks, specLinksPath } from "./persist.js";
import { ratifyLink, SpecLinkRatifyError } from "./ratify.js";
import { analyze } from "../core.js";

const link = (from: string, to: string, over: Partial<Link> = {}): Link => ({
  from: from as unknown as AnchorId,
  to,
  confidence: 1.0,
  evidence: "explicit",
  ratified: true,
  ...over,
});

describe("loadRatifiedLinks / saveRatifiedLinks", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "anatomia-speclinks-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns the initial empty state when the file does not exist", async () => {
    expect(await loadRatifiedLinks(root)).toEqual([]);
  });

  it("roundtrips ratified links, dropping non-ratified proposals", async () => {
    const path = await saveRatifiedLinks(root, [
      link("/r/b.ts", "clause-b"),
      link("/r/a.ts", "clause-a"),
      link("/r/c.ts", "clause-c", { ratified: false, evidence: "structural", confidence: 0.5 }),
    ]);
    expect(path).toBe(specLinksPath(root));
    const loaded = await loadRatifiedLinks(root);
    // Ratified only, sorted by (from, to) for clean committed diffs.
    expect(loaded.map((l) => String(l.from))).toEqual(["/r/a.ts", "/r/b.ts"]);
    expect(loaded.every((l) => l.ratified)).toBe(true);
  });

  it("throws on a malformed committed artifact (fail-fast, no silent ignore)", async () => {
    const path = specLinksPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 99, nope: true }), "utf8");
    await expect(loadRatifiedLinks(root)).rejects.toThrow(/unsupported or malformed/);
  });
});

describe("analyze merges persisted ratified links (Phase 5)", () => {
  let root: string;
  let codePath: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "anatomia-ratify-merge-"));
    codePath = join(root, "hash.ts");
    await writeFile(codePath, "export function hashThing() { return 1; }\n");
    // No basename reference / no annotation → the only proposal is structural
    // (keyword overlap), so the ratification promotion is observable.
    await writeFile(join(root, "spec.md"), "# Hash\nHashing rules live here.\n");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("ratified link wins the (from,to) dedup against the heuristic proposal", async () => {
    const first = await analyze(root, { quiet: true });
    // Pick a structural (non-1.0-explicit) proposal to ratify.
    const proposal = first.links!.find((l) => l.evidence === "structural");
    expect(proposal).toBeDefined();

    const { wasProposed } = await ratifyLink({
      repoRoot: root,
      from: String(proposal!.from),
      to: proposal!.to,
      links: first.links!,
      specClauses: first.specClauses!,
    });
    expect(wasProposed).toBe(true);

    const second = await analyze(root, { quiet: true });
    const merged = second.links!.filter(
      (l) => l.from === proposal!.from && l.to === proposal!.to,
    );
    // Exactly one link per (from,to) after the merge — the ratified one.
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ evidence: "explicit", confidence: 1.0, ratified: true });
  });

  it("ratifyLink rejects an unknown clause id (fail-fast)", async () => {
    const ctx = await analyze(root, { quiet: true });
    await expect(
      ratifyLink({
        repoRoot: root,
        from: codePath,
        to: "no-such-clause-00000000",
        links: ctx.links!,
        specClauses: ctx.specClauses!,
      }),
    ).rejects.toThrow(SpecLinkRatifyError);
    // Nothing persisted on failure.
    expect(await loadRatifiedLinks(root)).toEqual([]);
  });

  it("ratifyLink records a fresh explicit decree for an unproposed pair", async () => {
    const ctx = await analyze(root, { quiet: true });
    const clauseId = ctx.specClauses![0]!.id;
    const from = "unproposed-anchor";
    const result = await ratifyLink({
      repoRoot: root,
      from,
      to: clauseId,
      links: (ctx.links ?? []).filter((l) => String(l.from) !== from),
      specClauses: ctx.specClauses!,
    });
    expect(result.wasProposed).toBe(false);
    const persisted = await loadRatifiedLinks(root);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      from,
      to: clauseId,
      evidence: "explicit",
      confidence: 1.0,
      ratified: true,
    });
    // The artifact is committed JSON — verify the on-disk shape is versioned.
    const raw = JSON.parse(await readFile(specLinksPath(root), "utf8")) as { version: number };
    expect(raw.version).toBe(1);
  });
});
