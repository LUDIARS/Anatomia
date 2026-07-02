/**
 * Mutation auth gate (auth.ts) — token resolution, loopback detection,
 * fail-fast bind assertion, and the Bearer middleware end-to-end via a Hono
 * app plus the real createApp wiring. Hermetic: no live server, no network.
 */

import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import {
  resolveWebToken,
  isLoopbackHost,
  assertBindAllowed,
  mutationAuth,
} from "../auth.js";
import { createApp } from "../server.js";
import type { AnalysisContext } from "../../../core.js";

const TOKEN = "s3cret-web-token";

// ---------------------------------------------------------------------------
// resolveWebToken
// ---------------------------------------------------------------------------

describe("resolveWebToken", () => {
  it("returns undefined when unset or blank", () => {
    expect(resolveWebToken({})).toBeUndefined();
    expect(resolveWebToken({ ANATOMIA_WEB_TOKEN: "" })).toBeUndefined();
    expect(resolveWebToken({ ANATOMIA_WEB_TOKEN: "   " })).toBeUndefined();
  });

  it("returns the trimmed token when set", () => {
    expect(resolveWebToken({ ANATOMIA_WEB_TOKEN: ` ${TOKEN} ` })).toBe(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// isLoopbackHost
// ---------------------------------------------------------------------------

describe("isLoopbackHost", () => {
  it("accepts loopback spellings", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true); // 127.0.0.0/8
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects non-loopback binds", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assertBindAllowed (fail-fast on non-loopback bind without a token)
// ---------------------------------------------------------------------------

describe("assertBindAllowed", () => {
  it("allows loopback binds without a token", () => {
    expect(() => assertBindAllowed("127.0.0.1", undefined)).not.toThrow();
    expect(() => assertBindAllowed("localhost", undefined)).not.toThrow();
  });

  it("allows non-loopback binds when a token is configured", () => {
    expect(() => assertBindAllowed("0.0.0.0", TOKEN)).not.toThrow();
  });

  it("refuses non-loopback binds without a token (fail-fast, names the env var)", () => {
    expect(() => assertBindAllowed("0.0.0.0", undefined)).toThrow(/ANATOMIA_WEB_TOKEN/);
    expect(() => assertBindAllowed("192.168.1.10", undefined)).toThrow(/ANATOMIA_WEB_TOKEN/);
  });
});

// ---------------------------------------------------------------------------
// mutationAuth middleware (isolated Hono app)
// ---------------------------------------------------------------------------

function gatedApp(): Hono {
  const app = new Hono();
  app.use("*", mutationAuth(TOKEN));
  app.get("/api/projects", (c) => c.json({ ok: true }));
  app.post("/api/projects", (c) => c.json({ created: true }, 201));
  app.delete("/api/projects/x", (c) => c.json({ removed: true }));
  return app;
}

describe("mutationAuth middleware", () => {
  it("lets GET through without a token", async () => {
    const res = await gatedApp().request("/api/projects");
    expect(res.status).toBe(200);
  });

  it("rejects POST without an Authorization header (401)", async () => {
    const res = await gatedApp().request("/api/projects", { method: "POST" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("ANATOMIA_WEB_TOKEN");
  });

  it("rejects POST with a wrong token (401), including a different length", async () => {
    for (const bad of ["wrong-token", "x", `${TOKEN}-and-more`]) {
      const res = await gatedApp().request("/api/projects", {
        method: "POST",
        headers: { authorization: `Bearer ${bad}` },
      });
      expect(res.status).toBe(401);
    }
  });

  it("rejects a non-Bearer scheme (401)", async () => {
    const res = await gatedApp().request("/api/projects", {
      method: "POST",
      headers: { authorization: `Basic ${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it("accepts POST and DELETE with the correct Bearer token", async () => {
    const app = gatedApp();
    const post = await app.request("/api/projects", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(post.status).toBe(201);
    const del = await app.request("/api/projects/x", {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(del.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// createApp wiring (ANATOMIA_WEB_TOKEN read from the environment)
// ---------------------------------------------------------------------------

/** Minimal single-context fixture — auth is decided before any graph access. */
function minimalCtx(): AnalysisContext {
  return {
    repoPath: "/fixture",
    graph: {
      allNodes: async () => [],
      edgesFrom: async () => [],
    },
    files: [],
    functions: [],
    domains: [],
    links: [],
    specClauses: [],
  } as unknown as AnalysisContext;
}

describe("createApp auth wiring", () => {
  const saved = process.env.ANATOMIA_WEB_TOKEN;
  afterEach(() => {
    if (saved === undefined) delete process.env.ANATOMIA_WEB_TOKEN;
    else process.env.ANATOMIA_WEB_TOKEN = saved;
  });

  it("with ANATOMIA_WEB_TOKEN set, gates mutations but not reads", async () => {
    process.env.ANATOMIA_WEB_TOKEN = TOKEN;
    const app = createApp(minimalCtx());

    const read = await app.request("/api/projects");
    expect(read.status).toBe(200);

    const unauthed = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", rootPath: "/x" }),
    });
    expect(unauthed.status).toBe(401);

    // Correct token passes auth; single-context mode then answers 501
    // (manager required) — i.e. the request reached the route handler.
    const authed = await app.request("/api/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ name: "x", rootPath: "/x" }),
    });
    expect(authed.status).toBe(501);
  });

  it("without ANATOMIA_WEB_TOKEN, mutations pass straight to the routes", async () => {
    delete process.env.ANATOMIA_WEB_TOKEN;
    const app = createApp(minimalCtx());
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", rootPath: "/x" }),
    });
    expect(res.status).toBe(501); // no auth gate — single-context 501, not 401
  });
});
