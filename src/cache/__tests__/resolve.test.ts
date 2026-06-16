/**
 * resolveCacheStore — backend precedence Redis > File > memory.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCacheStore, describeCacheBackend } from "../resolve.js";

let dir: string;
const KEYS = ["ANATOMIA_CACHE_REDIS", "ANATOMIA_CACHE_DIR", "ANATOMIA_CACHE_REDIS_TTL"];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anatomia-resolve-"));
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe("resolveCacheStore", () => {
  it("defaults to an in-memory store (round-trips in process)", async () => {
    const s = resolveCacheStore<number>();
    await s.set("k", 1);
    expect(await s.get("k")).toBe(1);
    expect(describeCacheBackend()).toBe("memory");
  });

  it("uses a file store when ANATOMIA_CACHE_DIR is set (persists to disk)", async () => {
    process.env["ANATOMIA_CACHE_DIR"] = dir;
    const s = resolveCacheStore<string>();
    await s.set("k", "v");
    expect((await readdir(dir)).length).toBeGreaterThan(0); // a file was written
    expect(describeCacheBackend()).toContain("file");
  });

  it("prefers Redis over File when both are set (no file written; degrades to miss without a server)", async () => {
    process.env["ANATOMIA_CACHE_REDIS"] = "redis://127.0.0.1:6390"; // unlikely to be up
    process.env["ANATOMIA_CACHE_DIR"] = dir;
    const s = resolveCacheStore<number>();
    await s.set("k", 1); // would write a file if the file store were chosen
    expect(await readdir(dir)).toEqual([]); // nothing on disk => redis backend was chosen
    expect(await s.get("k")).toBeUndefined(); // no redis server => graceful miss
    expect(describeCacheBackend()).toContain("redis");
  });
});
