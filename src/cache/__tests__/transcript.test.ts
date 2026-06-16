/**
 * Transcript JSONL writer/reader + env/session resolution.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJsonlTranscript,
  createNullTranscript,
  readEvents,
  resolveSessionId,
  resolveTranscript,
} from "../transcript.js";
import type { CacheEvent } from "../transcript.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anatomia-tx-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env["ANATOMIA_CACHE_LOG"];
  delete process.env["ANATOMIA_SESSION_ID"];
});

describe("JSONL transcript", () => {
  it("appends events and reads them back", async () => {
    const path = join(dir, "cache.jsonl");
    const tx = createJsonlTranscript(path);
    const ev: CacheEvent = { kind: "get", ts: 1, session: "s", ns: "card", hit: true, key: "k" };
    tx.record(ev);
    tx.record({ kind: "llm", ts: 2, session: "s", model: "m", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } });
    await tx.flush();

    const events = await readEvents(path);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "get", hit: true, ns: "card" });
    expect(events[1]).toMatchObject({ kind: "llm", model: "m" });
  });

  it("readEvents skips blank and malformed lines, never throws", async () => {
    const path = join(dir, "mixed.jsonl");
    await writeFile(path, '{"kind":"get","ts":1,"session":"s","ns":"card","hit":false,"key":"k"}\n\n{ broken json\n{"kind":"other"}\n', "utf8");
    const events = await readEvents(path);
    expect(events).toHaveLength(1); // only the valid get; unknown-kind + broken dropped
    expect(events[0].kind).toBe("get");
  });

  it("readEvents on a missing file returns []", async () => {
    expect(await readEvents(join(dir, "nope.jsonl"))).toEqual([]);
  });

  it("null transcript is a no-op", async () => {
    const tx = createNullTranscript();
    tx.record({ kind: "get", ts: 1, session: "s", ns: "card", hit: true, key: "k" });
    await tx.flush(); // must not throw
  });
});

describe("session + transcript resolution", () => {
  it("resolveSessionId honours ANATOMIA_SESSION_ID", () => {
    process.env["ANATOMIA_SESSION_ID"] = "lictor-abc";
    expect(resolveSessionId()).toBe("lictor-abc");
  });

  it("resolveSessionId derives a stable per-process id when unset", () => {
    const id = resolveSessionId();
    expect(id).toMatch(/^\d+-/); // pid-prefixed
  });

  it("resolveTranscript is disabled without ANATOMIA_CACHE_LOG", () => {
    const r = resolveTranscript();
    expect(r.enabled).toBe(false);
  });

  it("resolveTranscript enabled + writes when ANATOMIA_CACHE_LOG is set", async () => {
    const path = join(dir, "env.jsonl");
    process.env["ANATOMIA_CACHE_LOG"] = path;
    const r = resolveTranscript();
    expect(r.enabled).toBe(true);
    r.transcript.record({ kind: "get", ts: 1, session: r.session, ns: "card", hit: false, key: "k" });
    await r.transcript.flush();
    expect(await readEvents(path)).toHaveLength(1);
  });

  it("concurrent appends from two transcripts on the same file do not interleave", async () => {
    const path = join(dir, "concurrent.jsonl");
    const a = createJsonlTranscript(path);
    const b = createJsonlTranscript(path);
    for (let i = 0; i < 20; i++) {
      a.record({ kind: "get", ts: i, session: "a", ns: "card", hit: true, key: `a${i}` });
      b.record({ kind: "get", ts: i, session: "b", ns: "card", hit: false, key: `b${i}` });
    }
    await Promise.all([a.flush(), b.flush()]);
    const events = await readEvents(path);
    expect(events).toHaveLength(40); // every line parses = no interleaving
  });
});
