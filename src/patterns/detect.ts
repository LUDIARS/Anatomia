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
import type { CodeGraphQuery } from "../graph/query.js";

export type AccessPatternKind = "singleton" | "service-locator" | "facade" | "network";

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
  /**
   * For kind="network": the logical target server category (e.g. "ゲームサーバ",
   * "APIサーバ", "ログインサーバ"). URLs/hosts are DI'd at runtime so the literal
   * is not statically available — we classify the role from the client name.
   */
  target?: string;
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

// Network/communication: a client class (by name) or a class that touches a
// known networking API. The literal host is DI'd (not in source), so we classify
// the *role* of the server from the client name (see classifyServer).
const NET_CLIENT_CLASS = /\b(?:class|struct)\s+(\w*(?:ApiClient|HttpClient|WebClient|RestClient|ServerClient|WebSocketClient|Gateway))\b/;
const NET_API = /\b(?:UnityWebRequest|HttpClient|HttpRequestMessage|ClientWebSocket|WebSocket|TcpClient|UdpClient|WebRequest|RestClient|DownloadHandler|UploadHandler|GrpcChannel|XMLHttpRequest)\b|\bSystem\.Net\b|\bfetch\s*\(|\baxios\b/;

// DI-container registrations binding an interface to a concrete type, so a
// consumer that only references the *interface* can still be traced to the
// concrete network client it resolves to:
//   Register<IFoo, Foo>() / RegisterType / RegisterSingleton / AddSingleton /
//   AddScoped / AddTransient / Bind<IFoo, Foo>()  → captures (iface, concrete).
const DI_REGISTER_PAIR =
  /\b(?:Register(?:Type|Singleton|Scoped|Transient)?|AddSingleton|AddScoped|AddTransient|Bind)\s*<\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*>/g;
// Zenject form: `Bind<IFoo>().To<Foo>()` → (iface, concrete).
const DI_BIND_TO =
  /\bBind\s*<\s*([A-Za-z_]\w*)\s*>\s*\([^)]*\)\s*\.\s*To\s*<\s*([A-Za-z_]\w*)\s*>/g;

// Structural-facade threshold: a class whose methods collectively call into at
// least this many DISTINCT functions spanning ≥2 domains is treated as an
// aggregation hub (a facade) even without a *Facade name. Initial value —
// calibrate against a real game (KS, task #324).
const STRUCTURAL_FACADE_FANOUT = 12;

/** Classify a network client's logical target server from its name keywords. */
function classifyServer(name: string): string {
  if (/login|auth|signin|sign_in|account|credential/i.test(name)) return "ログインサーバ";
  if (/rank|leaderboard|score/i.test(name)) return "ランキングサーバ";
  if (/match|lobby|session|realtime|relay|room|multiplay|gameserver/i.test(name)) return "ゲームサーバ";
  if (/error|report|crash|log|telemetry|analytics/i.test(name)) return "ログ/解析サーバ";
  if (/store|purchase|billing|iap|payment|shop|serialcode|unlockcode|redeem|coupon/i.test(name)) return "課金/コードサーバ";
  if (/asset|cdn|download|addressable/i.test(name)) return "アセット配信サーバ";
  return "APIサーバ";
}

// ---------------------------------------------------------------------------
// scanForPatterns (pure)
// ---------------------------------------------------------------------------

interface Decl {
  kind: AccessPatternKind;
  name: string;
  file: string;
  line: number;
  reason: string;
  target?: string;
  absFile?: string;
  /**
   * Accessors computed by the caller (structural facades, #323): when set, the
   * join uses them verbatim instead of attributing via `Name.Member` usages —
   * an unnamed aggregation hub has no name-based usage sites to scan for.
   */
  presetAccessors?: PatternAccessor[];
}
interface Use { name: string; access: string; absPath: string; line: number; }

/**
 * Per-class structural fan-out, derived from the call graph by the caller and
 * passed in so `scanForPatterns` stays pure. Feeds structural-facade detection
 * (#323): a class that aggregates many distinct outgoing calls across domains.
 */
export interface ClassFanOut {
  /** Distinct functions this class's methods call (union across its methods). */
  distinctCallees: number;
  /** Distinct domains those callees belong to. */
  calleeDomains: number;
  /** Domains that call INTO this class — the facade's accessors. */
  callerDomains: string[];
  /** A representative source location for the class (first member function). */
  file: string;
  line: number;
}

