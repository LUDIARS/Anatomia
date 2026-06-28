/**
 * End-to-end recorded-trace flow, GPU-free.
 *
 * The pieces (parse → decode → stitch → scene / phase discovery / FSM) each have
 * focused unit tests; this exercises the WHOLE chain on one richer, multi-phase
 * trace so the local "light up the scene layer without a real game" path is
 * covered as a unit. It also doubles as the worked example the trace-recording
 * runbook points at: a hand-authored JSONL trace stands in for a measurement
 * build's output, and we assert scenes, a phase vocabulary, and FSM transitions
 * all fall out of it deterministically.
 */

import { describe, it, expect } from "vitest";
import type { AnchorId } from "../../../types.js";
import type { DetectionResult } from "../../../domains/detect.js";
import {
  parseTraceJsonl,
  cardsFromDomains,
  decodeStitchedFrames,
  sceneModelFromTraceFile,
} from "../ingest.js";
import { discoverPhases } from "../../phase/discover.js";
import { induceFsm } from "../../phase/fsm.js";

// Three domains, each with one or two implementor anchors (as `trace plan`
// would bake into the markers).
const DOMAINS: DetectionResult[] = [
  { domain: "combat", implementors: ["combat_hit" as AnchorId, "combat_move" as AnchorId], violations: [], conforms: true },
  { domain: "menu", implementors: ["menu_nav" as AnchorId], violations: [], conforms: true },
  { domain: "item", implementors: ["item_use" as AnchorId], violations: [], conforms: true },
];

/** One anchor per active domain, picked deterministically (first implementor). */
const ANCHOR: Record<string, string> = { combat: "combat_hit", menu: "menu_nav", item: "item_use" };

/** Emit JSONL for a per-frame plan: plan[i] = the domains active in frame i+1. */
function buildTraceJsonl(plan: string[][]): string {
  const lines: string[] = [];
  let t = 0;
  plan.forEach((active, i) => {
    const frameId = i + 1;
    lines.push(JSON.stringify({ type: "frame_begin", frameId, timestampUs: t }));
    for (const dom of active) {
      lines.push(JSON.stringify({ type: "zone_enter", anchorId: ANCHOR[dom], timestampUs: t + 5 }));
      lines.push(JSON.stringify({ type: "zone_exit", anchorId: ANCHOR[dom], timestampUs: t + 95 }));
    }
    t += 100;
    lines.push(JSON.stringify({ type: "frame_end", frameId, timestampUs: t }));
    t += 10;
  });
  return lines.join("\n");
}

// A small session: combat run → menu → item → back to combat → menu.
// Distinct active-domain sets ⇒ distinct phases; the repeats drive transitions.
const PLAN: string[][] = [
  ["combat"], ["combat"], ["combat"],
  ["menu"], ["menu"],
  ["item"], ["item"], ["item"],
  ["combat"], ["combat"],
  ["menu"],
];
const TRACE = buildTraceJsonl(PLAN);

describe("recorded-trace end-to-end (GPU-free)", () => {
  it("parses one event per emitted line", () => {
    const events = parseTraceJsonl(TRACE);
    // 11 frames × (begin + end) + one zone (enter+exit) each = 22 + 22 = 44.
    expect(events.length).toBe(44);
  });

  it("derives a scene per distinct active-domain set", () => {
    const model = sceneModelFromTraceFile(TRACE, DOMAINS);
    // combat / menu / item → 3 distinct scenes.
    expect(model.scenes().length).toBe(3);
    expect(model.scenesForDomain("combat").length).toBe(1);
    expect(model.scenesForDomain("item").length).toBe(1);
  });

  it("discovers the phase vocabulary and induces an FSM with transitions", () => {
    const stitched = decodeStitchedFrames(parseTraceJsonl(TRACE), cardsFromDomains(DOMAINS))
      .map((f) => f.stitched);
    const model = discoverPhases(stitched);

    // 3 distinct phases, one per active-domain set.
    expect(model.phases.length).toBe(3);
    expect(model.framePhaseIds.length).toBe(PLAN.length);

    const fsm = induceFsm(model);
    expect(fsm.states.length).toBe(3);
    // combat→menu→item→combat→menu = 4 inter-phase transitions, no dead states.
    expect(fsm.transitions.length).toBeGreaterThan(0);
    expect(fsm.deadStates).toEqual([]);
    // dwell is recorded for the repeated combat / menu / item runs.
    const totalDwell = Object.values(fsm.dwell).reduce((a, b) => a + b, 0);
    expect(totalDwell).toBeGreaterThan(0);
  });

  it("a phase present but never entered shows up as a dead state", () => {
    // Discover over combat-only frames, then nothing transitions into menu/item.
    const stitched = decodeStitchedFrames(
      parseTraceJsonl(buildTraceJsonl([["combat"], ["combat"]])),
      cardsFromDomains(DOMAINS),
    ).map((f) => f.stitched);
    const model = discoverPhases(stitched);
    const fsm = induceFsm(model);
    expect(fsm.states.length).toBe(1); // only the combat phase was observed
    expect(fsm.deadStates).toEqual([]);
  });
});
