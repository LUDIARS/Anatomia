/**
 * POST /api/projects/:id/spec-links/ratify — the web ratification path.
 * Manager-backed: ratifies a proposed link, persists it to the project's
 * spec/data/spec-links.json, and invalidates the cached context so the next
 * analysis serves the merged (ratified) link. Also: 404 unknown project,
 * 400 on missing fields / unknown clause, 501 in legacy single-context mode.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server.js";
import { ProjectManager, ProjectRegistry } from "../../../project/index.js";
import { specLinksPath } from "../../../spec/persist.js";
import { buildFromSource } from "../../../supply/__tests__/helpers.js";
import type { AnalysisContext } from "../../../core.js";
import type { Link } from "../../../types.js";

let home: string;
let root: string;
let mgr: ProjectManager;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "anatomia-ratify-home-"));
  root = await mkdtemp(join(tmpdir(), "anatomia-ratify-root-"));
  await writeFile(join(root, "hash.ts"), "export function hashThing() { return 1; }\n");
  // No basename reference → the proposal stays structural (see persist.test.ts).
  await writeFile(join(root, "spec.md"), "# Hash\nHashing rules live here.\n");
  mgr = new ProjectManager(new ProjectRegistry(), {
    homeDir: home,
    analyzeOptions: { quiet: true },
  });
  await mgr.addProject({ name: "Ratify", rootPath: root });
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

function post(app: ReturnType<typeof createApp>, id: string, body: unknown) {
  return app.fetch(
    new Request(`http://localhost/api/projects/${id}/spec-links/ratify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/projects/:id/spec-links/ratify", () => {
  it("ratifies a proposed link and persists it to spec/data/spec-links.json", async () => {
    const app = createApp(mgr);
    const ctx = await mgr.getContext("ratify");
    const proposal = ctx.links!.find((l) => l.evidence === "structural");
    expect(proposal).toBeDefined();

    const res = await post(app, "ratify", {
      from: String(proposal!.from),
      to: proposal!.to,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { link: Link; wasProposed: boolean; path: string };
    expect(body.wasProposed).toBe(true);
    expect(body.link).toMatchObject({ evidence: "explicit", confidence: 1.0, ratified: true });

    const raw = JSON.parse(await readFile(specLinksPath(root), "utf8")) as {
      version: number;
      links: Link[];
    };
    expect(raw.version).toBe(1);
    expect(raw.links).toHaveLength(1);

    // Cache was invalidated → the next context serves the merged ratified link.
    const next = await mgr.getContext("ratify");
    const merged = next.links!.filter(
      (l) => l.from === proposal!.from && l.to === proposal!.to,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.ratified).toBe(true);
  });

  it("returns 400 when from/to are missing", async () => {
    const app = createApp(mgr);
    const res = await post(app, "ratify", { from: "only-from" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unknown clause id", async () => {
    const app = createApp(mgr);
    const res = await post(app, "ratify", { from: "x", to: "no-such-clause-00000000" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown project", async () => {
    const app = createApp(mgr);
    const res = await post(app, "nope", { from: "x", to: "y" });
    expect(res.status).toBe(404);
  });

  it("returns 501 in legacy single-context mode", async () => {
    const { graph, file, functions } = await buildFromSource("void leg() { }\n");
    const ctx: AnalysisContext = { repoPath: "/legacy", graph, files: [file], functions };
    const app = createApp(ctx);
    const res = await post(app, "legacy", { from: "x", to: "y" });
    expect(res.status).toBe(501);
  });
});
