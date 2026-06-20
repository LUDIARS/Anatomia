/**
 * Warm-server idle-shutdown decision helpers (idle.ts).
 */

import { describe, it, expect } from "vitest";
import { resolveIdleMs, checkIntervalMs, shouldShutdown, DEFAULT_IDLE_MS } from "../idle.js";

describe("resolveIdleMs", () => {
  it("defaults to 3 hours when unset", () => {
    expect(resolveIdleMs({})).toBe(DEFAULT_IDLE_MS);
    expect(DEFAULT_IDLE_MS).toBe(3 * 60 * 60 * 1000);
  });

  it("reads an explicit positive value", () => {
    expect(resolveIdleMs({ ANATOMIA_IDLE_SHUTDOWN_MS: "5000" })).toBe(5000);
  });

  it("disables (0) on <=0 or non-numeric", () => {
    expect(resolveIdleMs({ ANATOMIA_IDLE_SHUTDOWN_MS: "0" })).toBe(0);
    expect(resolveIdleMs({ ANATOMIA_IDLE_SHUTDOWN_MS: "-1" })).toBe(0);
    expect(resolveIdleMs({ ANATOMIA_IDLE_SHUTDOWN_MS: "nope" })).toBe(0);
  });
});

describe("checkIntervalMs", () => {
  it("caps the poll interval at one minute", () => {
    expect(checkIntervalMs(DEFAULT_IDLE_MS)).toBe(60_000);
    expect(checkIntervalMs(5_000)).toBe(5_000);
  });
});

describe("shouldShutdown", () => {
  it("fires once the idle window has elapsed", () => {
    const last = 1_000_000;
    expect(shouldShutdown(last, last + DEFAULT_IDLE_MS, DEFAULT_IDLE_MS)).toBe(true);
    expect(shouldShutdown(last, last + DEFAULT_IDLE_MS - 1, DEFAULT_IDLE_MS)).toBe(false);
  });

  it("never fires when disabled (idleMs <= 0)", () => {
    expect(shouldShutdown(0, Number.MAX_SAFE_INTEGER, 0)).toBe(false);
  });
});
