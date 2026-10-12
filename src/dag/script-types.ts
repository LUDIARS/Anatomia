/**
 * src/dag/script-types.ts — receiver typing facts for JavaScript / TypeScript.
 *
 * The C++/C# extractor reads class bases, data members and return types from
 * declared types. Script code mostly states them by CONSTRUCTION instead:
 *
 *   class Game extends Scene {           → bases come from `class_heritage`
 *     init() {
 *       this.game = new BodyPuzzleGame(); → field `game : BodyPuzzleGame`
 *       this.detector = createDetector(); → field `detector : <return of createDetector>`
 *     }
 *   }
 *   function createDetector() {
 *     return Object.freeze({ update() {…} }); → `update` is a method of `createDetector()`
 *   }
 *
 * Without these facts `this.detector.update()` had no receiver type, resolution
 * fell back to same-file/same-dir candidates only, and a method living in another
 * directory was reported as having no static caller (Ludellus PR #1757).
 *
 * A factory's returned object literal gets the synthetic type name `<factory>()`.
 * Parentheses cannot occur in a declared type name, so it never collides with a
 * class. Only a DIRECT `return { … }` / `return Object.freeze({ … })` of the
 * factory body counts — an object built elsewhere and returned by variable is
 * not followed (no guessing).
 *
 * SRP: read script-family syntax into the plain facts extract.ts records. No
 * resolution happens here; graph/type-resolve consumes the facts.
 *
 * @spec Script receiver typing
 */

import type { Node } from "web-tree-sitter";
import type { FieldInfo, ParamInfo } from "../types.js";

/** Function-like script nodes whose body owns its own `this` / `return`. */
const SCRIPT_FUNCTION_TYPES = new Set<string>([
  "function_declaration",
  "function_expression",
  "generator_function_declaration",
  "generator_function",
  "method_definition",
]);

/** Arrow functions keep the enclosing `this` but own their `return`. */
const RETURN_BOUNDARY_TYPES = new Set<string>([...SCRIPT_FUNCTION_TYPES, "arrow_function", "class_body"]);

/** The synthetic type name of the object a factory function returns. */
export function factoryTypeName(factoryName: string): string {
  return `${factoryName}()`;
}

/** Rightmost identifier of `Foo` / `ns.Foo` / `Foo<T>` (heritage and `new` targets). */
function scriptSimpleName(node: Node | null): string | null {
  if (!node) return null;
  switch (node.type) {
    case "identifier":
    case "type_identifier":
      return node.text;
    case "member_expression":
      return node.childForFieldName("property")?.text ?? null;
    case "nested_type_identifier":
      return node.childForFieldName("name")?.text ?? null;
    case "generic_type":
      return scriptSimpleName(node.childForFieldName("name") ?? node.namedChildren[0] ?? null);
    default:
      return null;
  }
}

/**
 * Base classes / implemented interfaces of a script class:
 *   JS: class_heritage → <expression>
 *   TS: class_heritage → extends_clause (value) / implements_clause (types)
 */
export function scriptBases(container: Node): string[] {
  const heritage = container.namedChildren.find((child) => child?.type === "class_heritage");
  if (!heritage) return [];
  const bases: string[] = [];
  for (const child of heritage.namedChildren) {
    if (!child) continue;
    if (child.type === "extends_clause" || child.type === "implements_clause") {
      for (const inner of child.namedChildren) {
        if (inner?.type === "type_arguments") continue;
        const name = scriptSimpleName(inner);
        if (name) bases.push(name);
      }
      continue;
    }
    const name = scriptSimpleName(child);
    if (name) bases.push(name);
  }
  return [...new Set(bases)];
}

/** TS formal parameter node types (`p: T`, `p?: T`, parameter properties). */
const SCRIPT_PARAMETER_TYPES = new Set<string>(["required_parameter", "optional_parameter"]);

