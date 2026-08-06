import type { KnowledgeQualityReport, KnowledgeQualitySample } from "./types.js";

// @implements SPEC-knowledge-quality-report

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(6));
}

function allSame(values: string[]): boolean {
  return values.length <= 1 || values.every((value) => value === values[0]);
}

export function measureKnowledgeQuality(sample: KnowledgeQualitySample): KnowledgeQualityReport {
  const parserTotal = sample.parser.truePositive + sample.parser.falsePositive + sample.parser.falseNegative;
  const identityCorrect = sample.identityPairs.filter((pair) => (pair.beforeId === pair.afterId) === pair.expectedStable).length;
  const evidenced = sample.assignments.filter((assignment) => assignment.evidenceCount > 0).length;
  return {
    schemaVersion: 1,
    parserPrecision: ratio(sample.parser.truePositive, sample.parser.truePositive + sample.parser.falsePositive),
    parserRecall: ratio(sample.parser.truePositive, sample.parser.truePositive + sample.parser.falseNegative),
    identityExpectationAccuracy: ratio(identityCorrect, sample.identityPairs.length),
    assignmentEvidenceCoverage: ratio(evidenced, sample.assignments.length),
    replayDeterministic: allSame(sample.replayHashes),
    regenerationByteIdentical: allSame(sample.regenerationOutputs),
    sampleCounts: {
      parserClauses: parserTotal,
      identityPairs: sample.identityPairs.length,
      assignments: sample.assignments.length,
      replayRuns: sample.replayHashes.length,
      regenerationRuns: sample.regenerationOutputs.length,
    },
    knownLimitations: [
      "Executable legacy DomainDef modules are inventoried but never executed by migration.",
      "Unmatched manual scenes remain conflicts; migration never creates canonical scene identity.",
      "Runtime trace verification still requires a real instrumented target.",
    ],
  };
}
