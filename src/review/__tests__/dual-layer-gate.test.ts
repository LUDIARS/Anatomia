import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FunctionNode, SpecClause } from "../../types.js";
import { buildDualLayerReview } from "../dual-layer-gate.js";

const repoPath = process.cwd();
const clause = (overrides: Partial<SpecClause> = {}): SpecClause => ({
  id: "SPEC-1", sourceFile: "spec/feature.md", heading: "Feature", text: "Requirement", embedding: null, ...overrides,
});
const functionNode = (path: string, id = "anchor-1", root = repoPath): FunctionNode => ({
  id: id as FunctionNode["id"], name: "feature", signature: "function feature()", sourceRange: { filePath: `${root}/${path}`, start: { line: 1, column: 1 }, end: { line: 1, column: 2 } }, bodyAst: {} as FunctionNode["bodyAst"],
});

describe("two-layer PR domain gate", () => {
  it("would block unclassified code while business ownership remains informational", async () => {
    const result = await buildDualLayerReview({ repoPath, sourceRevision: "test", functions: [functionNode("unclassified/a.ts")], changedAnchors: new Set(["anchor-1"]), businessOwnedAnchors: new Set(), changedPaths: ["unclassified/a.ts"], specClauses: [], businessDomains: [], mode: "advisory" });
    expect(result.program).toMatchObject({ pass: false, wouldBlock: true, blocking: false, unclassifiedAnchors: ["anchor-1"], businessUnownedAnchors: ["anchor-1"] });
  });

  it("permits classified code without a business-domain owner", async () => {
    const configuredRepo = await mkdtemp(join(tmpdir(), "anatomia-dual-layer-"));
    try {
      await mkdir(join(configuredRepo, ".anatomia"));
      await writeFile(
        join(configuredRepo, ".anatomia", "layers.json"),
        JSON.stringify({ layers: [{ glob: "src/**", layer: "application" }], mergeCouplingThreshold: 1 }),
        "utf8",
      );
      const result = await buildDualLayerReview({ repoPath: configuredRepo, sourceRevision: "test", functions: [functionNode("src/feature.ts", "anchor-1", configuredRepo)], changedAnchors: new Set(["anchor-1"]), businessOwnedAnchors: new Set(), changedPaths: ["src/feature.ts"], specClauses: [], businessDomains: [], mode: "enforced" });
      expect(result.program).toMatchObject({ pass: true, blocking: false, unclassifiedAnchors: [], businessUnownedAnchors: ["anchor-1"] });
    } finally {
      await rm(configuredRepo, { recursive: true, force: true });
    }
  });

  it("would block an unowned changed spec but permits missing program refinement", async () => {
    const result = await buildDualLayerReview({ repoPath, sourceRevision: "test", functions: [], changedAnchors: new Set(), businessOwnedAnchors: new Set(), changedPaths: ["spec/feature.md"], specClauses: [clause()], businessDomains: [], mode: "enforced" });
    expect(result.business).toMatchObject({ pass: false, blocking: true, unownedClauses: [expect.objectContaining({ id: "SPEC-1" })], programUnrefinedClauses: [] });
  });

  it("accepts a PR-local business-domain declaration for its changed spec", async () => {
    const result = await buildDualLayerReview({ repoPath, sourceRevision: "test", functions: [], changedAnchors: new Set(), businessOwnedAnchors: new Set(), changedPaths: ["spec/feature.md"], specClauses: [clause()], businessDomains: [{ name: "feature", description: "feature", presetRules: [], templateRules: [], source: "manual", specRefs: ["SPEC-1"] }], mode: "enforced" });
    expect(result.business).toMatchObject({ pass: true, blocking: false, unownedClauses: [] });
  });

  it("does not treat an unverified domain-reference hint as business ownership", async () => {
    const result = await buildDualLayerReview({ repoPath, sourceRevision: "test", functions: [], changedAnchors: new Set(), businessOwnedAnchors: new Set(), changedPaths: ["spec/feature.md"], specClauses: [clause({ domainRefs: ["domain:unverified"] })], businessDomains: [], mode: "enforced" });
    expect(result.business).toMatchObject({ pass: false, blocking: true, unownedClauses: [expect.objectContaining({ id: "SPEC-1" })] });
  });

  it("passes dependency-only changes without spec ownership", async () => {
    const result = await buildDualLayerReview({ repoPath, sourceRevision: "test", functions: [], changedAnchors: new Set(), businessOwnedAnchors: new Set(), changedPaths: ["package.json", "package-lock.json"], specClauses: [clause()], businessDomains: [], mode: "enforced" });
    expect(result.business).toMatchObject({ pass: true, skippedForDependencyOnlyChange: true, unownedClauses: [] });
  });
});
