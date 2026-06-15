/**
 * Web adapter tests — single-context (legacy) mode + manager mode.
 *
 * All tests call app.fetch() directly; no live HTTP server is started.
 *
 * Suite A — single-context mode:
 *   Tests the legacy createApp(ctx) path (backwards-compat) plus the new
 *   per-project data routes (GET /api/projects/:id/summary|hotspots|spec-links|domains|vis-data)
 *   which work with id="default" in single-context mode.
 *
 * Suite B — manager mode:
 *   Tests project CRUD routes (POST /api/projects, DELETE, POST /:id/analyze)
 *   using a real temp directory with a minimal C++ fixture file.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile as writeFs } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildFromSource } from "../../supply/__tests__/helpers.js";
import { createApp } from "../web/server.js";
import { ProjectManager } from "../../project/manager.js";
import { ProjectRegistry } from "../../project/registry.js";
import type { AnalysisContext } from "../../core.js";
import type { Hono } from "hono";

// ---------------------------------------------------------------------------
// Shared C++ fixture (3 functions with call relationships)
// ---------------------------------------------------------------------------

const CPP_FIXTURE = `
void alpha() { }
void beta()  { alpha(); }
void gamma() { beta(); alpha(); }
`;

// ---------------------------------------------------------------------------
// Suite A — single-context mode
// ---------------------------------------------------------------------------

let singleApp: Hono;

beforeAll(async () => {
  const { graph, file, functions } = await buildFromSource(CPP_FIXTURE);
  const ctx: AnalysisContext = {
    repoPath: "/fixture",
    graph,
    files: [file],
    functions,
    domains: [],
    links: [],
    specClauses: [],
  };
  singleApp = createApp(ctx);
});

describe("GET /api/graph (single-context)", () => {
  it("returns { nodes, edges } arrays", async () => {
    const res = await singleApp.fetch(new Request("http://localhost/api/graph"));
    expect(res.status).toBe(200);
    const body = await res.json() as { nodes: unknown[]; edges: unknown[] };
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
  });

  it("nodes have expected shape", async () => {
    const res = await singleApp.fetch(new Request("http://localhost/api/graph"));
    const body = await res.json() as { nodes: Array<{ id: string; name: string; kind: string }> };
    expect(body.nodes.length).toBeGreaterThan(0);
    const node = body.nodes[0];
    expect(node).toHaveProperty("id");
    expect(node).toHaveProperty("name");
    expect(node).toHaveProperty("kind");
  });

  it("edges have from/to/kind", async () => {
    const res = await singleApp.fetch(new Request("http://localhost/api/graph"));
    const body = await res.json() as { edges: Array<{ from: string; to: string; kind: string }> };
    expect(Array.isArray(body.edges)).toBe(true);
    if (body.edges.length > 0) {
      expect(body.edges[0]).toHaveProperty("from");
      expect(body.edges[0]).toHaveProperty("to");
      expect(body.edges[0]).toHaveProperty("kind");
    }
  });
});

describe("GET /api/metrics (single-context)", () => {
  it("returns an array of NodeMetrics", async () => {
    const res = await singleApp.fetch(new Request("http://localhost/api/metrics"));
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ anchor: string; fanIn: number; fanOut: number }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it("each metric has expected numeric fields", async () => {
    const res = await singleApp.fetch(new Request("http://localhost/api/metrics"));
    const body = await res.json() as Array<Record<string, unknown>>;
    const m = body[0];
    expect(m).toHaveProperty("anchor");
    expect(m).toHaveProperty("fanIn");
    expect(m).toHaveProperty("fanOut");
    expect(m).toHaveProperty("coupling");
    expect(m).toHaveProperty("cyclomatic");
  });
});

describe("GET /api/domains (single-context)", () => {
  it("returns { domains, cards }", async () => {
    const res = await singleApp.fetch(new Request("http://localhost/api/domains"));
    expect(res.status).toBe(200);
    const body = await res.json() as { domains: unknown[]; cards: unknown[] };
    expect(Array.isArray(body.domains)).toBe(true);
    expect(Array.isArray(body.cards)).toBe(true);
  });
});

describe("GET /api/projects (single-context)", () => {
  it("lists a single synthetic project", async () => {
    const res = await singleApp.fetch(new Request("http://localhost/api/projects"));
    expect(res.status).toBe(200);
    const body = await res.json() as { projects: Array<{ id: string }> };
    expect(body.projects.length).toBe(1);
    expect(body.projects[0].id).toBe("default");
  });
});

describe("GET /api/projects/:id/summary (single-context)", () => {
  it("returns count fields for id=default", async () => {
    const res = await singleApp.fetch(
      new Request("http://localhost/api/projects/default/summary"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, number>;
    expect(typeof body.files).toBe("number");
    expect(typeof body.functions).toBe("number");
    expect(typeof body.nodes).toBe("number");
    expect(typeof body.edges).toBe("number");
    expect(typeof body.domains).toBe("number");
    expect(typeof body.links).toBe("number");
  });
});

describe("GET /api/projects/:id/hotspots (single-context)", () => {
  it("returns an array", async () => {
    const res = await singleApp.fetch(
      new Request("http://localhost/api/projects/default/hotspots"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  it("hotspot entries have expected shape", async () => {
    const res = await singleApp.fetch(
      new Request("http://localhost/api/projects/default/hotspots"),
    );
    const body = await res.json() as Array<Record<string, unknown>>;
    if (body.length > 0) {
      const h = body[0];
      expect(h).toHaveProperty("anchor");
      expect(h).toHaveProperty("name");
      expect(h).toHaveProperty("coupling");
      expect(h).toHaveProperty("cyclomatic");
      expect(h).toHaveProperty("fanIn");
      expect(h).toHaveProperty("fanOut");
    }
  });
});

describe("GET /api/projects/:id/spec-links (single-context)", () => {
  it("returns an array (empty for fixture context)", async () => {
    const res = await singleApp.fetch(
      new Request("http://localhost/api/projects/default/spec-links"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("GET /api/projects/:id/domains (single-context)", () => {
  it("returns an array (empty for fixture context)", async () => {
    const res = await singleApp.fetch(
      new Request("http://localhost/api/projects/default/domains"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("GET /api/projects/:id/vis-data (single-context)", () => {
  it("returns vis-network data with nodes/edges/groups/summary", async () => {
    const res = await singleApp.fetch(
      new Request("http://localhost/api/projects/default/vis-data"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      nodes: unknown[];
      edges: unknown[];
      groups: unknown[];
      summary: { nodeCount: number; edgeCount: number };
    };
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
    expect(Array.isArray(body.groups)).toBe(true);
    expect(body.summary).toHaveProperty("nodeCount");
    expect(body.summary).toHaveProperty("edgeCount");
  });

  it("vis-data nodes include _meta fields", async () => {
    const res = await singleApp.fetch(
      new Request("http://localhost/api/projects/default/vis-data"),
    );
    const body = await res.json() as { nodes: Array<{ _meta: Record<string, unknown> }> };
    if (body.nodes.length > 0) {
      const meta = body.nodes[0]._meta;
      expect(meta).toHaveProperty("name");
      expect(meta).toHaveProperty("coupling");
      expect(meta).toHaveProperty("cyclomatic");
    }
  });
});

describe("GET / (single-context)", () => {
  it("returns HTML page", async () => {
    const res = await singleApp.fetch(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("html");
  });
});

// ---------------------------------------------------------------------------
// Suite B — manager mode (project CRUD)
// ---------------------------------------------------------------------------

let tempDir: string;
let managerApp: Hono;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "anatomia-web-test-"));
  // Write a minimal .cpp fixture so analyze() has something to parse.
  await writeFs(join(tempDir, "fixture.cpp"), "void foo() { } void bar() { foo(); }\n", "utf8");
  const registry = new ProjectRegistry();
  const manager  = new ProjectManager(registry, { homeDir: tempDir });
  managerApp = createApp(manager);
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("GET /api/projects (manager mode — empty)", () => {
  it("returns empty list initially", async () => {
    const res = await managerApp.fetch(new Request("http://localhost/api/projects"));
    expect(res.status).toBe(200);
    const body = await res.json() as { projects: unknown[] };
    expect(body.projects).toHaveLength(0);
  });
});

describe("POST /api/projects (manager mode)", () => {
  it("registers and analyzes a new project", async () => {
    const res = await managerApp.fetch(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "fixture", rootPath: tempDir }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json() as {
      project: { id: string; name: string };
      analyzed: { files: number; functions: number };
    };
    expect(body.project.name).toBe("fixture");
    expect(body.project.id).toBe("fixture");
    expect(typeof body.analyzed.files).toBe("number");
  });

  it("returns 400 when name is missing", async () => {
    const res = await managerApp.fetch(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootPath: tempDir }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/projects (manager mode — after add)", () => {
  it("lists the registered project", async () => {
    const res = await managerApp.fetch(new Request("http://localhost/api/projects"));
    expect(res.status).toBe(200);
    const body = await res.json() as { projects: Array<{ id: string }> };
    expect(body.projects.some((p) => p.id === "fixture")).toBe(true);
  });
});

describe("GET /api/projects/:id/summary (manager mode)", () => {
  it("returns summary counts for the registered project", async () => {
    const res = await managerApp.fetch(
      new Request("http://localhost/api/projects/fixture/summary"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { files: number; functions: number; nodes: number };
    expect(typeof body.files).toBe("number");
    expect(typeof body.functions).toBe("number");
    expect(typeof body.nodes).toBe("number");
  });

  it("returns 404 for unknown project id", async () => {
    const res = await managerApp.fetch(
      new Request("http://localhost/api/projects/nonexistent/summary"),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/projects/:id/hotspots (manager mode)", () => {
  it("returns hotspot rows for registered project", async () => {
    const res = await managerApp.fetch(
      new Request("http://localhost/api/projects/fixture/hotspots"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("GET /api/projects/:id/spec-links (manager mode)", () => {
  it("returns array", async () => {
    const res = await managerApp.fetch(
      new Request("http://localhost/api/projects/fixture/spec-links"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("GET /api/projects/:id/domains (manager mode)", () => {
  it("returns array", async () => {
    const res = await managerApp.fetch(
      new Request("http://localhost/api/projects/fixture/domains"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("GET /api/projects/:id/vis-data (manager mode)", () => {
  it("returns vis-network data structure", async () => {
    const res = await managerApp.fetch(
      new Request("http://localhost/api/projects/fixture/vis-data"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { nodes: unknown[]; edges: unknown[]; summary: unknown };
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
    expect(body).toHaveProperty("summary");
  });
});

describe("POST /api/projects/:id/analyze (manager mode)", () => {
  it("re-analyzes the project and returns counts", async () => {
    const res = await managerApp.fetch(
      new Request("http://localhost/api/projects/fixture/analyze", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { project: string; files: number };
    expect(body.project).toBe("fixture");
    expect(typeof body.files).toBe("number");
  });

  it("returns 404 for unknown project", async () => {
    const res = await managerApp.fetch(
      new Request("http://localhost/api/projects/nope/analyze", { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/projects/:id (manager mode)", () => {
  it("removes the project", async () => {
    const res = await managerApp.fetch(
      new Request("http://localhost/api/projects/fixture", { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { removed: boolean; id: string };
    expect(body.removed).toBe(true);
    expect(body.id).toBe("fixture");
  });

  it("returns 404 when project is already removed", async () => {
    const res = await managerApp.fetch(
      new Request("http://localhost/api/projects/fixture", { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("Mutation routes in single-context mode", () => {
  it("POST /api/projects returns 501", async () => {
    const res = await singleApp.fetch(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x", rootPath: "/x" }),
      }),
    );
    expect(res.status).toBe(501);
  });

  it("DELETE /api/projects/:id returns 501", async () => {
    const res = await singleApp.fetch(
      new Request("http://localhost/api/projects/default", { method: "DELETE" }),
    );
    expect(res.status).toBe(501);
  });

  it("POST /api/projects/:id/analyze returns 501", async () => {
    const res = await singleApp.fetch(
      new Request("http://localhost/api/projects/default/analyze", { method: "POST" }),
    );
    expect(res.status).toBe(501);
  });
});
