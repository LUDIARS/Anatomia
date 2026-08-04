/**
 * isTestFilePath — the single production/test boundary shared by the
 * spec_linkage / coupling_delta gates and review/pr-diff.ts changedOrphans.
 * Kept as a direct unit test so the two consumers cannot drift apart silently.
 */

import { describe, it, expect } from "vitest";
import { isTestFilePath } from "../gates/types.js";

describe("isTestFilePath", () => {
  it("matches __tests__ directories in both separator styles", () => {
    expect(isTestFilePath("src/supply/__tests__/verify.test.ts")).toBe(true);
    expect(isTestFilePath("src\\supply\\__tests__\\helpers.ts")).toBe(true);
    expect(isTestFilePath("__tests__/a.ts")).toBe(true);
  });

  it("matches *.test.* / *.spec.* files beside their module", () => {
    expect(isTestFilePath("src/domains/detect.test.ts")).toBe(true);
    expect(isTestFilePath("src/domains/Card.Spec.TSX")).toBe(true);
  });

  it("does not match production files that merely mention spec or test", () => {
    expect(isTestFilePath("src/spec/cache.ts")).toBe(false);
    expect(isTestFilePath("src/domains/focused-testing.ts")).toBe(false);
    expect(isTestFilePath("src/supply/gates/spec_linkage.ts")).toBe(false);
    expect(isTestFilePath("src/__tests__fixtures/a.ts")).toBe(false);
  });
});
