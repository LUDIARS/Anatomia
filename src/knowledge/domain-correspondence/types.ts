/** A source location retained as evidence for a derived cross-layer relation. */
export interface DomainCorrespondenceSource {
  id: string;
  file: string;
  line: number | null;
}

/** A weighted business-domain relation for one program domain. */
export interface ProgramToBusinessCorrespondence {
  businessDomainId: string;
  /** Distinct CodeSymbols that carry this relation. */
  weight: number;
  evidence: {
    codeSymbols: DomainCorrespondenceSource[];
    specClauses: DomainCorrespondenceSource[];
  };
}

/** A program domain and its approved business-domain links. */
export interface ProgramDomainCorrespondence {
  programDomainId: string;
  businessDomains: ProgramToBusinessCorrespondence[];
  /** Code is validly program-classified but has no approved business owner. */
  unlinkedCodeSymbols: DomainCorrespondenceSource[];
  unlinkedCodeSymbolCount: number;
}

/** A weighted program-domain relation for one business domain. */
export interface BusinessToProgramCorrespondence {
  programDomainId: string;
  /** Distinct CodeSymbols that carry this relation. */
  weight: number;
  evidence: ProgramToBusinessCorrespondence["evidence"];
}

/** An approved business domain and its program-domain links. */
export interface BusinessDomainCorrespondence {
  businessDomainId: string;
  programDomains: BusinessToProgramCorrespondence[];
}

/** A SpecClause's optional, code-link-derived program-domain refinement. */
export interface SpecClauseProgramDomainCorrespondence {
  specClauseId: string;
  programDomains: Array<{
    programDomainId: string;
    /** Distinct linked CodeSymbols. */
    weight: number;
    evidence: {
      codeSymbols: DomainCorrespondenceSource[];
      specClause: DomainCorrespondenceSource;
    };
  }>;
}

/** Read-only, deterministic projection; no transitive edges are persisted. */
export interface DomainCorrespondenceQuery {
  programDomains: ProgramDomainCorrespondence[];
  businessDomains: BusinessDomainCorrespondence[];
  specClauses: SpecClauseProgramDomainCorrespondence[];
}
