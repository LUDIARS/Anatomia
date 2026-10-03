/** @spec Redis analysis result cache */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedisTextStore, resolveResultRedis, type RedisTextClient } from "../redis-text-store.js";
function client(): RedisTextClient {
  return { connect: vi.fn(async () => undefined), get: vi.fn(async () => "payload"),
    set: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined), on: vi.fn(), ref: vi.fn(), unref: vi.fn() };
}
afterEach(() => vi.useRealTimers());
describe("Redis result transport", () => {
  it("shares a connection, applies TTL and releases idle process references", async () => {
    const c = client(); const factory = vi.fn(async () => c); const store = new RedisTextStore(factory, 120);
    expect(await store.get("a")).toBe("payload"); await store.set("b", "json");
    expect(factory).toHaveBeenCalledOnce(); expect(c.set).toHaveBeenCalledWith("b", "json", { EX: 120 });
    expect(c.ref).toHaveBeenCalledTimes(2); expect(c.unref).toHaveBeenCalledTimes(2);
  });
  it("times out, disposes a stuck client and reconnects on the next request", async () => {
    vi.useFakeTimers(); const a = client(); vi.mocked(a.get).mockImplementation(() => new Promise(() => {}));
    const b = client(); const factory = vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    const store = new RedisTextStore(factory, 60, 20);
    const failed = expect(store.get("a")).rejects.toThrow("unavailable"); await vi.advanceTimersByTimeAsync(21); await failed;
    expect(a.disconnect).toHaveBeenCalledOnce(); expect(await store.get("a")).toBe("payload");
  });
  it("requires explicit valid result-cache configuration", () => {
    expect(resolveResultRedis({ ANATOMIA_CACHE_REDIS: "redis://llm" })).toBeUndefined();
    expect(() => resolveResultRedis({ ANATOMIA_RESULT_CACHE_REDIS: "https://host" })).toThrow("protocol");
    expect(() => resolveResultRedis({ ANATOMIA_RESULT_CACHE_REDIS: "redis://host", ANATOMIA_RESULT_CACHE_TTL_SECONDS: "0" })).toThrow("positive integer");
  });
  it("does not execute a timed-out operation after late connection completion", async () => {
    vi.useFakeTimers(); const c = client(); let finish!: () => void;
    vi.mocked(c.connect).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const store = new RedisTextStore(async () => c, 60, 20);
    const failed = expect(store.get("late")).rejects.toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(21); await failed; finish(); await vi.advanceTimersByTimeAsync(0);
    expect(c.get).not.toHaveBeenCalled(); expect(c.disconnect).toHaveBeenCalledOnce();
  });
});
