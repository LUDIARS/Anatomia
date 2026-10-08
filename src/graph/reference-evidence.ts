/** Resolve plain lexical records without altering call edges or metric populations.
 * @spec Source reference evidence
 */
import { dirname, resolve } from "node:path";
import type { AnchorId, FileNode, SourceReferenceEvidence, SourceReferenceSyntax } from "../types.js";

type Binding = SourceReferenceSyntax["bindings"][number];
/**
 * @spec Source reference evidence
 */
function bindingAt(syntax: SourceReferenceSyntax, name: string, initial: number): Binding | undefined {
  for (let scope: number | null = initial; scope !== null; scope = syntax.scopes[scope]?.parent ?? null) {
    if (syntax.scopes[scope]?.uncertain) return undefined;
    const matches = syntax.bindings.filter((binding) => binding.scope === scope && binding.name === name);
    if (matches.length) return matches.length === 1 ? matches[0] : undefined;
  }
  return undefined;
}

/**
 * @spec Source reference evidence
 */
export function resolveReferenceEvidence(files: FileNode[]): SourceReferenceEvidence[] {
  const normalizePath = (path: string): string => resolve(path).replace(/\\/g, "/");
  const byPath = new Map(files.map((file) => [normalizePath(file.path), file]));
  const moduleFile = (file: FileNode, source: string): FileNode | undefined => {
    if (!source.startsWith(".")) return undefined;
    const path = normalizePath(resolve(dirname(file.path), source));
    const stem = path.replace(/\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/, "");
    const candidates = new Set<FileNode>();
    for (const candidate of [path, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].flatMap((ext) => [stem + ext, path + "/index" + ext])]) {
      const found = byPath.get(candidate);
      if (found) candidates.add(found);
    }
    return candidates.size === 1 ? [...candidates][0] : undefined;
  };
  const targetOf = (file: FileNode, binding: Binding, seen = new Set<Binding>()): AnchorId | undefined => {
    if (seen.has(binding)) return undefined;
    seen.add(binding);
    if (!binding.imported) return binding.targets.length === 1 ? binding.targets[0] : undefined;
    const importedFile = moduleFile(file, binding.imported.source);
    const syntax = importedFile?.referenceSyntax;
    if (!importedFile || !syntax) return undefined;
    const exports = syntax.exports.filter((entry) => entry.name === binding.imported!.name);
    if (exports.length !== 1) return undefined;
    const importedBinding = bindingAt(syntax, exports[0]!.binding, 0);
    return importedBinding ? targetOf(importedFile, importedBinding, seen) : undefined;
  };
  const evidence: SourceReferenceEvidence[] = [];
  files.forEach((file) => {
    const syntax = file.referenceSyntax;
    if (!syntax) return;
    for (const reference of syntax.references) {
      const binding = bindingAt(syntax, reference.name, reference.scope);
      const target = binding && targetOf(file, binding);
      if (!target || reference.owner === target) continue;
      evidence.push({ target, kind: reference.kind, file: file.path, line: reference.line,
        column: reference.column, owner: reference.owner });
    }
  });
  return evidence.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.kind.localeCompare(b.kind));
}
