/** Extract lexical usage records while a TS/JS file tree is alive. No name guessing.
 * @spec Source reference evidence
 */
import type { Node, Tree } from "web-tree-sitter";
import type { AnchorId, FunctionNode, SourceReferenceSyntax } from "../types.js";

const FUNCTIONS = new Set(["function_declaration", "function_expression", "arrow_function", "method_definition"]);
const SCOPES = new Set([...FUNCTIONS, "statement_block", "class_body", "catch_clause", "for_statement", "for_in_statement"]);

/**
 * @spec Source reference evidence
 */
function patternNames(node: Node | null): string[] {
  if (!node) return [];
  if (["identifier", "shorthand_property_identifier_pattern"].includes(node.type)) return [node.text];
  if (["type_annotation", "predefined_type", "type_identifier", "member_expression", "subscript_expression"].includes(node.type)) return [];
  if (node.type === "pair_pattern") return patternNames(node.childForFieldName("value"));
  if (["assignment_pattern", "object_assignment_pattern"].includes(node.type)) {
    return patternNames(node.childForFieldName("left"));
  }
  return node.namedChildren.flatMap((child) => patternNames(child));
}

/**
 * @spec Source reference evidence
 */
export function extractReferenceSyntax(tree: Tree, functions: FunctionNode[]): SourceReferenceSyntax {
  const syntax: SourceReferenceSyntax = { version: 2, scopes: [{ parent: null }], bindings: [], exports: [], references: [] };
  const scopeByNode = new Map<number, number>([[tree.rootNode.id, 0]]);
  const functionScopes = new Set([0]);
  const mutations: { scope: number; names: string[] }[] = [];
  const functionAt = (node: Node | null): AnchorId[] => {
    if (!node) return [];
    return functions.filter((fn) => fn.id && fn.sourceRange.start.line === node.startPosition.row
      && fn.sourceRange.start.column === node.startPosition.column).map((fn) => fn.id!);
  };
  const bind = (scope: number, name: string, targets: AnchorId[] = []): void => {
    syntax.bindings.push({ scope, name, targets });
  };
  const bindPattern = (scope: number, pattern: Node | null, targets: AnchorId[] = []): void => {
    for (const name of patternNames(pattern)) bind(scope, name, targets);
  };
  const exported = (node: Node): boolean => node.parent?.type === "export_statement"
    && !/^export\s+default\b/.test(node.parent.text);
  const expose = (node: Node, name: string): void => {
    if (exported(node)) syntax.exports.push({ name, binding: name });
  };
  const record = (node: Node, scope: number, owner: AnchorId | null, kind: "call" | "constructor" | "callback-reference"): void => {
    if (node.type !== "identifier") return;
    syntax.references.push({ scope, name: node.text, kind, line: node.startPosition.row,
      column: node.startPosition.column, owner });
  };

  const visit = (node: Node, outerScope: number, outerOwner: AnchorId | null): void => {
    // Declarations bind in their enclosing scope; function internals get a child scope.
    if (node.type === "function_declaration") {
      const name = node.childForFieldName("name");
      if (name) { bind(outerScope, name.text, functionAt(node)); expose(node, name.text); }
    }
    if (node.type === "class_declaration") {
      const name = node.childForFieldName("name");
      if (name) {
        const constructors = functions.filter((fn) => fn.id && fn.name === "constructor"
          && fn.enclosingType === name.text
          && fn.sourceRange.start.line >= node.startPosition.row && fn.sourceRange.end.line <= node.endPosition.row);
        bind(outerScope, name.text, constructors.map((fn) => fn.id!));
        expose(node, name.text);
      }
    }
    let scope = outerScope;
    let owner = outerOwner;
    if (SCOPES.has(node.type)) {
      scope = syntax.scopes.push({ parent: outerScope }) - 1;
      scopeByNode.set(node.id, scope);
      if (FUNCTIONS.has(node.type)) {
        functionScopes.add(scope);
        owner = functionAt(node)[0] ?? null;
        const params = node.childForFieldName("parameters") ?? node.childForFieldName("parameter");
        if (params?.type === "formal_parameters") {
          for (const param of params.namedChildren) {
            if (param) bindPattern(scope, param.childForFieldName("pattern") ?? param.childForFieldName("name") ?? param);
          }
        } else bindPattern(scope, params);
        if (node.type === "function_expression") bindPattern(scope, node.childForFieldName("name"), functionAt(node));
      }
      if (node.type === "catch_clause") bindPattern(scope, node.childForFieldName("parameter"));
    }
    if (node.type === "variable_declarator") {
      let bindingScope = scope;
      if (node.parent?.type === "variable_declaration") {
        while (!functionScopes.has(bindingScope)) bindingScope = syntax.scopes[bindingScope]!.parent ?? 0;
      }
      const value = node.childForFieldName("value");
      const targets = value && FUNCTIONS.has(value.type) ? functionAt(value) : [];
      const name = node.childForFieldName("name");
      bindPattern(bindingScope, name, targets);
      if (name?.type === "identifier" && node.parent?.parent?.type === "export_statement") {
        syntax.exports.push({ name: name.text, binding: name.text });
      }
    }
    if (node.type === "for_in_statement") {
      const left = node.childForFieldName("left");
      if (/^for\s*(?:await\s*)?\(\s*(?:const|let|var)\b/.test(node.text)) bindPattern(scope, left);
      else mutations.push({ scope, names: patternNames(left) });
    }
    if (node.type === "import_statement") {
      const source = node.childForFieldName("source")?.text.slice(1, -1);
      const typeOnly = /^import\s+type\b/.test(node.text);
      for (const spec of node.descendantsOfType("import_specifier")) {
        if (!spec) continue;
        const name = spec.childForFieldName("name");
        const alias = spec.childForFieldName("alias") ?? name;
        if (alias && name) syntax.bindings.push({ scope, name: alias.text, targets: [],
          ...(!typeOnly && !/^type\s/.test(spec.text) && source ? { imported: { source, name: name.text } } : {}) });
      }
      // Unsupported default/namespace imports still shadow same-named declarations.
      for (const clause of node.namedChildren) {
        if (clause?.type !== "import_clause") continue;
        for (const child of clause.namedChildren) {
          if (child?.type === "identifier") bind(scope, child.text);
          if (child?.type === "namespace_import") {
            for (const id of child.namedChildren) if (id?.type === "identifier") bind(scope, id.text);
          }
        }
      }
    }
    if (node.type === "export_statement") {
      const source = node.childForFieldName("source")?.text.slice(1, -1);
      const typeOnly = /^export\s+type\b/.test(node.text);
      for (const spec of node.descendantsOfType("export_specifier")) {
        const name = spec?.childForFieldName("name");
        const alias = spec?.childForFieldName("alias") ?? name;
        if (name && alias && !typeOnly && !/^type\s/.test(spec!.text)) {
          const binding = source ? `#export:${syntax.exports.length}` : name.text;
          if (source) syntax.bindings.push({ scope: 0, name: binding, targets: [], imported: { source, name: name.text } });
          syntax.exports.push({ name: alias.text, binding });
        }
      }
    }
    if (node.type === "call_expression" || node.type === "new_expression") {
      const callee = node.childForFieldName(node.type === "new_expression" ? "constructor" : "function");
      if (callee) record(callee, scope, owner, node.type === "new_expression" ? "constructor" : "call");
      const args = node.childForFieldName("arguments");
      for (const arg of args?.namedChildren ?? []) if (arg) record(arg, scope, owner, "callback-reference");
    }
    // Resolve mutations after all declarations are known, including hoisted names.
    if (["assignment_expression", "augmented_assignment_expression"].includes(node.type)) {
      const left = node.childForFieldName("left");
      mutations.push({ scope, names: patternNames(left) });
    }
    if (node.type === "update_expression") {
      mutations.push({ scope, names: patternNames(node.childForFieldName("argument") ?? node.namedChildren[0] ?? null) });
    }
    for (const child of node.namedChildren) if (child) visit(child, scope, owner);
  };
  visit(tree.rootNode, 0, null);
  // Type annotations are erased and cannot hide runtime bindings. Other
  // recoveries taint their nearest lexical scope, including unnamed missing
  // punctuation tokens that namedChildren would not visit.
  const stack: Node[] = [tree.rootNode];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === "ERROR" || node.isMissing) {
      let scope: number | undefined;
      let erasedType = false;
      for (let current: Node | null = node; current; current = current.parent) {
        if (current.type === "type_annotation") { erasedType = true; break; }
        scope ??= scopeByNode.get(current.id);
      }
      if (!erasedType) syntax.scopes[scope ?? 0]!.uncertain = true;
    }
    for (const child of node.children) if (child) stack.push(child);
  }
  for (const mutation of mutations) {
    for (const name of mutation.names) {
      for (let scope: number | null = mutation.scope; scope !== null; scope = syntax.scopes[scope]?.parent ?? null) {
        const bindings = syntax.bindings.filter((binding) => binding.scope === scope && binding.name === name);
        if (!bindings.length) continue;
        for (const binding of bindings) { binding.targets = []; delete binding.imported; }
        break;
      }
    }
  }
  return syntax;
}