export interface ScanOptions {
  /** className → structural fan-out, for structural-facade detection (#323). */
  classFanOut?: Map<string, ClassFanOut>;
}

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
  opts: ScanOptions = {},
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
  // DI registrations (iface → concrete), so a consumer that references only the
  // interface can be traced to the concrete network client it resolves to.
  const aliasPairs: { iface: string; concrete: string }[] = [];

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
      // network: a client class by name, or any class touching a networking API.
      const netCls = line.match(NET_CLIENT_CLASS);
      if (netCls) {
        const n = netCls[1]!;
        decls.push({ kind: "network", name: n, file: relFile, line: i + 1, target: classifyServer(n), absFile: f.path, reason: `network client class ${n}` });
      } else if (NET_API.test(line)) {
        const cls = enclosingClass(lines, i);
        if (cls) decls.push({ kind: "network", name: cls, file: relFile, line: i + 1, target: classifyServer(cls + " " + relFile), absFile: f.path, reason: `uses networking API in ${cls}` });
      }

      // ── DI registrations (interface → concrete) ──
      collectPairs(line, DI_REGISTER_PAIR, aliasPairs);
      collectPairs(line, DI_BIND_TO, aliasPairs);

      // ── usages ──
      collect(line, USE_SINGLETON, "reads", f.path, i + 1, uses);
      collect(line, USE_LOCATOR, "calls", f.path, i + 1, uses);
      collect(line, USE_FACADE, "calls", f.path, i + 1, uses);
    }
  }

  // #321 — trace each network client to its CALLING domains (not just the owner).
  // Build the set of type tokens that resolve to a network client: the concrete
  // class itself plus every interface a DI registration binds to it. Then a
  // second pass attributes any reference to one of those tokens (a resolve, a
  // typed field/param, a `new`) to the referencing site's domain.
  const netConcrete = new Set(decls.filter((d) => d.kind === "network").map((d) => d.name));
  const tokenToConcrete = new Map<string, string>();
  for (const n of netConcrete) tokenToConcrete.set(n, n);
  for (const { iface, concrete } of aliasPairs) {
    if (netConcrete.has(concrete)) tokenToConcrete.set(iface, concrete);
  }
  const netRefs: { concrete: string; absPath: string; line: number }[] = [];
  if (tokenToConcrete.size > 0) {
    const tokenRe = new RegExp(`\\b(${[...tokenToConcrete.keys()].join("|")})\\b`, "g");
    for (const f of files) {
      if (!f.text) continue;
      const lines = f.text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        tokenRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = tokenRe.exec(line)) !== null) {
          const token = m[1]!;
          // Skip the declaration site of the client/interface itself.
          if (new RegExp(`\\b(?:class|struct|interface)\\s+${token}\\b`).test(line)) continue;
          netRefs.push({ concrete: tokenToConcrete.get(token)!, absPath: f.path, line: i + 1 });
        }
      }
    }
  }

  // #323 — structural facades: a class that aggregates a lot of outgoing calls
  // across multiple domains is an aggregation hub even without a *Facade name.
  // Fan-out is graph-derived (passed in via opts to keep this function pure).
  const declaredNames = new Set(decls.map((d) => d.name));
  if (opts.classFanOut) {
    for (const [cls, info] of opts.classFanOut) {
      if (declaredNames.has(cls)) continue; // already a named pattern — don't relabel
      if (info.distinctCallees < STRUCTURAL_FACADE_FANOUT || info.calleeDomains < 2) continue;
      decls.push({
        kind: "facade",
        name: cls,
        file: info.file,
        line: info.line,
        reason: `structural facade: aggregates ${info.distinctCallees} outgoing calls across ${info.calleeDomains} domains`,
        presetAccessors: info.callerDomains.map((domain) => ({ domain, access: "calls" })),
      });
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
    const add = (dom: string, access: string): void => {
      let s = byDomain.get(dom);
      if (!s) byDomain.set(dom, (s = new Set()));
      s.add(access);
    };
    if (d.presetAccessors) {
      // Structural facade (#323): accessors are graph-derived, not name-scanned.
      for (const a of d.presetAccessors) add(a.domain, a.access);
    } else if (d.kind === "network") {
      // Attribute to the domain(s) that OWN the client (its file's functions)…
      for (const r of fnsByFile.get(d.absFile ?? "") ?? []) {
        for (const dom of domainsOf.get(r.anchor) ?? []) add(dom, "calls");
      }
      // …plus the domains that REFERENCE it through DI (#321): a resolve, a
      // typed field/param, or a `new`. Inside a function → that function's
      // domain; at class scope (e.g. a `[Inject]` field) → the file's domains.
      for (const r of netRefs) {
        if (r.concrete !== d.name) continue;
        const anchor = enclosingFn(fnsByFile.get(r.absPath), r.line);
        const doms = anchor
          ? domainsOf.get(anchor)
          : new Set((fnsByFile.get(r.absPath) ?? []).flatMap((x) => [...(domainsOf.get(x.anchor) ?? [])]));
        for (const dom of doms ?? []) add(dom, "calls");
      }
    } else {
      for (const u of uses) {
        if (u.name !== d.name) continue;
        const anchor = enclosingFn(fnsByFile.get(u.absPath), u.line);
        if (!anchor) continue;
        for (const dom of domainsOf.get(anchor) ?? []) add(dom, u.access);
      }
    }
    const accessors: PatternAccessor[] = [];
    for (const [domain, kinds] of byDomain) for (const access of kinds) accessors.push({ domain, access });
    accessors.sort((a, b) => a.domain.localeCompare(b.domain) || a.access.localeCompare(b.access));
    out.push({ name: d.name, file: d.file, line: d.line, kind: d.kind, reason: d.reason, target: d.target, accessors });
  }

  out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return out;
}

