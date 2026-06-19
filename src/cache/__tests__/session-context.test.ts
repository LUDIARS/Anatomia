import { describe, it, expect } from "vitest";
import { runWithSession, currentSession } from "../session-context.js";
import { instrumentStore } from "../instrumented.js";
import { createMemoryStore } from "../store.js";
import { createNullTranscript, type CacheEvent } from "../transcript.js";

describe("session-context", () => {
  it("currentSession is undefined outside a run", () => {
    expect(currentSession()).toBeUndefined();
  });

  it("propagates the session id across awaits", async () => {
    const seen = await runWithSession("S1", async () => {
      await Promise.resolve();
      return currentSession();
    });
    expect(seen).toBe("S1");
    expect(currentSession()).toBeUndefined(); // restored after the run
  });

  it("blank session is treated as no override", () => {
    expect(runWithSession("  ", () => currentSession())).toBeUndefined();
    expect(runWithSession(undefined, () => currentSession())).toBeUndefined();
  });

  it("instrumentStore with a resolver tags events with the current run's session", async () => {
    const recorded: CacheEvent[] = [];
    const transcript = { ...createNullTranscript(), record: (e: CacheEvent) => recorded.push(e) };
    const { store } = instrumentStore(createMemoryStore<string>(), {
      ns: "card",
      transcript,
      session: () => currentSession() ?? "global",
    });

    await store.get("k"); // outside a run → falls back
    await runWithSession("S2", () => store.get("k")); // inside → S2

    expect(recorded.map((e) => (e.kind === "get" ? e.session : ""))).toEqual(["global", "S2"]);
  });
});
