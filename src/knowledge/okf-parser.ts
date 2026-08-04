import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { SpecClause } from "../types.js";
import { normalizeIdSegment, provisionalEntityId } from "./identity.js";
import type { OkfProfile, ParsedOkfDocument } from "./types.js";

type UnitKind = NonNullable<SpecClause["unitKind"]>;

export interface OkfParserOptions {
  sourceFile?: string;
  projectId?: string;
  generatedRoot?: string;
  domainRoot?: string;
  annotationRoot?: string;
}

interface SemanticUnit {
  kind: UnitKind;
  text: string;
  heading: string;
  address: string;
  startLine: number;
  endLine: number;
  explicitId?: string;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function scalar(value: string): unknown {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map((item) => String(scalar(item))).filter(Boolean);
  }
  return trimmed;
}

function parseFrontmatter(lines: string[]): { data: Record<string, unknown>; bodyStart: number } {
  if (lines[0]?.trim() !== "---") return { data: {}, bodyStart: 0 };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  // A leading "---" is also a legal thematic break. Unterminated means "no
  // frontmatter", not "unparseable document" — parseSpecFiles walks whole repos.
  if (end < 0) return { data: {}, bodyStart: 0 };

  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [{ indent: -1, value: root }];
  let pendingArray: { indent: number; owner: Record<string, unknown>; key: string } | null = null;
  for (let index = 1; index < end; index++) {
    const raw = lines[index];
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const item = raw.trim().match(/^-\s+(.+)$/);
    if (item && pendingArray && indent > pendingArray.indent) {
      (pendingArray.owner[pendingArray.key] as unknown[]).push(scalar(item[1]));
      continue;
    }
    const match = raw.trim().match(/^([^:]+):(?:\s*(.*))?$/);
    if (!match) continue;
    while (stack.length > 1 && indent <= stack.at(-1)!.indent) stack.pop();
    const owner = stack.at(-1)!.value;
    const key = match[1].trim();
    const rest = match[2] ?? "";
    if (rest !== "") {
      owner[key] = scalar(rest);
      pendingArray = null;
      continue;
    }
    const next = lines[index + 1]?.trim() ?? "";
    if (next.startsWith("- ")) {
      owner[key] = [];
      pendingArray = { indent, owner, key };
    } else {
      const child: Record<string, unknown> = {};
      owner[key] = child;
      stack.push({ indent, value: child });
      pendingArray = null;
    }
  }
  return { data: root, bodyStart: end + 1 };
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

function readProfile(raw: Record<string, unknown>, filePath: string): OkfProfile {
  const extension = raw["x-anatomia"];
  const x = extension && typeof extension === "object" && !Array.isArray(extension)
    ? extension as Record<string, unknown>
    : {};
  const okfTypes: readonly string[] = ["data", "feature", "interface", "plan", "setup", "test"];
  const declaredType = typeof raw.type === "string" && okfTypes.includes(raw.type)
    ? raw.type as OkfProfile["type"]
    : undefined;
  // Only documents that opt into Anatomia routing are held to the AIFormat type
  // set; foreign Markdown ("type: post") must not abort the analysis run.
  if (extension !== undefined && raw.type !== undefined && declaredType === undefined) {
    throw new Error(`unsupported AIFormat type: ${String(raw.type)} (${filePath})`);
  }
  return {
    type: declaredType,
    title: typeof raw.title === "string" ? raw.title : undefined,
    service: typeof raw.service === "string" ? raw.service : undefined,
    domain: typeof raw.domain === "string" ? raw.domain : undefined,
    status: typeof raw.status === "string" ? raw.status : undefined,
    anatomia: {
      kind: typeof x.kind === "string" && x.kind.trim() ? x.kind.trim() : "specification",
      id: typeof x.id === "string" && x.id.trim() ? x.id.trim() : undefined,
      generated: x.generated === true,
      domainRefs: strings(x["domain-refs"]),
      symbolRefs: strings(x["symbol-refs"]),
    },
    raw,
  };
}

function normalizedPath(path: string): string {
  return resolve(path).replace(/\\/g, "/").toLowerCase();
}

function within(file: string, root?: string): boolean {
  if (!root) return false;
  const child = relative(normalizedPath(root), normalizedPath(file));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function routeFor(filePath: string, metadata: OkfProfile, options: OkfParserOptions): ParsedOkfDocument["route"] {
  // These throws abort parseSpecFiles for the whole run, so the message has to
  // name the offending file — otherwise every spec link silently drops to zero
  // with nothing but a kind name to go on.
  if (within(filePath, options.domainRoot) && metadata.anatomia.kind !== "domain") {
    throw new Error(`domain root document must use x-anatomia.kind: domain (${filePath})`);
  }
  if (within(filePath, options.annotationRoot) && metadata.anatomia.kind !== "scene-annotation") {
    throw new Error(`annotation root document must use x-anatomia.kind: scene-annotation (${filePath})`);
  }
  if (metadata.anatomia.generated || within(filePath, options.generatedRoot)) return "generated";
  if (metadata.anatomia.kind === "domain") return "domain";
  if (metadata.anatomia.kind === "scene") return "scene";
  if (metadata.anatomia.kind === "scene-annotation") return "scene-annotation";
  return "authored-spec";
}

function headingSlug(text: string): string {
  const normalized = text.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "-");
  return encodeURIComponent(normalized || "root");
}

function extractExplicitId(text: string): { text: string; id?: string } {
  const prefix = text.match(/^\s*\[id:\s*([^\]]+)\]\s*/i);
  if (prefix) return { text: text.slice(prefix[0].length).trim(), id: prefix[1].trim() };
  const suffix = text.match(/\s*\{#([A-Za-z0-9._~-]+)\}\s*$/);
  if (suffix) return { text: text.slice(0, suffix.index).trim(), id: suffix[1] };
  return { text: text.trim() };
}

function semanticUnits(lines: string[], bodyStart: number): SemanticUnit[] {
  const units: SemanticUnit[] = [];
  const headings: Array<string | null> = Array.from({ length: 6 }, () => null);
  const siblingCounts = new Map<string, number>();
  let currentHadContent = true;
  let currentHeadingStart = bodyStart + 1;
  let pendingHeadingExplicitId: string | undefined;
  const headingPath = () => headings.filter((value): value is string => value !== null).join(" / ");
  const add = (kind: UnitKind, text: string, startLine: number, endLine: number, explicitId?: string) => {
    const heading = headingPath();
    const base = `${headings.filter(Boolean).map((value) => headingSlug(value!)).join("/") || "root"}/${kind}`;
    const sibling = siblingCounts.get(base) ?? 0;
    siblingCounts.set(base, sibling + 1);
    units.push({
      kind,
      text: text.trim(),
      heading,
      address: `${base}[${sibling}]`,
      startLine,
      endLine,
      explicitId: explicitId ?? pendingHeadingExplicitId,
    });
    pendingHeadingExplicitId = undefined;
    currentHadContent = true;
  };

  let index = bodyStart;
  let inFence = false;
  let fenceStart = -1;
  let fenceLines: string[] = [];
  let tableHeaders: string[] | null = null;
  while (index < lines.length) {
    const line = lines[index];
    const lineNo = index + 1;
    const heading = !inFence ? line.match(/^(#{1,6})\s+(.+?)\s*$/) : null;
    if (heading) {
      if (!currentHadContent && headingPath()) {
        add("heading", headingPath().split(" / ").at(-1)!, currentHeadingStart, currentHeadingStart);
      }
      const level = heading[1].length;
      const explicit = extractExplicitId(heading[2]);
      headings[level - 1] = explicit.text;
      for (let deeper = level; deeper < headings.length; deeper++) headings[deeper] = null;
      currentHadContent = false;
      currentHeadingStart = lineNo;
      pendingHeadingExplicitId = explicit.id;
      tableHeaders = null;
      index++;
      continue;
    }

    if (/^\s*```/.test(line)) {
      if (!inFence) {
        inFence = true;
        fenceStart = lineNo;
        fenceLines = [line];
      } else {
        fenceLines.push(line);
        add("code-reference", fenceLines.join("\n"), fenceStart, lineNo);
        inFence = false;
      }
      index++;
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      index++;
      continue;
    }
    if (!line.trim()) {
      tableHeaders = null;
      index++;
      continue;
    }

    const list = line.match(/^\s*(?:[-*+] |\d+[.)] )(.*)$/);
    if (list) {
      const start = lineNo;
      const collected = [list[1]];
      index++;
      while (index < lines.length && /^\s{2,}\S/.test(lines[index])
        && !/^\s*(?:[-*+] |\d+[.)] )/.test(lines[index])) {
        collected.push(lines[index].trim());
        index++;
      }
      const explicit = extractExplicitId(collected.join("\n"));
      add("list-item", explicit.text, start, index, explicit.id);
      continue;
    }

    const cells = line.trim().startsWith("|") && line.trim().endsWith("|")
      ? line.trim().slice(1, -1).split("|").map((cell) => cell.trim())
      : null;
    const nextIsSeparator = cells && /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*$/.test(lines[index + 1] ?? "");
    if (cells && nextIsSeparator) {
      tableHeaders = cells;
      index += 2;
      continue;
    }
    if (cells && tableHeaders) {
      const text = tableHeaders.map((header, cell) => `${header}: ${cells[cell] ?? ""}`).join("; ");
      const explicit = extractExplicitId(text);
      add("table-row", explicit.text, lineNo, lineNo, explicit.id);
      index++;
      continue;
    }

    const definition = line.match(/^\s*([^:]{1,120})\s+::?\s+(.+)$/);
    if (definition) {
      const explicit = extractExplicitId(`${definition[1].trim()}: ${definition[2].trim()}`);
      add("definition", explicit.text, lineNo, lineNo, explicit.id);
      index++;
      continue;
    }

    const start = lineNo;
    const paragraph = [line.trim()];
    index++;
    while (index < lines.length && lines[index].trim()
      && !/^(#{1,6})\s+/.test(lines[index])
      && !/^\s*(?:[-*+] |\d+[.)] )/.test(lines[index])
      && !/^\s*```/.test(lines[index])
      && !(lines[index].trim().startsWith("|") && lines[index].trim().endsWith("|"))) {
      paragraph.push(lines[index].trim());
      index++;
    }
    const explicit = extractExplicitId(paragraph.join("\n"));
    add("paragraph", explicit.text, start, index, explicit.id);
  }
  // An unterminated fence closes at EOF: losing the trailing unit would be worse
  // than a slightly over-long code-reference, and throwing would drop the file.
  if (inFence) add("code-reference", fenceLines.join("\n"), fenceStart, lines.length);
  if (!currentHadContent && headingPath()) {
    add("heading", headingPath().split(" / ").at(-1)!, currentHeadingStart, currentHeadingStart);
  }
  return units;
}

function modality(text: string): NonNullable<SpecClause["modality"]> {
  if (/\b(?:must not|shall not)\b|禁止|してはならない/i.test(text)) return "must-not";
  if (/\b(?:must|shall|required)\b|必須|しなければならない/i.test(text)) return "must";
  if (/\bshould\b|推奨|すべき/i.test(text)) return "should";
  if (/\bmay\b|できる|任意/i.test(text)) return "may";
  return "descriptive";
}

function codeReferences(text: string): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(/`([^`\n]+)`/g)) refs.add(match[1]);
  for (const match of text.matchAll(/@implements\s+([A-Za-z0-9:./#_~-]+)/g)) refs.add(match[1]);
  return [...refs];
}

function clauseIdentity(documentId: string, unit: SemanticUnit): { id: string; explicit: boolean } {
  if (unit.explicitId) {
    return {
      id: unit.explicitId.includes(":") ? unit.explicitId : `${documentId}#${unit.explicitId}`,
      explicit: true,
    };
  }
  return { id: `${documentId}#${unit.address}`, explicit: false };
}