/** `p: T` → { name: p, type: T }; destructured / untyped parameters → null. */
export function scriptParam(param: Node): ParamInfo | null {
  if (!SCRIPT_PARAMETER_TYPES.has(param.type)) return null;
  const pattern = param.childForFieldName("pattern");
  if (pattern?.type !== "identifier") return null;
  const annotation = param.childForFieldName("type")?.namedChildren[0] ?? null;
  return { name: pattern.text, type: scriptSimpleName(annotation) };
}

/** `constructor(private readonly p: T)` declares a member `p : T` as well. */
function parameterProperties(constructor: Node): Array<{ name: string; type: string }> {
  const out: Array<{ name: string; type: string }> = [];
  const params = constructor.childForFieldName("parameters");
  for (const param of params?.namedChildren ?? []) {
    if (!param || !SCRIPT_PARAMETER_TYPES.has(param.type)) continue;
    const isProperty = param.namedChildren.some((child) => child?.type === "accessibility_modifier")
      || param.children.some((child) => child?.type === "readonly");
    const info = isProperty ? scriptParam(param) : null;
    if (info?.type) out.push({ name: info.name, type: info.type });
  }
  return out;
}

/** Type facts of an initializer: `new C()` → C, `factory()` → deferred to its return. */
function initializerFacts(value: Node | null): Pick<FieldInfo, "type" | "initCall"> | null {
  if (!value) return null;
  if (value.type === "new_expression") {
    const type = scriptSimpleName(value.childForFieldName("constructor"));
    return type ? { type } : null;
  }
  if (value.type === "call_expression") {
    const callee = value.childForFieldName("function");
    if (callee?.type === "identifier") return { type: null, initCall: callee.text };
  }
  return null;
}

/** `this.<name>` → name, else null. */
function thisMemberName(node: Node | null): string | null {
  if (node?.type !== "member_expression") return null;
  if (node.childForFieldName("object")?.type !== "this") return null;
  const property = node.childForFieldName("property");
  return property?.type === "property_identifier" ? property.text : null;
}

/** Visit descendants that share `root`'s `this` (stops at nested non-arrow functions). */
function visitSameThis(root: Node, visit: (node: Node) => void): void {
  const stack: Node[] = [...root.namedChildren.filter((child): child is Node => child !== null)];
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    if (SCRIPT_FUNCTION_TYPES.has(node.type) || node.type === "class_declaration" || node.type === "class") continue;
    for (const child of node.namedChildren) if (child) stack.push(child);
  }
}

/**
 * Data members of a script class, typed by how they are constructed:
 *   - TS `field: T` / `field = new C()` / `field = factory()` declarations;
 *   - `this.field = new C()` / `this.field = factory()` assignments in any method.
 * A member assigned two DIFFERENT types is dropped — the receiver type is then
 * genuinely unknown, and guessing one would bind calls to the wrong class.
 */