/** Collect (iface, concrete) capture pairs from a global DI-registration regex. */
function collectPairs(line: string, re: RegExp, out: { iface: string; concrete: string }[]): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out.push({ iface: m[1]!, concrete: m[2]! });
  }
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
  const classFanOut = await computeClassFanOut(
    ctx.functions,
    ctx.domains ?? [],
    ctx.graph,
    ctx.repoPath,
  );
  return scanForPatterns(files, ctx.functions, ctx.domains ?? [], ctx.repoPath, { classFanOut });
}

/**
 * Per-class structural fan-out from the call graph (#323). For each class (by
 * `FunctionNode.enclosingType`) we union the distinct callees of all its member
 * functions, count the domains those callees span, and collect the domains that
 * call into the class — the data structural-facade detection needs. Pure-data
 * out; the graph traversal is confined here so `scanForPatterns` stays pure.
 */
async function computeClassFanOut(
  functions: FunctionNode[],
  domains: DetectionResult[],
  graph: CodeGraphQuery,
  repoPath: string,
): Promise<Map<string, ClassFanOut>> {
  const domainsOf = new Map<AnchorId, Set<string>>();
  for (const d of domains) {
    for (const a of d.implementors) {
      let s = domainsOf.get(a);
      if (!s) domainsOf.set(a, (s = new Set()));
      s.add(d.domain);
    }
  }

  const byClass = new Map<string, FunctionNode[]>();
  for (const fn of functions) {
    if (!fn.id || !fn.enclosingType) continue;
    const arr = byClass.get(fn.enclosingType) ?? [];
    arr.push(fn);
    byClass.set(fn.enclosingType, arr);
  }

  const result = new Map<string, ClassFanOut>();
  for (const [cls, fns] of byClass) {
    const callees = new Set<AnchorId>();
    const calleeDomains = new Set<string>();
    const callerDomains = new Set<string>();
    for (const fn of fns) {
      for (const o of await graph.neighbors(fn.id!, "calls")) {
        callees.add(o.id);
        for (const dom of domainsOf.get(o.id) ?? []) calleeDomains.add(dom);
      }
      for (const p of await graph.predecessors(fn.id!, "calls")) {
        for (const dom of domainsOf.get(p.id) ?? []) callerDomains.add(dom);
      }
    }
    const loc = fns.reduce((a, b) =>
      a.sourceRange.start.line <= b.sourceRange.start.line ? a : b,
    );
    let file = loc.sourceRange.filePath;
    try { file = relative(repoPath, file).replace(/\\/g, "/"); } catch { /* keep abs */ }
    result.set(cls, {
      distinctCallees: callees.size,
      calleeDomains: calleeDomains.size,
      callerDomains: [...callerDomains],
      file,
      line: loc.sourceRange.start.line,
    });
  }
  return result;
}
