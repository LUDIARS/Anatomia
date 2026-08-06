import { describe, expect, it } from "vitest";
import { KNOWLEDGE_INTEGRATION_SCENARIOS } from "./fixtures.js";
import { measureKnowledgeQuality } from "./metrics.js";

describe("knowledge quality metric calculation", () => {
  it("catalogs every rollout scenario and calculates a synthetic sample", () => {
    expect(KNOWLEDGE_INTEGRATION_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "spec-only", "code-only", "mixed", "renamed", "hierarchy-conflict", "scene-rename", "trace-enrichment",
    ]);
    const report = measureKnowledgeQuality({
      parser: { truePositive: 98, falsePositive: 1, falseNegative: 1 },
      identityPairs: [
        { beforeId: "domain:p/a", afterId: "domain:p/a", expectedStable: true },
        { beforeId: "scene:p/a", afterId: "scene:p/a", expectedStable: true },
        { beforeId: "code:p/a", afterId: "code:p/b", expectedStable: false },
      ],
      assignments: [{ symbolId: "code:p/a", evidenceCount: 1 }, { symbolId: "code:p/b", evidenceCount: 2 }],
      replayHashes: ["sha256:one", "sha256:one"],
      regenerationOutputs: ["bytes", "bytes"],
    });
    expect(report).toMatchObject({ parserPrecision: 0.989899, parserRecall: 0.989899,
      identityExpectationAccuracy: 1, assignmentEvidenceCoverage: 1,
      replayDeterministic: true, regenerationByteIdentical: true });
  });
});