export function scriptFields(container: Node): FieldInfo[] {
  const body = container.childForFieldName("body")
    ?? container.namedChildren.find((child) => child?.type === "class_body")
    ?? null;
  if (!body) return [];
  const facts = new Map<string, Pick<FieldInfo, "type" | "initCall">[]>();
  const record = (name: string | null, fact: Pick<FieldInfo, "type" | "initCall"> | null): void => {
    if (!name || !fact) return;
    const list = facts.get(name) ?? [];
    list.push(fact);
    facts.set(name, list);
  };

  for (const member of body.namedChildren) {
    if (!member) continue;
    if (member.type === "public_field_definition" || member.type === "field_definition") {
      const name = (member.childForFieldName("name") ?? member.childForFieldName("property"))?.text ?? null;
      const annotation = member.childForFieldName("type")?.namedChildren[0] ?? null;
      const declared = scriptSimpleName(annotation);
      record(name, declared ? { type: declared } : initializerFacts(member.childForFieldName("value")));
      continue;
    }
    if (member.type !== "method_definition") continue;
    if (member.childForFieldName("name")?.text === "constructor") {
      for (const property of parameterProperties(member)) record(property.name, { type: property.type });
    }
    const methodBody = member.childForFieldName("body");
    if (!methodBody) continue;
    visitSameThis(methodBody, (node) => {
      if (node.type !== "assignment_expression") return;
      record(thisMemberName(node.childForFieldName("left")), initializerFacts(node.childForFieldName("right")));
    });
  }

  const fields: FieldInfo[] = [];
  for (const [name, list] of facts) {
    const distinct = new Set(list.map((fact) => `${fact.type ?? ""}\0${fact.initCall ?? ""}`));
    if (distinct.size !== 1) continue;
    const fact = list[0]!;
    fields.push({ name, type: fact.type, ...(fact.initCall ? { initCall: fact.initCall } : {}) });
  }
  return fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The object literal a `return` hands back directly (`{…}` or `Object.freeze({…})`). */
function returnedObject(returnStatement: Node): Node | null {
  const value = returnStatement.namedChildren[0] ?? null;
  if (!value) return null;
  if (value.type === "object") return value;
  if (value.type === "parenthesized_expression") {
    const inner = value.namedChildren[0] ?? null;
    return inner?.type === "object" ? inner : null;
  }
  if (value.type === "call_expression" && value.childForFieldName("function")?.text === "Object.freeze") {
    const first = value.childForFieldName("arguments")?.namedChildren[0] ?? null;
    return first?.type === "object" ? first : null;
  }
  return null;
}

/** tree-sitter hands out fresh wrapper objects, so compare node identity by id. */
function sameNode(a: Node | null, b: Node | null): boolean {
  return a !== null && b !== null && a.id === b.id;
}

/** Nearest function-like ancestor that owns `node`'s `return` (stops at class bodies). */
function returnOwner(node: Node): Node | null {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "class_body") return null;
    if (RETURN_BOUNDARY_TYPES.has(current.type)) return current;
  }
  return null;
}

/** Declared name of a script function (declaration name or `const f = () => …` binding). */
function scriptFunctionName(fn: Node): string | null {
  const name = fn.childForFieldName("name");
  if (name && fn.type !== "method_definition") return name.text;
  if (fn.type === "arrow_function" || fn.type === "function_expression") {
    const parent = fn.parent;
    if (parent?.type === "variable_declarator") return parent.childForFieldName("name")?.text ?? null;
  }
  return null;
}

/**
 * When `fn` is a named factory that directly returns an object literal, the
 * synthetic type of that object; else null.
 */
export function factoryReturnType(fn: Node): string | null {
  if (fn.type === "method_definition") return null;
  const name = scriptFunctionName(fn);
  if (!name) return null;
  const body = fn.childForFieldName("body");
  if (!body) return null;
  if (fn.type === "arrow_function" && body.type === "object") return factoryTypeName(name);
  const stack: Node[] = [body];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "return_statement" && sameNode(returnOwner(node), fn) && returnedObject(node)) {
      return factoryTypeName(name);
    }
    for (const child of node.namedChildren) {
      if (child && !RETURN_BOUNDARY_TYPES.has(child.type)) stack.push(child);
    }
  }
  return null;
}

/**
 * The synthetic owner of a method defined inside a factory's returned object
 * literal (`return Object.freeze({ update() {…} })` → `createDetector()`), else null.
 */
export function factoryMethodOwner(method: Node): string | null {
  let object: Node | null = method.parent;
  if (object?.type === "pair") object = object.parent; // `update: function () {…}`
  if (object?.type !== "object") return null;
  let carrier: Node | null = object.parent;
  if (carrier?.type === "parenthesized_expression") carrier = carrier.parent;
  if (carrier?.type === "arguments") carrier = carrier.parent?.parent ?? null; // Object.freeze(…)
  if (carrier?.type !== "return_statement" || !sameNode(returnedObject(carrier), object)) return null;
  const owner = returnOwner(carrier);
  const name = owner ? scriptFunctionName(owner) : null;
  return name ? factoryTypeName(name) : null;
}

/** `get name() {}` / `set name(v) {}` accessor kind of a method_definition. */
export function accessorKind(node: Node): "get" | "set" | undefined {
  if (node.type !== "method_definition") return undefined;
  for (const child of node.children) {
    if (child?.type === "get") return "get";
    if (child?.type === "set") return "set";
  }
  return undefined;
}
