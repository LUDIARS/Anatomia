/**
 * src/integral/scene.ts — Scene model: the dynamic/runtime partition layer.
 *
 * A SCENE is the third layer integral search climbs to (構造グラフ → ドメイン →
 * シーンステート). Where a domain is a *semantic* partition of the function set,
 * a scene is a *runtime/temporal* one: a 局面 that activates a set of domains
 * during a window of execution. The two are ORTHOGONAL — a scene references the
 * domains active in it, but scene state is NOT part of a domain (DESIGN,
 * boundary line). Some scenes coincide with a single domain; that coincidence is
 * surfaced, not collapsed.
 *
 * Scenes are derived from the dynamic layer's phase signatures (each carries the
 * sorted set of active domains, see dynamic/phase/signature.ts), so this module
 * is the bridge between 局面学習 and integral search. Most projects have no
 * recorded trace yet, so the EmptySceneModel is the graceful default: integral
 * search then runs on structure + domains alone (scene expansion contributes
 * nothing rather than failing).
 *
 * SRP: scene lookup only (domain↔scene). No graph access, no LLM, no HTTP.
 */

import { frameSignature, type PhaseSignature } from "../dynamic/phase/signature.js";
import type { TraceSource } from "../dynamic/viz/trace-source.js";

/** A scene = an id, an optional human label, and the domains it activates. */
export interface SceneRef {
  id: string;
  label?: string;
  /** Sorted, de-duplicated domain names active in this scene. */
  domains: string[];
}

/** Lookup interface over a set of scenes (domain ↔ scene, both directions). */
export interface SceneModel {
  /** All known scenes (empty when no dynamic data is wired). */
  scenes(): SceneRef[];
  /** Scenes that activate the given domain. */
  scenesForDomain(domain: string): SceneRef[];
  /** Scene by id (undefined when unknown). */
  sceneById(id: string): SceneRef | undefined;
}

/** Build a SceneModel from an explicit scene list (the common case). */
export function createSceneModel(scenes: SceneRef[]): SceneModel {
  const byId = new Map<string, SceneRef>();
  const byDomain = new Map<string, SceneRef[]>();
  for (const s of scenes) {
    byId.set(s.id, s);
    for (const d of s.domains) {
      const list = byDomain.get(d) ?? [];
      list.push(s);
      byDomain.set(d, list);
    }
  }
  return {
    scenes: () => scenes,
    scenesForDomain: (domain) => byDomain.get(domain) ?? [],
    sceneById: (id) => byId.get(id),
  };
}

/** The graceful default: no scenes. Integral search degrades to structure+domain. */
export function emptySceneModel(): SceneModel {
  return createSceneModel([]);
}

/**
 * Derive scenes from the dynamic layer's phase signatures. Each distinct phase
 * (signature id) becomes one scene whose domains are the signature's active
 * domain set. This is the wiring point that lets a recorded game trace feed
 * integral search's scene layer. Duplicate signature ids collapse to one scene.
 */
export function scenesFromPhaseSignatures(signatures: PhaseSignature[]): SceneRef[] {
  const byId = new Map<string, SceneRef>();
  for (const sig of signatures) {
    if (byId.has(sig.id)) continue;
    const domains = [...new Set(sig.domains)].sort();
    byId.set(sig.id, {
      id: sig.id,
      label: sig.hotDomain ? `phase:${sig.hotDomain}` : undefined,
      domains,
    });
  }
  // Deterministic order: by id.
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Derive scenes straight from a (recorded or live) trace source: take the recent
 * stitched frames, compress each to a phase signature (signature.ts), and fold
 * to scenes. This is the live wiring point — `anatomia web` already holds a
 * TraceSource, so once a game records a trace, its 局面 become integral-search
 * scenes with no extra plumbing. An empty trace yields [] (graceful: integral
 * search stays structure + domain). LLM-free + deterministic.
 */
export function scenesFromTrace(trace: TraceSource, windowN = 512): SceneRef[] {
  const frames = trace.recentFrames(windowN);
  if (frames.length === 0) return [];
  return scenesFromPhaseSignatures(frames.map((f) => frameSignature(f)));
}

/** Build a SceneModel directly from a trace source (empty trace → empty model). */
export function sceneModelFromTrace(trace: TraceSource, windowN = 512): SceneModel {
  return createSceneModel(scenesFromTrace(trace, windowN));
}
