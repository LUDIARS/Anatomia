/**
 * MCP provider wiring (A-1): createHandlers(src, providers) must thread the
 * injected providers into anatomia.verify so the duplication gate runs against
 * the real embedder + distilled cards. Without providers it stays mock.
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyze } from "../../core.js";
import { createHandlers } from "../mcp.js";
import type { Providers } from "../../providers/index.js";
import type { AnchorId } from "../../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "..", "__tests__", "fixtures", "mini");

const DIFF = "void f(int n){int t=0;for(int i=0;i<n;++i)t+=i;}";

describe("anatomia.verify — provider wiring", () => {
  it("uses injected providers (cards + real embedder) to flag duplication", async () => {
    const ctx = await analyze(FIXTURE, { quiet: true });
    const anchor = ctx.functions.find((f) => f.id !== null)!.id as AnchorId;
    ctx.domains = [
      { domain: "state-machine", implementors: [anchor], violations: [], conforms: true },
    ];

    const providers: Providers = {
      llm: async () =>
        JSON.stringify({ summary: "s", rules: [], specRefs: [], complexity: "low" }),
      embed: async (texts) => texts.map(() => [1, 0, 0]),
      llmModelId: "fake-model",
      embedModelId: "fake-embed",
      describe: () => "fake",
    };

    const withProviders = createHandlers(ctx, providers);
    const v1 = await withProviders["anatomia.verify"]({ diff: DIFF });
    expect(v1.gates.find((g) => g.gate === "duplication")?.pass).toBe(false);

    const noProviders = createHandlers(ctx);
    const v2 = await noProviders["anatomia.verify"]({ diff: DIFF });
    expect(v2.gates.find((g) => g.gate === "duplication")?.pass).toBe(true);
  });
});
