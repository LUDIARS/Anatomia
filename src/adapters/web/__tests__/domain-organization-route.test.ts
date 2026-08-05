/**
 * /api/projects/:id/domain-organization — the web organization surface.
 * Manager-backed and hermetic: drives the real spec → Gate A → assignment →
 * Gate B flow over a temp project so the route glue (revision stamping, path
 * resolution, head conflict → 409, 501 in legacy single-context mode) is
 * covered, not just the knowledge-layer services underneath it.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server.js";
import { ProjectManager, ProjectRegistry } from "../../../project/index.js";
import type { DomainOrganizationView } from "../../../knowledge/domain/organization-view.js";
import type { DomainAssignmentAction, DomainProposal } from "../../../knowledge/domain/types.js";

let home: string;
let root: string;
let mgr: ProjectManager;

const BASE = "http://localhost/api/projects/org/domain-organization";

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "anatomia-org-home-"));
  root = await mkdtemp(join(tmpdir(), "anatomia-org-root-"));
  await mkdir(join(root, "spec"), { recursive: true });
  await writeFile(join(root, "combat.ts"), "export function resolveHit() { return 1; }\n");
  await writeFile(
    join(root, "spec", "combat.md"),
    "# Combat resolution\n\nA hit is resolved against the defender.\n",
  );
  mgr = new ProjectManager(new ProjectRegistry(), {
    homeDir: home,
    analyzeOptions: { quiet: true },
  });
  await mgr.addProject({ name: "Org", rootPath: root });
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

function post(app: ReturnType<typeof createApp>, path: string, body?: unknown) {
  return app.fetch(new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

async function view(app: ReturnType<typeof createApp>): Promise<DomainOrganizationView> {
  const res = await app.fetch(new Request(BASE));
  expect(res.status).toBe(200);
  return await res.json() as DomainOrganizationView;
}

describe("domain organization routes", () => {
  it("drives spec proposal → Gate A → assignment → Gate B over HTTP", async () => {
    const app = createApp(mgr);

    const before = await view(app);
    expect(before.knowledgeHead).toBeNull();
    expect(before.domains).toEqual([]);
    const analyzed = before.unassignedCodeSymbols.find((s) => s.qualifiedName === "resolveHit");
    expect(analyzed?.anchorId).toBeTruthy();
    // Analyzed-but-unlogged code is the code-only side of the drift report.
    expect(before.driftFindings.some((f) => f.kind === "code-only" && f.entityId === analyzed!.id)).toBe(true);

    const proposed = await post(app, "/proposals/spec");
    expect(proposed.status).toBe(200);
    const bundle = await proposed.json() as { proposals: DomainProposal[]; expectedHead: string | null };
    expect(bundle.expectedHead).toBeNull();
    expect(bundle.proposals.length).toBeGreaterThan(0);
    // Gate A input must stay spec-only: no code path leaks into the semantics.
    expect(bundle.proposals.every((p) => p.sourceClauseIds.length > 0)).toBe(true);

    const gateA = await post(app, "/gate-a", {
      confirmApply: true,
      proposals: bundle.proposals,
      hierarchy: [],
      expectedHead: bundle.expectedHead,
      reviewRef: "test:gate-a",
    });
    expect(gateA.status).toBe(200);
    const applied = await gateA.json() as { writtenDomainFiles: string[]; canonicalCommitted: boolean };
    expect(applied.canonicalCommitted).toBe(true);
    expect(applied.writtenDomainFiles.length).toBe(bundle.proposals.length);

    // Replaying the same proposals against the stale head is a conflict, not a
    // second apply.
    const stale = await post(app, "/gate-a", {
      confirmApply: true,
      proposals: bundle.proposals,
      hierarchy: [],
      expectedHead: bundle.expectedHead,
      reviewRef: "test:gate-a",
    });
    expect(stale.status).toBe(409);

    const afterGateA = await view(app);
    expect(afterGateA.knowledgeHead).not.toBeNull();
    const domain = afterGateA.domains.find((d) => d.id === bundle.proposals[0].candidateId);
    expect(domain).toBeDefined();
    expect(domain!.implementationStatus).toBe("missing");
    const target = afterGateA.unassignedCodeSymbols.find((s) => s.qualifiedName === "resolveHit");
    expect(target?.anchorId).toBeTruthy();

    const assignment = await post(app, "/proposals/assignment", {
      anchorId: target!.anchorId,
      domainId: domain!.id,
    });
    expect(assignment.status).toBe(200);
    const proposal = await assignment.json() as {
      action: DomainAssignmentAction;
      expectedHead: string | null;
      codeRevision: string;
    };
    expect(proposal.action.action).toBe("assign-existing");
    expect(proposal.action.afterOwner).toBe(domain!.id);
    expect(proposal.action.symbol.sourcePath).toMatch(/^combat\.ts$/);

    const gateB = await post(app, "/gate-b", {
      confirmApply: true,
      actions: [proposal.action],
      expectedHead: proposal.expectedHead,
      codeRevision: proposal.codeRevision,
      reviewRef: "test:gate-b",
    });
    expect(gateB.status).toBe(200);

    const afterGateB = await view(app);
    expect(afterGateB.domains.find((d) => d.id === domain!.id)!.implementationStatus).toBe("implemented");
    expect(afterGateB.unassignedCodeSymbols.some((s) => s.qualifiedName === "resolveHit")).toBe(false);
    expect(afterGateB.typedEdges.some((e) => e.kind === "domain-owns-code" && e.from === domain!.id)).toBe(true);
  }, 120_000);

  it("rejects a Gate C OKF write that escapes the knowledge write root", async () => {
    const app = createApp(mgr);
    const res = await post(app, "/gate-c", {
      confirmApply: true,
      kind: "split",
      proposals: [],
      okfWrites: [{ path: "../../escape.md", content: "x", expectedContentHash: null }],
      operations: [],
      expectedHead: null,
      reviewRef: "test:gate-c",
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/escapes knowledgeWriteRoot/);
  });

  it("requires manager mode", async () => {
    const ctx = await mgr.getContext("org");
    const app = createApp(ctx);
    const res = await post(app, "/proposals/spec");
    expect(res.status).toBe(501);
  });
});
