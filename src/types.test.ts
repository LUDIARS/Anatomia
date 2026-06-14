/**
 * T01/T02 smoke test.
 * Verifies that core types are importable and that the branded AnchorId
 * type works at runtime via a simple const assertion.
 * No logic beyond confirming the scaffold wires up.
 */

import { describe, it, expect } from "vitest";
import type { AnchorId, Verdict, Rule } from "./types.js";
import { resolvePluginDir } from "./plugins/loader.js";

describe("T02 core types", () => {
  it("AnchorId can be cast from a plain string (brand is type-only)", () => {
    const id = "sha256:abc123" as AnchorId;
    expect(typeof id).toBe("string");
    expect(id).toBe("sha256:abc123");
  });

  it("Verdict shape satisfies expected keys", () => {
    const verdict: Verdict = {
      pass: true,
      gates: [],
      anchors: [],
      suggestion: null,
    };
    expect(verdict.pass).toBe(true);
    expect(Array.isArray(verdict.gates)).toBe(true);
  });

  it("Rule shape satisfies expected keys", () => {
    const rule: Rule = {
      id: "global/no-alloc-in-hot-path",
      scope: "global",
      description: "No heap allocation on the hot render path.",
      predicate: {
        type: "EdgeForbidden",
        from: { tags: ["hotPath"] },
        to: { tags: ["alloc"] },
        kind: "calls",
      },
      severity: "block",
    };
    expect(rule.scope).toBe("global");
    expect(rule.severity).toBe("block");
  });
});

describe("T01 plugin loader stub", () => {
  it("returns null when ANATOMIA_PLUGIN_DIR is unset", () => {
    delete process.env["ANATOMIA_PLUGIN_DIR"];
    expect(resolvePluginDir()).toBeNull();
  });

  it("returns a resolved path when ANATOMIA_PLUGIN_DIR is set", () => {
    process.env["ANATOMIA_PLUGIN_DIR"] = "./plugins";
    const result = resolvePluginDir();
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
    // Should be an absolute path after resolve()
    expect(result!.startsWith("/") || /^[A-Za-z]:\\/.test(result!)).toBe(true);
    delete process.env["ANATOMIA_PLUGIN_DIR"];
  });
});
