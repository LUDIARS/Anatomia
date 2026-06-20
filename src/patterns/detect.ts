/**
 * src/patterns/detect.ts — Heuristic access-pattern detection (source scan).
 *
 * Games lean heavily on globally-reached objects (singletons), Service-Locator
 * and Facade entry points. Those turn a domain graph into a hairball, so the
 * Domain View wants to (a) mark them and (b) show WHICH domains reach them and
 * HOW.
 *
 * Why a SOURCE scan and not the call graph: the dominant singleton form in C#
 * Unity code is a *static property* — `public static GameManager Instance { get; }`
 * / `=> s_instance;`. Properties (and `Type.Instance` member accesses) are not
 * extracted into the function DAG at all, so a graph overlay finds nothing on a
 * real game. We therefore scan source text for declarations + `Type.Member`
 * usages, then attribute each usage to the enclosing analyzed function (by line
 * range) and thence to its domain.
 *
 * Kept separate from `src/domains/` (ontology/engine, under active B-3 work):
 * this is name/signature/source heuristics, promotable to ontology later.
 *
 * SRP: pattern detection + accessor-domain attribution. No HTTP, no rendering.
 * `scanForPatterns` is pure (testable without fs); `detectAccessPatterns` adds
 * the file reads.
 */

import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type { AnchorId, FunctionNode } from "../types.js";
import type { AnalysisContext } from "../core.js";
import type { DetectionResult } from "../domains/detect.js";

export type AccessPatternKind = "singleton" | "service-locator" | "facade";

export interface PatternAccessor {
  domain: string;
  /** How the domain reaches it: "reads" (property/field) or "calls" (method). */
  access: string;
}

export interface AccessPattern {
  /** Declaring type/class name (the identity referenced as `Name.Member`). */
  name: string;
  file: string; // repo-relative, forward slashes
  line: number;
  kind: AccessPatternKind;
  reason: string;
  /** Domains that reach this pattern, with how. */
  accessors: PatternAccessor[];
}

/** One source file's path + text, for the pure scanner. */
export interface ScanFile {
  path: string; // absolute
  text: string;
}

// ---------------------------------------------------------------------------
// Heuristic regexes
// ---------------------------------------------------------------------------

