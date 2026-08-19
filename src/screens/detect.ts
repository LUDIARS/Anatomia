/**
 * src/screens/detect.ts — Heuristic screen-composition detection (source scan).
 *
 * Learns the UI screen composition of a repo, multi-stack, from source text:
 *   - Web (React/Vue/TSX): components named `*Page/*View/*Screen`, components
 *     declared under pages/ views/ screens/, Next file-routes (app/**\/page.tsx,
 *     pages/**), and routing tables (<Route path element>, `{path, component}`).
 *   - Unity / native game UI (C#/C++): classes named `*Panel/*Dialog/*Window/
 *     *Modal/*Menu/*HUD/*Overlay/*Screen/*View`, and `SceneManager.LoadScene`.
 *
 * Composition is read the same way patterns/detect.ts reads access patterns — a
 * SOURCE scan, not the call graph: a screen's child screens (`contains`) and its
 * navigation targets (`navigatesTo`) are mostly JSX/string literals that never
 * become function-DAG nodes. We attribute each screen to the domains its file's
 * functions belong to (call-graph attribution), so the screen overlay lines up
 * with the domain view.
 *
 * Navigation/composition are attributed at FILE granularity (every screen
 * declared in a file inherits that file's nav targets + child refs). For the
 * common one-screen-per-file case this is exact; for multi-screen files it is
 * intentionally coarse (this is advisory structural data, not a proof).
 *
 * SRP: screen detection + composition/navigation resolution + domain
 * attribution. No HTTP, no rendering, no taxonomy mapping (that is retune's job).
 * `scanForScreens` is pure (testable without fs); `detectScreens` adds the reads.
 */

import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type { FunctionNode } from "../types.js";
import type { AnalysisContext } from "../core.js";
import { semanticDetectionResults, type DetectionResult } from "../domains/detect.js";
import type { ScreenGraph, ScreenKind, ScreenNode, ScreenStack } from "./types.js";

