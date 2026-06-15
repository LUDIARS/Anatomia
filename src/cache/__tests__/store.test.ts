import { describe, it, expect } from "vitest";
import { createMemoryStore, versionedKey } from "../store.js";

describe("createMemoryStore", () => {
  it("round-trips set/get", async () => {
    const s = createMemoryStore<{ n: number }>();
    await s.set("k", { n: 1 });
    expect(await s.get("k")).toEqual({ n: 1 });
  });

  it("returns undefined for a missing key", async () => {
    const s = createMemoryStore<number>();
    expect(await s.get("nope")).toBeUndefined();
  });
});

describe("versionedKey", () => {
  it("is deterministic", () => {
    expect(versionedKey("content", "model", "1")).toBe(versionedKey("content", "model", "1"));
  });

  it("changes with model id", () => {
    expect(versionedKey("c", "model-a", "1")).not.toBe(versionedKey("c", "model-b", "1"));
  });

  it("changes with template version", () => {
    expect(versionedKey("c", "m", "1")).not.toBe(versionedKey("c", "m", "2"));
  });

  it("changes with content", () => {
    expect(versionedKey("c1", "m", "1")).not.toBe(versionedKey("c2", "m", "1"));
  });

  it("produces a filesystem-safe sha256 hex digest", () => {
    expect(versionedKey("c", "m", "1")).toMatch(/^[0-9a-f]{64}$/);
  });
});
