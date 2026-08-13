import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectManager } from "../../../project/manager.js";
import { ProjectRegistry } from "../../../project/registry.js";
import { buildRefactoringProposals } from "../../../review/refactoring-proposals.js";
import { WEB_CACHE_SCHEMA_VERSION, type ProgramDomainViewPayload } from "../../../web-cache/types.js";
import { mountRefactoringTaskRoutes } from "./refactoring-tasks.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "refactoring-route-root-"));
  const home = await mkdtemp(join(tmpdir(), "refactoring-route-home-"));
  temporaryRoots.push(root, home);
  await mkdir(join(root, "spec"), { recursive: true });

  const registry = new ProjectRegistry();
  registry.add({ id: "demo", name: "demo", rootPath: root });
  const manager = new ProjectManager(registry, { homeDir: home });
  vi.spyOn(manager, "fingerprint").mockResolvedValue("fingerprint");

  const proposal = buildRefactoringProposals([{
    rule: "misfit",
    action: "move",
    targets: [{ stableId: "fn:a", file: "src/a.ts", line: 3 }],
    evidence: { metric: "ties", value: 3, threshold: 1, detail: "a" },
    impactRadius: { codeSymbols: 1, modules: 2, domains: 0 },
  }])[0]!;
  const data: ProgramDomainViewPayload = {
    layers: [],
    diagnostics: [],
    classDiagram: { nodes: [], edges: [] },
    dependencies: [],
    modularity: 0,
    proposals: [proposal],
  };
  const web = join(manager.cache.dirFor("demo"), "web");
  await mkdir(web, { recursive: true });
  await writeFile(join(web, "program-domain-view.json"), JSON.stringify({
    version: WEB_CACHE_SCHEMA_VERSION,
    view: "program-domain-view",
    preparedAt: "2026-08-13T00:00:00.000Z",
    fingerprint: "fingerprint",
    data,
  }));
  return { manager, proposal, root };
}

describe("refactoring task route", () => {
  it("requires confirmation and an active cached proposal", async () => {
    const { manager, proposal } = await fixture();
    const sink = { issue: vi.fn(async () => ({ id: "task-1", status: "open" as const })) };
    const app = new Hono();
    mountRefactoringTaskRoutes(app, { manager, sink });

    const malformed = await app.request("/api/projects/demo/refactoring-tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);

    const unconfirmed = await app.request("/api/projects/demo/refactoring-tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: proposal.proposalId }),
    });
    expect(unconfirmed.status).toBe(409);

    const inactive = await app.request("/api/projects/demo/refactoring-tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: "proposal:refactor:missing", confirm: true }),
    });
    expect(inactive.status).toBe(409);
    expect(sink.issue).not.toHaveBeenCalled();
  });

  it("issues once and does not expose internal errors", async () => {
    const { manager, proposal, root } = await fixture();
    const sink = { issue: vi.fn(async () => ({ id: "task-1", status: "open" as const })) };
    const app = new Hono();
    mountRefactoringTaskRoutes(app, { manager, sink });
    const request = () => app.request("/api/projects/demo/refactoring-tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: proposal.proposalId, confirm: true }),
    });

    await expect((await request()).json()).resolves.toMatchObject({ task: { id: "task-1", status: "open" } });
    await expect((await request()).json()).resolves.toMatchObject({ task: { id: "task-1", status: "open" } });
    expect(sink.issue).toHaveBeenCalledTimes(1);

    const failing = new Hono();
    mountRefactoringTaskRoutes(failing, {
      manager,
      sink: { issue: async () => { throw new Error(`private path: ${root}`); } },
    });
    const otherProposal = { ...proposal, proposalId: `${proposal.proposalId}-other` };
    const cachePath = join(manager.cache.dirFor("demo"), "web", "program-domain-view.json");
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as { data: ProgramDomainViewPayload };
    cached.data.proposals.push(otherProposal);
    await writeFile(cachePath, JSON.stringify(cached));
    const response = await failing.request("/api/projects/demo/refactoring-tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: otherProposal.proposalId, confirm: true }),
    });
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain(root);
  });
});
