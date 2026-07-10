import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_DOMAINS } from "./ontology.js";

export type DomainWarningCode =
  | "domain-count-zero"
  | "domain-count-low-vs-taxonomy";

export interface DomainWarning {
  code: DomainWarningCode;
  severity: "warning";
  message: string;
  details: {
    detectedDomains: number;
    detectedCuratedDomains: number;
    activeDomains: number;
    builtinDomains: number;
    expectedCuratedDomains: number | null;
    threshold: number;
    functionCount: number;
    source: "taxonomy" | "analysis";
  };
}

export interface DomainHealthSummary {
  detectedDomains: number;
  detectedCuratedDomains: number;
  activeDomains: number;
  builtinDomains: number;
  expectedCuratedDomains: number | null;
  functionCount: number;
  warnings: DomainWarning[];
}

export interface DomainHealthInput {
  repoPath: string;
  functions: readonly unknown[];
  domains?: readonly { implementors?: readonly unknown[] }[];
}

export async function assessDomainHealth(input: DomainHealthInput): Promise<DomainHealthSummary> {
  const detectedDomains = input.domains?.length ?? 0;
  const builtinDomains = BUILTIN_DOMAINS.length;
  const detectedCuratedDomains = Math.max(0, detectedDomains - builtinDomains);
  const activeDomains = (input.domains ?? []).filter((domain) => (domain.implementors?.length ?? 0) > 0).length;
  const expectedCuratedDomains = await loadExpectedTaxonomyDomainCount(input.repoPath);
  const functionCount = input.functions.length;
  const warnings: DomainWarning[] = [];

  if (expectedCuratedDomains != null && expectedCuratedDomains > 0) {
    const threshold = Math.max(1, Math.ceil(expectedCuratedDomains * 0.5));
    if (detectedCuratedDomains < threshold) {
      warnings.push({
        code: detectedDomains === 0 ? "domain-count-zero" : "domain-count-low-vs-taxonomy",
        severity: "warning",
        message:
          `Only ${detectedCuratedDomains} curated domains were detected, but ` +
          `${expectedCuratedDomains} are present in the taxonomy. ` +
          "The project may be using a stale/missing ontology directory, or domain detection may have failed.",
        details: {
          detectedDomains,
          detectedCuratedDomains,
          activeDomains,
          builtinDomains,
          expectedCuratedDomains,
          threshold,
          functionCount,
          source: "taxonomy",
        },
      });
    }
  } else if (functionCount >= 20 && detectedDomains === 0) {
    warnings.push({
      code: "domain-count-zero",
      severity: "warning",
      message:
        `No domains were detected for a project with ${functionCount} functions. ` +
        "Domain detection may have failed before the builtin ontology loaded.",
      details: {
        detectedDomains,
        detectedCuratedDomains,
        activeDomains,
        builtinDomains,
        expectedCuratedDomains,
        threshold: 1,
        functionCount,
        source: "analysis",
      },
    });
  }

  return {
    detectedDomains,
    detectedCuratedDomains,
    activeDomains,
    builtinDomains,
    expectedCuratedDomains,
    functionCount,
    warnings,
  };
}

export async function loadExpectedTaxonomyDomainCount(repoPath: string): Promise<number | null> {
  const dataDir = join(repoPath, "spec", "data");
  let entries: string[];
  try {
    entries = await readdir(dataDir);
  } catch {
    return null;
  }
  const file = entries.find((entry) => entry.endsWith(".taxonomy.json"));
  if (!file) return null;
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, file), "utf8")) as {
      domains?: unknown[];
    };
    return Array.isArray(parsed.domains) ? parsed.domains.length : null;
  } catch {
    return null;
  }
}
