import { describe, expect, it } from "vitest";
import {
  deriveUxCriticalDomains,
  resolveUxCriticalDetectionDomains,
  uxCriticalDomainIds,
} from "./ux-critical.js";
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode } from "../types.js";

function domain(id: string, data: Record<string, unknown> = {}): KnowledgeNode {
  return { id, kind: "domain", revision: { sourceRevision: "r", contentFingerprint: "f" }, data };
}

function symbol(id: string, sourcePath?: string, anchorId?: string): KnowledgeNode {
  return {
    id,
    kind: "code-symbol",
    revision: {
      sourceRevision: "r",
      contentFingerprint: anchorId ? `anchor:${anchorId}` : "f",
      ...(sourcePath ? { sourcePath } : {}),
    },
  };
}

function owns(from: string, to: string): KnowledgeEdge {
  return { id: `domain-owns-code:${from}->${to}`, kind: "domain-owns-code", from, to };
}

function graph(nodes: KnowledgeNode[], edges: KnowledgeEdge[]): KnowledgeGraph {
  return {
    head: null,
    transactions: [],
    nodes: new Map(nodes.map((node) => [node.id, node])),
    edges: new Map(edges.map((edge) => [edge.id, edge])),
  };
}

describe("deriveUxCriticalDomains", () => {
  it("derives from a screen's direct entry symbol", () => {
    const state = graph(
      [domain("menu"), symbol("sym:openMenu")],
      [owns("menu", "sym:openMenu")],
    );
    const [finding] = deriveUxCriticalDomains(state, {
      entryCodeSymbolIds: ["sym:openMenu"],
      screenFiles: [],
    });
    expect(finding).toMatchObject({ uxCritical: true, derived: true, declared: null, conflict: false });
    expect(finding!.evidence).toEqual(["sym:openMenu"]);
  });

  it("derives from a screen declaration file", () => {
    const state = graph(
      [domain("menu"), symbol("sym:render", "src\\ui\\MenuScreen.tsx")],
      [owns("menu", "sym:render")],
    );
    const [finding] = deriveUxCriticalDomains(state, {
      entryCodeSymbolIds: [],
      screenFiles: ["src/ui/MenuScreen.tsx"],
    });
    expect(finding!.uxCritical).toBe(true);
  });

  it("honours an explicit declaration with no screen evidence", () => {
    const state = graph([domain("billing", { uxCritical: true })], []);
    const [finding] = deriveUxCriticalDomains(state, { entryCodeSymbolIds: [], screenFiles: [] });
    expect(finding).toMatchObject({ uxCritical: true, declared: true, derived: false, conflict: true });
  });

  it("lets the explicit declaration win and reports the disagreement", () => {
    const state = graph(
      [domain("menu", { uxCritical: false }), symbol("sym:openMenu")],
      [owns("menu", "sym:openMenu")],
    );
    const [finding] = deriveUxCriticalDomains(state, {
      entryCodeSymbolIds: ["sym:openMenu"],
      screenFiles: [],
    });
    expect(finding).toMatchObject({ uxCritical: false, declared: false, derived: true, conflict: true });
  });

  it("does not mark a domain only reachable transitively from a scene", () => {
    // `sym:deepHelper` is reached from the screen but is NOT a direct entry.
    const state = graph(
      [domain("math"), symbol("sym:deepHelper")],
      [owns("math", "sym:deepHelper")],
    );
    const [finding] = deriveUxCriticalDomains(state, {
      entryCodeSymbolIds: ["sym:openMenu"],
      screenFiles: [],
    });
    expect(finding!.uxCritical).toBe(false);
  });
});

describe("resolveUxCriticalDetectionDomains", () => {
  const state = graph(
    [domain("menu"), symbol("sym:openMenu")],
    [owns("menu", "sym:openMenu")],
  );
  const uxIds = uxCriticalDomainIds(deriveUxCriticalDomains(state, {
    entryCodeSymbolIds: ["sym:openMenu"],
    screenFiles: [],
  }));

  it("resolves through owned code symbols, not names", () => {
    const realisticState = graph(
      [domain("menu"), symbol("code:fixture/open-menu", undefined, "anchor:openMenu")],
      [owns("menu", "code:fixture/open-menu")],
    );
    const realisticIds = uxCriticalDomainIds(deriveUxCriticalDomains(realisticState, {
      entryCodeSymbolIds: ["anchor:openMenu"],
      screenFiles: [],
    }));
    const resolved = resolveUxCriticalDetectionDomains(realisticState, realisticIds, [
      { domain: "ui-shell", implementors: ["anchor:openMenu"] },
      // Same NAME as the business domain but claims none of its code.
      { domain: "menu", implementors: ["sym:unrelated"] },
    ]);
    expect(resolved).toEqual(["ui-shell"]);
  });

  it("resolves to nothing when no business domain is UX-critical", () => {
    expect(resolveUxCriticalDetectionDomains(state, new Set(), [
      { domain: "ui-shell", implementors: ["sym:openMenu"] },
    ])).toEqual([]);
  });
});
