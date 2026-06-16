/**
 * MCP cache observability (A-3 measurement): when createHandlers receives a
 * CacheObservability, the card cache records a miss on the first verify and a
 * hit on the second (the card is content-keyed and reused across calls).
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyze } from "../../core.js";
import { createHandlers } from "../mcp.js";
import type { Providers } from "../../providers/index.js";
import type { CacheEvent, CacheTranscript } from "../../cache/transcript.js";
import type { AnchorId } from "../../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "..", "__tests__", "fixtures", "mini");
const DIFF = "void f(int n){int t=0;for(int i=0;i<n;++i)t+=i;}";

describe("createHandlers — cache observability", () => {
  it("records a card miss then a hit across two verify calls", async () => {
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
      describe: () => "fake",
    };

    const events: CacheEvent[] = [];
    const transcript: CacheTranscript = {
      record: (e) => events.push(e),
      flush: async () => undefined,
    };

    const h = createHandlers(ctx, providers, { transcript, session: "sess", model: "fake-model" });
    await h["anatomia.verify"]({ diff: DIFF });
    await h["anatomia.verify"]({ diff: DIFF });

    const cardGets = events.filter((e) => e.kind === "get" && e.ns === "card");
    expect(cardGets.length).toBeGreaterThanOrEqual(2);
    expect(cardGets[0]).toMatchObject({ hit: false, session: "sess" }); // first: miss
    expect(cardGets.some((e) => e.kind === "get" && e.hit === true)).toBe(true); // later: hit
  });

  it("records nothing when no observability is passed", async () => {
    const ctx = await analyze(FIXTURE, { quiet: true });
    const h = createHandlers(ctx); // no providers, no obs
    const v = await h["anatomia.verify"]({ diff: DIFF });
    expect(v).toBeDefined(); // runs fine, just unmeasured
  });
});
