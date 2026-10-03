/** HTTP boundary: route templates and explicit caller labels, never URLs or bodies. */
import type { Hono } from "hono";
import { callerLabel, recordRequest } from "../../obs/request-usage.js";
import { readUsageReport, usageDays } from "../../obs/request-usage-report.js";
import { vgEnabled } from "../../obs/vestigium.js";

export function mountRequestUsage(app: Hono): void {
  app.use("*", async (c, next) => {
    if (c.req.path === "/api/request-usage") { await next(); return; }
    const start = performance.now();
    let failed = false;
    try { await next(); } catch (error) { failed = true; throw error; }
    finally {
      recordRequest({ transport: "http", operation: `${c.req.method} ${c.req.routePath === "*" ? "unmatched" : c.req.routePath}`,
        caller: callerLabel(c.req.header("X-Anatomia-Caller")), status: failed ? 500 : c.res.status,
        duration_ms: performance.now() - start });
    }
  });
  app.get("/api/request-usage", async (c) => {
    const today = new Date().toISOString().slice(0, 10);
    let days: string[];
    try { days = usageDays(c.req.query("from") ?? today, c.req.query("to") ?? today); }
    catch { return c.json({ error: "Use an inclusive UTC date range of 1 to 31 days (YYYY-MM-DD)" }, 400); }
    try { return c.json({ loggingEnabled: vgEnabled(), ...await readUsageReport(days) }); }
    catch { return c.json({ error: "Request log could not be read" }, 503); }
  });
}
