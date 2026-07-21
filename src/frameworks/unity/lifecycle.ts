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

/**
 * Documented parameter counts for the event functions that take arguments; every
 * other lifecycle event is parameterless (arity 0). Unity dispatches a message
 * only to the method whose signature matches, so a same-named overload with a
 * different parameter shape (e.g. a custom `void Update(float dt)`) is NOT the
 * Unity message and must not be recognized as one.
 */
const EVENT_ARITY: Readonly<Record<string, number>> = Object.freeze({
  OnApplicationFocus: 1, OnApplicationPause: 1,
  OnCollisionEnter: 1, OnCollisionEnter2D: 1,
  OnCollisionExit: 1, OnCollisionExit2D: 1,
  OnCollisionStay: 1, OnCollisionStay2D: 1,
  OnControllerColliderHit: 1, OnJointBreak: 1, OnJointBreak2D: 1,
  OnTriggerEnter: 1, OnTriggerEnter2D: 1,
  OnTriggerExit: 1, OnTriggerExit2D: 1,
  OnTriggerStay: 1, OnTriggerStay2D: 1,
  OnAnimatorIK: 1,
  OnRenderImage: 2,
});

/**
 * Does `fn` actually match the Unity lifecycle message named `event`, by
 * signature — not just by name? A real event function is an INSTANCE method
 * (Unity never dispatches to `static` members) whose parameter count equals the
 * documented arity. This rejects same-named non-lifecycle members: a `static`
 * look-alike, or an overload whose parameter shape differs (extra/missing args).
 * Params are dropped from the extractor when empty, so an absent list = arity 0.
 */
function matchesLifecycleSignature(fn: FunctionNode, event: string): boolean {
  if (/\bstatic\b/.test(fn.signature)) return false;
  const arity = fn.params?.length ?? 0;
  return arity === (EVENT_ARITY[event] ?? 0);
}

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

  // Two views of the inheritance graph:
  //  - `basesByType` (name-keyed) is used ONLY to walk base *names* transitively,
  //    which is inherently name-based because bases are recorded by simple name.
  //  - `directBasesByDecl` (file+name-keyed) holds each declaration's OWN direct
  //    bases. A specific method's class is resolved against its declaring file's
  //    entry, so an unrelated class that merely shares a simple name in another
  //    file (a different namespace) is never merged into this class's bases.
  const basesByType = new Map<string, Set<string>>();
  const directBasesByDecl = new Map<string, Set<string>>();
  const declKey = (filePath: string, name: string): string => `${filePath}\0${name}`;
  for (const file of input.files) {
    for (const type of file.types ?? []) {
      const nameBases = basesByType.get(type.name) ?? new Set<string>();
      const key = declKey(type.filePath, type.name);
      const declBases = directBasesByDecl.get(key) ?? new Set<string>();
      for (const base of type.bases) {
        nameBases.add(base);
        declBases.add(base);
      }
      basesByType.set(type.name, nameBases);
      directBasesByDecl.set(key, declBases);
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

  // Does the class `typeName` AS DECLARED IN `filePath` derive from
  // MonoBehaviour? Starts from that declaration's own direct bases (no cross-file
  // merge) then resolves base names transitively. Unity lifecycle is C#-only,
  // where a class body and its methods share a file, so scoping to the method's
  // file is precise; a C++ out-of-line definition simply finds no ancestor.
  const classInFileDerivesFromMonoBehaviour = (typeName: string, filePath: string): boolean => {
    const directBases = directBasesByDecl.get(declKey(filePath, typeName));
    if (!directBases) return false;
    for (const base of directBases) {
      if (base === "MonoBehaviour" || derivesFromMonoBehaviour(base)) return true;
    }
    return false;
  };

  for (const fn of input.functions) {
    if (!fn.id || !fn.enclosingType) continue;
    const phase = EVENTS[fn.name];
    if (!phase || !matchesLifecycleSignature(fn, fn.name)) continue;
    if (!classInFileDerivesFromMonoBehaviour(fn.enclosingType, fn.sourceRange.filePath)) continue;
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
