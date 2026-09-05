/**
 * src/supply/plan/public-api.ts — What counts as a domain's own vocabulary.
 *
 * Measured on the first plan PR: the 「データ定義」 list of a C++ domain filled up
 * with `size`, `empty`, `count`, `begin`, `end` — every container accessor the
 * domain happens to define — and the 手本 (exemplar) landed on
 * `demo/graph/snippet_cache.h:size` because accessors are, by construction, the
 * most-referenced functions in a codebase. Both readings are useless to an
 * author: an accessor says nothing about what a domain is FOR.
 *
 * So both steps share one rule here: a domain's vocabulary is its type
 * declarations plus its public API functions, where an accessor and an operator
 * overload are NOT public API. The list is a curated set of the names that are
 * accessors in every language Anatomia parses, not a heuristic over shapes —
 * a name-shape guess would quietly drop real API like `getSnapshot`.
 *
 * SRP: the accessor/operator predicate, shared by data-defs.ts and exemplar.ts.
 */

/**
 * Names that are accessors wherever they appear (STL/BCL/JS collection
 * protocol). Compared case-insensitively, and with a leading `get_`/`set_`
 * stripped, so `get_size` folds onto `size`.
 */
const ACCESSOR_NAMES = new Set([
  "at",
  "back",
  "begin",
  "capacity",
  "cbegin",
  "cend",
  "count",
  "crbegin",
  "crend",
  "data",
  "empty",
  "end",
  "first",
  "front",
  "get",
  "has",
  "isempty",
  "iterator",
  "key",
  "last",
  "length",
  "next",
  "rbegin",
  "rend",
  "second",
  "set",
  "size",
  "value",
]);

/**
 * True when `name` is an accessor or an operator overload.
 *
 * Also excludes the compiler-generated members a parse surfaces (constructors
 * spelled as the type, destructors, `operator...`): none of them is API a new
 * implementation should be modelled on.
 */
export function isAccessorName(name: string): boolean {
  const bare = name.trim().replace(/^~/, "");
  if (bare === "") return true;
  if (/^operator\b/i.test(bare) || /^operator[^a-z0-9_]/i.test(bare)) return true;
  const folded = bare.toLowerCase().replace(/^(get|set)_/, "");
  return ACCESSOR_NAMES.has(folded);
}

/**
 * True when `name` reads as a domain's public API.
 *
 * "Public" stays a naming convention (no leading underscore) because a
 * FunctionNode carries no visibility flag; claiming otherwise would be a
 * precision the model does not have.
 */
export function isPublicApiName(name: string): boolean {
  return name !== "" && !name.startsWith("_") && !isAccessorName(name);
}
