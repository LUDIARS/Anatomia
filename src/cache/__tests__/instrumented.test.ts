/**
 * instrumentStore decorator — records hit/miss to the transcript + counters,
 * passes set through, and leaves the wrapped store's values untouched.
 */
import { describe, it, expect } from "vitest";
import { createMemoryStore } from "../store.js";
import { instrumentStore } from "../instrumented.js";
import type { CacheEvent, CacheTranscript } from "../transcript.js";

function spyTranscript(): { transcript: CacheTranscript; events: CacheEvent[] } {
  const events: CacheEvent[] = [];
  return {
    events,
    transcript: {
      record: (e) => events.push(e),
      flush: async () => undefined,
    },
  };
}

describe("instrumentStore", () => {
  it("records a miss then a hit, tallies counters, returns values unchanged", async () => {
    const { transcript, events } = spyTranscript();
    const { store, counters } = instrumentStore(createMemoryStore<number>(), {
      ns: "card",
      transcript,
      session: "s1",
      model: "claude-opus-4-8",
    });

    expect(await store.get("k")).toBeUndefined(); // miss
    await store.set("k", 42);
    expect(await store.get("k")).toBe(42); // hit

    expect(counters).toEqual({ gets: 2, hits: 1, misses: 1 });
    const gets = events.filter((e) => e.kind === "get");
    expect(gets).toHaveLength(2);
    expect(gets[0]).toMatchObject({ ns: "card", session: "s1", hit: false, key: "k", model: "claude-opus-4-8" });
    expect(gets[1]).toMatchObject({ ns: "card", hit: true, key: "k" });
  });

  it("does not emit an event for set (only get is observed)", async () => {
    const { transcript, events } = spyTranscript();
    const { store } = instrumentStore(createMemoryStore<string>(), {
      ns: "phase",
      transcript,
      session: "s2",
    });
    await store.set("x", "v");
    expect(events).toHaveLength(0);
  });

  it("accumulates into a shared counter across instrumented stores", async () => {
    const { transcript } = spyTranscript();
    const counters = { gets: 0, hits: 0, misses: 0 };
    const a = instrumentStore(createMemoryStore<number>(), { ns: "card", transcript, session: "s", counters });
    const b = instrumentStore(createMemoryStore<number>(), { ns: "phase", transcript, session: "s", counters });
    await a.store.get("p"); // miss
    await b.store.get("q"); // miss
    expect(counters).toEqual({ gets: 2, hits: 0, misses: 2 });
  });
});
