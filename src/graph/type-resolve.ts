/**
 * Type-aware call resolution registry.
 *
 * Anatomia resolves a call by bare method name. For a name a single layer owns
 * that is fine, but generic virtual accessors (`alive()`, `position()`,
 * `tick()`) are redefined in every layer, so a by-name resolution fans an edge
 * out to EVERY definition — manufacturing false "calls up the layer spine"
 * violations (combat's hitbox calling `target.alive()` on a `HitReceiver&`
 * drawing edges into player/, enemy/, … layers).
 *
 * This registry narrows a call when the receiver's STATIC type is known:
 *
 *   recv.method() where recv : T  ⇒  resolve `method` within T and T's bases.
 *
 * The key move is what happens when T is a KNOWN class but the method is not
 * found in T's hierarchy (the pure-virtual interface case — the bodies live in
 * concrete subclasses, not on the interface T the caller holds): we resolve to
 * NOTHING and DROP the edge, rather than fanning out to every same-named
 * override. A call through an abstraction the caller's layer owns is dependency
 * inversion, not a spine violation, so dropping it removes the false positive
 * while a direct call on a concrete receiver still resolves to the real method.
 *
 * Tradeoff (matches build.ts's locality philosophy): a genuine virtual dispatch
 * edge is lost for the call graph. For an advisory architecture linter, fewer
 * false positives (trust) beats call-graph completeness.
 *
 * Types are tracked independently of method bodies (via TypeDecl) so an
 * interface whose methods are all pure-virtual — and therefore has no
 * FunctionNode — is still a *known type*, which is what enables the drop above.
 */

import type { AnchorId, FileNode, FunctionNode, TypeDecl } from "../types.js";

/** A field's resolved type info (simple type + optional container element type). */
export interface FieldType {
  type: string | null;
  elementType?: string | null;
}

export class TypeRegistry {
  /** type → (method name → AnchorIds of definitions WITH a body on that type). */
  private readonly methods = new Map<string, Map<string, AnchorId[]>>();
  /** type → direct base type names. */
  private readonly bases = new Map<string, string[]>();
  /** type → (field name → field type info). */
  private readonly fields = new Map<string, Map<string, FieldType>>();
  /** Every type name seen (declared OR owning a method) — the "known" set. */
  private readonly known = new Set<string>();

  /** Build a registry from a set of analyzed files. */
  static build(files: FileNode[]): TypeRegistry {
    const reg = new TypeRegistry();
    reg.addFiles(files);
    return reg;
  }

  /** Shallow-clone (for incremental verify overlays). */
  clone(): TypeRegistry {
    const reg = new TypeRegistry();
    for (const [type, byName] of this.methods) {
      reg.methods.set(type, new Map([...byName].map(([n, ids]) => [n, [...ids]])));
    }
    for (const [type, bs] of this.bases) reg.bases.set(type, [...bs]);
    for (const [type, byName] of this.fields) {
      reg.fields.set(type, new Map([...byName].map(([n, ft]) => [n, { ...ft }])));
    }
    for (const t of this.known) reg.known.add(t);
    return reg;
  }

  /** Fold the functions + type decls of `files` into this registry. */
  addFiles(files: FileNode[]): void {
    for (const file of files) {
      for (const fn of file.functions) this.addFunction(fn);
      for (const decl of file.types ?? []) this.addType(decl);
    }
  }

  private addFunction(fn: FunctionNode): void {
    if (!fn.id || !fn.enclosingType) return;
    this.known.add(fn.enclosingType);
    let byName = this.methods.get(fn.enclosingType);
    if (!byName) {
      byName = new Map();
      this.methods.set(fn.enclosingType, byName);
    }
    const ids = byName.get(fn.name);
    if (ids) {
      if (!ids.includes(fn.id)) ids.push(fn.id);
    } else {
      byName.set(fn.name, [fn.id]);
    }
  }

  private addType(decl: TypeDecl): void {
    this.known.add(decl.name);
    const existing = this.bases.get(decl.name);
    if (existing) {
      for (const b of decl.bases) if (!existing.includes(b)) existing.push(b);
    } else {
      this.bases.set(decl.name, [...decl.bases]);
    }
    if (decl.fields && decl.fields.length > 0) {
      let byName = this.fields.get(decl.name);
      if (!byName) {
        byName = new Map();
        this.fields.set(decl.name, byName);
      }
      for (const f of decl.fields) {
        // First declaration wins (forward decls / split headers stay stable).
        if (!byName.has(f.name)) byName.set(f.name, { type: f.type, elementType: f.elementType });
      }
    }
  }

  /**
   * Resolve a data member `field` on `type`, walking `type` and its transitive
   * bases. Returns the field's type info, or null when no such member is known.
   */
  fieldType(type: string, field: string): FieldType | null {
    const seen = new Set<string>();
    const stack = [type];
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (seen.has(t)) continue;
      seen.add(t);
      const ft = this.fields.get(t)?.get(field);
      if (ft) return ft;
      const bs = this.bases.get(t);
      if (bs) for (const b of bs) if (!seen.has(b)) stack.push(b);
    }
    return null;
  }

  /** Is `type` a class/struct/interface defined in the analyzed code? */
  isKnownType(type: string): boolean {
    return this.known.has(type);
  }

  /**
   * Resolve `method` on `type`, walking `type` and its transitive bases. Returns
   * the AnchorIds of matching definitions (usually one). An empty array means the
   * method has no body anywhere in `type`'s hierarchy — the caller drops the edge
   * rather than fanning out (see module header).
   */
  resolveMethod(type: string, method: string): AnchorId[] {
    const seen = new Set<string>();
    const stack = [type];
    const out: AnchorId[] = [];
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (seen.has(t)) continue;
      seen.add(t);
      const ids = this.methods.get(t)?.get(method);
      if (ids) for (const id of ids) if (!out.includes(id)) out.push(id);
      const bs = this.bases.get(t);
      if (bs) for (const b of bs) if (!seen.has(b)) stack.push(b);
    }
    return out;
  }
}
