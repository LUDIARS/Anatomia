import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileStore } from "../file-store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anatomia-cache-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createFileStore", () => {
  it("round-trips set/get with JSON values", async () => {
    const s = createFileStore<{ name: string; n: number }>(dir);
    await s.set("abc123", { name: "card", n: 7 });
    expect(await s.get("abc123")).toEqual({ name: "card", n: 7 });
  });

  it("returns undefined for a missing key", async () => {
    const s = createFileStore<number>(dir);
    expect(await s.get("missing")).toBeUndefined();
  });

  it("persists across store instances on the same dir (cross-process sharing)", async () => {
    const writer = createFileStore<string>(dir);
    await writer.set("key1", "value1");

    const reader = createFileStore<string>(dir); // fresh instance = different "process"
    expect(await reader.get("key1")).toBe("value1");
  });

  it("treats a corrupt entry as a miss (no crash)", async () => {
    const s = createFileStore<{ x: number }>(dir);
    await writeFile(join(dir, "corrupt.json"), "{ not valid json", "utf8");
    expect(await s.get("corrupt")).toBeUndefined();
  });
});
