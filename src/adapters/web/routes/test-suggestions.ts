/**
 * src/adapters/web/routes/test-suggestions.ts -- Augur test suggestion bridge.
 *
 * Anatomia owns project analysis; Augur owns test-planning suggestions. This
 * route shapes a small CreatePlanRequest from the current project + user
 * objective and forwards it to Augur's local HTTP API.
 */

import type { Hono } from "hono";
import { buildFocusedTestingFacts, FocusedTestingError } from "../../../domains/focused-testing.js";
import type { WebContextSource } from "../context.js";
import { parseFocusedTestingInput } from "./focused-testing-input.js";

const OBJECTIVE_KINDS = new Set([
  "new_feature",
  "bug_fix",
  "regression",
  "refactor",
  "performance",
  "stability",
  "security",
  "unknown",
]);

type ObjectiveKind =
  | "new_feature"
  | "bug_fix"
  | "regression"
  | "refactor"
  | "performance"
  | "stability"
  | "security"
  | "unknown";

interface AugurPlanRequest {
  objective?: {
    kind?: unknown;
    description?: unknown;
    desiredOutcome?: unknown;
  };
  change?: {
    changedFiles?: unknown;
    diff?: unknown;
  };
  focusedTesting?: unknown;
}

export function mountTestSuggestionRoutes(app: Hono, source: WebContextSource): void {
  app.post("/api/projects/:id/test-suggestions", async (c) => {
    const id = c.req.param("id");
    let body: AugurPlanRequest = {};
    try {
      body = (await c.req.json()) as AugurPlanRequest;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }

    let counts;
    try {
      counts = await source.summary(id, { stale: true });
    } catch {
      return c.json({ error: `no such project "${id}"` }, 404);
    }

    const project = source.projects().find((p) => p.id === id);
    const objective = parseObjective(body, project?.name ?? id);
    if (!objective.ok) return c.json({ error: objective.error }, 400);

    let focusedTesting;
    try {
      const policies = parseFocusedTestingInput(body.focusedTesting);
      if (policies !== undefined) {
        const ctx = await source.resolve(id);
        focusedTesting = buildFocusedTestingFacts(ctx, policies);
      }
    } catch (err) {
      if (err instanceof FocusedTestingError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    const augurUrl = resolveAugurUrl();
    const changedFiles = stringList(body.change?.changedFiles).slice(0, 20);
    const diff = typeof body.change?.diff === "string" && body.change.diff.trim()
      ? body.change.diff
      : undefined;

    const request = {
      objective: objective.value,
      project: {
        name: project?.name ?? id,
        language: "typescript",
        frameworks: ["hono"],
        testRunners: ["vitest"],
        packageManager: "npm",
      },
      change:
        diff || changedFiles.length
          ? { ...(diff ? { diff } : {}), ...(changedFiles.length ? { changedFiles } : {}) }
          : undefined,
      runtimeSignals: [
        {
          type: "custom",
          name: "anatomia.files",
          value: counts.files,
          unit: "count",
          source: "Anatomia summary",
        },
        {
          type: "custom",
          name: "anatomia.functions",
          value: counts.functions,
          unit: "count",
          source: "Anatomia summary",
        },
      ],
      constraints: [
        {
          type: "policy",
          value: "Augur suggests tests only; execution remains outside Augur.",
        },
      ],
      ...(focusedTesting !== undefined ? { focusedTesting } : {}),
    };

    let res: Response;
    try {
      res = await fetch(`${augurUrl}/v1/plans`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch (err) {
      return c.json(
        {
          error: "Augur is not reachable",
          augurUrl,
          detail: err instanceof Error ? err.message : String(err),
        },
        503,
      );
    }

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      return c.json(
        {
          error: "Augur plan request failed",
          augurUrl,
          status: res.status,
          detail: payload,
        },
        502,
      );
    }

    return c.json({
      augurUrl,
      request,
      summary: payload.summary ?? "",
      suggestions: payload.testPlan?.suggestions ?? [],
      fixPolicy: payload.fixPolicy ?? null,
      evidence: payload.evidence ?? [],
      focusedTesting: focusedTesting ?? null,
    });
  });
}

function resolveAugurUrl(): string {
  const raw = process.env.ANATOMIA_AUGUR_URL || process.env.AUGUR_URL || "http://127.0.0.1:4210";
  return raw.replace(/\/+$/, "");
}

function parseObjective(
  body: AugurPlanRequest,
  projectName: string,
): { ok: true; value: { kind: ObjectiveKind; description: string; desiredOutcome?: string } } | { ok: false; error: string } {
  const rawKind = typeof body.objective?.kind === "string" ? body.objective.kind : "unknown";
  if (!OBJECTIVE_KINDS.has(rawKind)) {
    return { ok: false, error: `objective.kind must be one of ${Array.from(OBJECTIVE_KINDS).join(", ")}` };
  }
  const description = typeof body.objective?.description === "string"
    ? body.objective.description.trim()
    : "";
  if (!description) return { ok: false, error: "objective.description is required" };
  const desiredOutcome = typeof body.objective?.desiredOutcome === "string"
    ? body.objective.desiredOutcome.trim()
    : "";
  return {
    ok: true,
    value: {
      kind: rawKind as ObjectiveKind,
      description: description || `Suggest useful tests for ${projectName}.`,
      ...(desiredOutcome ? { desiredOutcome } : {}),
    },
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}
