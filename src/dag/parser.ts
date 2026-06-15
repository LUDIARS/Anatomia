/**
 * T03 — C++/C# parser wrapper (language frontend boundary).
 *
 * Uses web-tree-sitter (WASM, no node-gyp) + tree-sitter-wasms (prebuilt
 * grammar .wasm for cpp and c_sharp). Source text → tree-sitter `Tree`.
 *
 * Adding a new language = adding a grammar wasm + one entry in GRAMMAR_WASM.
 */

import { createRequire } from "node:module";
import { Parser, Language } from "web-tree-sitter";
import type { Tree } from "web-tree-sitter";
import type { Lang } from "../types.js";

const require = createRequire(import.meta.url);

/** Grammar wasm file (shipped by tree-sitter-wasms) per language. */
const GRAMMAR_WASM: Record<Lang, string> = {
  cpp: "tree-sitter-wasms/out/tree-sitter-cpp.wasm",
  c_sharp: "tree-sitter-wasms/out/tree-sitter-c_sharp.wasm",
  typescript: "tree-sitter-wasms/out/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-wasms/out/tree-sitter-tsx.wasm",
};

let initPromise: Promise<void> | null = null;
const languageCache = new Map<Lang, Language>();

/** Initialise the web-tree-sitter runtime exactly once (idempotent). */
async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init({
      locateFile(scriptName: string) {
        // The core tree-sitter.wasm ships next to the web-tree-sitter module.
        return require.resolve(`web-tree-sitter/${scriptName}`);
      },
    } as unknown as Parameters<typeof Parser.init>[0]);
  }
  await initPromise;
}

/** Load (and cache) the grammar Language for a given lang. */
async function loadLanguage(lang: Lang): Promise<Language> {
  const cached = languageCache.get(lang);
  if (cached) return cached;
  await ensureInit();
  const wasmPath = require.resolve(GRAMMAR_WASM[lang]);
  const language = await Language.load(wasmPath);
  languageCache.set(lang, language);
  return language;
}

/**
 * Parse a source string into a tree-sitter `Tree`.
 *
 * The returned `Tree` owns native memory; callers that parse in tight loops
 * should call `tree.delete()` when done. For one-shot analysis this is left to
 * GC of the underlying module.
 */
export async function parse(source: string, lang: Lang): Promise<Tree> {
  const language = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  parser.delete();
  if (!tree) {
    throw new Error(`tree-sitter failed to parse ${lang} source`);
  }
  return tree;
}
