/**
 * T48 — Phase labeling with content-keyed cache (DESIGN §5.5; mirrors card.ts).
 *
 * Each discovered phase is named + described by an injected LLM exactly once,
 * keyed by the phase's content id (its representative signature id). On a cache
 * HIT the LLM is NOT called; only a MISS invokes it, then stores the result.
 * This is the dynamic twin of the domain-card cache (DESIGN §4.4): cheap LLM
 * pass once, content-addressed, re-run only when the phase signature changes.
 *
 * SRP: prompt assembly + caching + lenient parse only. The LLM is injected
 * (reusing domains/card.ts's LLMClient) — no hardcoded client, no I/O.
 */
import type { LLMClient } from "../../domains/card.js";
import type { Phase, PhaseModel } from "./discover.js";

export interface PhaseLabel {
  phaseId: string;
  /** Short human name, e.g. "Combat: Skill+Effect hot". */
  name: string;
  /** One- to two-sentence description of the situation. */
  description: string;
  /** Content key = phaseId (the representative signature id). */
  cacheKey: string;
}

export type PhaseLabelCache = Map<string, PhaseLabel>;

export function createPhaseLabelCache(): PhaseLabelCache {
  return new Map<string, PhaseLabel>();
}

/**
 * Deterministic prompt for a phase: its active-domain set, the hot domain and
 * how many frames fell into it. Stable ordering => identical prompts.
 */
export function assemblePhasePrompt(phase: Phase): string {
  const lines: string[] = [];
  lines.push(`Phase id: ${phase.id}`);
  lines.push(`Active domains: ${phase.signature.domains.join(", ") || "(none)"}`);
  lines.push(`Hot domain: ${phase.signature.hotDomain ?? "(none)"}`);
  lines.push(`Frames observed: ${phase.frameCount}`);
  lines.push("");
  lines.push(
    "This describes a recurring runtime situation in a game loop. Return a JSON " +
      "object with fields: name (short label) and description (1–2 sentences).",
  );
  return lines.join("\n");
}

function parseResponse(text: string): { name: string; description: string } {
  const fallback = {
    name: text.trim().slice(0, 60) || "(unnamed phase)",
    description: text.trim().slice(0, 280),
  };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return fallback;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    return {
      name: typeof obj.name === "string" ? obj.name : fallback.name,
      description: typeof obj.description === "string" ? obj.description : fallback.description,
    };
  } catch {
    return fallback;
  }
}

/**
 * Generate (or fetch from cache) a label for one phase.
 * Cache HIT => no LLM call. MISS => exactly one LLM call, then cache.
 */
export async function labelPhase(
  phase: Phase,
  llm: LLMClient,
  cache?: PhaseLabelCache,
): Promise<PhaseLabel> {
  const cacheKey = phase.id;
  if (cache) {
    const hit = cache.get(cacheKey);
    if (hit) return hit;
  }

  const prompt = assemblePhasePrompt(phase);
  const response = await llm(prompt);
  const parsed = parseResponse(response);

  const label: PhaseLabel = {
    phaseId: phase.id,
    name: parsed.name,
    description: parsed.description,
    cacheKey,
  };

  if (cache) cache.set(cacheKey, label);
  return label;
}

/** Label every phase in a model (cache-aware), in model order. */
export async function labelPhases(
  model: PhaseModel,
  llm: LLMClient,
  cache?: PhaseLabelCache,
): Promise<PhaseLabel[]> {
  const out: PhaseLabel[] = [];
  for (const phase of model.phases) {
    out.push(await labelPhase(phase, llm, cache));
  }
  return out;
}
