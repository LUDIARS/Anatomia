import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { replayKnowledgeLog } from "../log.js";
import { resolveKnowledgeWriteRoot } from "../write-root.js";
import { describeCodeSymbol } from "../code-symbol.js";
import { buildDomainOrganizationView } from "../domain/organization-view.js";
import { proposeDomainsFromSpec } from "../domain/spec-proposals.js";
import { analyzeCodeAssignment } from "../domain/assignments.js";
import { classifyDomainDrift, proposeSemanticDomainChanges, type DomainDriftInput } from "../domain/drift.js";
import { applyGateA, type GateARequest } from "../domain/gate-a.js";
import { applyGateB, type GateBRequest } from "../domain/gate-b.js";
import { applyGateC, type GateCRequest } from "../domain/gate-c.js";
import type { KnowledgeProjectPort } from "./port.js";

// @implements SPEC-knowledge-adapter-migration

async function readKnowledgeGraph(path: string) {
  try { return replayKnowledgeLog(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return replayKnowledgeLog("");
    throw error;
  }
}

export class DomainKnowledgeApplication {
  readonly writeRoot: string;
  readonly knowledgeLogPath: string;
  readonly domainRoot: string;

  constructor(private readonly port: KnowledgeProjectPort) {
    this.writeRoot = resolveKnowledgeWriteRoot(port.project);
    this.knowledgeLogPath = join(this.writeRoot, "data", "domain-map", `${port.project.id}.knowledge.jsonl`);
    this.domainRoot = join(this.writeRoot, "data", "domains");
  }

  private async revisions() {
    const fingerprint = await this.port.fingerprint();
    return { sourceRevision: `sha256:${fingerprint}`, analysisSnapshotId: `analysis:${fingerprint}` };
  }

  private residual = async () => {
    const context = await this.port.refresh();
    return { clauses: context.specClauses?.length ?? 0, codeSymbols: (await context.graph.allNodes()).length };
  };

  async query() {
    const context = await this.port.context();
    const revision = await this.revisions();
    const symbols = (await context.graph.allNodes())
      .filter((node) => node.id !== null)
      .map((node) => {
        const symbol = describeCodeSymbol(this.port.project.id, this.port.project.rootPath, node, revision.sourceRevision);
        return { id: symbol.symbolId, anchorId: symbol.anchorId, qualifiedName: symbol.qualifiedName,
          sourcePath: symbol.sourcePath, sourceRange: { startLine: symbol.startLine, endLine: symbol.endLine } };
      });
    return buildDomainOrganizationView(await readKnowledgeGraph(this.knowledgeLogPath), symbols);
  }

  async proposeFromSpec() {
    const context = await this.port.context();
    const revision = await this.revisions();
    const state = await readKnowledgeGraph(this.knowledgeLogPath);
    return {
      proposals: proposeDomainsFromSpec({ projectId: this.port.project.id, clauses: context.specClauses ?? [],
        ...revision, expectedHead: state.head }),
      ...revision,
      expectedHead: state.head,
    };
  }

  async proposeAssignment(anchorId: string, domainId: string) {
    const context = await this.port.context();
    const codeNode = (await context.graph.allNodes()).find((node) => node.id === anchorId);
    if (!codeNode) throw new Error(`unknown code anchor ${anchorId}`);
    const revision = await this.revisions();
    const state = await readKnowledgeGraph(this.knowledgeLogPath);
    const symbol = describeCodeSymbol(this.port.project.id, this.port.project.rootPath, codeNode, revision.sourceRevision);
    const beforeOwner = [...state.edges.values()]
      .find((edge) => edge.kind === "domain-owns-code" && edge.to === symbol.symbolId)?.from ?? null;
    const { anchorId: _anchorId, ...evidence } = symbol;
    const action = analyzeCodeAssignment(evidence, [{ domainId, evidence: [{ kind: "explicit-annotation",
      detail: "human selection in domain organization review", confidence: 1, sourceAnchor: String(codeNode.id) }] }],
    beforeOwner, revision.analysisSnapshotId, state.head);
    return { action, expectedHead: state.head, codeRevision: revision.sourceRevision };
  }

  async proposeReconciliation(inputs: DomainDriftInput[]) {
    const revision = await this.revisions();
    const state = await readKnowledgeGraph(this.knowledgeLogPath);
    const findings = inputs.flatMap(classifyDomainDrift);
    const proposals = proposeSemanticDomainChanges(findings, { ...revision, expectedHead: state.head });
    return { findings, proposals, ...revision, expectedHead: state.head };
  }

  async gateA(body: Pick<GateARequest, "confirmApply" | "proposals" | "hierarchy" | "expectedHead" | "reviewRef">) {
    return applyGateA({ ...body, ...await this.revisions(), repoRoot: this.port.project.rootPath,
      service: this.port.project.id, domainRoot: this.domainRoot, knowledgeLogPath: this.knowledgeLogPath });
  }

  async gateB(body: Pick<GateBRequest, "confirmApply" | "actions" | "expectedHead" | "codeRevision" | "reviewRef">) {
    const revision = await this.revisions();
    return applyGateB({ ...body, repoRoot: this.port.project.rootPath, knowledgeLogPath: this.knowledgeLogPath,
      analysisSnapshotId: revision.analysisSnapshotId, residualAnalysis: this.residual });
  }

  async gateC(body: Omit<GateCRequest, "repoRoot" | "workflowRoot" | "knowledgeLogPath" | "sourceRevision" | "analysisSnapshotId" | "residualAnalysis">) {
    const root = resolve(this.writeRoot);
    if (!Array.isArray(body.okfWrites)) throw new Error("okfWrites must be an array");
    const okfWrites = body.okfWrites.map((write) => {
      if (!write || typeof write.path !== "string" || write.path.length === 0) {
        throw new Error("okfWrites entries require a path");
      }
      const path = resolve(root, write.path);
      if (!path.startsWith(`${root}${sep}`)) throw new Error(`semantic OKF path escapes knowledgeWriteRoot: ${write.path}`);
      return { ...write, path };
    });
    return applyGateC({ ...body, okfWrites, ...await this.revisions(), repoRoot: this.port.project.rootPath,
      workflowRoot: this.writeRoot, knowledgeLogPath: this.knowledgeLogPath, residualAnalysis: this.residual });
  }

  async state() { return readKnowledgeGraph(this.knowledgeLogPath); }
}
