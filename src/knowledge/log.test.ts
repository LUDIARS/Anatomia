import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson } from "./canonical-json.js";
import {
  KnowledgeHeadConflictError,
  materializeTransaction,
  replayKnowledgeLog,
  writeKnowledgeTransaction,
} from "./log.js";
import type { KnowledgeNode, KnowledgeTransactionDraft } from "./types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const node = (id: string, kind: KnowledgeNode["kind"]): KnowledgeNode => ({
  id,
  kind,
  revision: { sourceRevision: "git:a", contentFingerprint: "sha256:a" },
});

function draft(transactionId: string, operations: KnowledgeTransactionDraft["operations"]): KnowledgeTransactionDraft {
  return {
    transactionId,
    analysisSnapshotId: "analysis:a",
    sourceRevisions: { spec: "sha256:a", code: { gitHead: "git:a", contentFingerprint: "sha256:a" }, trace: null },
    origin: "human-approval",
    operations,
    provenance: { proposalIds: [], approval: { kind: "human", reviewRef: "PR-1" }, generatorSchema: 1 },
  };
}

describe("canonical knowledge transaction log", () => {
  it("replays a canonical hash chain into nodes and typed edges", () => {
    const transaction = materializeTransaction(draft("tx:1", [
      { op: "upsert-node", record: node("domain:p/child", "domain") },
      { op: "upsert-node", record: node("domain:p/parent", "domain") },
      { op: "upsert-edge", record: { id: "edge:parent", kind: "subdomain-of", from: "domain:p/child", to: "domain:p/parent" } },
    ]), null);
    const state = replayKnowledgeLog(canonicalJson(transaction) + "\n");
    expect(state.head).toBe(transaction.transactionHash);
    expect(state.nodes.size).toBe(2);
    expect(state.edges.size).toBe(1);
  });

  it("fails fast on malformed lines, dangling edges, cycles, and duplicate transactions", () => {
    expect(() => replayKnowledgeLog("{}\n")).toThrow(/schema/);
    const dangling = materializeTransaction(draft("tx:dangling", [
      { op: "upsert-edge", record: { id: "e", kind: "subdomain-of", from: "a", to: "b" } },
    ]), null);
    expect(() => replayKnowledgeLog(canonicalJson(dangling) + "\n")).toThrow(/dangling/);

    const cycle = materializeTransaction(draft("tx:cycle", [
      { op: "upsert-node", record: node("domain:p/a", "domain") },
      { op: "upsert-node", record: node("domain:p/b", "domain") },
      { op: "upsert-edge", record: { id: "e1", kind: "subdomain-of", from: "domain:p/a", to: "domain:p/b" } },
      { op: "upsert-edge", record: { id: "e2", kind: "subdomain-of", from: "domain:p/b", to: "domain:p/a" } },
    ]), null);
    expect(() => replayKnowledgeLog(canonicalJson(cycle) + "\n")).toThrow(/cycle/);
  });

  it("preserves byte-identical log contents on an expected-head conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-knowledge-log-"));
    roots.push(root);
    const path = join(root, "p.knowledge.jsonl");
    const first = await writeKnowledgeTransaction(path, draft("tx:1", [
      { op: "upsert-node", record: node("domain:p/a", "domain") },
    ]), null);
    const before = await readFile(path);
    await expect(writeKnowledgeTransaction(path, draft("tx:2", []), null))
      .rejects.toBeInstanceOf(KnowledgeHeadConflictError);
    expect(await readFile(path)).toEqual(before);
    expect(replayKnowledgeLog(before.toString("utf8")).head).toBe(first.transactionHash);

    const second = await writeKnowledgeTransaction(path, draft("tx:2", [
      { op: "upsert-node", record: node("domain:p/b", "domain") },
    ]), first.transactionHash);
    const replayed = replayKnowledgeLog(await readFile(path, "utf8"));
    expect(replayed.head).toBe(second.transactionHash);
    expect(replayed.transactions).toHaveLength(2);
  });
});
