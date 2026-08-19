/**
 * src/knowledge/entrypoint/entrypoint.test.ts — commit + project the entry set.
 */

import { afterEach, describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnchorId, AstNode, FunctionNode } from "../../types.js";
import type { EntryPointGraph } from "../../entrypoints/types.js";
import { replayKnowledgeLog, writeKnowledgeTransaction } from "../log.js";
import { materializeEntryPointGraph } from "./derive.js";
import { syncCanonicalEntryPoints } from "./sync.js";
import { computeEntryPointSourceRevision } from "./project-reader.js";
import type { Project } from "../../project/types.js";

const ROOT = "/repo";
const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryRoots].map((root) => rm(root, { recursive: true, force: true })));
  temporaryRoots.clear();
});

function fn(name: string, path: string): FunctionNode {
  return {
    id: `${path}#${name}` as AnchorId,
    name,
    signature: `void ${name}()`,
    sourceRange: {
      start: { line: 0, column: 0 }, end: { line: 3, column: 0 }, filePath: `${ROOT}/${path}`,
    },
    bodyAst: { type: "block", children: [] } as unknown as AstNode,
  };
}

const handler = fn("handleUsers", "src/routes.ts");
// The log already holds this domain; "billing" is a heuristic name that must not
// become an edge.
const knownDomainIds = new Set(["domain:fixture/users"]);

function graph(): EntryPointGraph {
  return {
    schemaVersion: 1,
    projectId: "fixture",
    sourceRevision: "sha256:rev",
    definitionFingerprint: "sha256:fp",
    entries: [{
      id: String(handler.id),
      classes: ["http-route"],
      detector: ["http-route"],
      symbol: { anchor: handler.id as AnchorId, name: "handleUsers", path: "src/routes.ts", line: 0 },
      reached: 2,
      maxDistance: 1,
      activatesDomains: { business: ["domain:fixture/users", "billing"], program: [] },
      frontierCount: 0,
    }],
    nodes: [],
    edges: [],
    unrooted: [],
    diagnostics: [],
  };
}

/**
 * A log that already holds the domain the entry activates. The entry layer only
 * links to domains that exist, so the fixture has to create one the same way the
 * domain layer would.
 */
async function tempRoots(): Promise<{ log: string; generated: string; head: string }> {
  const dir = await mkdtemp(join(tmpdir(), "anatomia-entrypoint-knowledge-"));
  temporaryRoots.add(dir);
  const log = join(dir, "knowledge.jsonl");
  const seeded = await writeKnowledgeTransaction(log, {
    transactionId: "tx:seed-domain",
    analysisSnapshotId: "seed",
    sourceRevisions: { spec: null, code: "sha256:rev", trace: null },
    origin: "human-approval",
    operations: [{
      op: "upsert-node",
      record: {
        id: "domain:fixture/users",
        kind: "domain",
        revision: { sourceRevision: "sha256:rev", contentFingerprint: "seed" },
        data: { name: "users" },
      },
    }],
    provenance: { proposalIds: [], approval: { kind: "human", reviewRef: null }, generatorSchema: 1 },
  }, null);
  return { log, generated: join(dir, "generated"), head: seeded.transactionHash };
}

