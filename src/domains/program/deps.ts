// @spec プログラムドメイン
/**
 * Builtin dependency-artifact detection (spec/feature/domain-dual-layer.md
 * 「依存系（package 等）の扱い」). Paths recognized here classify to the
 * infrastructure layer before any repository config, so dependency-only
 * changes (deps-sweep / Dependabot) always carry a program-domain link.
 */
const DEPENDENCY_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".gitmodules",
]);

const VENDORED_ROOT = /^(?:vendor|lib|node_modules)\//;

export function isDependencyArtifactPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const basename = normalized.split("/").pop() ?? normalized;
  if (DEPENDENCY_BASENAMES.has(basename.toLowerCase())) return true;
  return VENDORED_ROOT.test(normalized);
}
