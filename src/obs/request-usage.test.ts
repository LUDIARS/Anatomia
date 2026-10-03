import { describe, expect, it, vi } from "vitest";
import { callerLabel, observeRequest, observeToolHandlers, REQUEST_EVENT } from "./request-usage.js";
import { UsageTotals, usageDays } from "./request-usage-report.js";

describe("request observations", () => {
  it("preserves results and failures and records one completion without arguments", async () => {
    const emit = vi.fn(); let time = 0;
    expect(await observeRequest("cli", "verify", async () => ({ exit: 2 }), "Concordia", r => r.exit ? 500 : 200, emit, () => ++time)).toEqual({ exit: 2 });
    expect(emit).toHaveBeenCalledWith({ transport: "cli", operation: "verify", caller: "concordia", status: 500, duration_ms: 1 });
    const error = new Error("private payload");
    await expect(observeRequest("mcp", "where", async () => { throw error; }, undefined, undefined, emit)).rejects.toBe(error);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private payload");
    expect(await observeRequest("cli", "plan", async () => 1, undefined, undefined, () => { throw error; })).toBe(1);
  });
  it("does not guess callers and preserves handler receivers", async () => {
    expect(callerLabel("node/22")).toBe("unknown");
    expect(callerLabel(undefined)).toBe("unknown");
    const handlers = observeToolHandlers({ count: 3, async read() { return this.count; } });
    expect(await handlers.read()).toBe(3);
  });
});

describe("retained usage aggregation", () => {
  it("validates UTC dates and the bounded range", () => {
    expect(usageDays("2026-10-01", "2026-10-03")).toHaveLength(3);
    for (const [a,b] of [["2026-02-30","2026-03-01"],["2026-10-02","2026-10-01"],["2026-01-01","2026-02-01"],["../secret","../secret"]]) {
      expect(() => usageDays(a,b)).toThrow();
    }
  });
  it("ignores legacy starts, reports broken records and separates callers/statuses", () => {
    const totals = new UsageTotals();
    const line = (status: number) => JSON.stringify({ msg: REQUEST_EVENT, ctx: { transport: "http", operation: "GET /api/projects/:id/review", caller: "concordia", status, duration_ms: 10, secret: "ignored" } });
    totals.add(line(200)); totals.add(line(200)); totals.add(line(500));
    totals.add('{"msg":"anatomia cli start"}'); totals.add("broken"); totals.add("null");
    expect(totals.snapshot()).toMatchObject({ total: 3, malformedLines: 1, truncated: false });
    expect(totals.snapshot().groups[0]).toMatchObject({ count: 2, duration_ms: 20 });
    expect(JSON.stringify(totals.snapshot())).not.toContain("secret");
  });
  it("bounds distinct groups and signals incomplete counts", () => {
    const totals = new UsageTotals();
    for (let i = 0; i < 1001; i++) totals.add(JSON.stringify({ msg: REQUEST_EVENT, ctx: { transport: "cli", operation: `op${i}`, caller: "unknown", status: 200, duration_ms: 1 } }));
    expect(totals.snapshot()).toMatchObject({ total: 1000, truncated: true });
  });
});
