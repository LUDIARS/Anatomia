import { describe, expect, it, vi } from "vitest";
import { PendingWork } from "../pending-work.js";

describe("PendingWork", () => {
  it("coalesces concurrent requests but releases completed results", async () => {
    const pending = new PendingWork<number>();
    const build = vi.fn(async () => 42);
    const first = pending.run("same", build);
    expect(pending.run("same", build)).toBe(first);
    expect(await first).toBe(42);
    await pending.run("same", build);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("does not mix projects, fingerprints, or output contracts", async () => {
    const pending = new PendingWork<string>();
    const keys = [["a", "v1", "fp1"], ["b", "v1", "fp1"], ["a", "v2", "fp1"], ["a", "v1", "fp2"]];
    expect(await Promise.all(keys.map(key => pending.run(JSON.stringify(key), async () => key.join("/")))))
      .toEqual(keys.map(key => key.join("/")));
  });

  it("shares rejection and permits retry, including synchronous throws", async () => {
    const pending = new PendingWork<number>();
    const failure = new Error("analysis failed");
    const build = vi.fn(() => { throw failure; });
    const first = pending.run("same", build);
    const second = pending.run("same", build);
    const results = await Promise.allSettled([first, second]);
    expect(results).toEqual([{ status: "rejected", reason: failure }, { status: "rejected", reason: failure }]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(await pending.run("same", async () => 7)).toBe(7);
  });
});
