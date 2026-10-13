/**
 * POST /api/projects/:id/domain-organization/proposals/review-notes, end to end
 * through the route and the domain application against a temporary knowledge log.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeKnowledgeTransaction } from "../../../knowledge/log.js";
import type { ProjectManager } from "../../../project/manager.js";
import { mountDomainOrganizationRoutes } from "../routes/domain-organization.js";

let root: string;

function fakeManager(rootPath: string): ProjectManager {
  const project = { id: "sample", name: "sample", rootPath };
  return {
    resolveId: (id?: string) => id ?? "sample",
    get: () => project,
    getContext: async () => ({}),
    fingerprint: async () => "abc",
    cache: { invalidate: () => undefined },
    analyzeProject: async () => ({}),
  } as unknown as ProjectManager;
}

async function seedDomain(rootPath: string, domainId: string): Promise<string> {
  const logPath = join(rootPath, "spec", "data", "domain-map", "sample.knowledge.jsonl");
  await mkdir(join(rootPath, "spec", "data", "domain-map"), { recursive: true });
  await writeKnowledgeTransaction(logPath, {
    transactionId: "tx:seed",
    analysisSnapshotId: "snap",
    sourceRevisions: { spec: "r1", code: null, trace: null },
    origin: "human-approval",
    operations: [{ op: "upsert-node", record: {
      id: domainId, kind: "domain", revision: { sourceRevision: "r1", contentFingerprint: "f1" }, data: { name: "combat" } } }],
    provenance: { proposalIds: [], approval: { kind: "human", reviewRef: null }, generatorSchema: 1 },
  }, null);
  return logPath;
}

function post(app: Hono, body: unknown) {
  return app.request("/api/projects/sample/domain-organization/proposals/review-notes", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "anatomia-review-notes-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("domain review notes route", () => {
  it("turns a note on a known domain into a Gate A draft and reports the unknown one", async () => {
    const logPath = await seedDomain(root, "domain:combat");
    const before = await readFile(logPath, "utf8");
    const app = new Hono();
    mountDomainOrganizationRoutes(app, fakeManager(root));

    const res = await post(app, { notes: [
      { domainId: "domain:combat", note: "説明が古い。武器のダメージは含めない", reviewRef: "cc:answer/1", kind: "description" },
      { domainId: "domain:magic", note: "魔法も入れて", reviewRef: "cc:answer/2" },
    ] });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      proposals: Array<{ kind: string; affectedDomainIds: string[]; note: string; requiresGate: string; analysisSnapshotId: string }>;
      rejected: Array<{ index: number; reviewRef: string | null; reason: string }>;
      expectedHead: string | null;
    };
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({
      kind: "review-note", affectedDomainIds: ["domain:combat"], note: "説明が古い。武器のダメージは含めない",
      requiresGate: "gate-a", analysisSnapshotId: "analysis:abc",
    });
    expect(body.rejected).toEqual([{ index: 1, reviewRef: "cc:answer/2", reason: "unknown domain domain:magic" }]);
    // The draft carries the current log head so Gate A can refuse it once the log moves on.
    expect(body.expectedHead).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Drafting never writes the knowledge log; only Gate A does.
    expect(await readFile(logPath, "utf8")).toBe(before);
  });

  it("refuses a request without notes", async () => {
    await seedDomain(root, "domain:combat");
    const app = new Hono();
    mountDomainOrganizationRoutes(app, fakeManager(root));
    const res = await post(app, { notes: [] });
    expect(res.status).toBe(400);
  });

  it("needs manager mode", async () => {
    const app = new Hono();
    mountDomainOrganizationRoutes(app, null);
    expect((await post(app, { notes: [] })).status).toBe(501);
  });
});
