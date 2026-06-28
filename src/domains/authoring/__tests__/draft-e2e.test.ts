/**
 * Domain-draft synthesis, end-to-end with the LLM seam un-mocked at every layer
 * EXCEPT the model call itself (hermetic: no real LLM / network — RULE per
 * CLAUDE.md). The existing authoring tests cover draft→def shaping, the disk
 * roundtrip, and reconcile in isolation; this wires the spec→draft *synthesis*
 * path — prompt assembly → (injected) LLM → lenient parse → reconcile → disk
 * roundtrip — which had no coverage (the gap behind #364's "実 LLM 抽出未検証").
 *
 * A real-LLM run is a manual step (see spec/feature/domain-authoring.md runbook);
 * this locks the wiring around it so the only variable in that run is model
 * output quality, not plumbing.
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpecClause } from "../../../types.js";
import type { LLMClient } from "../../card.js";
import type { CacheStore } from "../../../cache/store.js";
import type { DomainDraft } from "../types.js";
import { synthesizeDomainDrafts, assembleDraftPrompt } from "../draft.js";
import { reconcileDrafts } from "../reconcile.js";
import { saveEditableDomains, loadEditableDomains } from "../store.js";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "anatomia-draft-e2e-"));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const CLAUSES: SpecClause[] = [
  { id: "c1", sourceFile: "spec/combat.md", heading: "Combat / Damage", text: "Damage is dealt on hit.", embedding: null },
  { id: "c2", sourceFile: "spec/combat.md", heading: "Combat / Knockback", text: "Hits apply knockback.", embedding: null },
  { id: "c3", sourceFile: "spec/move.md", heading: "Movement / Speed", text: "Actors move at a speed.", embedding: null },
];
const FILES = ["/repo/src/combat/hit.cpp", "/repo/src/combat/dmg.cpp", "/repo/src/movement/move.cpp"];
const INPUTS = { specClauses: CLAUSES, filePaths: FILES };

/** A realistic model reply: JSON wrapped in prose (exercises parseDrafts leniency). */
const LLM_REPLY = `Here are the domains I propose:
[
  { "name": "combat", "description": "fighting", "pathPatterns": ["/combat/"],
    "namePatterns": [], "specRefs": ["Combat / Damage"], "mechanics": ["damage", "knockback"],
    "rationale": "files under combat/" },
  { "name": "movement", "description": "moving actors", "pathPatterns": ["/movement/"],
    "namePatterns": [], "specRefs": ["Movement / Speed"], "mechanics": [], "rationale": "movement/" }
]
That should be a coarse start.`;

function memoryCache(): CacheStore<DomainDraft[]> {
  const m = new Map<string, DomainDraft[]>();
  return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); } };
}

describe("domain draft synthesis e2e", () => {
  it("feeds the spec + module map to the LLM and parses mechanics out", async () => {
    let seenPrompt = "";
    const llm: LLMClient = async (prompt) => { seenPrompt = prompt; return LLM_REPLY; };

    const drafts = await synthesizeDomainDrafts(INPUTS, llm);

    // The prompt actually carried the spec headings + the module map (the inputs
    // a real run depends on), not an empty shell.
    expect(seenPrompt).toBe(assembleDraftPrompt(INPUTS));
    expect(seenPrompt).toContain("Combat / Damage");
    expect(seenPrompt).toContain("/repo/src/combat");

    expect(drafts.map((d) => d.name)).toEqual(["combat", "movement"]); // sorted
    expect(drafts.find((d) => d.name === "combat")!.mechanics).toEqual(["damage", "knockback"]);
  });

  it("content-keyed cache skips the second call on unchanged inputs", async () => {
    let calls = 0;
    const llm: LLMClient = async () => { calls++; return LLM_REPLY; };
    const cache = memoryCache();

    await synthesizeDomainDrafts(INPUTS, llm, cache);
    await synthesizeDomainDrafts(INPUTS, llm, cache);
    expect(calls).toBe(1); // second call served from cache
  });

  it("synthesised mechanics survive reconcile + disk roundtrip", async () => {
    const llm: LLMClient = async () => LLM_REPLY;
    const drafts = await synthesizeDomainDrafts(INPUTS, llm);

    const reconciled = reconcileDrafts([], drafts);
    expect(reconciled.added.sort()).toEqual(["combat", "movement"]);

    const dir = await tempDir();
    await saveEditableDomains(dir, reconciled.merged);
    const back = await loadEditableDomains(dir);

    const combat = back.find((d) => d.name === "combat")!;
    expect(combat.mechanics).toEqual(["damage", "knockback"]);
  });

  it("a prose-only (no JSON) reply yields zero drafts, not a throw", async () => {
    const llm: LLMClient = async () => "I could not determine any domains.";
    const drafts = await synthesizeDomainDrafts(INPUTS, llm);
    expect(drafts).toEqual([]);
  });
});
