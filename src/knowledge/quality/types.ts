export interface KnowledgeQualitySample {
  parser: { truePositive: number; falsePositive: number; falseNegative: number };
  identityPairs: Array<{ beforeId: string; afterId: string; expectedStable: boolean }>;
  assignments: Array<{ symbolId: string; evidenceCount: number }>;
  replayHashes: string[];
  regenerationOutputs: string[];
}

export interface KnowledgeQualityReport {
  schemaVersion: 1;
  parserPrecision: number;
  parserRecall: number;
  identityExpectationAccuracy: number;
  assignmentEvidenceCoverage: number;
  replayDeterministic: boolean;
  regenerationByteIdentical: boolean;
  sampleCounts: {
    parserClauses: number;
    identityPairs: number;
    assignments: number;
    replayRuns: number;
    regenerationRuns: number;
  };
  knownLimitations: string[];
}