export function parseOkfContent(
  content: string,
  filePath: string,
  options: OkfParserOptions = {},
): ParsedOkfDocument {
  const normalized = content.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const frontmatter = parseFrontmatter(lines);
  const metadata = readProfile(frontmatter.data, filePath);
  const sourceFile = options.sourceFile ?? filePath;
  const sourceRevision = sha256(normalized);
  // analyze() derives projectId from the repository directory name, which is not
  // guaranteed to be a stable-id segment ("Ars Anatomia", "My_Repo 2").
  const projectId = normalizeIdSegment(options.projectId ?? metadata.service ?? "project", "project");
  const documentId = metadata.anatomia.id
    ?? provisionalEntityId("spec-document", projectId, sourceFile.replace(/\\/g, "/"));
  const route = routeFor(filePath, metadata, options);
  const clauses = route === "authored-spec"
    ? semanticUnits(lines, frontmatter.bodyStart).map((unit): SpecClause => {
      const identity = clauseIdentity(documentId, unit);
      return {
        id: identity.id,
        documentId,
        explicitId: identity.explicit,
        sourceFile,
        heading: unit.heading,
        text: unit.text,
        unitKind: unit.kind,
        structuralAddress: unit.address,
        sourceLines: { start: unit.startLine, end: unit.endLine },
        revisionHash: sha256(unit.text.replace(/\s+/g, " ").trim()),
        modality: modality(unit.text),
        domainRefs: [...metadata.anatomia.domainRefs],
        symbolRefs: [...metadata.anatomia.symbolRefs],
        codeReferences: codeReferences(unit.text),
        provenance: { method: "markdown-ast", sourceRevision },
        embedding: null,
      };
    })
    : [];
  return {
    route,
    documentId,
    explicitDocumentId: metadata.anatomia.id !== undefined,
    profile: metadata,
    sourceRevision,
    sourceFile,
    clauses,
  };
}

export async function parseOkfFile(
  filePath: string,
  options: OkfParserOptions = {},
): Promise<ParsedOkfDocument> {
  return parseOkfContent(await readFile(filePath, "utf8"), filePath, options);
}
