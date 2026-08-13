import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { AnchorId } from "../../types.js";
import { deriveProgramDomains } from "../../domains/program/derive.js";
import type { ProgramSymbol } from "../../domains/program/types.js";
import { replayKnowledgeLog, writeKnowledgeTransaction } from "../log.js";
import { materializeProgramDomainGraph } from "./derive.js";
import { syncCanonicalProgramDomains } from "./sync.js";

describe("program-domain code sync", () => {
  it("replaces the derived set and persists a fingerprint-keyed deterministic projection", async () => {
    const symbols: ProgramSymbol[] = [{ id: "code:a", moduleId: "src/app", path: "src/app/a.ts", frameworkLayer: "application" }];
    const graph = materializeProgramDomainGraph(deriveProgramDomains({ projectId: "p", sourceRevision: "r1", modules: [{ id: "src/app", kind: "dir", label: "app", anchors: ["a" as AnchorId], files: ["src/app/a.ts"] }], symbols, config: { layers: [], mergeCouplingThreshold: 1 } }), symbols);
    const root = await mkdtemp(join(tmpdir(), "anatomia-program-domain-"));
    const result = await syncCanonicalProgramDomains({ graph, knowledgeLogPath: join(root, "knowledge.jsonl"), generatedRoot: join(root, "generated"), expectedHead: null });
    expect(result.transaction?.origin).toBe("code-sync");
    expect(result.projectionsStale).toBe(false);
    expect(JSON.parse(await readFile(join(root, "generated", "program-domains.json"), "utf8")).definitionFingerprint).toBe(graph.definitionFingerprint);
  });

  it("preserves an existing code-symbol record while adding program-domain relations", async () => {
    const symbols: ProgramSymbol[] = [{ id: "code:a", moduleId: "src/app", path: "src/app/a.ts", frameworkLayer: "application" }];
    const graph = materializeProgramDomainGraph(deriveProgramDomains({ projectId: "p", sourceRevision: "r1", modules: [{ id: "src/app", kind: "dir", label: "app", anchors: ["a" as AnchorId], files: ["src/app/a.ts"] }], symbols, config: { layers: [], mergeCouplingThreshold: 1 } }), symbols);
    const root = await mkdtemp(join(tmpdir(), "anatomia-program-domain-"));
    const knowledgeLogPath = join(root, "knowledge.jsonl");
    const existing = await writeKnowledgeTransaction(knowledgeLogPath, {
      transactionId: "tx:existing-symbol",
      analysisSnapshotId: "existing",
      sourceRevisions: { spec: null, code: "r0", trace: null },
      origin: "human-approval",
      operations: [{ op: "upsert-node", record: { id: "code:a", kind: "code-symbol", revision: { sourceRevision: "r0", contentFingerprint: "existing", sourcePath: "src/app/a.ts" }, data: { qualifiedName: "existingSymbol" } } }],
      provenance: { proposalIds: [], approval: { kind: "automatic", reviewRef: null }, generatorSchema: 1 },
    }, null);

    await syncCanonicalProgramDomains({ graph, knowledgeLogPath, generatedRoot: join(root, "generated"), expectedHead: existing.transactionHash });
    const symbol = replayKnowledgeLog(await readFile(knowledgeLogPath, "utf8")).nodes.get("code:a");
    expect(symbol?.data).toEqual({ qualifiedName: "existingSymbol" });
  });
});