// Singleton accessor declaration. Capital `Instance`/`GetInstance` counts as a
// property `{`, expression/field `=`, method `(`, or field `;` (the C# form).
// Lowercase `instance`/`getInstance` counts ONLY as a method `(` (C++ Meyers /
// TS getter) — so a private lowercase backing field `static X instance;` is NOT
// mistaken for the public accessor.
const SINGLETON_DECL =
  /\bstatic\b[^;={(]*?(?:\b(?:Instance|GetInstance)\s*[{=(;]|\b(?:getInstance|instance)\s*\()/;

// Service-Locator resolution method declaration in a locator-ish file/class.
const LOCATOR_DECL = /\b(?:public|internal|protected|private|static)\b[^;={(]*?\b(Resolve|Provide|GetService|Locate)\s*[<(]/;
const LOCATOR_FILE = /locator|servicelocator|container/i;

// class / struct declaration → captures the enclosing type name.
const CLASS_DECL = /\b(?:class|struct|interface)\s+([A-Za-z_]\w*)/;
const FACADE_CLASS = /\b(?:class|struct)\s+(\w*Facade)\b/;

// Usages: `Type.Instance`, `Type.Resolve(`/`Type.Provide(…`, `XFacade.member`.
const USE_SINGLETON = /\b([A-Z]\w*)\.(?:Instance|GetInstance|getInstance)\b/g;
const USE_LOCATOR = /\b([A-Z]\w*)\.(?:Resolve|Provide|GetService|Locate)\s*[<(]/g;
const USE_FACADE = /\b(\w*Facade)\s*\.\s*[A-Za-z_]\w*/g;

// ---------------------------------------------------------------------------
// scanForPatterns (pure)
// ---------------------------------------------------------------------------

interface Decl { kind: AccessPatternKind; name: string; file: string; line: number; reason: string; }
interface Use { name: string; access: string; absPath: string; line: number; }

/** Nearest enclosing `class/struct/interface` name at or above `idx`. */
function enclosingClass(lines: string[], idx: number): string | null {
  for (let i = idx; i >= 0; i--) {
    const m = lines[i]!.match(CLASS_DECL);
    if (m) return m[1]!;
  }
  return null;
}

export function scanForPatterns(
  files: ScanFile[],
  functions: FunctionNode[],
  domains: DetectionResult[],
  repoPath: string,
): AccessPattern[] {
  const rel = (p: string): string => {
    try { return relative(repoPath, p).replace(/\\/g, "/"); } catch { return p; }
  };

  // anchor → domains, for accessor attribution.
  const domainsOf = new Map<string, Set<string>>();
  for (const d of domains) {
    for (const a of d.implementors) {
      let s = domainsOf.get(a);
      if (!s) domainsOf.set(a, (s = new Set()));
      s.add(d.domain);
    }
  }

  // Per-file analyzed function ranges, for enclosing-function lookup of a usage.
  const fnsByFile = new Map<string, { start: number; end: number; anchor: AnchorId }[]>();
  for (const fn of functions) {
    if (!fn.id) continue;
    const arr = fnsByFile.get(fn.sourceRange.filePath) ?? [];
    arr.push({ start: fn.sourceRange.start.line, end: fn.sourceRange.end.line, anchor: fn.id });
    fnsByFile.set(fn.sourceRange.filePath, arr);
  }

  const decls: Decl[] = [];
  const uses: Use[] = [];

  for (const f of files) {
    if (!f.text) continue;
    const lines = f.text.split(/\r?\n/);
    const relFile = rel(f.path);
    const inLocatorFile = LOCATOR_FILE.test(relFile);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // ── declarations ──
      if (SINGLETON_DECL.test(line)) {
        const cls = enclosingClass(lines, i);
        if (cls) decls.push({ kind: "singleton", name: cls, file: relFile, line: i + 1, reason: `static Instance accessor in ${cls}` });
      }
      const facadeCls = line.match(FACADE_CLASS);
      if (facadeCls) {
        decls.push({ kind: "facade", name: facadeCls[1]!, file: relFile, line: i + 1, reason: `class ${facadeCls[1]} (facade-named)` });
      }
      if (inLocatorFile && LOCATOR_DECL.test(line)) {
        const cls = enclosingClass(lines, i) ?? relFile;
        decls.push({ kind: "service-locator", name: cls, file: relFile, line: i + 1, reason: `resolve method in ${relFile}` });
      }

      // ── usages ──
      collect(line, USE_SINGLETON, "reads", f.path, i + 1, uses);
      collect(line, USE_LOCATOR, "calls", f.path, i + 1, uses);
      collect(line, USE_FACADE, "calls", f.path, i + 1, uses);
    }
  }

  // Join: per declared type, attribute usages → enclosing function → domain.
  const byKey = new Map<string, Decl>(); // dedup decls by name+kind (keep first)
  for (const d of decls) {
    const k = d.kind + " " + d.name;
    if (!byKey.has(k)) byKey.set(k, d);
  }

  const out: AccessPattern[] = [];
  for (const d of byKey.values()) {
    const byDomain = new Map<string, Set<string>>();
    for (const u of uses) {
      if (u.name !== d.name) continue;
      const anchor = enclosingFn(fnsByFile.get(u.absPath), u.line);
      if (!anchor) continue;
      const ds = domainsOf.get(anchor);
      if (!ds) continue;
      for (const dom of ds) {
        let s = byDomain.get(dom);
        if (!s) byDomain.set(dom, (s = new Set()));
        s.add(u.access);
      }
    }
    const accessors: PatternAccessor[] = [];
    for (const [domain, kinds] of byDomain) for (const access of kinds) accessors.push({ domain, access });
    accessors.sort((a, b) => a.domain.localeCompare(b.domain) || a.access.localeCompare(b.access));
    out.push({ ...d, accessors });
  }

  out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return out;
}

function collect(line: string, re: RegExp, access: string, absPath: string, lineNo: number, uses: Use[]): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    uses.push({ name: m[1]!, access, absPath, line: lineNo });
  }
}

function enclosingFn(
  ranges: { start: number; end: number; anchor: AnchorId }[] | undefined,
  line: number,
): AnchorId | null {
  if (!ranges) return null;
  for (const r of ranges) if (line >= r.start && line <= r.end) return r.anchor;
  return null;
}

// ---------------------------------------------------------------------------
// detectAccessPatterns (reads files, then scans)
// ---------------------------------------------------------------------------

export async function detectAccessPatterns(ctx: AnalysisContext): Promise<AccessPattern[]> {
  const files: ScanFile[] = await Promise.all(
    ctx.files.map(async (f) => ({
      path: f.path,
      text: await readFile(f.path, "utf8").catch(() => ""),
    })),
  );
  return scanForPatterns(files, ctx.functions, ctx.domains ?? [], ctx.repoPath);
}
