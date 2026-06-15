/**
 * dynamic/phase/ — Phase learning (DESIGN §5.5, the dynamic hardening loop).
 *
 *   T45 signature.ts — frame → deterministic phase signature (compression)
 *   T46 discover.ts  — offline phase vocabulary (+ optional Jaccard merge)
 *   T47 fsm.ts       — FSM induction over the phase sequence
 *   T48 label.ts     — LLM phase labels, content-keyed cache (mirrors card.ts)
 *   T49 classify.ts  — online phase classification (fills where.ts `phase`)
 */
export * from "./signature.js";
export * from "./discover.js";
export * from "./fsm.js";
export * from "./label.js";
export * from "./classify.js";
