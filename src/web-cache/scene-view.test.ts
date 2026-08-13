import { describe, expect, it } from "vitest";
import { buildSceneViewPayload } from "./scene-view.js";
import type { SceneInspection } from "../knowledge/scene/types.js";
import type { ScreenGraph } from "../screens/types.js";
import type { DomainCorrespondenceQuery } from "../knowledge/domain-correspondence/types.js";

const correspondence: DomainCorrespondenceQuery = {
  programDomains: [], specClauses: [],
  businessDomains: [{ businessDomainId: "business:orders", programDomains: [{ programDomainId: "program:application", weight: 1, evidence: { codeSymbols: [], specClauses: [] } }] }],
};

function inspection(elements: Array<{ id: string; label: string; sourceAnchor: { path: string } }>): SceneInspection {
  return { stale: false, staleReasons: [], observations: [], manifest: {} as SceneInspection["manifest"], scenes: [{
    id: "scene:orders", nativeIdentity: "OrdersPage", referenceKeys: ["OrdersPage"], label: "Orders", kind: "page", origin: "route", sourceRevision: "r", identityBasis: "native-id",
    sourceAnchor: { path: "src/orders.ts", startLine: 1, endLine: 1, detector: "test", reason: "test" }, aliases: [], tombstone: false, entryCodeSymbolIds: [], reachedCodeSymbolIds: [], activeDomainIds: ["business:orders"], relatedSpecClauseIds: [], containedSceneIds: [], transitionSceneIds: ["scene:next"],
    elements: elements.map((element) => ({ ...element, sourceAnchor: { path: element.sourceAnchor.path, startLine: 1, endLine: 1, detector: "test", reason: "test" }, realizedByCodeSymbolIds: [] })), annotation: null,
  }] };
}

const screen: ScreenGraph = { screens: [{ name: "OrdersPage", file: "src/orders.ts", line: 1, kind: "page", stack: "web", contains: ["OrderForm"], navigatesTo: ["NextPage"], reason: "test", domains: [] }], summary: { total: 1, byStack: {}, byKind: {}, edges: 1 } };

describe("scene-view payload", () => {
  it("uses capture, wireframe, then element-tree fidelity in order and preserves dual-layer ids", () => {
    expect(buildSceneViewPayload(inspection([{ id: "shot", label: "shot", sourceAnchor: { path: "capture.png" } }]), screen, correspondence).scenes[0]).toMatchObject({ fidelity: "capture", businessDomainIds: ["business:orders"], programDomainIds: ["program:application"] });
    expect(buildSceneViewPayload(inspection([]), screen, correspondence).scenes[0]).toMatchObject({ fidelity: "wireframe", wireframe: { transitions: ["NextPage"] } });
    expect(buildSceneViewPayload(inspection([{ id: "root", label: "Root", sourceAnchor: { path: "src/orders.ts" } }]), { ...screen, screens: [] }, correspondence).scenes[0]).toMatchObject({ fidelity: "tree", elements: [{ id: "root", label: "Root" }] });
  });

  it("matches screens through canonical identities, never a display label", () => {
    const sameLabelDifferentIdentity: ScreenGraph = {
      ...screen,
      screens: [{ ...screen.screens[0], name: "Orders" }],
    };

    expect(buildSceneViewPayload(inspection([]), sameLabelDifferentIdentity, correspondence).scenes[0]).toMatchObject({ fidelity: "tree" });
  });

  it("does not turn external or filesystem paths into browser-loaded captures", () => {
    for (const path of ["https://internal.example/capture.png", "C:/private/capture.png", "../capture.png"]) {
      expect(buildSceneViewPayload(inspection([{ id: "shot", label: "shot", sourceAnchor: { path } }]), { ...screen, screens: [] }, correspondence).scenes[0])
        .toMatchObject({ fidelity: "tree", captureUrl: null });
    }
  });
});
