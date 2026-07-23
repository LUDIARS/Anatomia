/**
 * Unity 2021.3 MonoBehaviour lifecycle/event-function recognition.
 *
 * Source of truth:
 * https://docs.unity3d.com/ja/2021.3/Manual/ExecutionOrder.html
 * Cross-check:
 * https://docs.unity3d.com/ja/2021.3/ScriptReference/MonoBehaviour.html
 */

import type { AnchorId, FileNode, FunctionNode, TypeDecl } from "../../types.js";
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

interface UnityEventRule {
  phase: UnityLifecyclePhase;
  /** Allowed simple parameter lists; null denotes a primitive parameter. */
  parameterLists: readonly (readonly (string | null)[])[];
}

const noParameters = (phase: UnityLifecyclePhase): UnityEventRule => ({
  phase,
  parameterLists: [[]],
});
const oneParameter = (phase: UnityLifecyclePhase, type: string | null): UnityEventRule => ({
  phase,
  parameterLists: [[type]],
});
const optionalParameter = (phase: UnityLifecyclePhase, type: string): UnityEventRule => ({
  phase,
  parameterLists: [[], [type]],
});

const EVENTS: Readonly<Record<string, UnityEventRule>> = Object.freeze({
  Awake: noParameters("initialization"),
  OnEnable: noParameters("initialization"),
  Start: noParameters("initialization"),
  Reset: noParameters("editor"),
  OnValidate: noParameters("editor"),
  OnApplicationFocus: oneParameter("focus", null),
  OnApplicationPause: oneParameter("focus", null),
  FixedUpdate: noParameters("physics"),
  OnCollisionEnter: optionalParameter("physics", "Collision"),
  OnCollisionEnter2D: optionalParameter("physics", "Collision2D"),
  OnCollisionExit: optionalParameter("physics", "Collision"),
  OnCollisionExit2D: optionalParameter("physics", "Collision2D"),
  OnCollisionStay: optionalParameter("physics", "Collision"),
  OnCollisionStay2D: optionalParameter("physics", "Collision2D"),
  OnControllerColliderHit: oneParameter("physics", "ControllerColliderHit"),
  OnJointBreak: oneParameter("physics", null),
  OnJointBreak2D: oneParameter("physics", "Joint2D"),
  OnTriggerEnter: oneParameter("physics", "Collider"),
  OnTriggerEnter2D: oneParameter("physics", "Collider2D"),
  OnTriggerExit: oneParameter("physics", "Collider"),
  OnTriggerExit2D: oneParameter("physics", "Collider2D"),
  OnTriggerStay: oneParameter("physics", "Collider"),
  OnTriggerStay2D: oneParameter("physics", "Collider2D"),
  Update: noParameters("update"),
  LateUpdate: noParameters("update"),
  OnAnimatorMove: noParameters("animation"),
  OnAnimatorIK: oneParameter("animation", null),
  OnPreCull: noParameters("rendering"),
  OnBecameVisible: noParameters("rendering"),
  OnBecameInvisible: noParameters("rendering"),
  OnWillRenderObject: noParameters("rendering"),
  OnPreRender: noParameters("rendering"),
  OnRenderObject: noParameters("rendering"),
  OnPostRender: noParameters("rendering"),
  OnRenderImage: {
    phase: "rendering",
    parameterLists: [["RenderTexture", "RenderTexture"]],
  },
  OnGUI: noParameters("rendering"),
  OnDrawGizmos: noParameters("rendering"),
  OnDrawGizmosSelected: noParameters("rendering"),
  OnDestroy: noParameters("teardown"),
  OnApplicationQuit: noParameters("teardown"),
  OnDisable: noParameters("teardown"),
});

export interface UnityLifecycleInput {
  projectProfile?: ProjectProfile;
  files: FileNode[];
  functions: FunctionNode[];
}

function declarationKey(type: TypeDecl): string {
  const position = type.sourceRange?.start;
  return `${type.filePath}\0${type.name}\0${position?.line ?? -1}:${position?.column ?? -1}`;
}

function isSupportedEventSignature(fn: FunctionNode, rule: UnityEventRule): boolean {
  if (/(?:^|\s)static(?:\s|$)/u.test(fn.signature)) return false;
  const parameters = fn.params ?? [];
  return rule.parameterLists.some((expectedParameters) =>
    parameters.length === expectedParameters.length
    && expectedParameters.every((expected, index) => parameters[index]?.type === expected));
}

function declarationContainsFunction(type: TypeDecl, fn: FunctionNode): boolean {
  const range = type.sourceRange;
  if (!range || range.filePath !== fn.sourceRange.filePath) return false;
  const position = fn.sourceRange.start;
  const startsBefore = range.start.line < position.line
    || (range.start.line === position.line && range.start.column <= position.column);
  const endsAfter = range.end.line > position.line
    || (range.end.line === position.line && range.end.column >= position.column);
  return startsBefore && endsAfter;
}

/** Resolve documented lifecycle callbacks to their function anchors. */
export function resolveUnityLifecycleFunctions(
  input: UnityLifecycleInput,
): Map<AnchorId, UnityLifecycleMatch> {
  const matches = new Map<AnchorId, UnityLifecycleMatch>();
  if (input.projectProfile?.kind !== "unity") return matches;

  const declarationsByName = new Map<string, TypeDecl[]>();
  for (const file of input.files) {
    for (const type of file.types ?? []) {
      const declarations = declarationsByName.get(type.name);
      if (declarations) declarations.push(type);
      else declarationsByName.set(type.name, [type]);
    }
  }

  const resolveDeclaration = (typeName: string, preferredFile: string): TypeDecl | undefined => {
    const candidates = declarationsByName.get(typeName) ?? [];
    const sameFile = candidates.filter((type) => type.filePath === preferredFile);
    return sameFile.length === 1
      ? sameFile[0]
      : (candidates.length === 1 ? candidates[0] : undefined);
  };

  const resolveOwnerDeclaration = (fn: FunctionNode): TypeDecl | undefined => {
    const candidates = declarationsByName.get(fn.enclosingType ?? "") ?? [];
    const containing = candidates.filter((type) => declarationContainsFunction(type, fn));
    if (containing.length === 1) return containing[0];
    return resolveDeclaration(fn.enclosingType ?? "", fn.sourceRange.filePath);
  };

  const memo = new Map<string, boolean>();
  const derivesFromMonoBehaviour = (
    declaration: TypeDecl,
    visiting = new Set<string>(),
  ): boolean => {
    const key = declarationKey(declaration);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (visiting.has(key)) return false;
    visiting.add(key);
    const result = declaration.bases.some((base) => {
      if (base === "MonoBehaviour") return true;
      const baseDeclaration = resolveDeclaration(base, declaration.filePath);
      return baseDeclaration ? derivesFromMonoBehaviour(baseDeclaration, visiting) : false;
    });
    visiting.delete(key);
    memo.set(key, result);
    return result;
  };

  for (const fn of input.functions) {
    if (!fn.id || !fn.enclosingType) continue;
    const rule = EVENTS[fn.name];
    if (!rule || !isSupportedEventSignature(fn, rule)) continue;
    const declaration = resolveOwnerDeclaration(fn);
    if (!declaration || !derivesFromMonoBehaviour(declaration)) continue;
    matches.set(fn.id, {
      anchor: fn.id,
      event: fn.name,
      phase: rule.phase,
      ownerType: fn.enclosingType,
    });
  }
  return matches;
}

export function unityLifecyclePhase(name: string): UnityLifecyclePhase | undefined {
  return EVENTS[name]?.phase;
}
