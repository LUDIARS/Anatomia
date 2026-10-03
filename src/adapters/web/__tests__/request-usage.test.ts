import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ record: vi.fn(), read: vi.fn() }));
vi.mock("../../../obs/request-usage.js", async importOriginal => ({ ...await importOriginal<object>(), recordRequest: mocks.record }));
vi.mock("../../../obs/request-usage-report.js", async importOriginal => ({ ...await importOriginal<object>(), readUsageReport: mocks.read }));
import { mountRequestUsage } from "../request-usage.js";
beforeEach(() => { vi.clearAllMocks(); mocks.read.mockResolvedValue({ total: 0 }); });
describe("HTTP usage", () => {
  it("records templates and caller without URL/body secrets, including 404/500", async () => {
    const app = new Hono(); mountRequestUsage(app);
    app.get("/api/projects/:id/review", c => c.json({ ok: true }));
    app.get("/error", () => { throw new Error("private"); }); app.onError((_e,c) => c.json({ error: true },500));
    await app.request("/api/projects/private/review?token=secret", { headers: { "X-Anatomia-Caller": "concordia", Authorization: "Bearer private" } });
    expect(mocks.record.mock.calls[0][0]).toMatchObject({ operation: "GET /api/projects/:id/review", caller: "concordia", status: 200 });
    await app.request("/private-missing"); await app.request("/error");
    expect(mocks.record.mock.calls.map(x => x[0].status)).toEqual([200,404,500]);
    expect(JSON.stringify(mocks.record.mock.calls)).not.toMatch(/secret|private/);
  });
  it("excludes observer requests, validates ranges and surfaces read failures", async () => {
    const app = new Hono(); mountRequestUsage(app);
    expect((await app.request("/api/request-usage?from=2026-10-01&to=2026-10-03")).status).toBe(200);
    expect(mocks.read).toHaveBeenCalledWith(["2026-10-01","2026-10-02","2026-10-03"]);
    expect((await app.request("/api/request-usage?from=bad")).status).toBe(400);
    mocks.read.mockRejectedValue(new Error("private path"));
    const r = await app.request("/api/request-usage"); expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("private"); expect(mocks.record).not.toHaveBeenCalled();
  });
});
