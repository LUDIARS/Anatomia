/**
 * GET /api/cache-stats — global LLM-cache hit-rate route.
 *
 * Reports { enabled:false } with no ANATOMIA_CACHE_LOG, and an aggregated report
 * (read from the JSONL transcript) when the env var points at one.
 */
import { describe, it, expect, beforeAll, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildFromSource } from "../../supply/__tests__/helpers.js";
import { createApp } from "../web/server.js";
import type { AnalysisContext } from "../../core.js";
import type { Hono } from "hono";

let app: Hono;
let dir: string;

beforeAll(async () => {
  const { graph, file, functions } = await buildFromSource("void a(){}");
  const ctx: AnalysisContext = {
    repoPath: "/fixture",
    graph,
    files: [file],
    functions,
    domains: [],
    links: [],
    specClauses: [],
  };
  app = createApp(ctx);
  dir = await mkdtemp(join(tmpdir(), "anatomia-web-cache-"));
});

// Save/restore the env var rather than blind-delete, so this file never clears
// a value another test file in the same worker process may have set.
let priorLog: string | undefined;
beforeEach(() => {
  priorLog = process.env["ANATOMIA_CACHE_LOG"];
});
afterEach(() => {
  if (priorLog === undefined) delete process.env["ANATOMIA_CACHE_LOG"];
  else process.env["ANATOMIA_CACHE_LOG"] = priorLog;
});

describe("GET /api/cache-stats", () => {
  it("reports enabled:false when ANATOMIA_CACHE_LOG is unset", async () => {
    delete process.env["ANATOMIA_CACHE_LOG"]; // deterministic regardless of prior state
    const res = await app.fetch(new Request("http://x/api/cache-stats"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });

  it("aggregates the transcript when ANATOMIA_CACHE_LOG is set", async () => {
    const path = join(dir, "c.jsonl");
    await writeFile(
      path,
      [
        '{"kind":"get","ts":1,"session":"s1","ns":"card","hit":false,"key":"a"}',
        '{"kind":"get","ts":2,"session":"s1","ns":"card","hit":true,"key":"a"}',
      ].join("\n"),
      "utf8",
    );
    process.env["ANATOMIA_CACHE_LOG"] = path;
    const res = await app.fetch(new Request("http://x/api/cache-stats"));
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.logPath).toBe(path);
    expect(body.report.global).toMatchObject({ gets: 2, hits: 1, hitRate: 0.5 });
  });
});
