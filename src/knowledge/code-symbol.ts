import { extname, relative } from "node:path";
import type { AnchorId, SourceRange } from "../types.js";
import type { CodeSymbolEvidence } from "./domain/types.js";
import { codeSymbolEntityId } from "./identity.js";

export interface AnalyzedCodeSymbolEvidence extends CodeSymbolEvidence {
  anchorId: string;
}

export interface CodeSymbolSource {
  id: AnchorId | null;
  name: string;
  signature?: string;
  signatureShape?: string;
  sourceRange: SourceRange;
}

function sourceLanguage(sourcePath: string): string {
  const extension = extname(sourcePath).toLowerCase();
  if (extension === ".cs") return "c_sharp";
  if (extension === ".tsx") return "tsx";
  if (extension === ".ts") return "typescript";
  if ([".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"].includes(extension)) return "cpp";
  return extension.replace(/^\./, "") || "unknown";
}

export function describeCodeSymbol(
  projectId: string,
  projectRoot: string,
  node: CodeSymbolSource,
  sourceRevision: string,
): AnalyzedCodeSymbolEvidence {
  if (!node.id) throw new Error(`analyzed function has no anchor: ${node.name}`);
  const sourcePath = relative(projectRoot, node.sourceRange.filePath).replace(/\\/g, "/");
  const language = sourceLanguage(sourcePath);
  const signature = node.signature ?? node.signatureShape ?? node.name;
  const signatureShape = node.signatureShape ?? signature;
  return {
    anchorId: String(node.id),
    symbolId: codeSymbolEntityId(projectId, language, signatureShape, sourcePath),
    language,
    qualifiedName: node.name,
    sourcePath,
    startLine: node.sourceRange.start.line,
    endLine: node.sourceRange.end.line,
    signature,
    signatureShape,
    sourceRevision,
    contentFingerprint: `anchor:${String(node.id)}`,
  };
}
