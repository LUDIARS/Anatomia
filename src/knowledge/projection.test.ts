import { describe, expect, it } from "vitest";
import { KnowledgeProjection } from "./projection.js";
import type { KnowledgeEdge, KnowledgeNode, KnowledgeGraph } from "./types.js";

const node = (id: string, kind: KnowledgeNode["kind"]): KnowledgeNode => ({
  id, kind, revision: { sourceRevision: "git:a", contentFingerprint: "sha256:a" },
});

describe("knowledge projection queries", () => {
  it("provides domain closure and scene/domain/spec reverse lookup", () => {
    const nodes = [
      node("domain:p/root", "domain"), node("domain:p/child", "domain"),
      node("scene:p/battle", "scene"), node("spec:p/rules#hit", "spec-clause"),
    ];
    const state: KnowledgeGraph = {
      head: "sha256:head",
      transactions: [],
      nodes: new Map(nodes.map((value) => [value.id, value])),
      edges: new Map<string, KnowledgeEdge>([
        ["e1", { id: "e1", kind: "subdomain-of", from: "domain:p/child", to: "domain:p/root" }],
        ["e2", { id: "e2", kind: "scene-activates-domain", from: "scene:p/battle", to: "domain:p/child" }],
        ["e3", { id: "e3", kind: "scene-relates-spec", from: "scene:p/battle", to: "spec:p/rules#hit" }],
      ]),
    };
    const projection = KnowledgeProjection.fromState(state);
    expect(projection.ancestors("domain:p/child").map((value) => value.id)).toEqual(["domain:p/root"]);
    expect(projection.descendants("domain:p/root").map((value) => value.id)).toEqual(["domain:p/child"]);
    expect(projection.scenesForDomain("domain:p/child").map((value) => value.id)).toEqual(["scene:p/battle"]);
    expect(projection.scenesForSpec("spec:p/rules#hit").map((value) => value.id)).toEqual(["scene:p/battle"]);
  });
});
