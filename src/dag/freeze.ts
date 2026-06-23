/**
 * dag/freeze.ts — Detach a function body from the native tree-sitter tree.
 *
 * web-tree-sitter `Node`s are thin handles into the parser's emscripten heap,
 * which is capped at 2GB. `analyze()` used to keep every parsed `Tree` alive
 * until all bodyAst consumers (normalize / edge extraction / template matching)
 * had run — i.e. the whole repository's trees at once. On a single huge repo
 * that peak exhausts the heap mid-parse; the aborted WASM module then poisons
 * every subsequent parse (the cascading `Aborted()` flood). See task #335.
 *
 * `freezeBody` deep-copies the body subtree into a plain-JS `AstNode` mirror so
 * the originating `Tree` can be `delete()`d immediately after extraction — per
 * file, not per repo. The mirror exposes exactly the read surface declared by
 * `AstNode` (types.ts) and preserves CHILD IDENTITY (a node and the result of
 * `childForFieldName` / `children[i]` are the same object), which edge
 * extraction relies on (`lhs === node` in graph/build.ts).
 *
 * Memory model: the bulk AST (function bodies) moves from the native heap to
 * the V8 heap, which is separately sized and not the resource that aborts the
 * parser. The signature-bearing function node is frozen fully (normalize reads
 * its params/return type); the enclosing class/namespace scope chain above it
 * is frozen SHALLOWLY (only the `name` field per scope — all that
 * `normalizeSignatureShape`'s `enclosingScope` reads) so a deeply-nested method
 * never drags its whole containing class's text into the mirror.
 */

import type { Node as TreeSitterNode } from "web-tree-sitter";
import type { AstNode, AstPoint } from "../types.js";

interface FrozenInit {
  type: string;
  text: string;
  startIndex: number;
  startPosition: AstPoint;
  endPosition: AstPoint;
  isNamed: boolean;
  isExtra: boolean;
}

/** A plain-JS, native-memory-free mirror of a tree-sitter syntax node. */
class FrozenNode implements AstNode {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
  readonly startPosition: AstPoint;
  readonly endPosition: AstPoint;
  readonly isNamed: boolean;
  readonly isExtra: boolean;

  parent: AstNode | null = null;
  /** All children in document order; null slots mirror tree-sitter's array. */
  readonly children: (AstNode | null)[] = [];
  /** Named children only, in document order (same instances as `children`). */
  readonly namedChildren: (AstNode | null)[] = [];
  // A field name can bind MULTIPLE children (e.g. a C++ `declaration` with
  // several `declarator`s), so fields map to a list — childForFieldName returns
  // the first, childrenForFieldName the whole list (mirrors tree-sitter).
  private readonly fields = new Map<string, AstNode[]>();

  constructor(init: FrozenInit) {
    this.type = init.type;
    this.text = init.text;
    this.startIndex = init.startIndex;
    this.startPosition = init.startPosition;
    this.endPosition = init.endPosition;
    this.isNamed = init.isNamed;
    this.isExtra = init.isExtra;
  }

  /**
   * Exclude the AST mirror from JSON serialization. A live tree-sitter `Node`
   * has no enumerable own data, so a serialized ContextBundle never embedded the
   * body AST; FrozenNode does (and its `parent` back-pointer would otherwise make
   * the structure circular AND balloon the output with the whole subtree). The
   * mirror is an in-memory analysis artifact, never part of the bundle's data.
   */
  toJSON(): undefined {
    return undefined;
  }

  get childCount(): number {
    return this.children.length;
  }

  child(index: number): AstNode | null {
    return this.children[index] ?? null;
  }

  childForFieldName(fieldName: string): AstNode | null {
    return this.fields.get(fieldName)?.[0] ?? null;
  }

  childrenForFieldName(fieldName: string): (AstNode | null)[] {
    return this.fields.get(fieldName) ?? [];
  }

