/**
 * Unity 2021.3 MonoBehaviour lifecycle/event-function recognition.
 *
 * Source of truth:
 * https://docs.unity3d.com/ja/2021.3/Manual/ExecutionOrder.html
 * Cross-check:
 * https://docs.unity3d.com/ja/2021.3/ScriptReference/MonoBehaviour.html
 */

import type { AnchorId, FileNode, FunctionNode } from "../../types.js";
import type { ProjectProfile } from "../../project/profile.js";

export type UnityLifecyclePhase =
  | "initialization"
  | "editor"
  | "focus"
  | "physics"
  | "update"
  | "animation"
  | "rendering"
  | "teardown";

export interface UnityLifecycleMatch {
  anchor: AnchorId;
  event: string;
  phase: UnityLifecyclePhase;
  ownerType: string;
}

const EVENTS: Readonly<Record<string, UnityLifecyclePhase>> = Object.freeze({
  Awake: "initialization", OnEnable: "initialization", Start: "initialization",
  Reset: "editor", OnValidate: "editor",
  OnApplicationFocus: "focus", OnApplicationPause: "focus",
  FixedUpdate: "physics",
  OnCollisionEnter: "physics", OnCollisionEnter2D: "physics",
  OnCollisionExit: "physics", OnCollisionExit2D: "physics",
  OnCollisionStay: "physics", OnCollisionStay2D: "physics",
  OnControllerColliderHit: "physics", OnJointBreak: "physics", OnJointBreak2D: "physics",
  OnTriggerEnter: "physics", OnTriggerEnter2D: "physics",
  OnTriggerExit: "physics", OnTriggerExit2D: "physics",
  OnTriggerStay: "physics", OnTriggerStay2D: "physics",
  Update: "update", LateUpdate: "update",
  OnAnimatorMove: "animation", OnAnimatorIK: "animation",
  OnPreCull: "rendering", OnBecameVisible: "rendering", OnBecameInvisible: "rendering",
  OnWillRenderObject: "rendering", OnPreRender: "rendering", OnRenderObject: "rendering",
  OnPostRender: "rendering", OnRenderImage: "rendering", OnGUI: "rendering",
  OnDrawGizmos: "rendering", OnDrawGizmosSelected: "rendering",
  OnDestroy: "teardown", OnApplicationQuit: "teardown", OnDisable: "teardown",
});

export interface UnityLifecycleInput {
  projectProfile?: ProjectProfile;
  files: FileNode[];
  functions: FunctionNode[];
}

/** Resolve documented lifecycle callbacks to their function anchors. */
export function resolveUnityLifecycleFunctions(
  input: UnityLifecycleInput,
): Map<AnchorId, UnityLifecycleMatch> {
  const matches = new Map<AnchorId, UnityLifecycleMatch>();
  if (input.projectProfile?.kind !== "unity") return matches;

  const basesByType = new Map<string, Set<string>>();
  for (const file of input.files) {
    for (const type of file.types ?? []) {
      const bases = basesByType.get(type.name) ?? new Set<string>();
      for (const base of type.bases) bases.add(base);
      basesByType.set(type.name, bases);
    }
  }

  const memo = new Map<string, boolean>();
  const derivesFromMonoBehaviour = (typeName: string, visiting = new Set<string>()): boolean => {
    const cached = memo.get(typeName);
    if (cached !== undefined) return cached;
    if (visiting.has(typeName)) return false;
    visiting.add(typeName);
    const bases = basesByType.get(typeName) ?? new Set<string>();
    const result = [...bases].some(
      (base) => base === "MonoBehaviour" || derivesFromMonoBehaviour(base, visiting),
    );
    visiting.delete(typeName);
    memo.set(typeName, result);
    return result;
  };

  for (const fn of input.functions) {
    if (!fn.id || !fn.enclosingType) continue;
    const phase = EVENTS[fn.name];
    if (!phase || !derivesFromMonoBehaviour(fn.enclosingType)) continue;
    matches.set(fn.id, {
      anchor: fn.id,
      event: fn.name,
      phase,
      ownerType: fn.enclosingType,
    });
  }
  return matches;
}

export function unityLifecyclePhase(name: string): UnityLifecyclePhase | undefined {
  return EVENTS[name];
}
