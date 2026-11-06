/**
 * @spec C++ code-level static checks
 *
 * src/adapters/code-check-cli.ts — `anatomia code-check`.
 *
 *   anatomia code-check [<path>...] [--repo <root>] [--files-from <file|->]
 *                       [--json] [--fail-on error|warning|info|none]
 *
 * Paths are files or directories relative to `--repo` (default: cwd); a
 * directory is walked for C++ sources. `--files-from` reads one path per line
 * (Revisor passes a PR's changed files this way). Exit codes: 0 no finding at
 * or above `--fail-on` (default error), 1 there is one, 2 usage/config error.
 *
 * SRP: argument parsing, file collection and output shaping for code-check.
 * The checks themselves live in src/code-checks/.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { loadCodeCheckConfig } from "../code-checks/config.js";
import { defaultSeverities } from "../code-checks/families.js";
import { formatCodeCheckReport } from "../code-checks/format.js";
import { CPP_EXTENSIONS, runCodeChecks, type SourceInput } from "../code-checks/run.js";
import { SEVERITY_RANK, type Severity } from "../code-checks/types.js";

export interface CodeCheckCliResult {
  readonly exitCode: number;
  readonly output: string;
}

interface CodeCheckArgs {
  repo: string;
  paths: string[];
  filesFrom: string | null;
  json: boolean;
  failOn: Severity | "none";
}

const USAGE =
  "usage: anatomia code-check [<path>...] [--repo <root>] [--files-from <file|->] [--json] [--fail-on error|warning|info|none]";
/** Directories never holding the project's own C++ sources. */
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);
const FAIL_ON = new Set(["error", "warning", "info", "none"]);

class UsageError extends Error {}

function parse(argv: readonly string[], cwd: string): CodeCheckArgs {
  const args: CodeCheckArgs = { repo: cwd, paths: [], filesFrom: null, json: false, failOn: "error" };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new UsageError(`${token} needs a value`);
      return next;
    };
    if (token === "--repo") args.repo = resolve(cwd, value());
    else if (token === "--files-from") args.filesFrom = value();
    else if (token === "--json") args.json = true;
    else if (token === "--fail-on") {
      const level = value();
      if (!FAIL_ON.has(level)) throw new UsageError(`--fail-on must be error, warning, info or none`);
      args.failOn = level as Severity | "none";
    } else if (token.startsWith("-")) throw new UsageError(`unknown flag ${token}`);
    else args.paths.push(token);
  }
  return args;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function listedPaths(filesFrom: string, cwd: string): Promise<string[]> {
  const text = filesFrom === "-" ? await readStdin() : await readFile(resolve(cwd, filesFrom), "utf8");
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
}

async function collect(absolute: string, out: string[]): Promise<void> {
  const info = await stat(absolute);
  if (info.isFile()) {
    if (CPP_EXTENSIONS.test(absolute)) out.push(absolute);
    return;
  }
  if (!info.isDirectory()) return;
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;
    await collect(join(absolute, entry.name), out);
  }
}

function repoRelative(repo: string, absolute: string): string {
  const rel = relative(repo, absolute);
  return (rel === "" || rel.startsWith("..") || isAbsolute(rel) ? absolute : rel).replace(/\\/g, "/");
}

async function sources(args: CodeCheckArgs, cwd: string): Promise<SourceInput[]> {
  const requested = [...args.paths, ...(args.filesFrom ? await listedPaths(args.filesFrom, cwd) : [])];
  const roots = requested.length > 0 ? requested : ["."];
  const files: string[] = [];
  for (const path of roots) {
    const absolute = resolve(args.repo, path);
    try {
      await collect(absolute, files);
    } catch (error) {
      // A changed-file list names deleted files too; those have nothing to check.
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && args.filesFrom !== null) continue;
      throw error;
    }
  }
  const unique = [...new Set(files)];
  return Promise.all(unique.map(async (file) => ({ file: repoRelative(args.repo, file), text: await readFile(file, "utf8") })));
}

/** Run `anatomia code-check` with the arguments after the subcommand. */
export async function runCodeCheckCli(argv: readonly string[], cwd: string = process.cwd()): Promise<CodeCheckCliResult> {
  let args: CodeCheckArgs;
  try {
    args = parse(argv, cwd);
  } catch (error) {
    if (error instanceof UsageError) return { exitCode: 2, output: `${error.message}\n${USAGE}` };
    throw error;
  }
  let config;
  try {
    config = loadCodeCheckConfig(args.repo, new Set(defaultSeverities().keys()));
  } catch (error) {
    return { exitCode: 2, output: (error as Error).message };
  }
  const report = await runCodeChecks(await sources(args, cwd), config);
  const failing =
    args.failOn !== "none" && report.findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[args.failOn as Severity]);
  const output = args.json ? JSON.stringify(report, null, 2) : formatCodeCheckReport(report).trimEnd();
  return { exitCode: failing ? 1 : 0, output };
}
