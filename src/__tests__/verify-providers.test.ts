/**
 * buildVerdict provider wiring (A-1 / A-2).
 *
 * Proves the production path: when providers are injected, buildVerdict distils
 * the detected domains into cards (via providers.llm) and runs the duplication
 * gate against the real embedder — so reinventing a domain is actually flagged.
 * The default (no providers) path stays mock (duplication passes), keeping the
 * adapter/test surface hermetic.
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyze, buildVerdict } from "../core.js";
import type { Providers } from "../providers/index.js";
import type { AnchorId } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "mini");

const DIFF = `
  void reinventState(int kind) {
    int total = 0;
    for (int i = 0; i < kind; ++i) total += i;
  }
`;

describe("buildVerdict — provider wiring", () => {
  it("default (no providers) keeps duplication passing via the zero-vector mock", async () => {
    const ctx = await analyze(FIXTURE, { quiet: true });
    const v = await buildVerdict(ctx, DIFF);
    expect(v.gates.length).toBe(5);
    expect(v.gates.find((g) => g.gate === "duplication")?.pass).toBe(true);
  });

  it("with providers, distils domain cards and flags duplication via the real embedder", async () => {
    const ctx = await analyze(FIXTURE, { quiet: true });
    const anchor = ctx.functions.find((f) => f.id !== null)!.id as AnchorId;
    // One synthetic domain with a real implementor so card distillation has a
    // node to summarise.
    ctx.domains = [
      { domain: "state-machine", implementors: [anchor], violations: [], conforms: true },
    ];

    let llmCalls = 0;
    const providers: Providers = {
      llm: async () => {
        llmCalls++;
        return JSON.stringify({
          summary: "state machine domain",
          rules: ["mutate only via transition"],
          specRefs: [],
          complexity: "low",
        });
      },
      // Identical vectors → cosine 1 ≥ threshold → duplication must fail.
      embed: async (texts) => texts.map(() => [1, 0, 0]),
      llmModelId: "fake-model",
      describe: () => "fake",
    };

    const v = await buildVerdict(ctx, DIFF, undefined, { providers });
    const dup = v.gates.find((g) => g.gate === "duplication");
    expect(dup?.pass).toBe(false);
    expect(dup?.suggestion).toContain("state-machine");
    expect(llmCalls).toBeGreaterThan(0);
    expect(v.gates.length).toBe(5);
  });
});