/** One source file's path + text, for the pure scanner. */
export interface ScanFile {
  path: string; // absolute
  text: string;
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

// Name suffixes that mark a screen. Web is narrow (Page/View/Screen); game UI
// adds the panel/dialog/menu family common in Unity/native UI code.
const WEB_SUFFIX = /(Page|View|Screen)$/;
const GAME_SUFFIX = /(Page|View|Screen|Panel|Window|Dialog|Modal|Popup|Menu|HUD|Overlay)$/;

// Web component / class declarations that bind a PascalCase name.
const WEB_DECLS: RegExp[] = [
  /\bexport\s+default\s+function\s+([A-Z]\w*)/,
  /\bexport\s+function\s+([A-Z]\w*)/,
  /\bfunction\s+([A-Z]\w*)\s*\(/,
  /\b(?:export\s+)?const\s+([A-Z]\w*)\s*[:=]/,
  /\b(?:export\s+default\s+)?class\s+([A-Z]\w*)/,
];
// Game UI class/struct declaration.
const GAME_CLASS = /\b(?:class|struct)\s+([A-Z]\w*)/;

// The default-exported component name (the file's "primary" screen candidate).
const DEFAULT_EXPORT = /\bexport\s+default\s+(?:function\s+)?([A-Z]\w*)/;

// Routing tables → route path bound to a component name.
const ROUTE_JSX =
  /<Route\b[^>]*?\bpath\s*=\s*[`'"]([^`'"]+)[`'"][^>]*?\belement\s*=\s*\{?\s*<\s*([A-Z]\w*)/g;
const ROUTE_OBJ =
  /\bpath\s*:\s*[`'"]([^`'"]+)[`'"][\s\S]{0,160}?(?:element\s*:\s*(?:<\s*)?([A-Z]\w*)|component\s*:\s*([A-Z]\w*))/g;

// Navigation calls / links (web) and scene loads (game).
const NAV_FN = /\bnavigate\s*\(\s*[`'"]([^`'"]+)[`'"]/g;
const NAV_ROUTER = /\b(?:router|history|nav)\s*\.\s*(?:push|replace|navigate)\s*\(\s*[`'"]([^`'"]+)[`'"]/g;
const NAV_JSX = /<(?:Link|NavLink|Navigate|Redirect)\b[^>]*?\b(?:to|href)\s*=\s*[`'"]([^`'"]+)[`'"]/g;
const NAV_REDIRECT = /\bredirect\s*\(\s*[`'"]([^`'"]+)[`'"]/g;
const SCENE_LOAD = /\bLoadScene(?:Async)?\s*\(\s*[`'"]([^`'"]+)[`'"]/g;

// JSX child element (`<Child ` / `<Child/>`), for web composition.
const JSX_CHILD = /<([A-Z]\w*)[\s/>]/g;

/** Map a PascalCase suffix to a screen kind. */
function kindFromName(name: string): ScreenKind | null {
  if (/Page$/.test(name)) return "page";
  if (/(View|Screen)$/.test(name)) return "view";
  if (/Panel$/.test(name)) return "panel";
  if (/(Dialog|Modal|Window|Popup)$/.test(name)) return "dialog";
  if (/Menu$/.test(name)) return "menu";
  if (/(HUD|Overlay)$/.test(name)) return "hud";
  return null;
}

/** Stack from the file extension (a path with no known ext defaults to native). */
function stackFor(path: string): ScreenStack {
  const p = path.toLowerCase();
  if (p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".js") || p.endsWith(".jsx") || p.endsWith(".vue")) {
    return "web";
  }
  if (p.endsWith(".cs")) return "unity";
  return "native";
}

/** Directory-convention screen kind for a web file, or null. */
function dirKind(rel: string): ScreenKind | null {
  if (/(^|\/)pages\//.test(rel)) return "page";
  if (/(^|\/)views\//.test(rel)) return "view";
  if (/(^|\/)screens\//.test(rel)) return "view";
  return null;
}

/** True for a Next-style file route (app router page or pages router file). */
function isNextRouteFile(rel: string): boolean {
  if (/(^|\/)app\/.*page\.(t|j)sx?$/.test(rel)) return true;
  if (/(^|\/)pages\/(?!_app|_document|api\/).+\.(t|j)sx$/.test(rel)) return true;
  return false;
}

/** Derive a URL route from a Next file path (best-effort). */
function routeFromFile(rel: string): string {
  const app = rel.match(/(?:^|\/)app\/(.*)\/page\.(?:t|j)sx?$/);
  if (app) return "/" + app[1]!;
  const appRoot = /(?:^|\/)app\/page\.(?:t|j)sx?$/.test(rel);
  if (appRoot) return "/";
  const pages = rel.match(/(?:^|\/)pages\/(.*)\.(?:t|j)sx$/);
  if (pages) {
    const r = pages[1]!.replace(/\/index$/, "").replace(/^index$/, "");
    return "/" + r;
  }
  return "/";
}

/** A PascalCase screen name derived from a Next route file (for default exports). */
function nameFromRouteFile(rel: string): string {
  const route = routeFromFile(rel);
  const base = route === "/" ? "index" : route.replace(/[^A-Za-z0-9]+/g, " ").trim();
  const pascal = base
    .split(/\s+/)
    .map((s) => (s ? s[0]!.toUpperCase() + s.slice(1) : ""))
    .join("");
  return (pascal || "Index") + "Page";
}

/** PascalCase the file's base name (e.g. "game-search.tsx" → "GameSearch"). */
function fileBasePascal(rel: string): string {
  const base = (rel.split("/").pop() ?? rel).replace(/\.(t|j)sx?$/, "");
  return base
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join("");
}

/** Normalize a route/path literal for cross-referencing (trim slashes/query/hash). */
function normRoute(p: string): string {
  let s = p.split(/[?#]/)[0]!.trim();
  s = s.replace(/^\/+/, "").replace(/\/+$/, "");
  return s;
}

interface Decl {
  name: string;
  absFile: string;
  relFile: string;
  line: number;
  kind: ScreenKind;
  stack: ScreenStack;
  reason: string;
}

/** Collect all global-regex capture group 1 matches from text. */
function captures(text: string, re: RegExp, group = 1): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const v = m[group];
    if (v) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// scanForScreens (pure)
// ---------------------------------------------------------------------------

export function scanForScreens(
  files: ScanFile[],
  functions: FunctionNode[],
  domains: DetectionResult[],
  repoPath: string,
): ScreenGraph {
  const rel = (p: string): string => {
    try {
      return relative(repoPath, p).replace(/\\/g, "/");
    } catch {
      return p;
    }
  };

  // anchor → domains, then file → domains (screens attribute by file).
  const domainsOfAnchor = new Map<string, Set<string>>();
  for (const d of semanticDetectionResults(domains)) {
    for (const a of d.implementors) {
      let s = domainsOfAnchor.get(a);
      if (!s) domainsOfAnchor.set(a, (s = new Set()));
      s.add(d.domain);
    }
  }
  const domainsOfFile = new Map<string, Set<string>>();
  for (const fn of functions) {
    if (!fn.id) continue;
    const doms = domainsOfAnchor.get(fn.id);
    if (!doms || doms.size === 0) continue;
    let s = domainsOfFile.get(fn.sourceRange.filePath);
    if (!s) domainsOfFile.set(fn.sourceRange.filePath, (s = new Set()));
    for (const d of doms) s.add(d);
  }

  const decls: Decl[] = [];
  const routeToComponent = new Map<string, string>(); // normalized route → component
  const navByFile = new Map<string, Set<string>>(); // absFile → raw nav targets (paths/scenes)
  const scenes = new Set<string>(); // scene names referenced via LoadScene

  for (const f of files) {
    if (!f.text) continue;
    const relFile = rel(f.path);
    const stack = stackFor(f.path);
    const lines = f.text.split(/\r?\n/);

    // ── declarations ──
    if (stack === "web") {
      const dk = dirKind(relFile);
      const next = isNextRouteFile(relFile);
      // Folder/route conventions (pages/ views/ screens/, Next file routes) name
      // the FILE's primary component a screen — not every helper component
      // declared inside it. The primary = the default export, else the decl whose
      // name matches the filename. Sub-components qualify only by a name suffix.
      const defMatch = f.text.match(DEFAULT_EXPORT);
      const defaultName = defMatch ? defMatch[1]! : null;
      const baseName = fileBasePascal(relFile);
      const isPrimary = (n: string): boolean => n === defaultName || n === baseName;
      let foundPrimaryScreen = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        for (const re of WEB_DECLS) {
          const m = line.match(re);
          if (!m) continue;
          const name = m[1]!;
          // A component name is PascalCase (has a lowercase letter); skip
          // SCREAMING_SNAKE_CASE constants that also start with a capital.
          if (!/[a-z]/.test(name)) continue;
          const bySuffix = WEB_SUFFIX.test(name);
          const byLocation = (next || dk !== null) && isPrimary(name);
          if (!bySuffix && !byLocation) continue;
          const kind = kindFromName(name) ?? (next ? "page" : (dk ?? "view"));
          const reason = bySuffix
            ? `web component name ${name}`
            : next
              ? `Next file route ${routeFromFile(relFile)}`
              : `primary component under ${dk === "page" ? "pages" : "views/screens"} dir`;
          decls.push({ name, absFile: f.path, relFile, line: i + 1, kind, stack, reason });
          if ((next || dk === "page") && isPrimary(name)) {
            routeToComponent.set(normRoute(routeFromFile(relFile)), name);
          }
          if (byLocation) foundPrimaryScreen = true;
          break; // one screen decl per line
        }
      }
      // Next route file with only an anonymous default export → synthesize.
      if (next && !foundPrimaryScreen && !defaultName) {
        const name = nameFromRouteFile(relFile);
        decls.push({
          name,
          absFile: f.path,
          relFile,
          line: 1,
          kind: "page",
          stack,
          reason: `Next file route ${routeFromFile(relFile)} (anonymous default export)`,
        });
        routeToComponent.set(normRoute(routeFromFile(relFile)), name);
      }
    } else {
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i]!.match(GAME_CLASS);
        if (!m) continue;
        const name = m[1]!;
        if (!GAME_SUFFIX.test(name)) continue;
        const kind = kindFromName(name) ?? "view";
        decls.push({ name, absFile: f.path, relFile, line: i + 1, kind, stack, reason: `game UI class ${name}` });
      }
    }

    // ── routing tables ──
    for (const m of f.text.matchAll(ROUTE_JSX)) {
      if (m[1] && m[2]) routeToComponent.set(normRoute(m[1]), m[2]);
    }
    for (const m of f.text.matchAll(ROUTE_OBJ)) {
      const comp = m[2] ?? m[3];
      if (m[1] && comp) routeToComponent.set(normRoute(m[1]), comp);
    }

    // ── navigation targets + scene loads (file-level) ──
    const navTargets = new Set<string>();
    for (const re of [NAV_FN, NAV_ROUTER, NAV_JSX, NAV_REDIRECT]) {
      for (const t of captures(f.text, re)) navTargets.add(t);
    }
    for (const s of captures(f.text, SCENE_LOAD)) {
      navTargets.add(s);
      scenes.add(s);
    }
    if (navTargets.size > 0) navByFile.set(f.path, navTargets);
  }

  // Scene-only screens (referenced via LoadScene, no declaring file).
  const declNames = new Set(decls.map((d) => d.name));
  const sceneScreens: ScreenNode[] = [];
  for (const s of [...scenes].sort()) {
    if (declNames.has(s)) continue;
    sceneScreens.push({
      name: s,
      file: "",
      line: 0,
      kind: "scene",
      stack: "unity",
      route: s,
      contains: [],
      navigatesTo: [],
      reason: "scene referenced via LoadScene",
      domains: [],
    });
  }

  // The set of all screen names (declared ∪ scene), for composition resolution.
  const screenNames = new Set<string>([...declNames, ...sceneScreens.map((s) => s.name)]);

  // Mark a declared screen as a routed page when a routing table binds it.
  const componentRoute = new Map<string, string>();
  for (const [route, comp] of routeToComponent) componentRoute.set(comp, route);

  // Resolve a raw nav target → a screen name (via route table or scene), else
  // keep the raw path so the navigation is still recorded.
  const resolveNav = (target: string): string => {
    if (screenNames.has(target)) return target; // already a scene/screen name
    const comp = routeToComponent.get(normRoute(target));
    if (comp) return comp;
    return target;
  };

  // Per-file text cache for composition (child reference) lookups.
  const textByFile = new Map<string, string>();
  for (const f of files) textByFile.set(f.path, f.text ?? "");
  // Screens declared per file (to exclude self from contains).
  const declsByFile = new Map<string, Set<string>>();
  for (const d of decls) {
    let s = declsByFile.get(d.absFile);
    if (!s) declsByFile.set(d.absFile, (s = new Set()));
    s.add(d.name);
  }

  // Declared screens by extension-less absolute path (import specifier resolution).
  const declsByModule = new Map<string, Decl[]>();
  for (const d of decls) {
    const key = moduleKey(d.absFile);
    declsByModule.set(key, [...(declsByModule.get(key) ?? []), d]);
  }

  // Build the declared screen nodes.
  const declScreens: ScreenNode[] = decls.map((d) => {
    const text = textByFile.get(d.absFile) ?? "";
    const selfNames = declsByFile.get(d.absFile) ?? new Set<string>();

    // contains = other screens referenced in this file (JSX child for web,
    // word-boundary reference for game).
    const contains = new Set<string>();
    const containsQualified = new Set<string>();
    if (d.stack === "web") {
      const imported = importedDecls(text, d.absFile, declsByModule);
      for (const child of captures(text, JSX_CHILD)) {
        const importedDecl = imported.get(child);
        if (importedDecl && !selfNames.has(importedDecl.name)) {
          // JSX uses the local import binding, which may be an alias. Keep the
          // detected declaration name for the display-level relation and the
          // declaring file for its exact canonical reference.
          contains.add(importedDecl.name);
          containsQualified.add(`${importedDecl.relFile}#${importedDecl.name}`);
        } else if (screenNames.has(child) && !selfNames.has(child)) {
          contains.add(child);
        }
      }
    } else {
      for (const s of screenNames) {
        if (selfNames.has(s)) continue;
        if (new RegExp(`\\b${escapeRe(s)}\\b`).test(text)) contains.add(s);
      }
    }

    // navigatesTo = resolved nav targets for this file (minus self).
    const navTargets = navByFile.get(d.absFile) ?? new Set<string>();
    const navigatesTo = new Set<string>();
    for (const t of navTargets) {
      const r = resolveNav(t);
      if (!selfNames.has(r)) navigatesTo.add(r);
    }

    const route = componentRoute.get(d.name);
    const kind = route ? "page" : d.kind;
    return {
      name: d.name,
      file: d.relFile,
      line: d.line,
      kind,
      stack: d.stack,
      ...(route ? { route: "/" + route } : {}),
      contains: [...contains].sort(),
      ...(containsQualified.size ? { containsQualified: [...containsQualified].sort() } : {}),
      navigatesTo: [...navigatesTo].sort(),
      reason: d.reason,
      domains: [...(domainsOfFile.get(d.absFile) ?? [])].sort(),
    };
  });

  // Dedup declared screens by name+file (a name re-declared on multiple lines).
  const byKey = new Map<string, ScreenNode>();
  for (const s of [...declScreens, ...sceneScreens]) {
    const k = `${s.name} ${s.file}`;
    if (!byKey.has(k)) byKey.set(k, s);
  }
  const screens = [...byKey.values()].sort(
    (a, b) =>
      a.stack.localeCompare(b.stack) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  );

  const byStack: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  let edges = 0;
  for (const s of screens) {
    byStack[s.stack] = (byStack[s.stack] ?? 0) + 1;
    byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
    edges += s.contains.length + s.navigatesTo.length;
  }

  return { screens, summary: { total: screens.length, byStack, byKind, edges } };
}

/** Extension-less, forward-slash absolute path used to match import specifiers to files. */
function moduleKey(absFile: string): string {
  return absFile.replace(/\\/g, "/").replace(/\.(tsx?|jsx?|mjs|cjs|vue)$/, "");
}

const IMPORT_RE = /import\s+(?:type\s+)?([^;'"]*?)\s+from\s+["']([^"']+)["']/g;

/**
 * Screen declarations reachable through this file's relative imports, keyed by
 * the local binding name (`import { SessionList } from "./monitor/SessionList.js"`
 * → SessionList → the decl in monitor/SessionList.tsx). Only relative specifiers
 * are resolved; package imports and unmatched paths are ignored. Directory
 * imports fall back to `<dir>/index`.
 */
function importedDecls(
  text: string,
  absFile: string,
  declsByModule: ReadonlyMap<string, Decl[]>,
): Map<string, Decl> {
  const out = new Map<string, Decl>();
  const baseDir = absFile.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
  for (const match of text.matchAll(IMPORT_RE)) {
    const clause = match[1] ?? "";
    const spec = match[2] ?? "";
    if (!spec.startsWith(".")) continue;
    const target = moduleKey(resolveRelative(baseDir, spec));
    const candidates = declsByModule.get(target) ?? declsByModule.get(`${target}/index`) ?? [];
    if (candidates.length === 0) continue;
    for (const [local, exported] of importBindings(clause)) {
      const decl = exported === "default"
        ? (candidates.length === 1 ? candidates[0] : undefined)
        : candidates.find((c) => c.name === exported);
      if (decl && !out.has(local)) out.set(local, decl);
    }
  }
  return out;
}

/** `Default, { A, B as C }` → [[Default, default], [A, A], [C, B]] (local, exported). */
function importBindings(clause: string): Array<[string, string]> {
  const bindings: Array<[string, string]> = [];
  const named = /\{([^}]*)\}/.exec(clause);
  const rest = clause.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+\w+/, "").replace(/,/g, " ").trim();
  if (/^[A-Za-z_$][\w$]*$/.test(rest)) bindings.push([rest, "default"]);
  for (const part of (named?.[1] ?? "").split(",")) {
    const m = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
    if (m) bindings.push([m[2] ?? m[1]!, m[1]!]);
  }
  return bindings;
}

/** Minimal POSIX-style relative resolution (no fs access; deterministic). */
function resolveRelative(baseDir: string, spec: string): string {
  const parts = baseDir.split("/");
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// detectScreens (reads files, then scans)
// ---------------------------------------------------------------------------

export async function detectScreens(ctx: AnalysisContext): Promise<ScreenGraph> {
  const files: ScanFile[] = await Promise.all(
    ctx.files.map(async (f) => ({
      path: f.path,
      text: await readFile(f.path, "utf8").catch(() => ""),
    })),
  );
  return scanForScreens(files, ctx.functions, ctx.domains ?? [], ctx.repoPath);
}