describe("entry-point knowledge sync", () => {
  it("treats an entrypoints.json-only edit as a source revision change", async () => {
    const root = await mkdtemp(join(tmpdir(), "anatomia-entrypoint-revision-"));
    try {
      const knowledgeWriteRoot = join(root, "spec");
      await mkdir(knowledgeWriteRoot, { recursive: true });
      const project: Project = {
        id: "fixture",
        name: "Fixture",
        rootPath: root,
        knowledgeWriteRoot,
        addedAt: "2026-08-19T00:00:00.000Z",
      };
      const before = await computeEntryPointSourceRevision(project);
      await mkdir(join(root, ".anatomia"), { recursive: true });
      await writeFile(join(root, ".anatomia", "entrypoints.json"), '{"includeTests":true}', "utf8");
      expect(await computeEntryPointSourceRevision(project)).not.toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("commits the derived set and writes the artifact", async () => {
    const { log, generated, head } = await tempRoots();
    const canonical = materializeEntryPointGraph({ graph: graph(), projectRoot: ROOT, functions: [handler], knownDomainIds });
    const result = await syncCanonicalEntryPoints({
      canonical, knowledgeLogPath: log, generatedRoot: generated, expectedHead: head,
    });
    expect(result.canonicalChanged).toBe(true);
    expect(result.projectionsStale).toBe(false);
    const artifact = JSON.parse(await readFile(join(generated, "entrypoint-graph.json"), "utf8"));
    expect(artifact.entries[0].symbol.name).toBe("handleUsers");
    expect(artifact.knowledgeHead).toBe(result.knowledgeHead);
  });

  it("emits domain edges only for knowledge entity ids, never heuristic names", async () => {
    const canonical = materializeEntryPointGraph({ graph: graph(), projectRoot: ROOT, functions: [handler], knownDomainIds });
    const domainEdges = canonical.edges.filter((edge) => edge.kind === "entry-point-activates-domain");
    expect(domainEdges).toHaveLength(1);
    expect(domainEdges[0]!.to).toBe("domain:fixture/users");
  });

  it("preserves a code-symbol record owned by another knowledge pipeline", async () => {
    const { log, generated, head } = await tempRoots();
    const canonical = materializeEntryPointGraph({ graph: graph(), projectRoot: ROOT, functions: [handler], knownDomainIds });
    const generatedSymbol = canonical.nodes.find((node) => node.kind === "code-symbol")!;
    const existingSymbol = {
      ...generatedSymbol,
      revision: { ...generatedSymbol.revision, sourceRevision: "sha256:approved" },
      data: { ...generatedSymbol.data, qualifiedName: "approvedHandler", derivedOwner: "domain:fixture" },
    };
    const seeded = await writeKnowledgeTransaction(log, {
      transactionId: "tx:seed-code-symbol",
      analysisSnapshotId: "seed-code-symbol",
      sourceRevisions: { spec: null, code: "sha256:approved", trace: null },
      origin: "code-sync",
      operations: [{ op: "upsert-node", record: existingSymbol }],
      provenance: { proposalIds: [], approval: { kind: "automatic", reviewRef: null }, generatorSchema: 1 },
    }, head);

    await syncCanonicalEntryPoints({
      canonical,
      knowledgeLogPath: log,
      generatedRoot: generated,
      expectedHead: seeded.transactionHash,
    });
    const persisted = replayKnowledgeLog(await readFile(log, "utf8")).nodes.get(existingSymbol.id);
    expect(persisted?.data?.["qualifiedName"]).toBe("approvedHandler");
    expect(persisted?.data?.["derivedOwner"]).toBe("domain:fixture");
  });

  it("re-syncing an unchanged set writes no second transaction", async () => {
    const { log, generated, head } = await tempRoots();
    const canonical = materializeEntryPointGraph({ graph: graph(), projectRoot: ROOT, functions: [handler], knownDomainIds });
    const first = await syncCanonicalEntryPoints({
      canonical, knowledgeLogPath: log, generatedRoot: generated, expectedHead: head,
    });
    const second = await syncCanonicalEntryPoints({
      canonical, knowledgeLogPath: log, generatedRoot: generated, expectedHead: first.knowledgeHead,
    });
    expect(second.canonicalChanged).toBe(false);
    expect(second.transaction).toBeNull();
    expect(replayKnowledgeLog(await readFile(log, "utf8")).head).toBe(first.knowledgeHead);
  });

  it("refuses to commit against a moved head", async () => {
    const { log, generated, head } = await tempRoots();
    const canonical = materializeEntryPointGraph({ graph: graph(), projectRoot: ROOT, functions: [handler], knownDomainIds });
    await syncCanonicalEntryPoints({ canonical, knowledgeLogPath: log, generatedRoot: generated, expectedHead: head });
    await expect(syncCanonicalEntryPoints({
      canonical, knowledgeLogPath: log, generatedRoot: generated, expectedHead: head,
    })).rejects.toThrow(/head conflict/);
  });
});
