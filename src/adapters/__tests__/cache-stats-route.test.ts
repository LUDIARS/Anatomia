/**
 * GET /api/cache-stats — per-session view + cost estimate, exercised via
 * app.fetch() against a transcript written to a temp ANATOMIA_CACHE_LOG.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFromSource } from "../../supply/__tests__/helpers.js";
import { createApp } from "../web/server.js";
import type { AnalysisContext } from "../../core.js";
import type { Hono } from "hono";

let app: Hono;
let dir: string;
const prevLog = process.env["ANATOMIA_CACHE_LOG"];

beforeAll(async () => {
  const { graph, file, functions } = await buildFromSource("void a(){}");
  const ctx: AnalysisContext = {
    repoPath: "/fixture", graph, files: [file], functions,
    domains: [], links: [], specClauses: [],
  };
  app = createApp(ctx);

  dir = await mkdtemp(join(tmpdir(), "anatomia-cachestats-"));
  const log = join(dir, "cache.jsonl");
  // Session S1: 2 hits, 1 miss. Session S2: 1 miss.
  const lines = [
    { kind: "get", ts: 1, session: "S1", ns: "card", hit: true, key: "a" },
    { kind: "get", ts: 2, session: "S1", ns: "card", hit: true, key: "b" },
    { kind: "get", ts: 3, session: "S1", ns: "card", hit: false, key: "c" },
    { kind: "get", ts: 4, session: "S2", ns: "card", hit: false, key: "d" },
  ];
  await writeFile(log, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  process.env["ANATOMIA_CACHE_LOG"] = log;
});

afterAll(async () => {
  if (prevLog === undefined) delete process.env["ANATOMIA_CACHE_LOG"];
  else process.env["ANATOMIA_CACHE_LOG"] = prevLog;
  await rm(dir, { recursive: true, force: true });
});

describe("GET /api/cache-stats", () => {
  it("returns the per-session slice and a cost estimate for ?session=", async () => {
    const res = await app.fetch(new Request("http://x/api/cache-stats?session=S1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.report.global.gets).toBe(4);
    // S1's own slice: 2/3 hit
    expect(body.session.id).toBe("S1");
    expect(body.session.tally.hits).toBe(2);
    expect(body.session.tally.gets).toBe(3);
    // assumed-basis cost (no real LLM events): 1 miss × $0.0175
    expect(body.session.cost.basis).toBe("assumed");
    expect(body.session.cost.spentUsd).toBeCloseTo(0.0175, 6);
    expect(body.session.cost.savedUsd).toBeCloseTo(0.035, 6); // 2 hits
  });

  it("omits the session view when no ?session= is given but still returns global cost", async () => {
    const res = await app.fetch(new Request("http://x/api/cache-stats"));
    const body = await res.json();
    expect(body.session).toBeUndefined();
    expect(body.cost.projectedUsd).toBeCloseTo(0.07, 6); // 4 gets × $0.0175
  });
});
