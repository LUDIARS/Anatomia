/**
 * src/adapters/web/routes/domain-view.ts — Domain-view route.
 *
 * Route:
 *   GET /api/projects/:id/domain-view
 *     → DomainView[] (domains/view.ts): each detected domain with its
 *       implementor anchors (for focusing the graph) and the spec clauses that
 *       give it a Japanese description.
 *
 * SRP: HTTP routing + 404 shaping. View assembly is in domains/view.ts.
 */

import type { Hono } from "hono";
import { buildDomainView } from "../../../domains/view.js";
import type { WebContextSource } from "../context.js";

export function mountDomainViewRoute(app: Hono, source: WebContextSource): void {
  app.get("/api/projects/:id/domain-view", async (c) => {
    const id = c.req.param("id");
    let ctx;
    try {
      ctx = await source.resolve(id);
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }
    // Spec links are file-anchored; domain implementors are function-anchored.
    // Pass the implementor→file map so file-anchored links reach their domain
    // (otherwise every description is null — see domains/view.ts, #324).
    const anchorToFile = new Map<string, string>();
    for (const fn of ctx.functions) {
      if (fn.id) anchorToFile.set(fn.id, fn.sourceRange.filePath);
    }
    const views = buildDomainView(
      ctx.domains ?? [],
      ctx.links ?? [],
      ctx.specClauses ?? [],
      anchorToFile,
    );
    return c.json(views);
  });
}
