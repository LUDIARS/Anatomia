/** Stream the retained Vg events; never load request payloads into a report. */
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { REQUEST_EVENT, type RequestEvent } from "./request-usage.js";

export function usageDays(from: string, to: string): string[] {
  const valid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  if (!valid(from) || !valid(to)) throw new Error("Expected UTC dates YYYY-MM-DD");
  const n = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (n < 0 || n > 30) throw new Error("Expected an inclusive range of 1 to 31 days");
  return Array.from({ length: n + 1 }, (_, i) => new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10));
}

export class UsageTotals {
  total = 0;
  malformedLines = 0;
  truncated = false;
  private readonly groups = new Map<string, RequestEvent & { count: number; errors: number }>();
  add(line: string): void {
    if (!line.trim()) return;
    let entry;
    try { entry = JSON.parse(line); } catch { this.malformedLines++; return; }
    if (entry?.msg !== REQUEST_EVENT) return;
    const e = entry.ctx;
    if (!e || !["http", "cli", "mcp"].includes(e.transport) || typeof e.operation !== "string" ||
        typeof e.caller !== "string" || !Number.isInteger(e.status) || !Number.isFinite(e.duration_ms) || e.duration_ms < 0) {
      this.malformedLines++; return;
    }
    const key = JSON.stringify([e.transport, e.operation, e.caller, e.status]);
    const old = this.groups.get(key);
    if (!old && this.groups.size >= 1000) { this.truncated = true; return; }
    this.total++;
    this.groups.set(key, { transport: e.transport, operation: e.operation, caller: e.caller, status: e.status,
      count: (old?.count ?? 0) + 1, errors: (old?.errors ?? 0) + (e.status >= 400 ? 1 : 0),
      duration_ms: (old?.duration_ms ?? 0) + e.duration_ms });
  }
  snapshot() {
    return { total: this.total, malformedLines: this.malformedLines, truncated: this.truncated,
      groups: [...this.groups.values()].sort((a, b) => b.count - a.count) };
  }
}

export async function readUsageReport(days: string[], logsDir = process.env.VESTIGIUM_LOGS_DIR ?? "logs") {
  const totals = new UsageTotals();
  const availableDays: string[] = [];
  for (const day of days) {
    usageDays(day, day); // Public boundary rejects traversal even when used outside HTTP.
    const file = join(resolve(logsDir), "anatomia", `${day}.jsonl`);
    try { await access(file); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let count = 0;
    try {
      for await (const line of lines) {
        if (++count > 100000) { totals.truncated = true; break; }
        totals.add(line);
      }
      availableDays.push(day);
    } finally { lines.close(); stream.destroy(); }
  }
  return { ...totals.snapshot(), requestedDays: days, availableDays, coverage: "retained completed-call events only" };
}
