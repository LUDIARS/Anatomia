import { describe, it, expect } from "vitest";
import { induceFsm } from "./fsm.js";
import type { PhaseModel } from "./discover.js";

function model(framePhaseIds: string[], extraPhaseIds: string[] = []): PhaseModel {
  const ids = new Set([...framePhaseIds, ...extraPhaseIds]);
  return {
    phases: [...ids].map((id) => ({
      id,
      signature: { id, domains: [], hotDomain: null },
      frameCount: framePhaseIds.filter((x) => x === id).length,
      memberSignatureIds: [id],
    })),
    framePhaseIds,
    signatureOptions: {},
  };
}

describe("induceFsm", () => {
  it("counts inter-phase transitions and computes probabilities", () => {
    // P -> Q -> P -> Q : two P->Q, one Q->P
    const fsm = induceFsm(model(["P", "Q", "P", "Q"]));
    const pq = fsm.transitions.find((t) => t.from === "P" && t.to === "Q")!;
    const qp = fsm.transitions.find((t) => t.from === "Q" && t.to === "P")!;
    expect(pq.count).toBe(2);
    expect(pq.probability).toBe(1); // P only ever goes to Q
    expect(qp.count).toBe(1);
  });

  it("tracks self-dwell separately from transitions", () => {
    const fsm = induceFsm(model(["P", "P", "P", "Q"]));
    expect(fsm.dwell["P"]).toBe(2); // two consecutive P->P stays
    expect(fsm.transitions).toHaveLength(1);
    expect(fsm.transitions[0]).toMatchObject({ from: "P", to: "Q", count: 1 });
  });

  it("reports phases never entered as dead states", () => {
    const fsm = induceFsm(model(["P", "Q"], ["Z"]));
    expect(fsm.deadStates).toEqual(["Z"]);
    expect(fsm.states).toContain("Z");
  });

  it("splits outgoing probability across multiple targets", () => {
    // P -> Q, P -> R : each 0.5
    const fsm = induceFsm(model(["P", "Q", "P", "R"]));
    const pq = fsm.transitions.find((t) => t.from === "P" && t.to === "Q")!;
    const pr = fsm.transitions.find((t) => t.from === "P" && t.to === "R")!;
    expect(pq.probability).toBeCloseTo(0.5);
    expect(pr.probability).toBeCloseTo(0.5);
  });
});
