/**
 * createRedisStore — round-trips via an injected client, namespaces keys, and
 * degrades to a cache miss (never throws) when the client errors or is absent.
 */
import { describe, it, expect } from "vitest";
import { createRedisStore, type RedisLike } from "../redis-store.js";

function fakeRedis(): { client: RedisLike; map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    client: {
      async get(key) { return map.has(key) ? map.get(key)! : null; },
      async set(key, value) { map.set(key, value); return "OK"; },
    },
  };
}

describe("createRedisStore", () => {
  it("round-trips set/get with JSON values through the injected client", async () => {
    const { client } = fakeRedis();
    const s = createRedisStore<{ n: number; s: string }>({ client });
    await s.set("k1", { n: 7, s: "card" });
    expect(await s.get("k1")).toEqual({ n: 7, s: "card" });
  });

  it("returns undefined for a missing key", async () => {
    const s = createRedisStore<number>({ client: fakeRedis().client });
    expect(await s.get("nope")).toBeUndefined();
  });

  it("namespaces keys with the prefix", async () => {
    const { client, map } = fakeRedis();
    const s = createRedisStore<number>({ client, prefix: "anatomia:card:" });
    await s.set("abc", 42);
    expect([...map.keys()]).toEqual(["anatomia:card:abc"]);
  });

  it("degrades to a miss (no throw) when the client errors", async () => {
    const bad: RedisLike = {
      async get() { throw new Error("ECONNREFUSED"); },
      async set() { throw new Error("ECONNREFUSED"); },
    };
    const s = createRedisStore<number>({ client: bad });
    expect(await s.get("k")).toBeUndefined();
    await expect(s.set("k", 1)).resolves.toBeUndefined(); // must not throw
  });

  it("treats a corrupt (non-JSON) entry as a miss", async () => {
    const { client, map } = fakeRedis();
    map.set("anatomia:bad", "{ not json");
    const s = createRedisStore<number>({ client, prefix: "anatomia:" });
    expect(await s.get("bad")).toBeUndefined();
  });
});
