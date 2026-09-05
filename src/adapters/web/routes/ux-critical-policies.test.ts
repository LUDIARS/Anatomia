import { describe, expect, it } from "vitest";
import { withUxCriticalPolicies } from "./ux-critical-policies.js";
import type { DomainFocusPolicy } from "../../../domains/focused-testing.js";

const analysed = new Set(["ui-shell", "billing"]);

describe("withUxCriticalPolicies", () => {
  it("adds a UX-critical domain the caller did not ask for", () => {
    const merged = withUxCriticalPolicies(undefined, ["ui-shell"], analysed);
    expect(merged.added).toEqual(["ui-shell"]);
    expect(merged.policies).toEqual([
      { domain: "ui-shell", priority: "critical", risks: [], variables: [] },
    ]);
  });

  it("raises a caller-supplied domain to critical while keeping its patterns", () => {
    const requested: DomainFocusPolicy[] = [
      { domain: "ui-shell", priority: "low", risks: ["boundary"], variables: [{ pattern: "id", priority: "low" }] },
    ];
    const merged = withUxCriticalPolicies(requested, ["ui-shell"], analysed);
    expect(merged.added).toEqual([]);
    expect(merged.raised).toEqual(["ui-shell"]);
    expect(merged.policies![0]).toMatchObject({
      priority: "critical",
      risks: ["boundary"],
      variables: [{ pattern: "id", priority: "low" }],
    });
  });

  it("skips a domain the analysis does not know, so a mandatory policy cannot 400 the request", () => {
    const merged = withUxCriticalPolicies(undefined, ["ghost"], analysed);
    expect(merged.added).toEqual([]);
    expect(merged.policies).toBeUndefined();
  });

  it("leaves an untouched request untouched when nothing is UX-critical", () => {
    const requested: DomainFocusPolicy[] = [
      { domain: "billing", priority: "medium", risks: [], variables: [] },
    ];
    expect(withUxCriticalPolicies(requested, [], analysed).policies).toBe(requested);
  });
});