  /** Pre-order (document-order) subtree scan, mirroring tree-sitter semantics. */
  descendantsOfType(type: string): (AstNode | null)[] {
    const out: AstNode[] = [];
    const stack: AstNode[] = [this];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n.type === type) out.push(n);
      const kids = n.children;
      for (let i = kids.length - 1; i >= 0; i--) {
        const c = kids[i];
        if (c) stack.push(c);
      }
    }
    return out;
  }

  /** Internal: append a child (null preserves index alignment with `child(i)`). */
  append(child: FrozenNode | null, fieldName: string | null): void {
    this.children.push(child);
    if (child) {
      child.parent = this;
      if (child.isNamed) this.namedChildren.push(child);
      if (fieldName) {
        const existing = this.fields.get(fieldName);
        if (existing) existing.push(child);
        else this.fields.set(fieldName, [child]);
      }
    }
  }

  setParent(parent: AstNode | null): void {
    this.parent = parent;
  }
}

function point(p: { row: number; column: number }): AstPoint {
  return { row: p.row, column: p.column };
}

function initFrom(src: TreeSitterNode, text: string): FrozenInit {
  return {
    type: src.type,
    text,
    startIndex: src.startIndex,
    startPosition: point(src.startPosition),
    endPosition: point(src.endPosition),
    isNamed: src.isNamed,
    isExtra: src.isExtra,
  };
}

/**
 * Deep-copy a live subtree into FrozenNodes (iteratively, to survive deeply
 * nested expression trees), returning the frozen root plus a node.id → frozen
 * map so a specific descendant (the body block) can be located afterwards.
 */
function freezeSubtree(root: TreeSitterNode): {
  frozenRoot: FrozenNode;
  byId: Map<number, FrozenNode>;
} {
  const byId = new Map<number, FrozenNode>();
  const frozenRoot = new FrozenNode(initFrom(root, root.text));
  byId.set(root.id, frozenRoot);
  const stack: Array<{ live: TreeSitterNode; frozen: FrozenNode }> = [
    { live: root, frozen: frozenRoot },
  ];
  while (stack.length > 0) {
    const { live, frozen } = stack.pop()!;
    const kids = live.children;
    for (let i = 0; i < kids.length; i++) {
      const childLive = kids[i];
      if (!childLive) {
        frozen.append(null, null);
        continue;
      }
      const childFrozen = new FrozenNode(initFrom(childLive, childLive.text));
      byId.set(childLive.id, childFrozen);
      frozen.append(childFrozen, live.fieldNameForChild(i));
      stack.push({ live: childLive, frozen: childFrozen });
    }
  }
  return { frozenRoot, byId };
}

/**
 * Build a SHALLOW frozen mirror of a scope node (class/struct/namespace/…):
 * its `name` field only, no body text. `enclosingScope` (normalize.ts) reads
 * just `type`, `parent` and `childForFieldName("name")` while walking up, so
 * the rest of the scope's (potentially huge) subtree is intentionally dropped.
 */
function freezeScope(live: TreeSitterNode): FrozenNode {
  const scope = new FrozenNode(initFrom(live, ""));
  const nameLive = live.childForFieldName("name");
  if (nameLive) {
    scope.append(new FrozenNode(initFrom(nameLive, nameLive.text)), "name");
  }
  return scope;
}

/**
 * Detach a function body subtree from its native tree into a plain-JS mirror.
 *
 * The whole function-definition node (the body's parent) is frozen so that the
 * signature consumers (`normalizeSignatureShape`: params, return type, name)
 * keep working; the body block is then located within it. The enclosing scope
 * chain above the function is frozen shallowly for `enclosingScope`. The
 * returned node is the frozen BODY (parent links lead up through the function
 * node to the scope chain), matching the live `bodyAst` it replaces.
 */
export function freezeBody(liveBody: TreeSitterNode): AstNode {
  const fnLive = liveBody.parent;
  if (!fnLive) {
    // No enclosing function (defensive): freeze the body alone.
    return freezeSubtree(liveBody).frozenRoot;
  }

  const { byId } = freezeSubtree(fnLive);
  const frozenBody = byId.get(liveBody.id);
  const frozenFn = byId.get(fnLive.id);
  if (!frozenBody || !frozenFn) {
    // Should not happen (body is a descendant of fnLive); freeze body alone.
    return freezeSubtree(liveBody).frozenRoot;
  }

  // Re-root the frozen function node onto a shallow scope chain so signature
  // normalization can resolve the enclosing class/namespace names.
  let child: FrozenNode = frozenFn;
  let liveAnc: TreeSitterNode | null = fnLive.parent;
  while (liveAnc) {
    const scope = freezeScope(liveAnc);
    child.setParent(scope);
    child = scope;
    liveAnc = liveAnc.parent;
  }

  return frozenBody;
}
