/**
 * Web adapter tests — single-context (legacy) mode + manager mode.
 *
 * All tests call app.fetch() directly; no live HTTP server is started.
 *
 * Suite A — single-context mode:
 *   Tests the legacy createApp(ctx) path (backwards-compat) plus the new
 *   per-project data routes (GET /api/projects/:id/summary|hotspots|spec-links|domains|vis-data)
 *   which work with the repo-derived id in single-context mode.
 *
 * Suite B — manager mode:
 *   Tests project CRUD routes (POST /api/projects, DELETE, POST /:id/analyze)
 *   using a real temp directory with a minimal C++ fixture file.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
    expect(body.projects[0].id).toBe("fixture");
  });
});

describe("GET /api/projects/:id/summary (single-context)", () => {
  it("returns count fields for the repo-derived id", async () => {
    const res = await singleApp.fetch(
      new Request("http://localhost/api/projects/fixture/summary"),
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

describe("POST /api/projects/:id/test-suggestions (single-context)", () => {
  it("forwards a shaped Augur plan request and returns suggestions", async () => {
    vi.stubEnv("ANATOMIA_AUGUR_URL", "");
    vi.stubEnv("AUGUR_URL", "");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        summary: "Create regression guidance from Anatomia evidence.",
        testPlan: {
          suggestions: [{
            id: "test-001",
            title: "Cache generation request regression",
            kind: "regression",
            priority: "high",
            confidence: 0.86,
            targetFiles: ["src/adapters/web/public/index.html"],
            rationale: "The cache generation control is user-facing and stateful.",
            draft: {
              framework: "vitest",
              description: "Assert the request is posted once and the button is disabled while pending.",
              outline: ["Arrange dashboard state", "Click generate", "Assert disabled state"],
            },
            evidenceIds: ["ev-001"],
          }],
        },
        fixPolicy: {
          strategy: "test_first",
          steps: [{ id: "fix-001", title: "Add regression test", description: "Cover the cache action." }],
          risks: [],
        },
        evidence: [{ id: "ev-001", type: "objective", detail: "Objective supplied." }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      const res = await singleApp.fetch(
        new Request("http://localhost/api/projects/fixture/test-suggestions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            objective: {
              kind: "bug_fix",
              description: "Cache generation should disable while the request is running.",
              desiredOutcome: "All related requests are healthy and usable.",
            },
            change: { changedFiles: ["src/adapters/web/public/index.html"] },
          }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as {
        suggestions: Array<{ title: string; kind: string }>;
        request: {
          objective: { kind: string };
          project: { testRunners: string[] };
          change: { changedFiles: string[] };
          runtimeSignals: Array<{ name: string }>;
        };
      };
      expect(body.suggestions[0]).toMatchObject({
        title: "Cache generation request regression",
        kind: "regression",
      });
      expect(body.request.project.testRunners).toContain("vitest");
      expect(body.request.change.changedFiles).toEqual(["src/adapters/web/public/index.html"]);
      expect(body.request.runtimeSignals.some((signal) => signal.name === "anatomia.files")).toBe(true);

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://127.0.0.1:4210/v1/plans");
      expect(typeof calls[0].init?.body).toBe("string");
      const forwarded = JSON.parse(calls[0].init?.body as string) as {
        objective: { kind: string };
        project: { frameworks: string[] };
      };
      expect(forwarded.objective.kind).toBe("bug_fix");
      expect(forwarded.project.frameworks).toContain("hono");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("returns 503 when Augur is unreachable", async () => {
    vi.stubEnv("ANATOMIA_AUGUR_URL", "");
    vi.stubEnv("AUGUR_URL", "");
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });

    try {
      const res = await singleApp.fetch(
        new Request("http://localhost/api/projects/fixture/test-suggestions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            objective: {
              kind: "regression",
              description: "Protect the cache generation workflow.",
            },
          }),
        }),
      );
      expect(res.status).toBe(503);
      const body = await res.json() as { error: string; augurUrl: string };
      expect(body.error).toBe("Augur is not reachable");
      expect(body.augurUrl).toBe("http://127.0.0.1:4210");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

describe("GET /api/projects/:id/hotspots (single-context)", () => {
  it("returns an array", async () => {
    const res = await singleApp.fetch(
      new Request("http://localhost/api/projects/fixture/hotspots"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  it("hotspot entries have expected shape", async () => {
    const res = await singleApp.fetch(
      new Request("http://localhost/api/projects/fixture/hotspots"),
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
      new Request("http://localhost/api/projects/fixture/spec-links"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("GET /api/projects/:id/domains (single-context)", () => {
  it("returns an array (empty for fixture context)", async () => {
    const res = await singleApp.fetch(
      new Request("http://localhost/api/projects/fixture/domains"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("GET /api/projects/:id/vis-data (single-context)", () => {
  it("returns vis-network data with nodes/edges/groups/summary", async () => {
    const res = await singleApp.fetch(
      new Request("http://localhost/api/projects/fixture/vis-data"),
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
      new Request("http://localhost/api/projects/fixture/vis-data"),
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
    const body = await res.text();
    expect(body).toContain('data-tab="test-suggestions"');
    expect(body).toContain('id="augur-run"');
  });
});

describe("GET /domain-view-logic.js", () => {
  it("serves the pure panel logic as JavaScript (browser loads it as a module)", async () => {
    const res = await singleApp.fetch(new Request("http://localhost/domain-view-logic.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("javascript");
    const body = await res.text();
    expect(body).toContain("export function foldUnitGraph");
  });
});

// ---------------------------------------------------------------------------
// Suite B — manager mode (project CRUD)
// ---------------------------------------------------------------------------

let tempDir: string;
let managerApp: Hono;

async function waitForAnalyzeJob(jobId: string, timeoutMs = 30000): Promise<{ state: string; result: { files: number; functions: number } | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await managerApp.fetch(new Request("http://localhost/api/analyze-jobs"));
    const body = await res.json() as {
      jobs: Array<{ id: string; state: string; result: { files: number; functions: number } | null }>;
    };
    const job = body.jobs.find((j) => j.id === jobId);
    if (job && (job.state === "done" || job.state === "failed")) return job;
    if (Date.now() > deadline) throw new Error(`analysis job ${jobId} did not finish: ${JSON.stringify(job)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

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
  it("queues re-analysis and exposes the completed job counts", async () => {
    const res = await managerApp.fetch(
      new Request("http://localhost/api/projects/fixture/analyze", { method: "POST" }),
    );
    expect(res.status).toBe(202);
    const body = await res.json() as { jobId: string; projectId: string; state: string };
    expect(body.projectId).toBe("fixture");
    expect(body.state).toBe("queued");

    const job = await waitForAnalyzeJob(body.jobId);
    expect(job.state, JSON.stringify(job)).toBe("done");
    expect(typeof job.result?.files).toBe("number");
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
      new Request("http://localhost/api/projects/fixture", { method: "DELETE" }),
    );
    expect(res.status).toBe(501);
  });

  it("POST /api/projects/:id/analyze returns 501", async () => {
    const res = await singleApp.fetch(
      new Request("http://localhost/api/projects/fixture/analyze", { method: "POST" }),
    );
    expect(res.status).toBe(501);
  });
});
